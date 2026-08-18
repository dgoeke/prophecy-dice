/**
 * Ledger verification — spec/protocol.md §3.3, all 26 invariants.
 *
 * Failure message strings are normative for the negative test vectors:
 * verify.py must produce byte-identical messages. Change them only together.
 *
 * Prefixes: "inv N:" for §3.3 invariants, "seal:" for §2.12 field-form
 * violations, "structure:" for malformed entries.
 */

import { canonicalBytes } from './canonical.ts';
import * as C from './crypto.ts';
import { entryHash, ZERO64, LEDGER_FORMAT } from './ledger.ts';
import { validProfileName } from './profile.ts';

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const validTimestamp = (s: unknown): s is string =>
  typeof s === 'string' && TS_RE.test(s)
  && Number.isFinite(Date.parse(s))
  && new Date(s).toISOString().replace('.000Z', 'Z') === s;
const validDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && Number.isFinite(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Well-known drand chains (§2.8): recognized hash ⇒ params must match. */
export const KNOWN_CHAINS: Record<string, { genesis_time: number; period: number }> = {
  'drand:8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce': { genesis_time: 1595431050, period: 30 },
  'drand:52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971': { genesis_time: 1692803367, period: 3 },
};

const REQUIRED_FIELDS: Record<string, string[]> = {
  'genesis': ['transcript', 'tails'],
  'session-open': [],
  'session-close': [],
  'announce': ['slot', 'lane', 'check_type', 'initiator'],
  'draw': ['slot', 'lane', 'position', 'check_type', 'initiator'],
  'void': ['slot', 'lane', 'announce_seq', 'reason'],
  'correction': ['target_seq', 'reason'],
  'dc-late': ['target_seq'],
  'out-of-band': ['check_type', 'result', 'reason'],
  'disclose': ['slot', 'lane', 'through_position', 'preimage', 'opened'],
  'sheet-update': ['slot', 'effective_from', 'modifiers'],
  'check-type': ['op', 'check_type'],
  'activation-declare': ['declaration'],
  'activate': ['activation_record', 'tails'],
  'lane-add': ['slot', 'lane', 'tail'],
  'retire-slot': ['slot', 'reason'],
  'note': ['text'],
  'reveal-all': ['scope'],
  'final-reveal': ['secret', 'labels'],
  'closed': ['reason'],
};

const ENTRY_FIELDS: Record<string, string[]> = {
  genesis: ['transcript', 'tails'],
  'session-open': [],
  'session-close': [],
  announce: ['slot', 'lane', 'check_type', 'initiator', 'context', 'context_commit', 'dc', 'dc_commit'],
  draw: [
    'slot', 'lane', 'position', 'check_type', 'initiator', 'modifier', 'mod_commit',
    'context', 'context_commit', 'dc', 'dc_commit', 'announce_seq', 'batch',
    'paired_with', 'pair_rule', 'gm_degree',
  ],
  void: ['slot', 'lane', 'announce_seq', 'reason'],
  correction: ['target_seq', 'reason', 'replacement_seq'],
  'dc-late': ['target_seq', 'dc', 'dc_commit'],
  'out-of-band': ['check_type', 'slot', 'result', 'reason'],
  disclose: ['slot', 'lane', 'through_position', 'preimage', 'opened'],
  'sheet-update': ['slot', 'effective_from', 'modifiers'],
  'check-type': ['op', 'check_type'],
  'activation-declare': ['declaration'],
  activate: ['activation_record', 'tails'],
  'lane-add': ['slot', 'lane', 'tail'],
  'retire-slot': ['slot', 'reason'],
  note: ['text'],
  'reveal-all': ['scope'],
  'final-reveal': ['secret', 'labels'],
  closed: ['reason'],
};
const COMMON_ENTRY_FIELDS = new Set(['seq', 'ts', 'session', 'kind', 'prev', 'hash']);

export interface VerifyResult {
  verdict: 'VERIFIED' | 'FAILED';
  state: 'sealed' | 'partially disclosed' | 'fully revealed';
  failures: string[];
  entries: number;
  /** seq → derived roll, for every draw covered by a valid disclosure. */
  rolls: Record<number, number>;
}

interface SlotState {
  role: string | null;
  lanes: Set<string> | null;
  active: boolean;
  retired: boolean;
  A: Buffer | null;
}

interface Carrier {
  seq: number;
  pos: number;
  commits: Record<string, string>; // field name → commitment hex
}

export function verifyLedger(file: any): VerifyResult {
  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);
  const rolls: Record<number, number> = {};

  if (!file || typeof file !== 'object' || !Array.isArray(file.entries)) {
    return { verdict: 'FAILED', state: 'sealed', failures: ['structure: not a ledger file'], entries: 0, rolls };
  }
  for (const k of Object.keys(file)) {
    if (!['format', 'head', 'entries'].includes(k)) fail(`structure: unexpected ledger field ${k}`);
  }
  if (file.format !== LEDGER_FORMAT) fail(`structure: format is ${file.format}, expected ${LEDGER_FORMAT}`);
  const entries: any[] = file.entries;

  // ---- pass 1: structural invariants 1–5 -----------------------------------
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i) fail(`inv 1: entry at index ${i} has seq ${e.seq}, expected ${i}`);
    if (i === 0) {
      if (e.kind !== 'genesis') fail(`inv 2: entry 0 kind is ${e.kind}, expected genesis`);
    } else if (e.kind === 'genesis') {
      fail(`inv 2: entry ${e.seq} is a second genesis`);
    }
    const expectedPrev = i === 0 ? ZERO64 : entries[i - 1].hash;
    if (e.prev !== expectedPrev) fail(`inv 3: seq ${e.seq} prev does not match hash of seq ${i - 1}`);
    try {
      if (entryHash(e) !== e.hash) fail(`inv 4: seq ${e.seq} hash does not recompute`);
    } catch {
      fail(`inv 4: seq ${e.seq} hash does not recompute`);
    }
    if (!validTimestamp(e.ts)) {
      fail(`structure: seq ${e.seq} bad ts`);
    }
    else if (i > 0 && typeof entries[i - 1].ts === 'string' && e.ts < entries[i - 1].ts) {
      fail(`inv 5: seq ${e.seq} ts decreases`);
    }
  }
  if (entries.length > 0 && file.head !== entries[entries.length - 1].hash) {
    fail('structure: head does not match last entry hash');
  }
  if (entries.length === 0) {
    fail('structure: empty ledger');
    return { verdict: 'FAILED', state: 'sealed', failures, entries: 0, rolls };
  }

  // ---- semantic state -------------------------------------------------------
  let transcript: any = null;
  let chainLen = 0;
  const registry = new Map<string, any>();
  const slots = new Map<string, SlotState>();
  const activationRecords = new Map<string, any>();
  const deferredQueue: string[] = [];
  const tails = new Map<string, string>(); // "slot/lane" → tail hex
  const cursor = new Map<string, number>();
  const maxConcerned = new Map<string, number>();
  const carriers = new Map<string, Carrier[]>();
  const drawsByLane = new Map<string, { seq: number; pos: number }[]>();
  const drawRecords = new Map<number, { slot: string; lane: string; position: number; session: number; batch: string | null; hasDc: boolean; checkType: string }>();
  const openAnnounces = new Map<number, {
    slot: string; lane: string; checkType: string; initiator: string; resolved: boolean;
  }>();
  const pairedRefs = new Set<string>();
  const dcLateTargets = new Set<number>();
  const corrected = new Set<number>();
  const batches = new Map<string, { seqs: number[]; session: number; checkType: string }>();
  const watermark = new Map<string, number>();
  const openedSeqs = new Set<number>();
  const discloses: { seq: number; slot: string; lane: string; through: number; preimage: string }[] = [];
  const pendingSheetUpdates: { seq: number; slot: string }[] = [];
  let activatedCount = 0;
  let sawDisclose = false;
  let finalReveal: any = null;
  let closedSeq: number | null = null;
  let currentSession = 0;
  let sessionOpen = false;
  let pendingActivation: { seq: number; declaration: any } | null = null;

  const laneKey = (slot: string, lane: string) => `${slot}/${lane}`;
  const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, Math.max(m.get(k) ?? 0, v));
  const exactKeys = (obj: any, expected: string[], where: string): boolean => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      fail(`structure: ${where} is not an object`);
      return false;
    }
    const actual = Object.keys(obj).sort();
    const wanted = [...expected].sort();
    if (actual.join(',') !== wanted.join(',')) {
      fail(`structure: ${where} has unexpected or missing fields`);
      return false;
    }
    return true;
  };
  const addCarrier = (k: string, c: Carrier) => {
    if (Object.keys(c.commits).length === 0) return;
    if (!carriers.has(k)) carriers.set(k, []);
    carriers.get(k)!.push(c);
  };
  const leakCheck = (e: any) => {
    for (const key of Object.keys(e)) {
      if (key === 'link' || key === 'result' || key.includes('salt')) {
        fail(`inv 20: seq ${e.seq} forbidden field ${key}`);
      }
    }
  };
  // inv-10 family, shared by draw and announce. Returns type or null.
  const checkTyping = (e: any, st: SlotState | undefined): any | null => {
    if (!st) { fail(`inv 18: seq ${e.seq} draw for inactive slot ${e.slot}`); return null; }
    if (st.retired) fail(`inv 15: seq ${e.seq} draw for retired slot ${e.slot}`);
    else if (!st.active) fail(`inv 18: seq ${e.seq} draw for inactive slot ${e.slot}`);
    const type = registry.get(e.check_type);
    if (!type) { fail(`inv 10: seq ${e.seq} unknown check_type ${e.check_type}`); return null; }
    if (e.lane !== type.lane) fail(`inv 10: seq ${e.seq} lane ${e.lane} does not match check_type ${e.check_type} lane ${type.lane}`);
    if (st.lanes && !st.lanes.has(e.lane)) fail(`inv 10: seq ${e.seq} slot ${e.slot} does not declare lane ${e.lane}`);
    // role is sealed for activated slots — rechecked after final reveal
    if (st.role !== null && !type.roles.includes(st.role)) {
      fail(`inv 10: seq ${e.seq} slot role ${st.role} not in roles of check_type ${e.check_type}`);
    }
    return type;
  };
  const sealForms = (e: any, type: any) => {
    if (type.seal_dc && 'dc' in e) fail(`seal: seq ${e.seq} field dc form contradicts registry`);
    if (!type.seal_dc && 'dc_commit' in e) fail(`seal: seq ${e.seq} field dc form contradicts registry`);
    if (type.seal_modifier && 'modifier' in e) fail(`seal: seq ${e.seq} field modifier form contradicts registry`);
    if (!type.seal_modifier && 'mod_commit' in e) fail(`seal: seq ${e.seq} field modifier form contradicts registry`);
    const sealedCtx = transcript?.context_privacy === 'sealed';
    if (sealedCtx && 'context' in e) fail(`seal: seq ${e.seq} field context form contradicts registry`);
    if (!sealedCtx && 'context_commit' in e) fail(`seal: seq ${e.seq} field context form contradicts registry`);
    for (const f of ['dc_commit', 'mod_commit', 'context_commit']) {
      if (f in e && (typeof e[f] !== 'string' || !HEX64_RE.test(e[f]))) {
        fail(`structure: seq ${e.seq} malformed ${f}`);
      }
    }
    if ('dc' in e && !Number.isInteger(e.dc)) fail(`structure: seq ${e.seq} malformed dc`);
    if ('modifier' in e && !Number.isInteger(e.modifier)) fail(`structure: seq ${e.seq} malformed modifier`);
    if ('context' in e && typeof e.context !== 'string') fail(`structure: seq ${e.seq} malformed context`);
  };

  // ---- pass 2: semantic walk ------------------------------------------------
  for (const e of entries) {
    const req = REQUIRED_FIELDS[e.kind];
    if (req === undefined) { fail(`structure: seq ${e.seq} unknown kind ${typeof e.kind === 'string' ? e.kind : '?'}`); continue; }
    const missing = req.filter((f) => !(f in e));
    if (missing.length > 0) { fail(`structure: seq ${e.seq} missing field ${missing[0]}`); continue; }
    const allowed = new Set([...COMMON_ENTRY_FIELDS, ...ENTRY_FIELDS[e.kind]]);
    for (const field of Object.keys(e)) {
      if (!allowed.has(field)) fail(`structure: seq ${e.seq} unexpected field ${field}`);
    }
    const expectedSession = e.kind === 'session-open' ? currentSession + 1 : currentSession;
    if (!Number.isInteger(e.session) || e.session !== expectedSession) {
      fail(`structure: seq ${e.seq} session ${e.session} does not match ledger state`);
    }
    if (finalReveal !== null && e.kind !== 'closed') {
      fail(`structure: seq ${e.seq} entry after final-reveal`);
    }
    if (pendingActivation !== null && e.kind !== 'activate') {
      fail(`structure: seq ${e.seq} must complete activation declared at seq ${pendingActivation.seq}`);
    }

    switch (e.kind) {
      case 'genesis': {
        if (e.seq !== 0) break; // second genesis already failed inv 2
        transcript = e.transcript;
        if (typeof transcript !== 'object' || transcript === null) {
          fail('structure: genesis transcript missing'); transcript = null; break;
        }
        exactKeys(transcript, [
          'version', 'commitment', 'chain_length', 'created_at', 'campaign',
          'context_privacy', 'disclosure_policy', 'check_types', 'slots', 'beacon',
          'configuration_commitment',
        ], 'genesis transcript');
        if (typeof transcript.commitment !== 'string' || !HEX64_RE.test(transcript.commitment)) {
          fail('inv 6: commitment is not 64 lowercase hex');
        }
        if (transcript.version !== 'wotw-column/1') fail('structure: unsupported transcript version');
        if (typeof transcript.campaign !== 'string' || !transcript.campaign
            || typeof transcript.disclosure_policy !== 'string' || !transcript.disclosure_policy
            || !['plain', 'sealed'].includes(transcript.context_privacy)
            || !validTimestamp(transcript.created_at) || transcript.beacon !== null) {
          fail('structure: malformed genesis transcript metadata');
        }
        {
          // recomputation canonicalizes GM-supplied structure and can throw
          // on malformed input; unhashable can never match
          let configOk = false;
          try { configOk = transcript.configuration_commitment === C.configurationCommitment(transcript); }
          catch { configOk = false; }
          if (!configOk) fail('structure: genesis configuration commitment mismatch');
        }
        chainLen = transcript.chain_length;
        if (!Number.isInteger(chainLen) || chainLen < 1 || chainLen > 1_000_000) {
          fail('structure: bad chain_length');
          chainLen = 0; // normalized: downstream arithmetic must not crash
        }
        if (!Array.isArray(transcript.check_types) || transcript.check_types.length === 0) {
          fail('structure: genesis check_types missing');
        }
        for (const t of (Array.isArray(transcript.check_types) ? transcript.check_types : [])) {
          const fieldsOk = exactKeys(t,
            ['id', 'label', 'lane', 'roles', 'seal_dc', 'seal_modifier', 'ritual'],
            `genesis check_type ${t?.id ?? ''}`);
          if (!fieldsOk || typeof t.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(t.id) || registry.has(t.id)
              || typeof t.label !== 'string' || !C.LANE_NAME_RE.test(t.lane)
              || !Array.isArray(t.roles) || t.roles.length === 0
              || t.roles.some((r: unknown) => !['player', 'npc', 'world'].includes(String(r)))
              || typeof t.seal_dc !== 'boolean' || typeof t.seal_modifier !== 'boolean'
              || typeof t.ritual !== 'boolean') {
            fail(`structure: malformed genesis check_type ${typeof t?.id === 'string' ? t.id : ''}`);
          } else registry.set(t.id, t);
        }
        if (!Array.isArray(transcript.slots) || transcript.slots.length === 0) {
          fail('structure: genesis slots missing');
        }
        // normalize before iterating: a non-array survives the check above,
        // and downstream code must see the same shape in every implementation
        const transcriptSlots: any[] = Array.isArray(transcript.slots) ? transcript.slots : [];
        for (let si = 0; si < transcriptSlots.length; si++) {
          const s = transcriptSlots[si];
          const expectedId = `slot-${String(si + 1).padStart(2, '0')}`;
          if (!s || s.id !== expectedId || !['active', 'deferred'].includes(s.status)) {
            fail(`structure: genesis slot ${si} malformed or out of order`);
            continue;
          }
          if (s.status === 'active') {
            const fieldsOk = exactKeys(s, ['id', 'display', 'role', 'status', 'lanes', 'nonce'],
              `genesis active slot ${s.id}`);
            if (!fieldsOk || !['player', 'npc', 'world'].includes(s.role) || typeof s.display !== 'string'
                || typeof s.nonce !== 'string' || !s.nonce
                || !Array.isArray(s.lanes) || s.lanes.length === 0
                || new Set(s.lanes).size !== s.lanes.length
                || s.lanes.some((lane: unknown) => !C.LANE_NAME_RE.test(String(lane)))) {
              fail(`structure: genesis active slot ${s.id} malformed`);
              continue;
            }
            slots.set(s.id, { role: s.role, lanes: new Set(s.lanes), active: true, retired: false, A: null });
            for (const lane of s.lanes) {
              const tail = e.tails?.[s.id]?.[lane];
              if (typeof tail !== 'string' || !HEX64_RE.test(tail)) {
                fail(`structure: genesis missing tail for ${s.id}/${lane}`);
              } else tails.set(laneKey(s.id, lane), tail);
            }
          } else {
            const fieldsOk = exactKeys(s, ['id', 'display', 'role', 'status', 'lanes', 'nonce'],
              `genesis deferred slot ${s.id}`);
            if (!fieldsOk || s.role !== null || s.display !== null || s.lanes !== null || s.nonce !== null) {
              fail(`structure: genesis deferred slot ${s.id} is not empty`);
            }
            slots.set(s.id, { role: null, lanes: null, active: false, retired: false, A: null });
            deferredQueue.push(s.id);
          }
        }
        const activeSlots = transcriptSlots.filter((s: any) => s?.status === 'active');
        const tailSlots = Object.keys(e.tails ?? {}).sort();
        if (tailSlots.join(',') !== activeSlots.map((s: any) => s.id).sort().join(',')) {
          fail('structure: genesis tails do not match active slots');
        }
        for (const s of activeSlots) {
          const laneKeys = Object.keys(e.tails?.[s.id] ?? {}).sort();
          if (!Array.isArray(s.lanes) || laneKeys.join(',') !== [...s.lanes].sort().join(',')) {
            fail(`structure: genesis tails do not match lanes of ${s.id}`);
          }
        }
        try { C.genesisEntropy(transcript); } catch { fail('structure: genesis player entropy missing'); }
        break;
      }

      case 'session-open':
        if (sessionOpen) fail(`structure: seq ${e.seq} session-open while a session is open`);
        currentSession = e.session;
        sessionOpen = true;
        break;
      case 'session-close':
        if (!sessionOpen) fail(`structure: seq ${e.seq} session-close while no session is open`);
        sessionOpen = false;
        break;
      case 'note':
        if (typeof e.text !== 'string' || !e.text.trim()) fail(`structure: seq ${e.seq} malformed note`);
        break;
      case 'reveal-all':
        if (typeof e.scope !== 'string' || !e.scope.trim()) fail(`structure: seq ${e.seq} malformed reveal-all`);
        break;

      case 'sheet-update': {
        const st = slots.get(e.slot);
        if (!st || !st.active || st.retired) {
          fail(`structure: seq ${e.seq} sheet-update for non-player slot ${e.slot}`);
        } else if (st.role === null) {
          pendingSheetUpdates.push({ seq: e.seq, slot: e.slot });
        } else if (st.role !== 'player') {
          fail(`structure: seq ${e.seq} sheet-update for non-player slot ${e.slot}`);
        }
        if (!validDate(e.effective_from)
            || !e.modifiers || typeof e.modifiers !== 'object' || Array.isArray(e.modifiers)
            || Object.entries(e.modifiers).some(([name, v]) => !validProfileName(name) || !Number.isInteger(v))) {
          fail(`structure: seq ${e.seq} malformed sheet-update`);
        }
        break;
      }

      case 'check-type': {
        fail(`structure: seq ${e.seq} check-type changes are not supported`);
        break;
      }

      case 'announce': {
        if (!sessionOpen) fail(`structure: seq ${e.seq} announce outside an open session`);
        if (e.initiator !== 'gm' && e.initiator !== 'player') {
          fail(`structure: seq ${e.seq} bad initiator`);
        }
        leakCheck(e);
        const st = slots.get(e.slot);
        const type = checkTyping(e, st);
        if (type) {
          sealForms(e, type);
          if (!type.ritual) fail(`structure: seq ${e.seq} announce for non-ritual check_type ${e.check_type}`);
        }
        const contextField = transcript?.context_privacy === 'sealed' ? 'context_commit' : 'context';
        if (!(contextField in e)) fail(`structure: seq ${e.seq} announce missing ${contextField}`);
        if ([...openAnnounces.values()].some((a) => !a.resolved)) {
          fail(`structure: seq ${e.seq} announce while another announce is unresolved`);
        }
        const k = laneKey(e.slot, e.lane);
        const reservation = (cursor.get(k) ?? 0) + 1;
        if (reservation > chainLen) fail(`structure: seq ${e.seq} reservation exceeds chain_length`);
        bump(maxConcerned, k, reservation);
        openAnnounces.set(e.seq, {
          slot: e.slot, lane: e.lane, checkType: e.check_type,
          initiator: e.initiator, resolved: false,
        });
        const commits: Record<string, string> = {};
        if (typeof e.context_commit === 'string') commits.context = e.context_commit;
        if (typeof e.dc_commit === 'string') commits.dc = e.dc_commit;
        addCarrier(k, { seq: e.seq, pos: reservation, commits });
        break;
      }

      case 'void': {
        if (!sessionOpen) fail(`structure: seq ${e.seq} void outside an open session`);
        if (typeof e.reason !== 'string' || !e.reason.trim()) fail(`structure: seq ${e.seq} malformed void`);
        const a = openAnnounces.get(e.announce_seq);
        if (!a || a.resolved || a.slot !== e.slot || a.lane !== e.lane) {
          fail(`inv 8: seq ${e.seq} announce_seq ${e.announce_seq} does not reference an open announce of ${e.slot}/${e.lane}`);
        } else a.resolved = true;
        break;
      }

      case 'draw': {
        if (!sessionOpen) fail(`structure: seq ${e.seq} draw outside an open session`);
        if (e.initiator !== 'gm' && e.initiator !== 'player') {
          fail(`structure: seq ${e.seq} bad initiator`);
        }
        leakCheck(e);
        const st = slots.get(e.slot);
        const type = checkTyping(e, st);
        if (type) {
          sealForms(e, type);
          if (type.ritual && !Number.isInteger(e.announce_seq)) {
            fail(`structure: seq ${e.seq} ritual draw has no announce_seq`);
          }
          const modField = type.seal_modifier ? 'mod_commit' : 'modifier';
          if (!(modField in e)) fail(`structure: seq ${e.seq} draw missing ${modField}`);
        }
        if ('announce_seq' in e && !Number.isInteger(e.announce_seq)) {
          fail(`structure: seq ${e.seq} bad announce_seq`);
        }
        if ('batch' in e && (typeof e.batch !== 'string' || !e.batch)) {
          fail(`structure: seq ${e.seq} bad batch`);
        }
        if ('paired_with' in e && !Number.isInteger(e.paired_with)) {
          fail(`structure: seq ${e.seq} bad paired_with`);
        }
        if (('paired_with' in e) !== ('pair_rule' in e)) {
          fail(`structure: seq ${e.seq} paired_with and pair_rule must appear together`);
        }
        if ('gm_degree' in e && (!Number.isInteger(e.gm_degree) || e.gm_degree < 0 || e.gm_degree > 3)) {
          fail(`structure: seq ${e.seq} bad gm_degree`);
        }
        const k = laneKey(e.slot, e.lane);
        const want = (cursor.get(k) ?? 0) + 1;
        if (!Number.isInteger(e.position) || e.position < 1 || e.position > chainLen) {
          fail(`structure: seq ${e.seq} position outside chain_length`);
        }
        if (e.position !== want) fail(`inv 7: seq ${e.seq} ${e.slot}/${e.lane} position ${e.position}, expected ${want}`);
        cursor.set(k, e.position);
        bump(maxConcerned, k, e.position);
        if (!drawsByLane.has(k)) drawsByLane.set(k, []);
        drawsByLane.get(k)!.push({ seq: e.seq, pos: e.position });
        drawRecords.set(e.seq, {
          slot: e.slot, lane: e.lane, position: e.position, session: e.session,
          batch: e.batch ?? null, hasDc: 'dc' in e || 'dc_commit' in e, checkType: e.check_type,
        });
        if ('announce_seq' in e) {
          const a = openAnnounces.get(e.announce_seq);
          if (!a || a.resolved || a.slot !== e.slot || a.lane !== e.lane
              || a.checkType !== e.check_type || a.initiator !== e.initiator) {
            fail(`inv 8: seq ${e.seq} announce_seq ${e.announce_seq} does not reference an open announce of ${e.slot}/${e.lane}/${e.check_type}/${e.initiator}`);
          } else a.resolved = true;
        }
        if ('batch' in e) {
          if (!batches.has(e.batch)) batches.set(e.batch, { seqs: [], session: e.session, checkType: e.check_type });
          const b = batches.get(e.batch)!;
          b.seqs.push(e.seq);
          if (b.session !== e.session || b.checkType !== e.check_type) {
            fail(`inv 13: batch ${e.batch} not contiguous or mixed session/check_type`);
          }
        }
        if ('paired_with' in e) {
          const refKey = `${k}#${e.paired_with}`;
          const partner = (drawsByLane.get(k) ?? []).find((d) => d.pos === e.paired_with && d.seq < e.seq);
          const pRec = partner ? drawRecords.get(partner.seq) : undefined;
          const sameGroup = pRec && (pRec.session === e.session || (pRec.batch !== null && pRec.batch === (e.batch ?? null)));
          if (!partner || !sameGroup || pairedRefs.has(refKey)) {
            fail(`inv 11: seq ${e.seq} invalid paired_with ${e.paired_with}`);
          } else {
            pairedRefs.add(refKey);
            pairedRefs.add(`${k}#${e.position}`);
          }
          if (e.pair_rule !== 'fortune' && e.pair_rule !== 'misfortune') {
            fail(`structure: seq ${e.seq} pair_rule ${e.pair_rule}`);
          }
        }
        const commits: Record<string, string> = {};
        if (typeof e.dc_commit === 'string') commits.dc = e.dc_commit;
        if (typeof e.mod_commit === 'string') commits.modifier = e.mod_commit;
        if (typeof e.context_commit === 'string') commits.context = e.context_commit;
        addCarrier(k, { seq: e.seq, pos: e.position, commits });
        break;
      }

      case 'correction': {
        if (typeof e.reason !== 'string' || !e.reason.trim()) {
          fail(`structure: seq ${e.seq} malformed correction`);
        }
        const t = drawRecords.get(e.target_seq);
        if (!t || e.target_seq >= e.seq || corrected.has(e.target_seq)) {
          fail(`inv 14: seq ${e.seq} invalid correction target ${e.target_seq}`);
        } else corrected.add(e.target_seq);
        if ('replacement_seq' in e && (!drawRecords.has(e.replacement_seq)
            || e.replacement_seq === e.target_seq || e.replacement_seq >= e.seq)) {
          fail(`inv 14: seq ${e.seq} invalid correction target ${e.target_seq}`);
        }
        break;
      }

      case 'dc-late': {
        if (!sessionOpen) fail(`structure: seq ${e.seq} dc-late outside an open session`);
        const t = drawRecords.get(e.target_seq);
        if (!t || t.session !== e.session || t.hasDc || dcLateTargets.has(e.target_seq)) {
          fail(`inv 12: seq ${e.seq} invalid dc-late target ${e.target_seq}`);
          break;
        }
        dcLateTargets.add(e.target_seq);
        const type = registry.get(t.checkType);
        if (type) sealForms(e, type);
        if (typeof e.dc_commit === 'string') {
          addCarrier(laneKey(t.slot, t.lane), { seq: e.seq, pos: t.position, commits: { dc: e.dc_commit } });
        } else if (!Number.isInteger(e.dc)) {
          fail(`structure: seq ${e.seq} dc-late carries neither dc nor dc_commit`);
        }
        break;
      }

      case 'out-of-band': {
        if (!registry.has(e.check_type)) fail(`inv 10: seq ${e.seq} unknown check_type ${e.check_type}`);
        if ('slot' in e && (typeof e.slot !== 'string' || !slots.has(e.slot))) {
          fail(`structure: seq ${e.seq} malformed out-of-band`);
        }
        if (!Number.isInteger(e.result) || e.result < 1 || e.result > 20
            || typeof e.reason !== 'string' || !e.reason) {
          fail(`structure: seq ${e.seq} malformed out-of-band`);
        }
        for (const key of Object.keys(e)) {
          if (key.endsWith('_commit')) fail(`inv 20: seq ${e.seq} forbidden field ${key}`);
        }
        break;
      }

      case 'activation-declare': {
        const d = e.declaration;
        const fieldsOk = exactKeys(d,
          ['version', 'slot', 'lanes', 'label_commit', 'nonce', 'declared_at', 'beacon'],
          `seq ${e.seq} activation declaration`);
        const beaconFieldsOk = d?.beacon && exactKeys(d.beacon,
          ['chain', 'round', 'genesis_time', 'period'], `seq ${e.seq} activation beacon`);
        if (!fieldsOk || !beaconFieldsOk || d.version !== 'wotw-column/1'
            || d.slot !== deferredQueue[activatedCount]
            || !Array.isArray(d.lanes) || d.lanes.length === 0
            || new Set(d.lanes).size !== d.lanes.length
            || d.lanes.some((lane: unknown) => !C.LANE_NAME_RE.test(String(lane)))
            || typeof d.nonce !== 'string' || !d.nonce
            || typeof d.label_commit !== 'string' || !HEX64_RE.test(d.label_commit)
            || !d.beacon || typeof d.beacon.chain !== 'string'
            || !Number.isInteger(d.beacon.round) || d.beacon.round < 1
            || !Number.isInteger(d.beacon.genesis_time) || d.beacon.genesis_time < 0
            || !Number.isInteger(d.beacon.period) || d.beacon.period < 1
            || !validTimestamp(d.declared_at)) {
          fail(`structure: seq ${e.seq} malformed activation declaration`);
        }
        pendingActivation = { seq: e.seq, declaration: d };
        break;
      }

      case 'activate': {
        if (pendingActivation === null) {
          fail(`structure: seq ${e.seq} activate has no preceding activation-declare`);
        }
        const rec = e.activation_record;
        if (typeof rec !== 'object' || rec === null || typeof rec.slot !== 'string') {
          fail(`structure: seq ${e.seq} malformed activation_record`); break;
        }
        exactKeys(rec, ['version', 'slot', 'lanes', 'label_commit', 'nonce', 'declared_at', 'beacon'],
          `seq ${e.seq} activation_record`);
        exactKeys(rec.beacon, ['chain', 'round', 'genesis_time', 'period', 'randomness'],
          `seq ${e.seq} activation beacon`);
        const expected = deferredQueue[activatedCount];
        if (rec.slot !== expected) {
          fail(`inv 16: seq ${e.seq} activation targets ${rec.slot}, expected ${expected}`);
        }
        activatedCount++;
        if (pendingActivation !== null) {
          let declaredMatches = false;
          try {
            const { randomness: _randomness, ...beaconWithoutRandomness } = rec.beacon ?? {};
            const completedDeclaration = { ...rec, beacon: beaconWithoutRandomness };
            declaredMatches =
              canonicalBytes(completedDeclaration).equals(canonicalBytes(pendingActivation.declaration));
          } catch { declaredMatches = false; }
          if (!declaredMatches) {
            fail(`inv 17: seq ${e.seq} activation_record differs from declaration at seq ${pendingActivation.seq}`);
          }
        }
        const b = rec.beacon;
        if (!b || !Number.isInteger(b.genesis_time) || b.genesis_time < 0
            || !Number.isInteger(b.period) || b.period < 1) {
          fail(`inv 17: seq ${e.seq} beacon missing genesis_time/period`);
        } else {
          if (!Number.isInteger(b.round) || b.round < 1 || typeof b.chain !== 'string'
              || typeof b.randomness !== 'string' || !HEX64_RE.test(b.randomness)) {
            fail(`inv 17: seq ${e.seq} malformed beacon round/randomness`);
          }
          const known = KNOWN_CHAINS[b.chain];
          if (known && (known.genesis_time !== b.genesis_time || known.period !== b.period)) {
            fail(`inv 17: seq ${e.seq} beacon parameters do not match known chain`);
          }
          const declared = Date.parse(rec.declared_at) / 1000;
          if (!Number.isFinite(declared)) fail(`structure: seq ${e.seq} bad declared_at`);
          else {
            const delta = b.genesis_time + (b.round - 1) * b.period - declared;
            if (delta < 600) fail(`inv 17: seq ${e.seq} beacon round publishes ${delta}s after declared_at, need >= 600`);
          }
        }
        const st = slots.get(rec.slot);
        if (st && !st.active) {
          if (!Array.isArray(rec.lanes) || rec.lanes.length === 0
              || new Set(rec.lanes).size !== rec.lanes.length
              || rec.lanes.some((lane: unknown) => !C.LANE_NAME_RE.test(String(lane)))) {
            fail(`structure: seq ${e.seq} malformed activation lanes`);
          }
          const tailKeys = Object.keys(e.tails ?? {}).sort();
          const laneKeys = [...(rec.lanes ?? [])].sort();
          if (tailKeys.join(',') !== laneKeys.join(',')) {
            fail(`structure: seq ${e.seq} activation tails do not match declared lanes`);
          }
          st.active = true;
          st.lanes = new Set(rec.lanes);
          try { st.A = C.sha256(canonicalBytes(rec)); } catch { fail(`structure: seq ${e.seq} unhashable activation_record`); }
          activationRecords.set(rec.slot, rec);
          for (const lane of rec.lanes ?? []) {
            const tail = e.tails?.[lane];
            if (typeof tail !== 'string' || !HEX64_RE.test(tail)) {
              fail(`structure: seq ${e.seq} missing tail for lane ${lane}`);
            } else tails.set(laneKey(rec.slot, lane), tail);
          }
        }
        pendingActivation = null;
        break;
      }

      case 'lane-add': {
        fail(`structure: seq ${e.seq} lane-add is not supported`);
        break;
      }

      case 'retire-slot': {
        const st = slots.get(e.slot);
        if (!st || !st.active || st.retired || typeof e.reason !== 'string' || !e.reason.trim()) {
          fail(`structure: seq ${e.seq} retire of non-active slot ${e.slot}`);
        }
        else st.retired = true;
        break;
      }

      case 'disclose': {
        sawDisclose = true;
        const k = laneKey(e.slot, e.lane);
        const tail = tails.get(k);
        if (!tail) { fail(`structure: seq ${e.seq} disclose for unknown lane ${k}`); break; }
        const t = e.through_position;
        if (!Number.isInteger(t) || t < 1 || t > chainLen) { fail(`structure: seq ${e.seq} bad through_position`); break; }
        const w = watermark.get(k) ?? 0;
        if (t <= w) fail(`inv 22: seq ${e.seq} through_position ${t} must exceed watermark ${w}`);
        const mc = maxConcerned.get(k) ?? 0;
        if (t > mc) fail(`inv 22: seq ${e.seq} through_position ${t} exceeds highest concerned position ${mc}`);
        // one forward walk serves the tail check (inv 21), every commitment
        // recomputation (inv 24), and every derived roll (inv 23) — O(t),
        // not O(t²) per disclosure
        let chainOk = false;
        let walk: Buffer[] | null = null;
        if (typeof e.preimage === 'string' && HEX64_RE.test(e.preimage)) {
          walk = new Array(t + 1);
          walk[0] = Buffer.from(e.preimage, 'hex');
          for (let i = 1; i <= t; i++) walk[i] = C.chainStep(walk[i - 1]);
          chainOk = walk[t].toString('hex') === tail;
        }
        if (!chainOk) fail(`inv 21: seq ${e.seq} preimage does not reach tail of ${e.slot}/${e.lane}`);
        // inv 24: coverage and commitment recomputation
        const opened: any[] = Array.isArray(e.opened) ? e.opened : [];
        if (!Array.isArray(e.opened)) fail(`structure: seq ${e.seq} opened is not an array`);
        const covered = new Map<number, Carrier>();
        for (const c of carriers.get(k) ?? []) {
          if (c.seq < e.seq && c.pos <= t && !openedSeqs.has(c.seq)) covered.set(c.seq, c);
        }
        const pAt = (pos: number): Buffer => walk![t - pos];
        let lastSeq = -1;
        for (const el of opened) {
          if (!Number.isInteger(el?.seq)) { fail(`structure: seq ${e.seq} malformed opened element`); continue; }
          if (el.seq <= lastSeq) fail(`inv 24: seq ${e.seq} opened not sorted ascending`);
          lastSeq = el.seq;
          const c = covered.get(el.seq);
          if (!c) { fail(`inv 24: seq ${e.seq} opened has unexpected seq ${el.seq}`); continue; }
          covered.delete(el.seq);
          openedSeqs.add(el.seq);
          const fields = Object.keys(el).filter((f) => f !== 'seq').sort();
          const expectFields = Object.keys(c.commits).sort();
          if (fields.join(',') !== expectFields.join(',')) {
            fail(`inv 24: seq ${e.seq} opened ${el.seq} fields do not match commitments`);
            continue;
          }
          if (chainOk && walk) {
            const p = pAt(c.pos);
            for (const f of expectFields) {
              let ok = false;
              try {
                if (f === 'dc') ok = C.dcCommit(p, c.seq, el.dc) === c.commits.dc;
                else if (f === 'modifier') ok = C.modCommit(p, c.seq, el.modifier) === c.commits.modifier;
                else if (f === 'context') ok = C.contextCommit(p, c.seq, el.context) === c.commits.context;
              } catch { ok = false; }
              if (!ok) fail(`inv 24: seq ${e.seq} opened ${el.seq} ${f} commitment mismatch`);
            }
          }
        }
        for (const seqLeft of covered.keys()) {
          fail(`inv 24: seq ${e.seq} opened must include seq ${seqLeft}`);
        }
        // inv 23: derive rolls for newly covered draws
        if (chainOk && walk) {
          for (const d of drawsByLane.get(k) ?? []) {
            if (d.pos > w && d.pos <= t) rolls[d.seq] = C.rollFromPreimage(pAt(d.pos));
          }
        }
        watermark.set(k, Math.max(w, t));
        discloses.push({ seq: e.seq, slot: e.slot, lane: e.lane, through: t, preimage: e.preimage });
        break;
      }

      case 'final-reveal': {
        if (sessionOpen) fail(`structure: seq ${e.seq} final-reveal while a session is open`);
        if (finalReveal !== null) fail(`structure: seq ${e.seq} second final-reveal`);
        else finalReveal = e;
        break;
      }

      case 'closed': {
        if (typeof e.reason !== 'string' || !e.reason.trim()) fail(`structure: seq ${e.seq} malformed closed`);
        if (closedSeq !== null) fail(`structure: seq ${e.seq} second closed`);
        closedSeq = e.seq;
        break;
      }
    }
  }

  // ---- end-of-ledger checks -------------------------------------------------
  const lastSeq = entries[entries.length - 1].seq;
  for (const [s, a] of openAnnounces) {
    if (!a.resolved && s !== lastSeq) fail(`inv 9: announce at seq ${s} unresolved`);
  }
  for (const [id, b] of batches) {
    if (!b.seqs.every((s, i) => i === 0 || s === b.seqs[i - 1] + 1)) {
      fail(`inv 13: batch ${id} not contiguous or mixed session/check_type`);
    }
  }
  if (closedSeq !== null && closedSeq !== lastSeq) fail('inv 26: closed is not the last entry');
  if (closedSeq !== null && finalReveal === null) fail('inv 26: closed requires final-reveal');
  if (closedSeq !== null && sessionOpen) fail('inv 26: closed while a session is open');

  // ---- inv 25: final reveal -------------------------------------------------
  if (finalReveal !== null && transcript !== null) {
    const fr = finalReveal;
    let secretOk = false;
    let S: Buffer | null = null;
    if (typeof fr.secret === 'string' && HEX64_RE.test(fr.secret)) {
      S = Buffer.from(fr.secret, 'hex');
      secretOk = C.sha256(S).toString('hex') === transcript.commitment;
    }
    if (!secretOk) fail('inv 25: secret does not match commitment');

    // labels must cover sealed activations exactly, ascending by slot
    const labels: any[] = Array.isArray(fr.labels) ? fr.labels : [];
    if (!Array.isArray(fr.labels)) fail('inv 25: labels do not cover activations exactly');
    const labelSlots = labels.map((l) => l?.slot);
    const activatedSlots = [...activationRecords.keys()].sort();
    const sortedOk = labelSlots.every((s, i) => i === 0 || s > labelSlots[i - 1]);
    if (!sortedOk || labelSlots.slice().sort().join(',') !== activatedSlots.join(',')) {
      fail('inv 25: labels do not cover activations exactly');
    }

    if (secretOk && S) {
      let E: Buffer | null = null;
      try { E = C.genesisEntropy(transcript); } catch { /* already reported */ }
      for (const l of labels) {
        if (!l || typeof l !== 'object'
            || Object.keys(l).sort().join(',') !== ['display', 'role', 'slot'].sort().join(',')) {
          fail(`inv 25: label for ${l?.slot ?? ''} does not recompute`);
          continue;
        }
        const rec = activationRecords.get(l?.slot);
        if (!rec) continue;
        if (!E) continue;
        const salt = C.labelSalt(S, E, l.slot);
        let ok = false;
        try {
          ok = typeof l.display === 'string' && l.display.length > 0
            && ['player', 'npc', 'world'].includes(l.role)
            && C.labelCommit(salt, l.display, l.role) === rec.label_commit;
        } catch { ok = false; }
        if (!ok) fail(`inv 25: label for ${l.slot} does not recompute`);
        else {
          // role now known: recheck inv 10 for this slot's draws
          const st = slots.get(l.slot);
          if (st) st.role = l.role;
          for (const [seq, d] of drawRecords) {
            if (d.slot !== l.slot) continue;
            const type = registry.get(d.checkType);
            if (type && !type.roles.includes(l.role)) {
              fail(`inv 10: seq ${seq} slot role ${l.role} not in roles of check_type ${d.checkType}`);
            }
          }
        }
      }
      for (const p of pendingSheetUpdates) {
        if (slots.get(p.slot)?.role !== 'player') {
          fail(`structure: seq ${p.seq} sheet-update for non-player slot ${p.slot}`);
        }
      }
      // every published tail and every disclosed preimage recomputes from S
      for (const [k, tailHex] of tails) {
        const [slot, lane] = k.split('/');
        const st = slots.get(slot);
        if (!E) continue;
        const ikm = st?.A ? C.ikmFor(S, E, st.A) : C.ikmFor(S, E);
        const links = C.chainLinks(C.laneRoot(ikm, slot, lane), chainLen);
        if (links[chainLen].toString('hex') !== tailHex) {
          fail(`inv 25: tail of ${slot}/${lane} does not recompute`);
          continue;
        }
        for (const d of discloses) {
          if (d.slot !== slot || d.lane !== lane) continue;
          if (links[chainLen - d.through].toString('hex') !== d.preimage) {
            fail(`inv 25: disclosed preimage mismatch for ${slot}/${lane}`);
          }
        }
        for (const [seq, d] of drawRecords) {
          if (d.slot === slot && d.lane === lane && Number.isInteger(d.position)
              && d.position >= 1 && d.position <= chainLen) {
            rolls[seq] = C.rollFromPreimage(C.preimageAt(links, d.position));
          }
        }
      }
    }
  }

  const state: VerifyResult['state'] =
    finalReveal !== null ? 'fully revealed' : sawDisclose ? 'partially disclosed' : 'sealed';
  return {
    verdict: failures.length > 0 ? 'FAILED' : 'VERIFIED',
    state, failures, entries: entries.length, rolls,
  };
}
