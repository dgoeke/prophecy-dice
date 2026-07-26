/**
 * Campaign domain logic — the sole writer of state/ (§6.3).
 *
 * Design: private state stores the secret, sealed field values and activation
 * labels, NPC sheets, idempotency maps, pending activation, and the nonce-free
 * configuration while the ceremony is incomplete. Chains, cursors, and
 * registry state are re-derived on every unlock, which makes a matching
 * backup pair self-contained and removes cursor drift by construction.
 *
 * Persistence order: private.enc FIRST, then ledger.json. A crash between
 * the two can only leave private orphans (values/draw_ids pointing past the
 * ledger end), which load() prunes — it can never lose a sealed value for a
 * published entry.
 *
 * The working ledger lives in state/, NOT public/: live publication would
 * let a player watching the public server infer a secret check just
 * happened (§4.3). publish() copies it to public/ explicitly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { canonicalBytes } from '../core/canonical.ts';
import * as C from '../core/crypto.ts';
import { entryHash, ZERO64, LEDGER_FORMAT } from '../core/ledger.ts';
import { KNOWN_CHAINS, verifyLedger } from '../core/verify.ts';
import {
  atomicWrite, decryptJson, DEFAULT_KDF, deriveKey, encryptJson, Kdf, KdfHeader,
  newKdfHeader, rotateBackup,
} from './store.ts';
import { BeaconProvider, BeaconRound } from './beacon.ts';

export class CampaignError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const err: (m: string, s?: number) => never = (m, s = 400) => { throw new CampaignError(m, s); };
const validRequestId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v)
  && !Object.prototype.hasOwnProperty.call(Object.prototype, v);

interface SealedValues { dc?: number; modifier?: number; context?: string }
interface Priv {
  secret: string;                                   // hex 64
  precommit_at: string;                             // RFC 3339
  rehearsal: boolean;
  configuration_commitment: string | null;          // frozen before player entropy
  configuration: any | null;                        // exact nonce-free projection
  values: Record<string, SealedValues>;             // committing seq → sealed values
  labels: Record<string, { display: string; role: string }>; // sealed activation labels
  npc_sheets: Record<string, Record<string, number>>;
  draw_ids: Record<string, number>;                 // transport-level, never in ledger (§6.5)
  batch_ids: Record<string, number[]>;
  pending: (PendingActivation & { declared_at: string }) | null;
  last_published_seq: number;
  ui_state: unknown;
}
interface PendingActivation {
  slot: string; display: string; role: string; lanes: string[]; nonce: string;
  beacon: BeaconRound; declaration_seq: number;
}
interface SlotState {
  role: string | null; display: string | null; lanes: Set<string>;
  active: boolean; retired: boolean; A: Buffer | null;
}

export interface GenesisInput {
  campaign: string; chain_length?: number; context_privacy?: 'plain' | 'sealed';
  disclosure_policy: string; check_types: any[];
  active_slots: { display: string; role: string; lanes: string[]; nonce: string }[];
  reserve_total?: number; beacon?: any;
}

export interface CampaignOpts {
  stateDir: string;
  publicDir: string;
  beacon?: BeaconProvider;
  now?: () => number;             // ms; injectable for tests
  minPrecommitAgeMs?: number;     // default 1h (§4.1)
  kdf?: Kdf;                      // tests may lower scrypt N
  rehearsal?: boolean;            // §7.8: unpromotable state, isolated publication defaults
  mirrorCommand?: string;         // §6.6: git mirror push, run after publish
}

export class Campaign {
  locked = true;
  onChange: (() => void) | null = null;
  private key: Buffer | null = null;
  private kdfHeader: KdfHeader | null = null;
  private priv: Priv | null = null;
  private entries: any[] = [];
  private links = new Map<string, Buffer[]>();      // "slot/lane" → chain links[0..N]
  private cursor = new Map<string, number>();
  private maxConcerned = new Map<string, number>();
  private watermark = new Map<string, number>();
  private openedSeqs = new Set<number>();
  private slots = new Map<string, SlotState>();
  private registry = new Map<string, any>();
  private deferredQueue: string[] = [];
  private activatedCount = 0;
  private openAnnounce: {
    seq: number; slot: string; lane: string; checkType: string; initiator: string;
  } | null = null;
  private transcript: any = null;
  private E: Buffer | null = null;
  private session = 0;
  private sessionOpen_ = false;
  private lastTs = '';
  private finalRevealed = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private now: () => number;

  constructor(public opts: CampaignOpts) {
    this.now = opts.now ?? Date.now;
  }

  // ---- paths and phase ------------------------------------------------------
  private path(name: string) { return join(this.opts.stateDir, name); }
  get phase(): 'empty' | 'precommitted' | 'live' {
    if (existsSync(this.path('ledger.json'))) return 'live';
    if (existsSync(this.path('private.enc'))) return 'precommitted';
    return 'empty';
  }
  status() {
    return {
      phase: this.phase, locked: this.locked, rehearsal: !!this.opts.rehearsal,
      campaign: this.transcript?.campaign ?? null, session: this.session,
      session_open: this.sessionOpen_,
      entries: this.entries.length,
      unpublished: this.locked ? null : this.entries.length - 1 - (this.priv?.last_published_seq ?? -1),
      pending_activation: this.locked ? null : this.priv?.pending
        ? { slot: this.priv.pending.slot, round: this.priv.pending.beacon.round,
            round_time: roundTime(this.priv.pending.beacon),
            declaration_seq: this.priv.pending.declaration_seq,
            declaration_head: this.entries[this.priv.pending.declaration_seq]?.hash ?? null,
            player_label_salt: this.priv.pending.role === 'player' && this.E
              ? C.labelSalt(Buffer.from(this.priv.secret, 'hex'), this.E, this.priv.pending.slot).toString('hex')
              : null } : null,
      precommit: this.locked || !this.priv ? null : {
        commitment: C.commitmentOf(Buffer.from(this.priv.secret, 'hex')),
        precommit_at: this.priv.precommit_at,
      },
      configuration_frozen: !this.locked && !!this.priv?.configuration_commitment,
    };
  }

  private mutate<T>(fn: () => Promise<T> | T): Promise<T> {
    // Any failed mutation resyncs memory from disk, so a validation error
    // mid-batch can never leave in-memory cursors ahead of the ledger.
    const run = this.queue.then(async () => {
      try { return await fn(); } catch (e) {
        if (!this.locked && this.priv && this.phase === 'live') {
          try { this.load(); } catch { /* surfaced on next op */ }
        }
        throw e;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // ---- lock state machine (§6.4) -------------------------------------------
  lock(): void {
    if (this.key) this.key.fill(0);
    this.key = null; this.priv = null; this.locked = true;
    this.links.clear();
    this.onChange?.();
  }

  async unlock(passphrase: string): Promise<void> {
    return this.mutate(() => {
      if (this.phase === 'empty') err('no campaign: run precommit first', 409);
      const { obj, key, kdf } = (() => {
        try { return decryptJson(readFileSync(this.path('private.enc'), 'utf8'), passphrase); }
        catch { return err('unlock failed', 401); }
      })();
      this.key = key; this.kdfHeader = kdf; this.priv = obj as Priv;
      // §7.8: rehearsal state is structurally unpromotable. The flag rides
      // inside the authenticated ciphertext, so moving the files between
      // state directories cannot change what they are.
      const stateIsRehearsal = !!this.priv.rehearsal;
      if (stateIsRehearsal !== !!this.opts.rehearsal) {
        this.lock(); // clears key and priv
        err(stateIsRehearsal
          ? 'this state was created in rehearsal mode and cannot be promoted to a real campaign'
          : 'this is real campaign state; refusing to open it in rehearsal mode', 409);
      }
      this.locked = false;
      try { this.load(); } catch (e: any) {
        this.lock();
        err(`refusing to unlock: ${e.message}`, 500);
      }
      this.onChange?.();
    });
  }

  // ---- phase 0: pre-commit (§4.1) ------------------------------------------
  async precommit(passphrase: string): Promise<{ commitment: string; precommit_at: string }> {
    return this.mutate(() => {
      if (this.phase !== 'empty') err('campaign already exists', 409);
      if (!passphrase || passphrase.length < 8) err('passphrase must be at least 8 characters');
      const S = randomBytes(32);
      this.kdfHeader = newKdfHeader(this.opts.kdf ?? DEFAULT_KDF);
      this.key = deriveKey(passphrase, Buffer.from(this.kdfHeader.salt, 'base64'), this.kdfHeader);
      this.priv = {
        secret: S.toString('hex'), precommit_at: this.ts(), rehearsal: !!this.opts.rehearsal,
        configuration_commitment: null, configuration: null,
        values: {}, labels: {}, npc_sheets: {}, draw_ids: {}, batch_ids: {},
        pending: null, last_published_seq: -1, ui_state: null,
      };
      this.locked = false;
      this.writePrivate();
      const commitment = C.commitmentOf(S);
      return { commitment, precommit_at: this.priv.precommit_at };
    });
  }

  // ---- phase 1: ceremony (§4.2) --------------------------------------------
  private buildTranscript(input: GenesisInput, createdAt: string): any {
    if (this.phase !== 'precommitted') err('genesis requires a precommitted, ledger-less campaign', 409);
    const age = this.now() - Date.parse(this.priv!.precommit_at);
    const minAge = this.opts.minPrecommitAgeMs ?? 3_600_000;
    if (age < minAge) err(`pre-commit is ${Math.floor(age / 1000)}s old; must be at least ${Math.floor(minAge / 1000)}s`, 409);
    const total = input.reserve_total ?? 64;
    if (!Number.isInteger(total) || total < 1 || total > 999) err('reserve_total must be an integer from 1 to 999');
    if (!Number.isInteger(input.chain_length ?? 20000) || (input.chain_length ?? 20000) < 1
        || (input.chain_length ?? 20000) > 1_000_000) {
      err('chain_length must be an integer from 1 to 1000000');
    }
    if (typeof input.campaign !== 'string' || !input.campaign.trim()) err('campaign name is required');
    if (typeof input.disclosure_policy !== 'string' || !input.disclosure_policy.trim()) {
      err('disclosure_policy is required');
    }
    if (input.context_privacy !== undefined && !['plain', 'sealed'].includes(input.context_privacy)) {
      err('context_privacy must be plain|sealed');
    }
    if (!Array.isArray(input.active_slots)) err('active_slots must be an array');
    if (input.active_slots.length < 1 || input.active_slots.length > total) err('bad slot roster');
    if (!input.active_slots.some((s) => s.role === 'player')) {
      err('at least one active player must contribute entropy at genesis');
    }
    if (!Array.isArray(input.check_types) || input.check_types.length === 0) err('at least one check type is required');
    const typeIds = new Set<string>();
    for (const t of input.check_types) {
      const fields = ['id', 'label', 'lane', 'roles', 'seal_dc', 'seal_modifier', 'ritual'];
      if (!t || Object.keys(t).sort().join(',') !== fields.sort().join(',')
          || typeof t.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(t.id)
          || typeof t.label !== 'string' || !C.LANE_NAME_RE.test(t.lane)
          || !Array.isArray(t.roles) || t.roles.length === 0
          || t.roles.some((r: unknown) => !['player', 'npc', 'world'].includes(String(r)))
          || typeof t.seal_dc !== 'boolean' || typeof t.seal_modifier !== 'boolean'
          || typeof t.ritual !== 'boolean') err(`malformed check_type ${t?.id ?? ''}`);
      if (typeIds.has(t.id)) err(`duplicate check_type ${t.id}`);
      typeIds.add(t.id);
    }
    for (const s of input.active_slots) {
      if (typeof s.display !== 'string' || !s.display.trim()) err('every active slot needs a display name');
      if (!['player', 'npc', 'world'].includes(s.role)) err('role must be player|npc|world');
      if (typeof s.nonce !== 'string' || !s.nonce) err('every active slot needs a nonce, entered at the table');
      if (!Array.isArray(s.lanes) || s.lanes.length === 0 || new Set(s.lanes).size !== s.lanes.length) {
        err(`slot ${s.display} needs a non-empty list of distinct lanes`);
      }
      for (const l of s.lanes) if (!C.LANE_NAME_RE.test(l)) err(`invalid lane name ${l}`);
    }
    const S = Buffer.from(this.priv!.secret, 'hex');
    const slots = Array.from({ length: total }, (_, i) => {
      const id = `slot-${String(i + 1).padStart(2, '0')}`;
      const a = input.active_slots[i];
      return a
        ? { id, display: a.display, role: a.role, status: 'active', lanes: a.lanes, nonce: a.nonce }
        : { id, display: null, role: null, status: 'deferred', lanes: null, nonce: null };
    });
    const transcript = {
      version: 'wotw-column/1', commitment: C.commitmentOf(S),
      chain_length: input.chain_length ?? 20000, created_at: createdAt,
      campaign: input.campaign, context_privacy: input.context_privacy ?? 'plain',
      disclosure_policy: input.disclosure_policy, check_types: input.check_types,
      slots, beacon: null,
    };
    return { ...transcript, configuration_commitment: C.configurationCommitment(transcript) };
  }

  /** §7.2 review step: exact transcript, transcript hash, and player entropy. */
  async freezeGenesisConfiguration(input: GenesisInput): Promise<{
    configuration_commitment: string; configuration: any;
  }> {
    return this.mutate(() => {
      this.requireUnlocked();
      const transcript = this.buildTranscript(input, this.ts());
      if (this.priv!.configuration_commitment
          && this.priv!.configuration_commitment !== transcript.configuration_commitment) {
        err('genesis configuration is already frozen and cannot be changed after entropy may have been collected', 409);
      }
      this.priv!.configuration_commitment = transcript.configuration_commitment;
      this.priv!.configuration = C.genesisConfiguration(transcript);
      this.writePrivate();
      return {
        configuration_commitment: transcript.configuration_commitment,
        configuration: this.priv!.configuration,
      };
    });
  }

  genesisConfiguration(): {
    configuration_commitment: string; configuration: any;
  } {
    this.requireUnlocked();
    if (this.phase !== 'precommitted' || !this.priv!.configuration_commitment
        || !this.priv!.configuration) {
      err('no frozen genesis configuration', 404);
    }
    return {
      configuration_commitment: this.priv!.configuration_commitment,
      configuration: this.priv!.configuration,
    };
  }

  /** §7.2 review step: exact transcript, transcript hash, and player entropy. */
  async genesisPreview(input: GenesisInput): Promise<{
    transcript: any; transcript_hash: string; entropy: string; configuration: any;
  }> {
    return this.mutate(() => {
      this.requireUnlocked();
      const transcript = this.buildTranscript(input, this.ts());
      if (!this.priv!.configuration_commitment
          || transcript.configuration_commitment !== this.priv!.configuration_commitment) {
        err('genesis configuration does not match the pre-entropy commitment', 409);
      }
      return {
        transcript,
        transcript_hash: C.sha256(canonicalBytes(transcript)).toString('hex'),
        entropy: C.genesisEntropy(transcript).toString('hex'),
        configuration: C.genesisConfiguration(transcript),
      };
    });
  }

  async genesis(input: GenesisInput & { created_at?: string }): Promise<{ entry: any; transcript: any }> {
    return this.mutate(() => {
      this.requireUnlocked();
      // accept the previewed created_at so review bytes match written bytes
      let createdAt = this.ts();
      if (input.created_at !== undefined) {
        if (typeof input.created_at !== 'string'
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input.created_at)
            || !Number.isFinite(Date.parse(input.created_at))
            || new Date(input.created_at).toISOString().replace('.000Z', 'Z') !== input.created_at
            || Math.abs(Date.parse(input.created_at) - this.now()) > 600_000) {
          err('created_at is invalid or stale; re-run the preview');
        }
        createdAt = input.created_at;
      }
      const transcript = this.buildTranscript(input, createdAt);
      if (!this.priv!.configuration_commitment
          || transcript.configuration_commitment !== this.priv!.configuration_commitment) {
        err('genesis configuration does not match the pre-entropy commitment', 409);
      }
      const S = Buffer.from(this.priv!.secret, 'hex');
      const E = C.genesisEntropy(transcript);
      const slots = transcript.slots;
      const ikm = C.ikmFor(S, E);
      const tails: Record<string, Record<string, string>> = {};
      for (const s of slots) {
        if (s.status !== 'active') continue;
        tails[s.id] = {};
        for (const lane of s.lanes!) {
          const links = C.chainLinks(C.laneRoot(ikm, s.id, lane), transcript.chain_length);
          tails[s.id][lane] = links[transcript.chain_length].toString('hex');
        }
      }
      const entry = this.append({ kind: 'genesis', transcript, tails });
      this.writePrivate();
      this.writeLedger();
      this.load(); // re-read and re-verify the ledger we just wrote
      return { entry, transcript };
    });
  }

  // ---- draws (§6.5, §7.3) ---------------------------------------------------
  async draw(req: {
    draw_id?: string; slot: string; check_type: string; modifier?: number; dc?: number;
    context?: string; announce_seq?: number; initiator?: string;
    paired_with?: number; pair_rule?: string; gm_degree?: number;
  }): Promise<{ entry: any; roll: number; replay: boolean; modifier?: number; dc?: number }> {
    return this.mutate(() => {
      this.requireLive();
      if (req.draw_id !== undefined && !validRequestId(req.draw_id)) err('invalid draw_id');
      if (req.draw_id && Object.prototype.hasOwnProperty.call(this.priv!.draw_ids, req.draw_id)) {
        const seq = this.priv!.draw_ids[req.draw_id];
        return { entry: this.entries[seq], roll: this.rollAt(this.entries[seq]), replay: true };
      }
      const { entry, roll, used } = this.buildDraw(req);
      const built = this.append(entry);
      this.storeDrawPrivates(built, req, used.modifier);
      if (req.draw_id) this.priv!.draw_ids[req.draw_id] = built.seq;
      this.writePrivate();
      this.writeLedger();
      return { entry: built, roll, replay: false, modifier: used.modifier, dc: req.dc };
    });
  }

  async batch(req: {
    batch_id: string; check_type: string; dc?: number; context?: string; initiator?: string;
    slots: { slot: string; modifier?: number }[];
  }): Promise<{ entries: any[]; rolls: number[]; replay: boolean; modifiers?: (number | undefined)[] }> {
    return this.mutate(() => {
      this.requireLive();
      if (!validRequestId(req.batch_id)) err('invalid batch_id');
      if (Object.prototype.hasOwnProperty.call(this.priv!.batch_ids, req.batch_id)) {
        const seqs = this.priv!.batch_ids[req.batch_id];
        const es = seqs.map((s) => this.entries[s]);
        return { entries: es, rolls: es.map((e) => this.rollAt(e)), replay: true };
      }
      if (!Array.isArray(req.slots) || !req.slots.length) err('empty batch');
      if (new Set(req.slots.map((s) => s.slot)).size !== req.slots.length) err('batch slots must be distinct');
      // atomic: validate and build ALL before appending any (§3.2 batches)
      const drafts = req.slots.map((s) => this.buildDraw({
        slot: s.slot, check_type: req.check_type, modifier: s.modifier, dc: req.dc,
        context: req.context, initiator: req.initiator, batch: req.batch_id,
      }));
      const builtAll = drafts.map((d, i) => {
        const built = this.append(d.entry);
        this.storeDrawPrivates(built, {
          dc: req.dc, context: req.context, modifier: req.slots[i].modifier,
          slot: req.slots[i].slot, check_type: req.check_type,
        }, d.used.modifier);
        return built;
      });
      this.priv!.batch_ids[req.batch_id] = builtAll.map((e) => e.seq);
      this.writePrivate();
      this.writeLedger();
      return { entries: builtAll, rolls: drafts.map((d) => d.roll), replay: false, modifiers: drafts.map((d) => d.used.modifier) };
    });
  }

  /** Validate + assemble a draw entry and consume its position (in memory). */
  private buildDraw(req: any): { entry: any; roll: number; used: { modifier?: number } } {
    if (!this.sessionOpen_) err('draws require an open session');
    const type = this.registry.get(req.check_type) ?? err(`unknown check_type ${req.check_type}`);
    const st = this.slots.get(req.slot) ?? err(`unknown slot ${req.slot}`);
    if (!st.active) err(`slot ${req.slot} is not active`);
    if (st.retired) err(`slot ${req.slot} is retired`);
    const lane = type.lane;
    if (!st.lanes.has(lane)) err(`slot ${req.slot} does not declare lane ${lane}`);
    const role = st.role ?? this.priv!.labels[req.slot]?.role ?? err(`no role known for ${req.slot}`);
    if (!type.roles.includes(role)) err(`slot role ${role} not in roles of check_type ${req.check_type}`);
    if (req.announce_seq !== undefined) {
      const a = this.openAnnounce;
      if (!a || a.seq !== req.announce_seq || a.slot !== req.slot
          || a.lane !== type.lane || a.checkType !== req.check_type
          || a.initiator !== (req.initiator ?? 'gm')) {
        err('announce_seq does not match the exact open announce');
      }
      this.openAnnounce = null;
    } else if (this.openAnnounce) err('an announce is unresolved: reveal or void it first');
    if (type.ritual && req.announce_seq === undefined) {
      err(`check_type ${req.check_type} is ritual and must be announced before it is drawn`);
    }
    const key = `${req.slot}/${lane}`;
    const links = this.links.get(key) ?? err(`no chain for ${key}`);
    const N = this.transcript.chain_length;
    const position = (this.cursor.get(key) ?? 0) + 1;
    if (position > N) err(`lane ${key} is exhausted (N=${N}); no extension protocol exists`, 409);
    if (position > N * 0.8) console.warn(`[column] warning: ${key} at ${position}/${N} (>80%)`);
    const p = C.preimageAt(links, position);
    const seq = this.entries.length;
    const entry: any = {
      kind: 'draw', slot: req.slot, lane, position, check_type: req.check_type,
      initiator: req.initiator ?? 'gm',
    };
    if (entry.initiator !== 'gm' && entry.initiator !== 'player') err('initiator must be gm|player');
    // §2.12 field forms follow the registry, never the request
    // Where a modifier comes from is a property of the SLOT's role; whether
    // it publishes or seals is a property of the check type. Keying the
    // lookup on seal_modifier left non-player slots with non-sealed types
    // (public-gm-check on an NPC) with no source at all.
    let modifier = req.modifier;
    if (modifier === undefined) {
      modifier = role === 'player'
        ? this.playerSheetMod(req.slot, req.check_type)
        : this.priv!.npc_sheets[req.slot]?.[req.check_type];
    }
    if (!Number.isInteger(modifier)) {
      err(`no modifier recorded for ${req.slot}/${req.check_type} — set it on /sheets, or press m at the table`);
    }
    if (type.seal_modifier) entry.mod_commit = C.modCommit(p, seq, modifier!);
    else entry.modifier = modifier;
    if (req.dc !== undefined && !Number.isInteger(req.dc)) err('dc must be an integer');
    if (req.dc !== undefined) {
      if (type.seal_dc) entry.dc_commit = C.dcCommit(p, seq, req.dc);
      else entry.dc = req.dc;
    }
    const context = req.context ?? type.label;
    if (context !== undefined) {
      if (typeof context !== 'string') err('context must be a string');
      if (this.transcript.context_privacy === 'sealed') entry.context_commit = C.contextCommit(p, seq, context);
      else entry.context = context;
    }
    if (req.announce_seq !== undefined) entry.announce_seq = req.announce_seq;
    if (req.batch !== undefined) entry.batch = req.batch;
    if (req.paired_with !== undefined) {
      if (req.pair_rule !== 'fortune' && req.pair_rule !== 'misfortune') err('pair_rule must be fortune|misfortune');
      const earlier = this.entries.find((e) => e.kind === 'draw'
        && e.slot === req.slot && e.lane === lane && e.position === req.paired_with);
      const sameGroup = earlier
        && (earlier.session === this.session
          || (req.batch !== undefined && earlier.batch === req.batch));
      if (!Number.isInteger(req.paired_with) || !earlier || !sameGroup
          || earlier.paired_with !== undefined
          || this.entries.some((e) => e.kind === 'draw' && e.slot === req.slot
            && e.lane === lane && e.paired_with === req.paired_with)) {
        err('paired_with must name an unpaired earlier position of the same slot, lane, and session');
      }
      entry.paired_with = req.paired_with; entry.pair_rule = req.pair_rule;
    }
    if (req.gm_degree !== undefined) entry.gm_degree = req.gm_degree;
    if (req.gm_degree !== undefined && (!Number.isInteger(req.gm_degree) || req.gm_degree < 0 || req.gm_degree > 3)) {
      err('gm_degree must be an integer from 0 to 3');
    }
    this.cursor.set(key, position);
    this.maxConcerned.set(key, Math.max(this.maxConcerned.get(key) ?? 0, position));
    return { entry, roll: C.rollFromPreimage(p), used: { modifier } };
  }

  private storeDrawPrivates(built: any, req: any, resolvedModifier?: number): void {
    const type = this.registry.get(req.check_type)!;
    const vals: SealedValues = {};
    if (req.dc !== undefined && type.seal_dc) vals.dc = req.dc;
    if ('mod_commit' in built) {
      vals.modifier = resolvedModifier;
    }
    if ('context_commit' in built) vals.context = req.context ?? type.label;
    if (Object.keys(vals).length) this.priv!.values[built.seq] = vals;
  }

  // ---- announces (§5.3, §7.3.4) --------------------------------------------
  async announce(req: { slot: string; check_type: string; context?: string; initiator?: string }) {
    return this.mutate(() => {
      this.requireLive();
      if (!this.sessionOpen_) err('announces require an open session');
      if (this.openAnnounce) err('an announce is already open');
      const type = this.registry.get(req.check_type) ?? err(`unknown check_type ${req.check_type}`);
      if (!type.ritual) err(`check_type ${req.check_type} is not ritual and cannot be announced`);
      const st = this.slots.get(req.slot) ?? err(`unknown slot ${req.slot}`);
      if (!st.active || st.retired) err(`slot ${req.slot} not drawable`);
      if (!st.lanes.has(type.lane)) err(`slot ${req.slot} does not declare lane ${type.lane}`);
      const role = st.role ?? this.priv!.labels[req.slot]?.role ?? err(`no role known for ${req.slot}`);
      if (!type.roles.includes(role)) err(`slot role ${role} not in roles of check_type ${req.check_type}`);
      const initiator = req.initiator ?? 'gm';
      if (initiator !== 'gm' && initiator !== 'player') err('initiator must be gm|player');
      const key = `${req.slot}/${type.lane}`;
      const links = this.links.get(key) ?? err(`no chain for ${key}`);
      const reservation = (this.cursor.get(key) ?? 0) + 1;
      if (reservation > this.transcript.chain_length) err(`lane ${key} is exhausted`, 409);
      const p = C.preimageAt(links, reservation);
      const seq = this.entries.length;
      const entry: any = { kind: 'announce', slot: req.slot, lane: type.lane, check_type: req.check_type, initiator };
      const context = req.context ?? type.label;
      if (typeof context !== 'string') err('context must be a string');
      if (this.transcript.context_privacy === 'sealed') entry.context_commit = C.contextCommit(p, seq, context);
      else entry.context = context;
      const built = this.append(entry);
      if ('context_commit' in built) this.priv!.values[built.seq] = { context };
      this.maxConcerned.set(key, Math.max(this.maxConcerned.get(key) ?? 0, reservation));
      this.openAnnounce = {
        seq: built.seq, slot: req.slot, lane: type.lane,
        checkType: req.check_type, initiator,
      };
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }

  async voidAnnounce(req: { announce_seq: number; reason: string }) {
    return this.mutate(() => {
      this.requireLive();
      const a = this.openAnnounce;
      if (!a || a.seq !== req.announce_seq) err('announce_seq does not match the open announce');
      if (typeof req.reason !== 'string' || !req.reason.trim()) err('void reason is required');
      const built = this.append({ kind: 'void', slot: a.slot, lane: a.lane, announce_seq: a.seq, reason: req.reason });
      this.openAnnounce = null;
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }

  // ---- the rest of the entry kinds -----------------------------------------
  async correction(req: { target_seq: number; reason: string; replacement_seq?: number }) {
    return this.mutate(() => {
      this.requireLive();
      const t = this.entries[req.target_seq];
      if (!t || t.kind !== 'draw') err('correction target must be a draw');
      if (this.entries.some((e) => e.kind === 'correction' && e.target_seq === req.target_seq)) err('draw already corrected');
      if (typeof req.reason !== 'string' || !req.reason.trim()) err('correction reason is required');
      const e: any = { kind: 'correction', target_seq: req.target_seq, reason: req.reason };
      if (req.replacement_seq !== undefined) {
        const replacement = this.entries[req.replacement_seq];
        if (!Number.isInteger(req.replacement_seq) || !replacement || replacement.kind !== 'draw'
            || req.replacement_seq === req.target_seq) err('replacement_seq must name another earlier draw');
        e.replacement_seq = req.replacement_seq;
      }
      const built = this.append(e);
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }

  async dcLate(req: { target_seq: number; dc: number }) {
    return this.mutate(() => {
      this.requireLive();
      if (!this.sessionOpen_) err('dc-late requires an open session');
      const t = this.entries[req.target_seq];
      if (!t || t.kind !== 'draw') err('dc-late target must be a draw');
      if (t.session !== this.session) err('dc-late must land in the same session as its draw');
      if ('dc' in t || 'dc_commit' in t) err('target already has a DC');
      if (this.entries.some((e) => e.kind === 'dc-late' && e.target_seq === req.target_seq)) err('target already has a dc-late');
      if (!Number.isInteger(req.dc)) err('dc must be an integer');
      const type = this.registry.get(t.check_type)!;
      const links = this.links.get(`${t.slot}/${t.lane}`)!;
      const p = C.preimageAt(links, t.position);
      const seq = this.entries.length;
      const e: any = { kind: 'dc-late', target_seq: req.target_seq };
      if (type.seal_dc) e.dc_commit = C.dcCommit(p, seq, req.dc);
      else e.dc = req.dc;
      const built = this.append(e);
      if ('dc_commit' in built) this.priv!.values[built.seq] = { dc: req.dc };
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }

  async outOfBand(req: { check_type: string; slot?: string; result: number; reason: string }) {
    return this.mutate(() => {
      this.requireLive();
      if (!this.registry.has(req.check_type)) err(`unknown check_type ${req.check_type}`);
      if (!Number.isInteger(req.result) || req.result < 1 || req.result > 20) err('result must be 1..20');
      if (typeof req.reason !== 'string' || !req.reason.trim()) err('out-of-band reason is required');
      if (req.slot !== undefined && !this.slots.has(req.slot)) err(`unknown slot ${req.slot}`);
      const e: any = { kind: 'out-of-band', check_type: req.check_type, result: req.result, reason: req.reason };
      if (req.slot !== undefined) e.slot = req.slot;
      const built = this.append(e);
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }

  async sheetUpdate(req: { slot: string; effective_from: string; modifiers: Record<string, number> }) {
    return this.mutate(() => {
      this.requireLive();
      if (typeof req.effective_from !== 'string'
          || !/^\d{4}-\d{2}-\d{2}$/.test(req.effective_from)
          || !Number.isFinite(Date.parse(`${req.effective_from}T00:00:00Z`))
          || new Date(`${req.effective_from}T00:00:00Z`).toISOString().slice(0, 10) !== req.effective_from) {
        err('effective_from must be a real YYYY-MM-DD date');
      }
      if (!req.modifiers || typeof req.modifiers !== 'object'
          || Object.entries(req.modifiers).some(([id, v]) => !this.registry.has(id) || !Number.isInteger(v))) {
        err('modifiers must map known check types to integers');
      }
      const st = this.slots.get(req.slot) ?? err(`unknown slot ${req.slot}`);
      if (!st.active || st.retired) err(`slot ${req.slot} is not active`);
      const role = st.role ?? this.priv!.labels[req.slot]?.role;
      if (role === 'player') {
        const built = this.append({ kind: 'sheet-update', slot: req.slot, effective_from: req.effective_from, modifiers: req.modifiers });
        this.writePrivate(); this.writeLedger();
        return { entry: built, private: false };
      }
      // NPC/world sheets stay private; modifiers actually used in draws are
      // committed per draw and open through disclosure/final reveal (§7.5).
      this.priv!.npc_sheets[req.slot] = { ...this.priv!.npc_sheets[req.slot], ...req.modifiers };
      this.writePrivate();
      return { entry: null, private: true };
    });
  }

  async retireSlot(req: { slot: string; reason: string }) {
    return this.mutate(() => {
      this.requireLive();
      const st = this.slots.get(req.slot) ?? err(`unknown slot ${req.slot}`);
      if (!st.active || st.retired) err(`slot ${req.slot} not active`);
      if (typeof req.reason !== 'string' || !req.reason.trim()) err('retirement reason is required');
      const built = this.append({ kind: 'retire-slot', slot: req.slot, reason: req.reason });
      st.retired = true;
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }

  async sessionOpen() {
    return this.mutate(() => {
      this.requireLive();
      if (this.sessionOpen_) err('a session is already open');
      this.session += 1;
      this.sessionOpen_ = true;
      const built = this.append({ kind: 'session-open' });
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }
  async sessionClose() {
    return this.mutate(() => {
      this.requireLive();
      if (!this.sessionOpen_) err('no session is open');
      if (this.openAnnounce) err('resolve the open announce before closing the session');
      this.sessionOpen_ = false;
      const built = this.append({ kind: 'session-close' });
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }
  async note(text: string) {
    return this.mutate(() => {
      this.requireLive();
      if (typeof text !== 'string' || !text.trim()) err('note text is required');
      const built = this.append({ kind: 'note', text });
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }

  // ---- activation (§4.5): declare, wait for the beacon, complete -----------
  async activationDeclare(req: { display: string; role: string; lanes: string[]; nonce: string; slot?: string }) {
    const beacon = this.opts.beacon ?? err('no beacon provider configured', 500);
    const round = await beacon.declare(600);
    const declared = await this.mutate(() => {
      this.requireLive();
      if (this.sessionOpen_) err('activate slots between sessions, not while a session is open');
      if (this.priv!.pending) err('an activation is already pending');
      const expected = this.deferredQueue[this.activatedCount] ?? err('no deferred slots left', 409);
      // ordered allocation is structural: the server only ever offers the
      // lowest deferred slot (§2.9, §7.4)
      if (req.slot !== undefined && req.slot !== expected) err(`activation must target ${expected}, the lowest deferred slot`);
      if (typeof req.display !== 'string' || !req.display.trim()) err('display is required');
      if (typeof req.nonce !== 'string' || !req.nonce) err('nonce is required for every activation');
      if (!Array.isArray(req.lanes) || req.lanes.length === 0 || new Set(req.lanes).size !== req.lanes.length) {
        err('activation requires a non-empty list of distinct lanes');
      }
      for (const l of req.lanes) if (!C.LANE_NAME_RE.test(l)) err(`invalid lane name ${l}`);
      if (!['player', 'npc', 'world'].includes(req.role)) err('role must be player|npc|world');
      if (typeof round.chain !== 'string' || !round.chain
          || !Number.isInteger(round.round) || round.round < 1
          || !Number.isInteger(round.genesis_time) || round.genesis_time < 0
          || !Number.isInteger(round.period) || round.period < 1
          || roundTime(round) < Math.floor(this.now() / 1000) + 600) {
        err('beacon provider returned a malformed or insufficiently future round', 502);
      }
      const known = KNOWN_CHAINS[round.chain];
      if (known && (known.genesis_time !== round.genesis_time || known.period !== round.period)) {
        err('beacon provider returned parameters that do not match the known chain', 502);
      }
      const S = Buffer.from(this.priv!.secret, 'hex');
      const declaration = {
        version: 'wotw-column/1', slot: expected, lanes: req.lanes,
        label_commit: C.labelCommit(C.labelSalt(S, this.E!, expected), req.display.trim(), req.role),
        nonce: req.nonce, declared_at: this.ts(), beacon: round,
      };
      const built = this.append({ kind: 'activation-declare', declaration });
      this.priv!.pending = {
        slot: expected, display: req.display.trim(), role: req.role, lanes: req.lanes,
        nonce: req.nonce, beacon: round, declared_at: declaration.declared_at,
        declaration_seq: built.seq,
      };
      this.writePrivate(); this.writeLedger();
      return {
        declaration: built, slot: expected, round: round.round,
        round_time: roundTime(round), head: built.hash,
      };
    });
    // A future beacon only prevents grinding if the declaration is witnessed
    // before that round. Publish it immediately; the UI also shows the full
    // head for posting to the group chat.
    // Rehearsal publishes to its own directory, so the declare-then-witness
    // step is rehearsable too; only a configured mirror is refused.
    const publication = await this.publish();
    return { ...declared, publication };
  }

  async activationComplete(): Promise<any> {
    const pend = this.priv?.pending ?? err('no pending activation', 409);
    const beacon = this.opts.beacon ?? err('no beacon provider', 500);
    if (this.now() / 1000 < roundTime(pend.beacon)) {
      err(`beacon round ${pend.beacon.round} publishes at ${roundTime(pend.beacon)}; wait`, 409);
    }
    const randomness = await beacon.fetch(pend.beacon.round);
    if (!/^[0-9a-f]{64}$/.test(randomness)) err('beacon returned malformed randomness', 502);
    return this.mutate(() => {
      this.requireLive();
      const live = this.priv!.pending;
      if (!live || live.declaration_seq !== pend.declaration_seq) err('pending activation changed while fetching beacon', 409);
      const S = Buffer.from(this.priv!.secret, 'hex');
      const declaration = this.entries[pend.declaration_seq]?.declaration
        ?? err('public activation declaration is missing', 500);
      const record = { ...declaration, beacon: { ...declaration.beacon, randomness } };
      const A = C.sha256(canonicalBytes(record));
      const N = this.transcript.chain_length;
      const ikm = C.ikmFor(S, this.E!, A);
      const tails: Record<string, string> = {};
      for (const lane of pend.lanes) {
        const links = C.chainLinks(C.laneRoot(ikm, pend.slot, lane), N);
        this.links.set(`${pend.slot}/${lane}`, links);
        tails[lane] = links[N].toString('hex');
      }
      const built = this.append({ kind: 'activate', activation_record: record, tails });
      this.slots.set(pend.slot, { role: null, display: null, lanes: new Set(pend.lanes), active: true, retired: false, A });
      this.priv!.labels[pend.slot] = { display: pend.display, role: pend.role };
      this.priv!.pending = null;
      this.activatedCount += 1;
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }

  // ---- disclosure (§4.4, §7.6) ---------------------------------------------
  disclosePreview(slot: string, lane: string, through: number) {
    this.requireLive();
    if (!Number.isInteger(through)) err('through_position must be an integer');
    const key = `${slot}/${lane}`;
    const links = this.links.get(key) ?? err(`no chain for ${key}`);
    const w = this.watermark.get(key) ?? 0;
    if (through <= w) err(`through_position ${through} must exceed watermark ${w}`);
    if (through > (this.maxConcerned.get(key) ?? 0)) err(`through_position ${through} exceeds highest concerned position`);
    const opened: any[] = [];
    const draws: any[] = [];
    for (const e of this.entries) {
      if (e.slot !== slot || e.lane !== lane) {
        if (!(e.kind === 'dc-late' && this.entries[e.target_seq]?.slot === slot && this.entries[e.target_seq]?.lane === lane)) continue;
      }
      const pos = e.kind === 'draw' ? e.position
        : e.kind === 'dc-late' ? this.entries[e.target_seq].position
        : e.kind === 'announce' ? this.reservationOf(e) : null;
      if (pos === null || pos > through || this.openedSeqs.has(e.seq)) continue;
      const vals = this.priv!.values[e.seq];
      if (vals) opened.push({ seq: e.seq, ...vals });
      if (e.kind === 'draw') {
        const roll = C.rollFromPreimage(C.preimageAt(links, pos));
        const dc = e.dc ?? vals?.dc ?? this.dcLateValueFor(e.seq);
        const mod = e.modifier ?? vals?.modifier;
        draws.push({
          seq: e.seq, position: pos, roll, dc, modifier: mod,
          context: e.context ?? vals?.context,
          degree: dc !== undefined && mod !== undefined ? C.degreeOfSuccess(roll, mod, dc) : null,
        });
      }
    }
    opened.sort((a, b) => a.seq - b.seq);
    return { slot, lane, through_position: through, watermark: w, opened, draws };
  }

  async disclose(req: { slot: string; lane: string; through_position: number }) {
    return this.mutate(() => {
      const pv = this.disclosePreview(req.slot, req.lane, req.through_position);
      const key = `${req.slot}/${req.lane}`;
      const links = this.links.get(key)!;
      const built = this.append({
        kind: 'disclose', slot: req.slot, lane: req.lane, through_position: req.through_position,
        preimage: C.preimageAt(links, req.through_position).toString('hex'),
        opened: pv.opened,
      });
      for (const el of pv.opened) this.openedSeqs.add(el.seq);
      this.watermark.set(key, req.through_position);
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }

  // ---- reveal-all (§7.3.9): the entry lands BEFORE any value is returned ---
  async revealAll(scope: string) {
    return this.mutate(() => {
      this.requireLive();
      if (typeof scope !== 'string' || !scope.trim()) err('reveal-all scope is required');
      const built = this.append({ kind: 'reveal-all', scope });
      this.writePrivate(); this.writeLedger(); // if this throws, nothing is shown
      const values: any[] = [];
      for (const e of this.entries) {
        if (e.kind !== 'draw') continue;
        const links = this.links.get(`${e.slot}/${e.lane}`)!;
        values.push({ seq: e.seq, slot: e.slot, lane: e.lane, position: e.position,
          roll: C.rollFromPreimage(C.preimageAt(links, e.position)), ...this.priv!.values[e.seq] });
      }
      return { entry: built, values };
    });
  }

  // ---- phase 5 (§4.6) -------------------------------------------------------
  async finalReveal() {
    return this.mutate(() => {
      this.requireLive();
      if (this.finalRevealed) err('already revealed', 409);
      if (this.sessionOpen_) err('close the current session before final reveal');
      if (this.priv!.pending) err('complete the pending activation before final reveal');
      if (this.openAnnounce) err('resolve the open announce before final reveal');
      // One serialized mutation: no session, draw, or activation can slip
      // between the final disclosures and the secret reveal.
      const lanes = [...this.maxConcerned.keys()].sort()
        .filter((k) => (this.maxConcerned.get(k) ?? 0) > (this.watermark.get(k) ?? 0));
      for (const k of lanes) {
        const [slot, lane] = k.split('/');
        const through = this.maxConcerned.get(k)!;
        const pv = this.disclosePreview(slot, lane, through);
        const links = this.links.get(k)!;
        this.append({
          kind: 'disclose', slot, lane, through_position: through,
          preimage: C.preimageAt(links, through).toString('hex'), opened: pv.opened,
        });
        for (const el of pv.opened) this.openedSeqs.add(el.seq);
        this.watermark.set(k, through);
      }
      const labels = Object.entries(this.priv!.labels).sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([slot, l]) => ({ slot, display: l.display, role: l.role }));
      const built = this.append({ kind: 'final-reveal', secret: this.priv!.secret, labels });
      this.finalRevealed = true;
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }

  async close(reason: string) {
    return this.mutate(() => {
      this.requireLive();
      if (!this.finalRevealed) err('final-reveal is required before closing the ledger', 409);
      if (this.sessionOpen_) err('close the current session before closing the ledger');
      if (typeof reason !== 'string' || !reason.trim()) err('closing reason is required');
      const built = this.append({ kind: 'closed', reason });
      this.closed = true;
      this.writePrivate(); this.writeLedger();
      return built;
    });
  }

  // ---- publish (§4.3, §7.7) -------------------------------------------------
  async publish(): Promise<{ head: string; digest: string; mirror: string | null }> {
    return this.mutate(() => {
      this.requireLive();
      // Rehearsal publishes into its own publicDir so the ceremony's final
      // step, the session-close wizard, and the player verifier can all be
      // exercised for real (§7.8). What it must never do is reach the
      // players: a mirror command would push a throwaway campaign to the
      // audience, so its presence is a hard configuration error here rather
      // than something the GM must remember not to trigger.
      if (this.opts.rehearsal && this.opts.mirrorCommand) {
        err('rehearsal must not be configured with a git mirror: it would publish a throwaway campaign to the players', 409);
      }
      const from = this.priv!.last_published_seq + 1;
      const fresh = this.entries.slice(from);
      const draws = fresh.filter((e) => e.kind === 'draw');
      const sealedCount = draws.filter((e) => e.lane !== 'open').length;
      const digest = [
        // a stray rehearsal digest must announce itself: the chat message is
        // the one artifact that travels without its surrounding context
        ...(this.opts.rehearsal ? ['REHEARSAL — throwaway campaign, do not post to the players'] : []),
        `Session ${this.session} — ${draws.length} draws (${sealedCount} sealed, ${draws.length - sealedCount} open), `
        + `${fresh.filter((e) => e.kind === 'void').length} voids, ${fresh.filter((e) => e.kind === 'correction').length} corrections`,
        `head ${this.entries[this.entries.length - 1].hash}`,
      ].join('\n');
      // 0644: the published artifact is read by a separate web server (§6.6)
      atomicWrite(join(this.opts.publicDir, 'ledger.json'), this.ledgerText(), 0o644);
      this.priv!.last_published_seq = this.entries.length - 1;
      this.writePrivate();
      // §6.6: a configured command may push to an independent witness. We can
      // report command success, not prove where it pushed or whether the
      // remote resists rewrites. Failure never undoes the local publication.
      let mirror: string | null = null;
      if (this.opts.mirrorCommand) {
        try {
          execFileSync('/bin/sh', ['-c', this.opts.mirrorCommand],
            { cwd: this.opts.publicDir, timeout: 60_000, stdio: 'pipe' });
          mirror = 'ok';
        } catch (e: any) { mirror = `failed: ${e.message}`; }
      }
      return { head: this.entries[this.entries.length - 1].hash, digest, mirror };
    });
  }

  // ---- table state for the UI ----------------------------------------------
  tableState() {
    this.requireLive();
    const lanes: any = {};
    for (const [k, c] of this.cursor) lanes[k] = { drawn: c, remaining: this.transcript.chain_length - c, watermark: this.watermark.get(k) ?? 0 };
    for (const [id, st] of this.slots) {
      for (const lane of st.lanes) {
        const k = `${id}/${lane}`;
        if (!lanes[k]) lanes[k] = { drawn: 0, remaining: this.transcript.chain_length, watermark: 0 };
      }
    }
    const sheets: any = {};
    for (const e of this.entries) if (e.kind === 'sheet-update') sheets[e.slot] = { ...sheets[e.slot], ...e.modifiers };
    return {
      session: this.session, lanes, sheets, npc_sheets: this.priv!.npc_sheets,
      // enough for /table to rebuild the ANNOUNCED state after a reload or a
      // failed reveal: an announcement is public and can only be resolved by
      // a draw or a void, so the UI must never lose its way back to it
      open_announce: this.openAnnounce ? {
        ...this.openAnnounce,
        context: this.entries[this.openAnnounce.seq]?.context
          ?? this.priv!.values[this.openAnnounce.seq]?.context ?? null,
        initiator: this.entries[this.openAnnounce.seq]?.initiator ?? 'gm',
      } : null,
      registry: [...this.registry.values()],
      slots: [...this.slots.entries()].map(([id, st]) => ({
        id, active: st.active, retired: st.retired,
        role: st.role ?? this.priv!.labels[id]?.role ?? null,
        display: st.display ?? this.priv!.labels[id]?.display ?? null,
        lanes: [...st.lanes],
      })),
      next_deferred: this.deferredQueue[this.activatedCount] ?? null,
      ui_state: this.priv!.ui_state,
    };
  }
  async setUiState(state: unknown) {
    return this.mutate(() => { this.requireUnlocked(); this.priv!.ui_state = state; this.writePrivate(); });
  }
  ledgerJson(): any { return JSON.parse(this.ledgerText()); }

  /**
   * §7.6 /ledger histogram: rolls for DISCLOSED positions only — already
   * public data (any verifier can derive them), so criterion 9 is untouched.
   */
  disclosedStats() {
    this.requireLive();
    const perSlot: Record<string, number[]> = {};
    let undisclosed = 0;
    for (const e of this.entries) {
      if (e.kind !== 'draw') continue;
      if (e.position <= (this.watermark.get(`${e.slot}/${e.lane}`) ?? 0)) {
        (perSlot[e.slot] ??= []).push(this.rollAt(e));
      } else undisclosed++;
    }
    return { per_slot: perSlot, undisclosed };
  }

  /** §7.9 paced walkthrough data. Post-reveal only (criterion 9). */
  walkthrough() {
    this.requireLive();
    if (!this.finalRevealed) err('final reveal has not happened', 409);
    const N = this.transcript.chain_length;
    const out: any[] = [];
    for (const [id, st] of [...this.slots.entries()].sort()) {
      const draws = this.entries.filter((e) => e.kind === 'draw' && e.slot === id).map((e) => {
        const roll = this.rollAt(e);
        const vals = this.priv!.values[e.seq] ?? {};
        const dc = e.dc ?? vals.dc ?? this.dcLateValueFor(e.seq);
        const mod = e.modifier ?? vals.modifier;
        return {
          seq: e.seq, session: e.session, lane: e.lane, position: e.position,
          check_type: e.check_type, roll, dc, modifier: mod,
          context: e.context ?? vals.context ?? null,
          degree: dc !== undefined && mod !== undefined ? C.degreeOfSuccess(roll, mod, dc) : null,
          corrected: this.entries.some((c) => c.kind === 'correction' && c.target_seq === e.seq),
        };
      });
      const lanes = [...st.lanes].sort().map((lane) => {
        const links = this.links.get(`${id}/${lane}`)!;
        const used = this.cursor.get(`${id}/${lane}`) ?? 0;
        const sample: number[] = [];
        for (let k = used + 1; k <= Math.min(N, used + 40); k++) sample.push(C.rollFromPreimage(C.preimageAt(links, k)));
        return { lane, used, total: N, remainder_count: N - used, remainder_sample: sample };
      });
      const rolls = draws.map((d) => d.roll);
      out.push({
        id, display: st.display ?? this.priv!.labels[id]?.display ?? null,
        role: st.role ?? this.priv!.labels[id]?.role ?? null, retired: st.retired,
        draws, lanes, mean: rolls.length ? rolls.reduce((a, b) => a + b, 0) / rolls.length : null,
      });
    }
    return { slots: out, never_activated: this.deferredQueue.slice(this.activatedCount) };
  }

  // ---- internals ------------------------------------------------------------
  private requireUnlocked() { if (this.locked || !this.priv) err('locked', 423); }
  private requireLive() { this.requireUnlocked(); if (this.phase !== 'live') err('no genesis yet', 409); }

  private ts(): string {
    const t = new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return t >= this.lastTs ? t : this.lastTs;
  }

  private append(partial: Record<string, unknown>): any {
    if (this.closed) err('the ledger is closed', 409);
    if (this.finalRevealed && partial.kind !== 'closed') err('only closed may follow final-reveal', 409);
    // guard on the public ledger tail, not private state: the adjacency
    // invariant (inv 17) must hold even if a crash lost the pending record
    if (this.entries.at(-1)?.kind === 'activation-declare' && partial.kind !== 'activate') {
      err('the pending activation must complete before any other ledger entry', 409);
    }
    const seq = this.entries.length;
    const prev = seq === 0 ? ZERO64 : this.entries[seq - 1].hash;
    const entry: any = { seq, ts: this.ts(), session: partial.kind === 'genesis' ? 0 : this.session, ...partial, prev };
    entry.hash = entryHash(entry);
    this.lastTs = entry.ts;
    this.entries.push(entry);
    return entry;
  }

  /**
   * THE private→public projection (§6.3). Every ledger write goes through
   * this. Entries are built public-only, so this is defence in depth — the
   * assert turns any future mistake into a crash instead of a leak.
   */
  private static projectPublic(entries: any[]): any[] {
    return entries.map((e) => {
      const out: any = {};
      for (const [k, v] of Object.entries(e)) {
        if (k === 'link' || k.includes('salt')) continue;
        if (k === 'result' && e.kind !== 'out-of-band') continue;
        out[k] = v;
      }
      return out;
    });
  }
  static assertNoLeak(entries: any[]): void {
    for (const e of entries) {
      const visit = (value: unknown, path: string[], seen: Set<object>): void => {
        if (value === null || typeof value !== 'object') return;
        if (seen.has(value as object)) throw new Error(`LEAK: entry ${e.seq} contains a cycle`);
        seen.add(value as object);
        if (Array.isArray(value)) {
          value.forEach((v, i) => visit(v, [...path, String(i)], seen));
        } else {
          for (const [k, v] of Object.entries(value)) {
            // Slot/lane/type ids are object keys in these protocol maps, not
            // field names. An otherwise-valid lane called "salt-marsh" or a
            // check type called "result" must not trip the leak guard.
            const dataMapKey =
              (e.kind === 'genesis' && path[0] === 'tails'
                && (path.length === 1 || path.length === 2))
              || (e.kind === 'activate' && path.length === 1 && path[0] === 'tails')
              || (e.kind === 'sheet-update' && path.length === 1 && path[0] === 'modifiers');
            const rootOutOfBandResult = path.length === 0 && k === 'result' && e.kind === 'out-of-band';
            if (!dataMapKey
                && (k === 'link' || k.includes('salt') || (k === 'result' && !rootOutOfBandResult))) {
              throw new Error(`LEAK: entry ${e.seq} contains forbidden field ${[...path, k].join('.')}`);
            }
            visit(v, [...path, k], seen);
          }
        }
        seen.delete(value as object);
      };
      visit(e, [], new Set());
    }
  }

  private ledgerText(): string {
    // Check the source object, not just the projection. A future programming
    // mistake must stop publication rather than be silently redacted into an
    // entry whose hash no longer matches.
    Campaign.assertNoLeak(this.entries);
    const entries = Campaign.projectPublic(this.entries);
    Campaign.assertNoLeak(entries);
    return JSON.stringify({ format: LEDGER_FORMAT, head: this.entries[this.entries.length - 1].hash, entries }, null, 1);
  }

  private writeLedger(): void {
    atomicWrite(this.path('ledger.json'), this.ledgerText());
    rotateBackup(this.opts.stateDir, this.entries.length - 1);
    this.onChange?.();
  }
  private writePrivate(): void {
    if (!this.key || !this.kdfHeader || !this.priv) err('locked', 423);
    atomicWrite(this.path('private.enc'), encryptJson(this.priv, this.key, this.kdfHeader));
  }

  private deriveLane(slot: string, lane: string, A: Buffer | null): Buffer[] {
    const S = Buffer.from(this.priv!.secret, 'hex');
    const ikm = A ? C.ikmFor(S, this.E!, A) : C.ikmFor(S, this.E!);
    const links = C.chainLinks(C.laneRoot(ikm, slot, lane), this.transcript.chain_length);
    this.links.set(`${slot}/${lane}`, links);
    return links;
  }

  private rollAt(entry: any): number {
    const links = this.links.get(`${entry.slot}/${entry.lane}`)!;
    return C.rollFromPreimage(C.preimageAt(links, entry.position));
  }
  private reservationOf(announce: any): number {
    let n = 0;
    for (const e of this.entries) {
      if (e.seq >= announce.seq) break;
      if (e.kind === 'draw' && e.slot === announce.slot && e.lane === announce.lane) n++;
    }
    return n + 1;
  }
  private dcLateValueFor(drawSeq: number): number | undefined {
    const late = this.entries.find((e) => e.kind === 'dc-late' && e.target_seq === drawSeq);
    return late ? (late.dc ?? this.priv!.values[late.seq]?.dc) : undefined;
  }
  private playerSheetMod(slot: string, checkType: string): number | undefined {
    let v: number | undefined;
    for (const e of this.entries) {
      if (e.kind === 'sheet-update' && e.slot === slot && e.modifiers?.[checkType] !== undefined) v = e.modifiers[checkType];
    }
    return v;
  }

  /**
   * Rebuild all derived state from the ledger + secret. Called on unlock and
   * after genesis. Verifies the full chain and refuses to proceed on failure
   * (§6.3); also checks every published tail against a fresh derivation from
   * the secret, so a ledger/secret mismatch is caught immediately.
   */
  private load(): void {
    // prune private orphans from a crash between private and ledger writes
    const text = existsSync(this.path('ledger.json')) ? readFileSync(this.path('ledger.json'), 'utf8') : null;
    if (text === null) { this.entries = []; return; }
    const file = JSON.parse(text);
    const res = verifyLedger(file);
    if (res.verdict !== 'VERIFIED') {
      throw new Error(`ledger failed verification on load; refusing to start:\n${res.failures.join('\n')}`);
    }
    this.entries = file.entries;
    const nEntries = this.entries.length;
    for (const [id, s] of Object.entries(this.priv!.draw_ids)) if (s >= nEntries) delete this.priv!.draw_ids[id];
    for (const [id, ss] of Object.entries(this.priv!.batch_ids)) if (ss.some((s) => s >= nEntries)) delete this.priv!.batch_ids[id];
    for (const s of Object.keys(this.priv!.values)) if (Number(s) >= nEntries) delete this.priv!.values[s];
    // reconcile the pending activation with the ledger. Two crash windows
    // exist between writePrivate and writeLedger:
    //  - declare crashed: priv has pending, ledger lacks the declaration →
    //    drop pending (nothing public references it; re-declare freshly);
    //  - complete crashed: priv cleared pending (and stored the label), the
    //    ledger still ends with the declaration → rebuild pending so
    //    completion can run again against the same public declaration.
    {
      const pend = this.priv!.pending;
      if (pend) {
        const decl = this.entries[pend.declaration_seq];
        if (decl?.kind !== 'activation-declare' || decl?.declaration?.slot !== pend.slot) {
          this.priv!.pending = null;
        }
      }
      const tail = this.entries[nEntries - 1];
      if (!this.priv!.pending && tail?.kind === 'activation-declare') {
        const d = tail.declaration;
        const label = this.priv!.labels[d?.slot];
        if (!label) {
          throw new Error('activation state is inconsistent: pending declaration without label material; restore a matching backup pair');
        }
        this.priv!.pending = {
          slot: d.slot, display: label.display, role: label.role, lanes: d.lanes,
          nonce: d.nonce, beacon: d.beacon, declared_at: d.declared_at,
          declaration_seq: tail.seq,
        };
      }
    }

    const S = Buffer.from(this.priv!.secret, 'hex');
    this.transcript = this.entries[0].transcript;
    this.E = C.genesisEntropy(this.transcript);
    if (this.transcript.commitment !== C.commitmentOf(S)) throw new Error('secret does not match ledger commitment; refusing to start');
    this.registry.clear(); this.slots.clear(); this.links.clear();
    this.cursor.clear(); this.maxConcerned.clear(); this.watermark.clear(); this.openedSeqs.clear();
    this.deferredQueue = []; this.activatedCount = 0; this.openAnnounce = null;
    this.session = 0; this.finalRevealed = false; this.closed = false;
    this.lastTs = this.entries[nEntries - 1].ts;
    for (const t of this.transcript.check_types) this.registry.set(t.id, t);
    for (const s of this.transcript.slots) {
      if (s.status === 'active') {
        this.slots.set(s.id, { role: s.role, display: s.display, lanes: new Set(s.lanes), active: true, retired: false, A: null });
        for (const lane of s.lanes) this.deriveLane(s.id, lane, null);
      } else this.deferredQueue.push(s.id);
    }
    this.sessionOpen_ = false;
    for (const e of this.entries) {
      if (e.kind === 'session-open') { this.session = e.session; this.sessionOpen_ = true; }
      else if (e.kind === 'session-close') this.sessionOpen_ = false;
      else if (e.kind === 'draw') {
        const k = `${e.slot}/${e.lane}`;
        this.cursor.set(k, e.position);
        this.maxConcerned.set(k, Math.max(this.maxConcerned.get(k) ?? 0, e.position));
        if ('announce_seq' in e && this.openAnnounce?.seq === e.announce_seq) this.openAnnounce = null;
      } else if (e.kind === 'announce') {
        const k = `${e.slot}/${e.lane}`;
        this.maxConcerned.set(k, Math.max(this.maxConcerned.get(k) ?? 0, (this.cursor.get(k) ?? 0) + 1));
        this.openAnnounce = {
          seq: e.seq, slot: e.slot, lane: e.lane,
          checkType: e.check_type, initiator: e.initiator,
        };
      } else if (e.kind === 'void') {
        if (this.openAnnounce?.seq === e.announce_seq) this.openAnnounce = null;
      } else if (e.kind === 'activate') {
        const rec = e.activation_record;
        const A = C.sha256(canonicalBytes(rec));
        this.slots.set(rec.slot, { role: null, display: null, lanes: new Set(rec.lanes), active: true, retired: false, A });
        for (const lane of rec.lanes) this.deriveLane(rec.slot, lane, A);
        this.activatedCount += 1;
      } else if (e.kind === 'retire-slot') {
        this.slots.get(e.slot)!.retired = true;
      } else if (e.kind === 'disclose') {
        this.watermark.set(`${e.slot}/${e.lane}`, e.through_position);
        for (const el of e.opened) this.openedSeqs.add(el.seq);
      } else if (e.kind === 'final-reveal') this.finalRevealed = true;
      else if (e.kind === 'closed') this.closed = true;
    }
    // integrity: every published tail must recompute from the secret
    for (const e of this.entries) {
      if (e.kind === 'genesis') {
        for (const [slot, byLane] of Object.entries<any>(e.tails)) {
          for (const [lane, tail] of Object.entries<string>(byLane)) this.checkTail(slot, lane, tail);
        }
      } else if (e.kind === 'activate') {
        for (const [lane, tail] of Object.entries<string>(e.tails)) this.checkTail(e.activation_record.slot, lane, tail);
      } else if (e.kind === 'lane-add') this.checkTail(e.slot, e.lane, e.tail);
    }
  }
  private checkTail(slot: string, lane: string, tail: string): void {
    const links = this.links.get(`${slot}/${lane}`);
    if (!links || links[this.transcript.chain_length].toString('hex') !== tail) {
      throw new Error(`derived tail for ${slot}/${lane} does not match ledger; refusing to start`);
    }
  }
}

export function roundTime(b: BeaconRound): number {
  return b.genesis_time + (b.round - 1) * b.period;
}
