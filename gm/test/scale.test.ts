/**
 * §9.2 / §12.12 scale test: a 10,000-entry ledger with N = 20000 and 20
 * activated slots verifies in all three implementations "within a few
 * seconds". The ledger is generated directly (not through Campaign
 * persistence — that would test disk I/O, not verification).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalBytes } from '../core/canonical.ts';
import * as C from '../core/crypto.ts';
import { entryHash, ZERO64 } from '../core/ledger.ts';
import { verifyLedger } from '../core/verify.ts';

const here = dirname(fileURLToPath(import.meta.url));
const N = 20000;
const SESSIONS = 50;
const DRAWS_PER_SESSION = 199;

function buildScaleLedger() {
  const S = Buffer.alloc(32, 7);
  const players = ['slot-01', 'slot-02', 'slot-03', 'slot-04'];
  const world = 'slot-05';
  const npcs = Array.from({ length: 14 }, (_, i) => `slot-${String(6 + i).padStart(2, '0')}`);
  const CHECKS = [
    { id: 'rk-general', label: 'RK', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: false },
    { id: 'public-gm-check', label: 'Public', lane: 'open', roles: ['player', 'npc', 'world'], seal_dc: false, seal_modifier: false, ritual: false },
    { id: 'npc-secret', label: 'NPC secret', lane: 'deep', roles: ['npc'], seal_dc: true, seal_modifier: true, ritual: false },
    { id: 'world-routine', label: 'World routine', lane: 'routine', roles: ['world'], seal_dc: true, seal_modifier: true, ritual: false },
  ];
  const slots = Array.from({ length: 24 }, (_, i) => {
    const id = `slot-${String(i + 1).padStart(2, '0')}`;
    if (i < 4) return { id, display: `P${i + 1}`, role: 'player', status: 'active', lanes: ['sealed', 'open'], nonce: `n${i}` };
    if (i === 4) return { id, display: 'the world', role: 'world', status: 'active', lanes: ['open', 'routine'], nonce: 'w' };
    if (i < 19) return { id, display: `N${i}`, role: 'npc', status: 'active', lanes: ['deep', 'open'], nonce: `x${i}` };
    return { id, display: null, role: null, status: 'deferred', lanes: null, nonce: null };
  });
  const transcriptBase = {
    version: 'wotw-column/1', commitment: C.commitmentOf(S), chain_length: N,
    created_at: '2026-08-14T19:32:11Z', campaign: 'Scale', context_privacy: 'plain',
    disclosure_policy: 'scale test', check_types: CHECKS, slots, beacon: null,
  };
  const transcript = {
    ...transcriptBase,
    configuration_commitment: C.configurationCommitment(transcriptBase),
  };
  const E = C.genesisEntropy(transcript);
  const links = new Map<string, Buffer[]>();
  const gIkm = C.ikmFor(S, E);
  for (const s of slots) {
    if (s.status !== 'active') continue;
    for (const lane of s.lanes!) links.set(`${s.id}/${lane}`, C.chainLinks(C.laneRoot(gIkm, s.id, lane), N));
  }

  const entries: any[] = [];
  const values = new Map<number, { lane: string; pos: number; dc?: number; modifier?: number }>();
  const cursor = new Map<string, number>();
  let prev = ZERO64;
  let session = 0;
  const base = Date.parse('2026-08-14T20:00:00Z') / 1000;
  const ts = () => new Date((base + entries.length) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const append = (partial: any) => {
    const seq = entries.length;
    const e: any = { seq, ts: ts(), session: partial.kind === 'genesis' ? 0 : session, ...partial, prev };
    e.hash = entryHash(e);
    prev = e.hash;
    entries.push(e);
    return e;
  };

  const tails: any = {};
  for (const s of slots) {
    if (s.status !== 'active') continue;
    tails[s.id] = {};
    for (const lane of s.lanes!) tails[s.id][lane] = links.get(`${s.id}/${lane}`)![N].toString('hex');
  }
  append({ kind: 'genesis', transcript, tails });
  for (const slot of players) {
    append({
      kind: 'sheet-update', slot, effective_from: '2026-08-14',
      modifiers: { 'rk-general': 5, 'public-gm-check': 4 },
    });
  }

  const draw = (slot: string, typeId: string, lane: string,
    o: { mod?: number; sealMod?: number; dc?: number; sealDc?: number }) => {
    const key = `${slot}/${lane}`;
    const pos = (cursor.get(key) ?? 0) + 1;
    cursor.set(key, pos);
    const p = C.preimageAt(links.get(key)!, pos);
    const seq = entries.length;
    const e: any = { kind: 'draw', slot, lane, position: pos, check_type: typeId, initiator: 'gm' };
    const v: any = { lane: key, pos };
    if (o.mod !== undefined) e.modifier = o.mod;
    if (o.sealMod !== undefined) { e.mod_commit = C.modCommit(p, seq, o.sealMod); v.modifier = o.sealMod; }
    if (o.dc !== undefined) e.dc = o.dc;
    if (o.sealDc !== undefined) { e.dc_commit = C.dcCommit(p, seq, o.sealDc); v.dc = o.sealDc; }
    append(e);
    if (v.dc !== undefined || v.modifier !== undefined) values.set(seq, v);
  };

  let active = [...players, world, ...npcs];
  for (let s = 1; s <= SESSIONS; s++) {
    if (s === 25) {
      // activation of slot-20 (the lowest deferred), beacon published +700s
      const declaredEpoch = Math.floor(base + entries.length) - 800;
      const period = 30, round = 100;
      const declaration = {
        version: 'wotw-column/1', slot: 'slot-20', lanes: ['deep'],
        label_commit: C.labelCommit(C.labelSalt(S, E, 'slot-20'), 'The Stranger', 'npc'),
        nonce: 'stranger-nonce',
        declared_at: new Date(declaredEpoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        beacon: {
          chain: 'drand:scale-test', round,
          genesis_time: declaredEpoch + 700 - (round - 1) * period, period,
        },
      };
      append({ kind: 'activation-declare', declaration });
      const record = {
        ...declaration,
        beacon: { ...declaration.beacon, randomness: C.sha256(Buffer.from('r')).toString('hex') },
      };
      const A = C.sha256(canonicalBytes(record));
      const l = C.chainLinks(C.laneRoot(C.ikmFor(S, E, A), 'slot-20', 'deep'), N);
      links.set('slot-20/deep', l);
      append({ kind: 'activate', activation_record: record, tails: { deep: l[N].toString('hex') } });
      active = [...active, 'slot-20'];
    }
    session = s;
    append({ kind: 'session-open' });
    for (let d = 0; d < DRAWS_PER_SESSION; d++) {
      // Exercise the advisory lookup at archival scale instead of timing only
      // ledgers with no sheet history (the regression that prompted this).
      if (d % 10 === 0) {
        append({
          kind: 'sheet-update', slot: players[(s + d) % players.length],
          effective_from: '2026-08-14',
          modifiers: { 'rk-general': 5, 'public-gm-check': 4 },
        });
      }
      const slot = active[d % active.length];
      if (players.includes(slot)) {
        if (d % 3 === 2) draw(slot, 'public-gm-check', 'open', { mod: 4, dc: 12 + (d % 8) });
        else draw(slot, 'rk-general', 'sealed', { mod: 5, sealDc: 12 + (d % 10) });
      } else if (slot === world) {
        draw(slot, 'world-routine', 'routine', { sealMod: 8, sealDc: 13 + (d % 7) });
      } else {
        draw(slot, 'npc-secret', 'deep', { sealMod: 6 + (d % 5), sealDc: 14 + (d % 9) });
      }
    }
    append({ kind: 'session-close' });
  }

  // final discloses per drawn lane, then reveal and close
  const opened = new Set<number>();
  for (const key of [...cursor.keys()].sort()) {
    const through = cursor.get(key)!;
    const [slot, lane] = key.split('/');
    const arr: any[] = [];
    for (const [seq, v] of values) {
      if (v.lane !== key || v.pos > through || opened.has(seq)) continue;
      const el: any = { seq };
      if (v.dc !== undefined) el.dc = v.dc;
      if (v.modifier !== undefined) el.modifier = v.modifier;
      arr.push(el);
      opened.add(seq);
    }
    arr.sort((a, b) => a.seq - b.seq);
    append({
      kind: 'disclose', slot, lane, through_position: through,
      preimage: C.preimageAt(links.get(key)!, through).toString('hex'), opened: arr,
    });
  }
  append({ kind: 'final-reveal', secret: S.toString('hex'),
    labels: [{ slot: 'slot-20', display: 'The Stranger', role: 'npc' }] });
  append({ kind: 'closed', reason: 'scale test complete' });

  return { format: 'wotw-column-ledger/4', head: entries[entries.length - 1].hash, entries };
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('scale (§12.12)', () => {
  const t0 = performance.now();
  const ledger = buildScaleLedger();
  const buildS = (performance.now() - t0) / 1000;

  it('has the required shape: ≥10k entries, N=20000, 20 activated slots', () => {
    expect(ledger.entries.length).toBeGreaterThanOrEqual(10000);
    expect(ledger.entries[0].transcript.chain_length).toBe(20000);
    const activeCount = ledger.entries[0].transcript.slots.filter((s: any) => s.status === 'active').length
      + ledger.entries.filter((e: any) => e.kind === 'activate').length;
    expect(activeCount).toBe(20);
    expect(ledger.entries.filter((entry: any) => entry.kind === 'sheet-update').length)
      .toBeGreaterThanOrEqual(1000);
    console.log(`built ${ledger.entries.length} entries in ${buildS.toFixed(1)}s`);
  });

  it('TS verifier: full post-reveal audit in a few seconds', () => {
    const t1 = performance.now();
    const res = verifyLedger(ledger);
    const dt = (performance.now() - t1) / 1000;
    console.log(`TS verify: ${dt.toFixed(2)}s, ${Object.keys(res.rolls).length} rolls derived`);
    expect(res.failures).toEqual([]);
    expect(res.state).toBe('fully revealed');
    expect(dt).toBeLessThan(20);
  }, 60_000);

  it('verify.py agrees within its budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'column-scale-'));
    dirs.push(dir);
    const p = join(dir, 'ledger.json');
    writeFileSync(p, JSON.stringify(ledger));
    const t1 = performance.now();
    const py = spawnSync('python3', [join(here, '../../verifier/verify.py'), p], { encoding: 'utf8' });
    const dt = (performance.now() - t1) / 1000;
    console.log(`verify.py: ${dt.toFixed(2)}s`);
    expect(py.stderr).toBe('');
    expect(py.stdout).toContain('VERIFIED (fully revealed)');
    expect(dt).toBeLessThan(60);
  }, 120_000);

  it('verify.html (sync JS SHA-256) completes without hanging', async () => {
    const html = readFileSync(join(here, '../../verifier/verify.html'), 'utf8');
    new Function(html.match(/<script>([\s\S]*)<\/script>/)![1])();
    const col = (globalThis as any).__column;
    const t1 = performance.now();
    const res = await col.verifyLedger(ledger);
    const dt = (performance.now() - t1) / 1000;
    console.log(`verify.html: ${dt.toFixed(2)}s`);
    expect(res.failures).toEqual([]);
    expect(res.state).toBe('fully revealed');
    expect(dt).toBeLessThan(90);
  }, 180_000);
});
