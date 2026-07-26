/**
 * Builds the §9.1 item-10 ledger: a complete 80-entry campaign against the
 * toy ceremony, exercising every entry kind — and the item-11 negative
 * cases: 12 mutations, each with the exact failure message both verifiers
 * must produce.
 */

import { canonicalBytes } from '../../gm/core/canonical.ts';
import * as C from '../../gm/core/crypto.ts';
import { entryHash, ZERO64 } from '../../gm/core/ledger.ts';
import { S, E, N, transcript, GENESIS_LANES, genesisChains } from './toy.ts';

const BASE_EPOCH = Date.parse('2026-08-14T20:00:00Z') / 1000;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

interface SealedValues { lane: string; pos: number; dc?: number; modifier?: number; context?: string }

class Builder {
  entries: any[] = [];
  chains = new Map<string, Buffer[]>();
  cursor = new Map<string, number>();
  maxConcerned = new Map<string, number>();
  watermark = new Map<string, number>();
  values = new Map<number, SealedValues>(); // committing seq → sealed values
  openedSeqs = new Set<number>();
  expectedRolls: { seq: number; roll: number }[] = [];
  session = 0;
  slotA = new Map<string, Buffer>(); // activation A per slot
  private prevHash = ZERO64;

  constructor() {
    for (const [key, links] of genesisChains()) this.chains.set(key, links);
  }

  private ts(seq: number): string {
    return new Date((BASE_EPOCH + seq * 60) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  epochOfNext(): number {
    return BASE_EPOCH + this.entries.length * 60;
  }

  append(fields: Record<string, unknown>): any {
    const seq = this.entries.length;
    const entry: any = { seq, ts: this.ts(seq), session: this.session, ...fields, prev: this.prevHash };
    entry.hash = entryHash(entry);
    this.prevHash = entry.hash;
    this.entries.push(entry);
    return entry;
  }

  genesis(): void {
    const tails: Record<string, Record<string, string>> = {};
    for (const [slot, lane] of GENESIS_LANES) {
      (tails[slot] ??= {})[lane] = hex(this.chains.get(`${slot}/${lane}`)![N]);
    }
    this.append({ kind: 'genesis', transcript, tails });
  }

  draw(o: {
    slot: string; lane: string; type: string; initiator?: string;
    mod?: number; sealMod?: number; dc?: number; sealDc?: number; ctx?: string;
    announce_seq?: number; batch?: string; paired_with?: number; pair_rule?: string;
  }): number {
    const key = `${o.slot}/${o.lane}`;
    const pos = (this.cursor.get(key) ?? 0) + 1;
    this.cursor.set(key, pos);
    this.maxConcerned.set(key, Math.max(this.maxConcerned.get(key) ?? 0, pos));
    const p = C.preimageAt(this.chains.get(key)!, pos);
    const seq = this.entries.length;
    const e: Record<string, unknown> = {
      kind: 'draw', slot: o.slot, lane: o.lane, position: pos,
      check_type: o.type, initiator: o.initiator ?? 'gm',
    };
    const sealed: SealedValues = { lane: key, pos };
    if (o.mod !== undefined) e.modifier = o.mod;
    if (o.sealMod !== undefined) { e.mod_commit = C.modCommit(p, seq, o.sealMod); sealed.modifier = o.sealMod; }
    if (o.dc !== undefined) e.dc = o.dc;
    if (o.sealDc !== undefined) { e.dc_commit = C.dcCommit(p, seq, o.sealDc); sealed.dc = o.sealDc; }
    if (o.ctx !== undefined) { e.context_commit = C.contextCommit(p, seq, o.ctx); sealed.context = o.ctx; }
    if (o.announce_seq !== undefined) e.announce_seq = o.announce_seq;
    if (o.batch !== undefined) e.batch = o.batch;
    if (o.paired_with !== undefined) { e.paired_with = o.paired_with; e.pair_rule = o.pair_rule; }
    this.append(e);
    if (sealed.dc !== undefined || sealed.modifier !== undefined || sealed.context !== undefined) {
      this.values.set(seq, sealed);
    }
    this.expectedRolls.push({ seq, roll: C.rollFromPreimage(p) });
    return seq;
  }

  announce(o: { slot: string; lane: string; type: string; ctx: string; initiator: string }): number {
    const key = `${o.slot}/${o.lane}`;
    const reservation = (this.cursor.get(key) ?? 0) + 1;
    this.maxConcerned.set(key, Math.max(this.maxConcerned.get(key) ?? 0, reservation));
    const p = C.preimageAt(this.chains.get(key)!, reservation);
    const seq = this.entries.length;
    this.append({
      kind: 'announce', slot: o.slot, lane: o.lane, check_type: o.type,
      context_commit: C.contextCommit(p, seq, o.ctx), initiator: o.initiator,
    });
    this.values.set(seq, { lane: key, pos: reservation, context: o.ctx });
    return seq;
  }

  dcLate(targetSeq: number, sealDc: number): number {
    const target = this.values.get(targetSeq) ?? this.targetOfDraw(targetSeq);
    const p = C.preimageAt(this.chains.get(target.lane)!, target.pos);
    const seq = this.entries.length;
    this.append({ kind: 'dc-late', target_seq: targetSeq, dc_commit: C.dcCommit(p, seq, sealDc) });
    this.values.set(seq, { lane: target.lane, pos: target.pos, dc: sealDc });
    return seq;
  }

  private targetOfDraw(seq: number): { lane: string; pos: number } {
    const e = this.entries[seq];
    return { lane: `${e.slot}/${e.lane}`, pos: e.position };
  }

  disclose(slot: string, lane: string, through: number): number {
    const key = `${slot}/${lane}`;
    const preimage = hex(C.preimageAt(this.chains.get(key)!, through));
    const seq = this.entries.length;
    const opened: any[] = [];
    for (const [vSeq, v] of this.values) {
      if (v.lane !== key || v.pos > through || vSeq >= seq || this.openedSeqs.has(vSeq)) continue;
      const el: Record<string, unknown> = { seq: vSeq };
      if (v.dc !== undefined) el.dc = v.dc;
      if (v.modifier !== undefined) el.modifier = v.modifier;
      if (v.context !== undefined) el.context = v.context;
      opened.push(el);
      this.openedSeqs.add(vSeq);
    }
    opened.sort((a, b) => a.seq - b.seq);
    this.append({ kind: 'disclose', slot, lane, through_position: through, preimage, opened });
    this.watermark.set(key, through);
    return seq;
  }

  activate(slot: string, lanes: string[], display: string, role: string): number {
    const declaredEpoch = this.epochOfNext() - 700;
    const period = 30;
    const round = 200;
    const record = {
      version: 'wotw-column/1',
      slot,
      lanes,
      label_commit: C.labelCommit(C.labelSalt(S, E, slot), display, role),
      nonce: `${slot}-activation-nonce`,
      declared_at: new Date(declaredEpoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      beacon: {
        chain: 'drand:toy-chain',
        round,
        genesis_time: declaredEpoch + 700 - (round - 1) * period,
        period,
      },
    };
    this.append({ kind: 'activation-declare', declaration: record });
    const completed = {
      ...record,
      beacon: {
        ...record.beacon,
        randomness: hex(C.sha256(Buffer.from(`beacon-${slot}`, 'utf8'))),
      },
    };
    const A = C.sha256(canonicalBytes(completed));
    this.slotA.set(slot, A);
    const ikm = C.ikmFor(S, E, A);
    const tails: Record<string, string> = {};
    for (const lane of lanes) {
      const links = C.chainLinks(C.laneRoot(ikm, slot, lane), N);
      this.chains.set(`${slot}/${lane}`, links);
      tails[lane] = hex(links[N]);
    }
    return this.append({ kind: 'activate', activation_record: completed, tails }).seq;
  }

  /** lanes with concerned positions beyond their watermark, sorted. */
  lanesNeedingDisclose(): { slot: string; lane: string; through: number }[] {
    const out: { slot: string; lane: string; through: number }[] = [];
    for (const key of [...this.maxConcerned.keys()].sort()) {
      const mc = this.maxConcerned.get(key)!;
      if (mc > (this.watermark.get(key) ?? 0)) {
        const [slot, lane] = key.split('/');
        out.push({ slot, lane, through: mc });
      }
    }
    return out;
  }
}

export interface ToyLedgerResult {
  ledger: { format: string; head: string; entries: any[] };
  expectedRolls: { seq: number; roll: number }[];
  builder: Builder;
}

export function buildToyLedger(): ToyLedgerResult {
  const b = new Builder();
  b.genesis();

  // ---- session 1 ------------------------------------------------------------
  b.session = 1;
  b.append({ kind: 'session-open' });
  b.append({ kind: 'sheet-update', slot: 'slot-01', effective_from: '2026-08-14',
    modifiers: { 'rk-cosmology': 3, 'rk-general': 5, 'perception-secret': 7, 'public-gm-check': 4 } });
  b.append({ kind: 'sheet-update', slot: 'slot-02', effective_from: '2026-08-14',
    modifiers: { 'rk-cosmology': 2, 'rk-general': 6, 'perception-secret': 5, 'public-gm-check': 3 } });
  const ann1 = b.announce({ slot: 'slot-01', lane: 'sealed', type: 'rk-cosmology',
    ctx: 'an announced question', initiator: 'player' });
  b.draw({ slot: 'slot-01', lane: 'sealed', type: 'rk-cosmology', initiator: 'player',
    mod: 3, sealDc: 22, announce_seq: ann1 });
  b.draw({ slot: 'slot-01', lane: 'sealed', type: 'perception-secret', mod: 7, sealDc: 15,
    ctx: 'example batch context', batch: 'b1' });
  b.draw({ slot: 'slot-02', lane: 'sealed', type: 'perception-secret', mod: 5, sealDc: 15,
    ctx: 'example batch context', batch: 'b1' });
  const noDcDraw = b.draw({ slot: 'slot-02', lane: 'sealed', type: 'rk-general', mod: 6,
    ctx: 'example deferred DC context' }); // DC supplied later via dc-late
  b.draw({ slot: 'slot-03', lane: 'routine', type: 'world-routine', sealMod: 8, sealDc: 18,
    ctx: 'example routine context' });
  const annV1 = b.announce({ slot: 'slot-03', lane: 'deep', type: 'world-plot',
    ctx: 'a hidden event begins', initiator: 'gm' });
  b.append({ kind: 'void', slot: 'slot-03', lane: 'deep', announce_seq: annV1,
    reason: 'scene interrupted' });
  // re-announce with the SAME context at the SAME reserved position:
  // seq-bound salts must make the two context commitments differ (§2.12)
  const ann2 = b.announce({ slot: 'slot-03', lane: 'deep', type: 'world-plot',
    ctx: 'a hidden event begins', initiator: 'gm' });
  b.draw({ slot: 'slot-03', lane: 'deep', type: 'world-plot', sealMod: 11, sealDc: 25,
    announce_seq: ann2 });
  b.dcLate(noDcDraw, 17);
  b.append({ kind: 'out-of-band', check_type: 'public-gm-check', slot: 'slot-01',
    result: 14, reason: 'network interruption' });
  const openDraw1 = b.draw({ slot: 'slot-01', lane: 'open', type: 'public-gm-check',
    mod: 4, dc: 15, ctx: 'example public check' });
  const misfire = b.draw({ slot: 'slot-01', lane: 'sealed', type: 'rk-general', mod: 5,
    sealDc: 16, ctx: 'example corrected check' }); // meant slot-02
  const redraw = b.draw({ slot: 'slot-02', lane: 'sealed', type: 'rk-general', mod: 6,
    sealDc: 16, ctx: 'example corrected check' });
  b.append({ kind: 'correction', target_seq: misfire, reason: 'drew on wrong slot',
    replacement_seq: redraw });
  b.append({ kind: 'note', text: 'end of example session' });
  b.append({ kind: 'session-close' });
  b.disclose('slot-01', 'open', 1); // nightly open-lane disclosure

  // ---- session 2 ------------------------------------------------------------
  b.session = 2;
  b.append({ kind: 'session-open' });
  const annV2 = b.announce({ slot: 'slot-02', lane: 'sealed', type: 'rk-cosmology',
    ctx: 'a second announced question', initiator: 'player' });
  b.append({ kind: 'void', slot: 'slot-02', lane: 'sealed', announce_seq: annV2,
    reason: 'player withdrew the question' });
  const ann3 = b.announce({ slot: 'slot-02', lane: 'sealed', type: 'rk-cosmology',
    ctx: 'a second announced question', initiator: 'player' });
  b.draw({ slot: 'slot-02', lane: 'sealed', type: 'rk-cosmology', initiator: 'player',
    mod: 2, sealDc: 24, announce_seq: ann3 });
  const pairFirst = b.draw({ slot: 'slot-01', lane: 'sealed', type: 'perception-secret',
    mod: 7, sealDc: 15, ctx: 'example paired check' });
  const pairFirstPos = b.entries[pairFirst].position;
  b.draw({ slot: 'slot-01', lane: 'sealed', type: 'perception-secret', mod: 7, sealDc: 15,
    ctx: 'example paired check', paired_with: pairFirstPos, pair_rule: 'fortune' });
  b.draw({ slot: 'slot-01', lane: 'sealed', type: 'lore-mystery', mod: 4, sealDc: 20,
    ctx: 'an obscure inscription' });
  b.draw({ slot: 'slot-01', lane: 'sealed', type: 'rk-general', mod: 5, sealDc: 18,
    ctx: 'second example batch', batch: 'b2' });
  b.draw({ slot: 'slot-02', lane: 'sealed', type: 'rk-general', mod: 6, sealDc: 18,
    ctx: 'second example batch', batch: 'b2' });
  b.draw({ slot: 'slot-03', lane: 'routine', type: 'world-routine', sealMod: 8, sealDc: 14,
    ctx: 'example world event' });
  b.draw({ slot: 'slot-03', lane: 'open', type: 'world-only-open', mod: 6, dc: 10,
    ctx: 'example public world event' });
  b.draw({ slot: 'slot-01', lane: 'open', type: 'public-gm-check', mod: 4, dc: 12,
    ctx: 'example public player check' });
  b.append({ kind: 'sheet-update', slot: 'slot-01', effective_from: '2026-09-04',
    modifiers: { 'rk-cosmology': 4, 'rk-general': 7, 'perception-secret': 8,
      'public-gm-check': 5, 'lore-mystery': 4 } });
  b.append({ kind: 'session-close' });
  b.disclose('slot-01', 'open', 2); // nightly
  b.disclose('slot-03', 'open', 1); // nightly
  // rolling sealed disclosure: slot-02 sealed through position 2
  // (opens the batch draw's DC and the dc-late DC for the DC-less draw)
  b.disclose('slot-02', 'sealed', 2);

  // ---- between sessions: activation -----------------------------------------
  b.activate('slot-04', ['open', 'shadow'], 'Bud', 'npc');

  // ---- session 3 ------------------------------------------------------------
  b.session = 3;
  b.append({ kind: 'session-open' });
  b.draw({ slot: 'slot-04', lane: 'open', type: 'public-gm-check', mod: 2, dc: 14,
    ctx: 'example public NPC check' });
  b.draw({ slot: 'slot-04', lane: 'shadow', type: 'npc-secret', sealMod: 9, sealDc: 21,
    ctx: 'example NPC secret check one' });
  b.draw({ slot: 'slot-04', lane: 'shadow', type: 'npc-secret', sealMod: 9, sealDc: 21,
    ctx: 'example NPC secret check two' });
  const ann4 = b.announce({ slot: 'slot-03', lane: 'deep', type: 'world-plot',
    ctx: 'a hidden event resolves', initiator: 'gm' });
  b.draw({ slot: 'slot-03', lane: 'deep', type: 'world-plot', sealMod: 11, sealDc: 27,
    announce_seq: ann4 });
  b.draw({ slot: 'slot-02', lane: 'sealed', type: 'perception-secret', mod: 5, sealDc: 16,
    ctx: 'example perception check' });
  b.append({ kind: 'retire-slot', slot: 'slot-02', reason: 'example retirement' });
  b.draw({ slot: 'slot-01', lane: 'sealed', type: 'rk-general', mod: 7, sealDc: 19,
    ctx: 'example knowledge check' });
  b.append({ kind: 'reveal-all', scope: 'all' });
  b.draw({ slot: 'slot-01', lane: 'open', type: 'public-gm-check', mod: 5, dc: 11,
    ctx: 'example final public check' });

  // ---- filler to land at exactly 80 entries --------------------------------
  // remaining fixed entries: session-close + final discloses + final-reveal + closed
  const remaining = 1 + b.lanesNeedingDisclose().length + 2;
  const filler = 80 - b.entries.length - remaining;
  if (filler < 0 || filler > 30) throw new Error(`filler out of range: ${filler}`);
  for (let i = 0; i < filler; i++) {
    b.draw({ slot: 'slot-03', lane: 'routine', type: 'world-routine',
      sealMod: 8, sealDc: 13 + (i % 5), ctx: `routine event ${i + 1}` });
  }
  b.append({ kind: 'session-close' });

  // ---- final reveal ---------------------------------------------------------
  for (const d of b.lanesNeedingDisclose()) b.disclose(d.slot, d.lane, d.through);
  b.append({ kind: 'final-reveal', secret: hex(S),
    labels: [{ slot: 'slot-04', display: 'Bud', role: 'npc' }] });
  b.append({ kind: 'closed', reason: 'campaign complete (toy)' });

  if (b.entries.length !== 80) throw new Error(`toy ledger has ${b.entries.length} entries, expected 80`);
  const ledger = {
    format: 'wotw-column-ledger/4',
    head: b.entries[b.entries.length - 1].hash,
    entries: b.entries,
  };
  return { ledger, expectedRolls: b.expectedRolls, builder: b };
}

// ---- negative cases (§9.1 item 11) -----------------------------------------

function clone(x: any): any {
  return JSON.parse(JSON.stringify(x));
}

/** Recompute prev/hash from index i on — "the GM wrote a bad ledger honestly". */
function rehashFrom(entries: any[], i: number): void {
  for (let j = i; j < entries.length; j++) {
    entries[j].prev = j === 0 ? ZERO64 : entries[j - 1].hash;
    const { hash: _hash, ...rest } = entries[j];
    entries[j].hash = entryHash(rest);
  }
}

function withHead(entries: any[]): any {
  return { format: 'wotw-column-ledger/4', head: entries[entries.length - 1].hash, entries };
}

export interface NegativeCase { name: string; expected_message: string; ledger: any }

export function buildNegatives(good: ToyLedgerResult): NegativeCase[] {
  const src = good.ledger.entries;
  const find = (pred: (e: any) => boolean, from = 0): number => {
    const i = src.findIndex((e, idx) => idx >= from && pred(e));
    if (i < 0) throw new Error('negative-case target not found');
    return i;
  };
  const findLast = (pred: (e: any) => boolean): number => {
    for (let i = src.length - 1; i >= 0; i--) if (pred(src[i])) return i;
    throw new Error('negative-case target not found');
  };
  const cases: NegativeCase[] = [];
  const add = (name: string, expected: string, entries: any[]) =>
    cases.push({ name, expected_message: expected, ledger: withHead(entries) });

  // 1. reordered entries (tamper: no rehash)
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'note');
    [e[i], e[i + 1]] = [e[i + 1], e[i]];
    add('reordered entries', `inv 1: entry at index ${i} has seq ${i + 1}, expected ${i}`, e);
  }
  // 2. broken prev (tamper at one link; hash covers the bad prev, chain
  //    consistent downstream, so ONLY inv 3 fires at seq 30)
  {
    const e = clone(src);
    e[30].prev = 'ff'.repeat(32);
    const { hash: _h, ...rest } = e[30];
    e[30].hash = entryHash(rest);
    rehashFrom(e, 31);
    add('broken prev', 'inv 3: seq 30 prev does not match hash of seq 29', e);
  }
  // 3. skipped position
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'draw' && x.slot === 'slot-03' && x.lane === 'routine',
      find((x) => x.kind === 'draw' && x.slot === 'slot-03' && x.lane === 'routine') + 1);
    e[i].position += 1;
    rehashFrom(e, i);
    add('skipped position',
      `inv 7: seq ${i} slot-03/routine position ${e[i].position}, expected ${e[i].position - 1}`, e);
  }
  // 4. unmatched announce_seq
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'draw' && 'announce_seq' in x && x.lane === 'deep');
    const noteSeq = find((x) => x.kind === 'note');
    e[i].announce_seq = noteSeq;
    rehashFrom(e, i);
    add('unmatched announce_seq',
      `inv 8: seq ${i} announce_seq ${noteSeq} does not reference an open announce of slot-03/deep/world-plot/gm`, e);
  }
  // 5. disclosure preimage not reaching the tail
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'disclose' && x.slot === 'slot-02' && x.lane === 'sealed');
    e[i].preimage = C.sha256(Buffer.from('junk', 'utf8')).toString('hex');
    rehashFrom(e, i);
    add('disclosure preimage not reaching tail',
      `inv 21: seq ${i} preimage does not reach tail of slot-02/sealed`, e);
  }
  // 6. decreasing watermark (preimage corrected so ONLY inv 22 fires)
  {
    const e = clone(src);
    const first = find((x) => x.kind === 'disclose' && x.slot === 'slot-01' && x.lane === 'open');
    const i = find((x) => x.kind === 'disclose' && x.slot === 'slot-01' && x.lane === 'open', first + 1);
    e[i].through_position = 1;
    e[i].preimage = hex(C.preimageAt(good.builder.chains.get('slot-01/open')!, 1));
    e[i].opened = [];
    rehashFrom(e, i);
    add('decreasing watermark',
      `inv 22: seq ${i} through_position 1 must exceed watermark 1`, e);
  }
  // 7. a draw containing a result field (invariant 20)
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'draw' && x.batch === 'b1');
    e[i].result = 17;
    rehashFrom(e, i);
    add('draw containing result field', `inv 20: seq ${i} forbidden field result`, e);
  }
  // 8. draw whose check_type lane contradicts the registry
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'draw' && x.slot === 'slot-01' && x.lane === 'open');
    e[i].check_type = 'rk-general';
    rehashFrom(e, i);
    add('check_type lane contradicts registry',
      `inv 10: seq ${i} lane open does not match check_type rk-general lane sealed`, e);
  }
  // 9. draw whose slot role is not in the type's roles
  {
    const e = clone(src);
    const i = findLast((x) => x.kind === 'draw' && x.slot === 'slot-01'
      && x.lane === 'open' && x.check_type === 'public-gm-check');
    e[i].check_type = 'world-only-open';
    rehashFrom(e, i);
    add('slot role not in check_type roles',
      `inv 10: seq ${i} slot role player not in roles of check_type world-only-open`, e);
  }
  // 10. an activation skipping a deferred slot (invariant 16)
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'activate');
    e[i].activation_record.slot = 'slot-05';
    rehashFrom(e, i);
    add('activation skips deferred slot',
      `inv 16: seq ${i} activation targets slot-05, expected slot-04`, e);
  }
  // 11. a draw for a retired slot
  {
    const e = clone(src);
    const retire = find((x) => x.kind === 'retire-slot');
    const i = find((x) => x.kind === 'draw' && x.slot === 'slot-01' && x.lane === 'sealed', retire);
    const slot02SealedCount = src.filter(
      (x) => x.kind === 'draw' && x.slot === 'slot-02' && x.lane === 'sealed').length;
    e[i].slot = 'slot-02';
    e[i].position = slot02SealedCount + 1;
    rehashFrom(e, i);
    add('draw for retired slot', `inv 15: seq ${i} draw for retired slot slot-02`, e);
  }
  // 12. final-reveal whose secret mismatches the commitment
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'final-reveal');
    e[i].secret = 'ff'.repeat(32);
    rehashFrom(e, i);
    add('final-reveal secret mismatch', 'inv 25: secret does not match commitment', e);
  }

  // 13. a hash-valid draw beyond the committed chain length
  {
    const e = clone(src);
    const i = findLast((x) => x.kind === 'draw');
    e[i].position = N + 1;
    rehashFrom(e, i);
    add('draw beyond committed chain length',
      `structure: seq ${i} position outside chain_length`, e);
  }
  // 14. syntactically shaped but impossible timestamp
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'note');
    e[i].ts = '2026-99-99T99:99:99Z';
    rehashFrom(e, i);
    add('impossible timestamp', `structure: seq ${i} bad ts`, e);
  }
  // 15. initiator outside the closed gm|player vocabulary
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'draw');
    e[i].initiator = 'dragon';
    rehashFrom(e, i);
    add('invalid initiator', `structure: seq ${i} bad initiator`, e);
  }
  // 16. ritual draw without the public announce reference
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'draw' && x.check_type === 'rk-cosmology');
    delete e[i].announce_seq;
    rehashFrom(e, i);
    add('ritual draw without announce',
      `structure: seq ${i} ritual draw has no announce_seq`, e);
  }
  // 17. activation input changed after its public declaration
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'activate');
    e[i].activation_record.nonce = 'changed-after-beacon';
    rehashFrom(e, i);
    add('activation differs from declaration',
      `inv 17: seq ${i} activation_record differs from declaration at seq ${i - 1}`, e);
  }
  // 18. unknown top-level fields are rejected even when the hash is valid
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'draw');
    e[i].debug = { result: 20 };
    rehashFrom(e, i);
    add('unexpected nested debug field', `structure: seq ${i} unexpected field debug`, e);
  }

  // 19. the final transcript must match the configuration witnessed before
  // players supplied entropy.
  {
    const e = clone(src);
    e[0].transcript.chain_length += 1;
    rehashFrom(e, 0);
    add('configuration changed after player entropy',
      'structure: genesis configuration commitment mismatch', e);
  }

  // 20. the ledger envelope is exact too; unknown side channels are rejected.
  {
    const ledger = withHead(clone(src));
    ledger.debug = { private: true };
    cases.push({
      name: 'unexpected ledger envelope field',
      expected_message: 'structure: unexpected ledger field debug',
      ledger,
    });
  }

  // 21. final reveal cannot occur while a session is still open.
  {
    const e = clone(src);
    const final = find((x) => x.kind === 'final-reveal');
    let i = final - 1;
    while (i >= 0 && e[i].kind !== 'session-close') i--;
    if (i < 0) throw new Error('negative-case session-close not found');
    e[i] = { ...e[i], kind: 'note', text: 'close removed' };
    rehashFrom(e, i);
    add('final reveal during open session',
      `structure: seq ${final} final-reveal while a session is open`, e);
  }

  // 22. An announce fixes the ritual's exact purpose, not only its lane.
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'draw' && x.check_type === 'rk-cosmology'
      && 'announce_seq' in x);
    e[i].check_type = 'rk-general'; // same slot/lane and seal forms
    rehashFrom(e, i);
    add('ritual purpose differs from announcement',
      `inv 8: seq ${i} announce_seq ${e[i].announce_seq} does not reference an open announce of slot-01/sealed/rk-general/player`, e);
  }

  // 23. One d20 result cannot be reused as an endpoint of two paired rolls.
  {
    const e = clone(src);
    const paired = find((x) => x.kind === 'draw' && 'paired_with' in x);
    const i = find((x) => x.kind === 'draw' && x.slot === e[paired].slot
      && x.lane === e[paired].lane && x.seq > paired);
    e[i].paired_with = e[paired].position;
    e[i].pair_rule = 'fortune';
    rehashFrom(e, i);
    add('paired draw endpoint reused',
      `inv 11: seq ${i} invalid paired_with ${e[paired].position}`, e);
  }

  // 24. The person who initiated a ritual is part of the public declaration.
  {
    const e = clone(src);
    const i = find((x) => x.kind === 'draw' && x.check_type === 'rk-cosmology'
      && x.initiator === 'player' && 'announce_seq' in x);
    e[i].initiator = 'gm';
    rehashFrom(e, i);
    add('ritual initiator differs from announcement',
      `inv 8: seq ${i} announce_seq ${e[i].announce_seq} does not reference an open announce of slot-01/sealed/rk-cosmology/gm`, e);
  }

  if (cases.length !== 24) throw new Error(`expected 24 negative cases, built ${cases.length}`);
  return cases;
}
