/**
 * GM server test battery (§9.2): leak test, lane isolation, ordered
 * allocation, idempotency, append-only, lock state, restore, reveal-all
 * ordering, activation wait, and cross-verification with verify.py.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, cpSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const VERIFY_PY = join(TEST_DIR, '../../verifier/verify.py');
const VERIFY_HTML = readFileSync(join(TEST_DIR, '../../verifier/verify.html'), 'utf8');
import { Campaign } from '../server/campaign.ts';
import { createServer } from '../server/http.ts';
import { decryptJson } from '../server/store.ts';
import { verifyLedger } from '../core/verify.ts';
import { defaultLanesForRole } from '../src/api.ts';
import { canonicalBytes } from '../core/canonical.ts';
import { entryHash, ZERO64 } from '../core/ledger.ts';
import * as C from '../core/crypto.ts';
import type { BeaconProvider } from '../server/beacon.ts';

const PASS = 'test-passphrase';
const KDF = { N: 2 ** 12, r: 8, p: 1 }; // fast for tests; prod is 2^17 (§6.4)
const CHECK_TYPES = [
  { id: 'rk-general', label: 'Recall Knowledge — general', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: false },
  { id: 'perception-secret', label: 'Secret Perception', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: false },
  { id: 'rk-cosmology', label: 'RK — cosmology', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: true },
  { id: 'world-routine', label: 'World — routine', lane: 'routine', roles: ['world'], seal_dc: true, seal_modifier: true, ritual: false },
  { id: 'npc-public', label: 'NPC check the table watched', lane: 'open', roles: ['npc'], seal_dc: false, seal_modifier: true, ritual: false },
  { id: 'npc-secret', label: 'NPC secret check', lane: 'deep', roles: ['npc'], seal_dc: true, seal_modifier: true, ritual: false },
  { id: 'public-gm-check', label: 'Public GM check', lane: 'open', roles: ['player', 'npc', 'world'], seal_dc: false, seal_modifier: false, ritual: false },
];

class FakeClock {
  t = Date.parse('2026-08-14T20:00:00Z');
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}
class FakeBeacon implements BeaconProvider {
  constructor(private clock: FakeClock) {}
  async declare(minDelaySec: number) {
    const nowSec = Math.floor(this.clock.t / 1000);
    const period = 30, round = 500;
    // round_time lands exactly minDelay+30s from now
    return { chain: 'drand:test-chain', round, period, genesis_time: nowSec + minDelaySec + 30 - (round - 1) * period };
  }
  async fetch(round: number) {
    return C.sha256(Buffer.from(`fake-round-${round}`)).toString('hex');
  }
}

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'column-test-'));
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function makeCampaign(over: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const stateDir = tmp(), publicDir = tmp();
  const campaign = new Campaign({
    stateDir, publicDir, kdf: KDF, minPrecommitAgeMs: 0,
    now: clock.now, beacon: new FakeBeacon(clock), ...over,
  });
  await campaign.precommit(PASS);
  clock.advance(60_000);
  const genesisInput = {
    campaign: 'Test Campaign', chain_length: 400, context_privacy: 'sealed' as const,
    disclosure_policy: 'test policy', check_types: CHECK_TYPES, reserve_total: 6,
    active_slots: [
      { display: 'Alice', role: 'player', lanes: ['sealed', 'open'], nonce: 'a-nonce' },
      { display: 'Bob', role: 'player', lanes: ['sealed', 'open'], nonce: 'b-nonce' },
      { display: 'the world', role: 'world', lanes: ['open', 'routine'], nonce: 'w-nonce' },
    ],
  };
  await campaign.freezeGenesisConfiguration(genesisInput);
  await campaign.genesis(genesisInput);
  return { campaign, clock, stateDir, publicDir };
}

let browserVerify: ((ledger: unknown) => Promise<any>) | null = null;
function verifyInBrowser(ledger: unknown): Promise<any> {
  if (!browserVerify) {
    new Function(VERIFY_HTML.match(/<script>([\s\S]*)<\/script>/)![1])();
    browserVerify = (globalThis as any).__column.verifyLedger;
  }
  return browserVerify!(ledger);
}

function rehashLedger(ledger: any): any {
  let prev = ZERO64;
  for (const entry of ledger.entries) {
    entry.prev = prev;
    entry.hash = entryHash(entry);
    prev = entry.hash;
  }
  ledger.head = prev;
  return ledger;
}

async function verifyModifierParity(ledger: any) {
  const ts = verifyLedger(ledger);
  const browser = await verifyInBrowser(ledger);
  const dir = tmp(), path = join(dir, 'ledger.json');
  writeFileSync(path, JSON.stringify(ledger));
  const pyRun = spawnSync('python3', [VERIFY_PY, path, '--json'], { encoding: 'utf8' });
  expect(pyRun.stderr).toBe('');
  const py = JSON.parse(pyRun.stdout);
  expect(browser.modifier_checks).toEqual(ts.modifier_checks);
  expect(browser.advisories).toEqual(ts.advisories);
  expect(py.modifier_checks).toEqual(ts.modifier_checks);
  expect(py.advisories).toEqual(ts.advisories);
  expect(browser.verdict, browser.failures.join('\n')).toBe(ts.verdict);
  expect(py.verdict, py.failures.join('\n')).toBe(ts.verdict);
  return ts;
}

/** Decrypt the private state out-of-band and derive all secret material. */
function secretMaterial(stateDir: string, ledger: any) {
  const { obj } = decryptJson(readFileSync(join(stateDir, 'private.enc'), 'utf8'), PASS);
  const S = Buffer.from(obj.secret, 'hex');
  const transcript = ledger.entries[0].transcript;
  const E = C.genesisEntropy(transcript);
  const N = transcript.chain_length;
  const links = new Map<string, Buffer[]>();
  for (const s of transcript.slots) {
    if (s.status !== 'active') continue;
    for (const lane of s.lanes) {
      links.set(`${s.id}/${lane}`, C.chainLinks(C.laneRoot(C.ikmFor(S, E), s.id, lane), N));
    }
  }
  return { S, E, N, links, priv: obj };
}

describe('lifecycle', () => {
  it('bootstraps every active player with a Default +0 profile for all available checks', async () => {
    const { campaign } = await makeCampaign();
    const ledger = campaign.ledgerJson();
    const bootstrapSheets = ledger.entries.filter((e: any) => e.kind === 'sheet-update');
    expect(bootstrapSheets.map((e: any) => ({
      slot: e.slot, effective_from: e.effective_from, modifiers: e.modifiers,
    }))).toEqual([
      { slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Default: 0 } },
      { slot: 'slot-02', effective_from: '2026-08-14', modifiers: { Default: 0 } },
    ]);

    const table = campaign.tableState();
    const playerTypes = CHECK_TYPES
      .filter((type) => type.roles.includes('player') && ['sealed', 'open'].includes(type.lane))
      .map((type) => type.id);
    expect(table.sheets['slot-01']).toEqual({ Default: 0 });
    expect(table.sheets['slot-02']).toEqual({ Default: 0 });
    expect(table.profile_defaults['slot-01']).toEqual(
      Object.fromEntries(playerTypes.map((type) => [type, 'Default'])),
    );
    expect(table.profile_defaults['slot-02']).toEqual(
      Object.fromEntries(playerTypes.map((type) => [type, 'Default'])),
    );
    expect(table.profile_defaults['slot-03']).toBeUndefined();
    expect(table.npc_sheets['slot-03']).toBeUndefined();

    await campaign.sessionOpen();
    const draw = await campaign.draw({ slot: 'slot-01', check_type: 'rk-general', dc: 15 });
    expect(draw.modifier).toBe(0);
    expect(draw.entry.modifier).toBe(0);
    expect(verifyLedger(campaign.ledgerJson()).failures).toEqual([]);
  });

  it('freezes all genesis routing choices before accepting player entropy', async () => {
    const clock = new FakeClock();
    const stateDir = tmp(), publicDir = tmp();
    const campaign = new Campaign({
      stateDir, publicDir, kdf: KDF, minPrecommitAgeMs: 0, now: clock.now,
    });
    await campaign.precommit(PASS);
    const input = {
      campaign: 'Frozen', chain_length: 100,
      disclosure_policy: 'x', check_types: CHECK_TYPES, reserve_total: 2,
      active_slots: [
        { display: 'Alice', role: 'player', lanes: ['sealed', 'open'], nonce: 'placeholder' },
      ],
    };
    const frozen = await campaign.freezeGenesisConfiguration(input);
    expect(frozen.configuration.context_privacy).toBe('sealed');
    expect(frozen.configuration_commitment).toMatch(/^[0-9a-f]{64}$/);
    campaign.lock();
    const resumed = new Campaign({
      stateDir, publicDir, kdf: KDF, minPrecommitAgeMs: 0, now: clock.now,
    });
    await resumed.unlock(PASS);
    expect(resumed.genesisConfiguration()).toEqual(frozen);
    await expect(resumed.freezeGenesisConfiguration({ ...input, chain_length: 101 }))
      .rejects.toThrow(/already frozen/);
    // Nonces are deliberately excluded from the configuration commitment.
    await expect(resumed.genesis({
      ...input, active_slots: [{ ...input.active_slots[0], nonce: 'typed-later-by-alice' }],
    })).resolves.toBeDefined();
  });

  it('precommit → genesis → sessions → draws → verifies in TS and Python', async () => {
    const { campaign, stateDir } = await makeCampaign();
    await campaign.sessionOpen();
    await campaign.sheetUpdate({ slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Society: 5, Perception: 7, Occultism: 4 } });
    await campaign.profileDefaults({ slot: 'slot-01', defaults: {
      'rk-general': 'Society', 'perception-secret': 'Perception', 'rk-cosmology': 'Occultism',
    } });
    const d1 = await campaign.draw({ slot: 'slot-01', check_type: 'rk-general', dc: 18, context: 'first check' });
    expect(d1.entry.position).toBe(1);
    expect(d1.entry.modifier).toBe(5); // auto-filled from the sheet (§7.5)
    expect(d1.roll).toBeGreaterThanOrEqual(1);
    expect(d1.roll).toBeLessThanOrEqual(20);
    // ritual: announce → draw
    const ann = await campaign.announce({ slot: 'slot-01', check_type: 'rk-cosmology', context: 'the deep question', initiator: 'player' });
    await expect(campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', dc: 22,
      announce_seq: ann.seq, initiator: 'player',
    })).rejects.toThrow(/exact open announce/);
    const d2 = await campaign.draw({ slot: 'slot-01', check_type: 'rk-cosmology', dc: 22, announce_seq: ann.seq, initiator: 'player' });
    expect(d2.entry.announce_seq).toBe(ann.seq);
    // dc-late
    const d3 = await campaign.draw({ slot: 'slot-02', check_type: 'rk-general', modifier: 6, context: 'no dc yet' });
    expect('dc_commit' in d3.entry).toBe(false);
    await campaign.dcLate({ target_seq: d3.entry.seq, dc: 15 });
    await campaign.outOfBand({ check_type: 'public-gm-check', slot: 'slot-01', result: 14, reason: 'server was down' });
    await campaign.sessionClose();
    const ledger = campaign.ledgerJson();
    const res = verifyLedger(ledger);
    expect(res.failures).toEqual([]);
    expect(res.verdict).toBe('VERIFIED');
    // cross-implementation: verify.py must agree (§9.2)
    const py = spawnSync('python3', [VERIFY_PY, join(stateDir, 'ledger.json')], { encoding: 'utf8' });
    expect(py.stderr).toBe('');
    expect(py.stdout).toContain('VERIFIED');
    expect(py.status).toBe(0);
  });

  it('paired_with names an earlier lane position, not an entry seq', async () => {
    const { campaign } = await makeCampaign();
    await campaign.sessionOpen();
    const first = await campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', modifier: 5, dc: 18,
    });
    const second = await campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', modifier: 5, dc: 18,
      paired_with: first.entry.position, pair_rule: 'fortune',
    });
    expect(second.entry.paired_with).toBe(1);
    await expect(campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', modifier: 5, dc: 18,
      paired_with: second.entry.position, pair_rule: 'fortune',
    })).rejects.toThrow(/unpaired earlier position/);
    expect(verifyLedger(campaign.ledgerJson()).failures).toEqual([]);
  });

  it('draw beyond N is a hard error (§10.2)', async () => {
    const { campaign } = await makeCampaign();
    await campaign.sessionOpen();
    const small = campaign as any;
    // exhaust by cursor manipulation would touch internals; instead use N=400 and just check the guard exists
    small.cursor.set('slot-01/sealed', 400);
    await expect(campaign.draw({ slot: 'slot-01', check_type: 'rk-general' })).rejects.toThrow(/exhausted/);
  });
});

describe('leak test (§9.2, highest priority)', () => {
  it('rejects forbidden fields at any nesting depth before projection', () => {
    expect(() => Campaign.assertNoLeak([
      { seq: 7, kind: 'note', text: 'x', nested: { salt_dc: 'secret' } },
    ])).toThrow(/nested\.salt_dc/);
    expect(() => Campaign.assertNoLeak([
      { seq: 8, kind: 'out-of-band', result: 10, nested: { result: 20 } },
    ])).toThrow(/nested\.result/);
    expect(() => Campaign.assertNoLeak([
      { seq: 9, kind: 'genesis', tails: { 'slot-01': { 'salt-marsh': 'ab'.repeat(32) } } },
      { seq: 10, kind: 'sheet-update', modifiers: { result: 4 } },
    ])).not.toThrow();
  });

  it('300 draws: no private value appears in any published byte', async () => {
    const { campaign, stateDir, publicDir } = await makeCampaign();
    await campaign.sessionOpen();
    const contexts: string[] = [];
    for (let i = 0; i < 300; i++) {
      const ctx = `ctx-secret-${i}-${C.sha256(Buffer.from(`c${i}`)).toString('hex').slice(0, 16)}`;
      contexts.push(ctx);
      const slot = ['slot-01', 'slot-02'][i % 2];
      const type = ['rk-general', 'perception-secret'][i % 2];
      await campaign.draw({ slot, check_type: type, modifier: 5, dc: 10 + (i % 15), context: ctx });
    }
    await campaign.sessionClose();
    await campaign.publish();
    const ledger = campaign.ledgerJson();
    const { N, links } = secretMaterial(stateDir, ledger);
    const stateBytes = readFileSync(join(stateDir, 'ledger.json'), 'utf8');
    const publicBytes = readFileSync(join(publicDir, 'ledger.json'), 'utf8');
    for (const raw of [stateBytes, publicBytes]) {
      // every consumed preimage, every derived salt, every sealed context
      for (const e of ledger.entries) {
        if (e.kind !== 'draw') continue;
        const p = C.preimageAt(links.get(`${e.slot}/${e.lane}`)!, e.position);
        expect(raw).not.toContain(p.toString('hex'));
        expect(raw).not.toContain(C.saltDc(p, e.seq).toString('hex'));
        expect(raw).not.toContain(C.saltMod(p, e.seq).toString('hex'));
        expect(raw).not.toContain(C.saltCtx(p, e.seq).toString('hex'));
      }
      for (const ctx of contexts) expect(raw).not.toContain(ctx);
      // structural: no forbidden keys anywhere
      for (const e of JSON.parse(raw).entries) {
        for (const k of Object.keys(e)) {
          expect(k).not.toBe('link');
          expect(k.includes('salt')).toBe(false);
          if (k === 'result') expect(e.kind).toBe('out-of-band');
        }
      }
    }
  }, 60_000);

  it('publishes world-readable ledger bytes despite the hardened service umask', async () => {
    const { campaign, publicDir } = await makeCampaign();
    const previous = process.umask(0o077);
    try {
      await campaign.publish();
    } finally {
      process.umask(previous);
    }
    expect(statSync(join(publicDir, 'ledger.json')).mode & 0o777).toBe(0o644);
  });
});

describe('lane isolation (§9.2)', () => {
  it('fully disclosing one lane exposes nothing from any other lane', async () => {
    const { campaign, stateDir } = await makeCampaign();
    await campaign.sessionOpen();
    for (let i = 0; i < 10; i++) {
      await campaign.draw({ slot: 'slot-01', check_type: 'rk-general', modifier: 4, dc: 15, context: `a${i}` });
      await campaign.draw({ slot: 'slot-02', check_type: 'rk-general', modifier: 4, dc: 15, context: `b${i}` });
      await campaign.draw({ slot: 'slot-01', check_type: 'public-gm-check', modifier: 2, dc: 10, context: `c${i}` });
    }
    await campaign.sessionClose();
    await campaign.disclose({ slot: 'slot-01', lane: 'sealed', through_position: 10 });
    const ledger = campaign.ledgerJson();
    expect(verifyLedger(ledger).verdict).toBe('VERIFIED');
    const raw = JSON.stringify(ledger);
    const { links } = secretMaterial(stateDir, ledger);
    for (const [key, lks] of links) {
      if (key === 'slot-01/sealed') continue;
      // links[N] is the tail — public by design; everything before it is secret
      for (const link of lks.slice(0, -1)) expect(raw).not.toContain(link.toString('hex'));
    }
  }, 30_000);
});

describe('ordered allocation (§9.2)', () => {
  it('server only offers the lowest deferred slot and rejects others', async () => {
    const { campaign, clock } = await makeCampaign();
    await expect(campaign.activationDeclare({
      slot: 'slot-05', display: 'Eve', role: 'npc', lanes: ['open'], nonce: 'n',
    })).rejects.toThrow(/must target slot-04/);
    const dec = await campaign.activationDeclare({ display: 'Bud', role: 'npc', lanes: ['open'], nonce: 'bud-nonce' });
    expect(dec.slot).toBe('slot-04');
    // completing before the beacon round publishes is refused (§4.5)
    await expect(campaign.activationComplete()).rejects.toThrow(/wait/);
    clock.advance(700 * 1000);
    const act = await campaign.activationComplete();
    expect(act.kind).toBe('activate');
    expect(act.activation_record.slot).toBe('slot-04');
    // sealed labels: the display name must not appear anywhere public (§2.8)
    expect(JSON.stringify(campaign.ledgerJson())).not.toContain('Bud');
    // the activated NPC can draw, with its role resolved from private labels
    await campaign.sessionOpen();
    const d = await campaign.draw({ slot: 'slot-04', check_type: 'public-gm-check', modifier: 2, dc: 12, context: 'npc acts' });
    expect(d.entry.slot).toBe('slot-04');
    expect(verifyLedger(campaign.ledgerJson()).verdict).toBe('VERIFIED');
  });

  it('an activation lane set is permanent, so the UI defaults must cover the role', async () => {
    // There is no lane-add: whatever lanes a slot is activated with are its
    // lanes forever. An NPC activated without `deep` could never make a
    // secret check and nothing could repair it, so the wizard's per-role
    // defaults have to cover every lane that role's check types route to.
    const { campaign, clock } = await makeCampaign();

    // the hazard, demonstrated: activate with an incomplete lane set
    await campaign.activationDeclare({ display: 'Bud', role: 'npc', lanes: ['open'], nonce: 'n1' });
    clock.advance(700 * 1000);
    await campaign.activationComplete();
    await campaign.sessionOpen();
    await expect(campaign.draw({ slot: 'slot-04', check_type: 'npc-secret', modifier: 4, dc: 18 }))
      .rejects.toThrow(/does not declare lane deep/);
    // and it is unrepairable: no lane-add route exists on the campaign at all
    expect((campaign as any).laneAdd).toBeUndefined();

    // The shipped default must not walk the GM into that — checked against
    // the production function the wizard actually calls, not a copy of it,
    // and against this campaign's own registry rather than a fixed table.
    for (const role of ['player', 'npc', 'world']) {
      const offered = defaultLanesForRole(campaign.tableState().registry, role);
      const routable = [...new Set(CHECK_TYPES.filter((t) => t.roles.includes(role)).map((t) => t.lane))];
      expect(routable.filter((l) => !offered.includes(l)), `${role} default lanes miss a routable lane`).toEqual([]);
    }

    // and the good path works end to end with the offered default
    await campaign.sessionClose();
    const npcLanes = defaultLanesForRole(campaign.tableState().registry, 'npc');
    await campaign.activationDeclare({ display: 'Vic', role: 'npc', lanes: npcLanes, nonce: 'n2' });
    clock.advance(700 * 1000);
    await campaign.activationComplete();
    await campaign.sessionOpen();
    const secret = await campaign.draw({ slot: 'slot-05', check_type: 'npc-secret', modifier: 4, dc: 18 });
    expect(secret.entry.lane).toBe('deep');
    const pub = await campaign.draw({ slot: 'slot-05', check_type: 'npc-public', modifier: 2, dc: 12 });
    expect(pub.entry.lane).toBe('open');
    await campaign.sessionClose();
    expect(verifyLedger(campaign.ledgerJson()).failures).toEqual([]);
  });

  it('modifiers auto-fill by the slot role, for sealed and unsealed types alike', async () => {
    // Sourcing follows the SLOT's role; the check type only decides whether
    // the value publishes or seals. Keying the lookup on seal_modifier left
    // an NPC drawing an unsealed type with no source at all, so every such
    // draw was refused however carefully the sheets were filled in.
    const { campaign, clock } = await makeCampaign();
    await campaign.activationDeclare({ display: 'Vic', role: 'npc', lanes: ['open', 'deep'], nonce: 'n' });
    clock.advance(700 * 1000);
    await campaign.activationComplete();
    // one private sheet covering both an unsealed and a sealed NPC type
    await campaign.sheetUpdate({
      slot: 'slot-04', modifiers: { Diplomacy: 2, Deception: 9 },
    });
    await campaign.profileDefaults({ slot: 'slot-04', defaults: {
      'public-gm-check': 'Diplomacy', 'npc-secret': 'Deception',
    } });
    await campaign.sessionOpen();
    const unsealed = await campaign.draw({ slot: 'slot-04', check_type: 'public-gm-check', dc: 12 });
    expect(unsealed.entry.modifier).toBe(2); // publishes in the clear
    const sealed = await campaign.draw({ slot: 'slot-04', check_type: 'npc-secret', dc: 18 });
    expect(sealed.entry.modifier).toBeUndefined(); // sealed instead
    expect(sealed.entry.mod_commit).toMatch(/^[0-9a-f]{64}$/);
    await campaign.sessionClose();
    expect(verifyLedger(campaign.ledgerJson()).failures).toEqual([]);
  });

  it('names the fix when no modifier is recorded', async () => {
    const { campaign } = await makeCampaign();
    // Bootstrapping supplies Default +0; explicitly remove this check's
    // private pointer to exercise the repair path.
    await campaign.profileDefaults({ slot: 'slot-01', defaults: {} });
    await campaign.sessionOpen();
    // A missing default must say exactly how to repair it.
    await expect(campaign.draw({ slot: 'slot-01', check_type: 'perception-secret', dc: 15 }))
      .rejects.toThrow(/set it on \/sheets, or press m at the table/);
    // and the table's own one-key fix clears it for good
    await campaign.sheetUpdate({
      slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Perception: 7 },
    });
    await campaign.profileDefaults({ slot: 'slot-01', defaults: { 'perception-secret': 'Perception' } });
    const d = await campaign.draw({ slot: 'slot-01', check_type: 'perception-secret', dc: 15 });
    expect(d.entry.modifier).toBe(7);
  });

  it('a later player can publish a sheet and use its modifier', async () => {
    const { campaign, clock } = await makeCampaign();
    await campaign.activationDeclare({
      display: 'Cara', role: 'player', lanes: ['sealed', 'open'], nonce: 'cara-supplied-this',
    });
    const pending = campaign.status().pending_activation!;
    expect(pending.player_label_salt).toMatch(/^[0-9a-f]{64}$/);
    const declaration = campaign.ledgerJson().entries[pending.declaration_seq].declaration;
    expect(C.labelCommit(Buffer.from(pending.player_label_salt!, 'hex'), 'Cara', 'player'))
      .toBe(declaration.label_commit);
    clock.advance(700 * 1000);
    await campaign.activationComplete();
    await campaign.sheetUpdate({
      slot: 'slot-04', effective_from: '2026-08-14', modifiers: { Society: 9 },
    });
    await campaign.profileDefaults({ slot: 'slot-04', defaults: { 'rk-general': 'Society' } });
    await campaign.sessionOpen();
    const draw = await campaign.draw({
      slot: 'slot-04', check_type: 'rk-general', dc: 20, context: 'new player acts',
    });
    expect(draw.entry.modifier).toBe(9);
    await campaign.sessionClose();
    expect(verifyLedger(campaign.ledgerJson()).failures).toEqual([]);
    await campaign.finalReveal();
    expect(verifyLedger(campaign.ledgerJson()).failures).toEqual([]);
  });

  // crashes between writePrivate and writeLedger leave the two files one
  // step apart; load() must reconcile the pending activation both ways
  const truncateLedger = (stateDir: string) => {
    const p = join(stateDir, 'ledger.json');
    const file = JSON.parse(readFileSync(p, 'utf8'));
    file.entries.pop();
    file.head = file.entries[file.entries.length - 1].hash;
    writeFileSync(p, JSON.stringify(file));
  };

  it('recovers a declare-side crash: pending is dropped and re-declarable', async () => {
    const { campaign, stateDir, publicDir, clock } = await makeCampaign();
    await campaign.activationDeclare({ display: 'Bud', role: 'npc', lanes: ['open'], nonce: 'n1' });
    campaign.lock();
    truncateLedger(stateDir); // the declaration never reached the ledger
    const c2 = new Campaign({ stateDir, publicDir, kdf: KDF, now: clock.now, beacon: new FakeBeacon(clock) });
    await c2.unlock(PASS);
    expect(c2.status().pending_activation).toBeNull();
    const dec = await c2.activationDeclare({ display: 'Bud', role: 'npc', lanes: ['open'], nonce: 'n2' });
    expect(dec.slot).toBe('slot-04');
    clock.advance(700 * 1000);
    await c2.activationComplete();
    expect(verifyLedger(c2.ledgerJson()).failures).toEqual([]);
  });

  it('recovers a complete-side crash: pending is rebuilt from the public declaration', async () => {
    const { campaign, stateDir, publicDir, clock } = await makeCampaign();
    await campaign.activationDeclare({ display: 'Bud', role: 'npc', lanes: ['open'], nonce: 'n1' });
    clock.advance(700 * 1000);
    await campaign.activationComplete();
    campaign.lock();
    truncateLedger(stateDir); // the activate entry never reached the ledger
    const c2 = new Campaign({ stateDir, publicDir, kdf: KDF, now: clock.now, beacon: new FakeBeacon(clock) });
    await c2.unlock(PASS);
    expect(c2.status().pending_activation?.slot).toBe('slot-04');
    // the adjacency guard holds even in the recovered state
    await expect(c2.note('nope')).rejects.toThrow(/pending activation must complete/);
    const act = await c2.activationComplete();
    expect(act.activation_record.slot).toBe('slot-04');
    await c2.sessionOpen();
    const d = await c2.draw({ slot: 'slot-04', check_type: 'public-gm-check', modifier: 2, dc: 12, context: 'npc acts' });
    expect(d.entry.slot).toBe('slot-04');
    await c2.sessionClose();
    expect(verifyLedger(c2.ledgerJson()).failures).toEqual([]);
    await c2.finalReveal();
    // labels survived the crash: the reveal opens Bud on slot-04
    const fr = c2.ledgerJson().entries.find((e: any) => e.kind === 'final-reveal');
    expect(fr.labels).toEqual([{ slot: 'slot-04', display: 'Bud', role: 'npc' }]);
    expect(verifyLedger(c2.ledgerJson()).failures).toEqual([]);
  });
});

describe('idempotency (§9.2, §6.5)', () => {
  it('the same draw_id replayed 50 times consumes exactly one position', async () => {
    const { campaign } = await makeCampaign();
    await campaign.sessionOpen();
    const results = [];
    for (let i = 0; i < 50; i++) {
      results.push(await campaign.draw({
        draw_id: 'once-only', slot: 'slot-01', check_type: 'rk-general', modifier: 5, dc: 18, context: 'x',
      }));
    }
    expect(results[0].replay).toBe(false);
    expect(results.slice(1).every((r) => r.replay)).toBe(true);
    expect(new Set(results.map((r) => r.entry.seq)).size).toBe(1);
    expect(new Set(results.map((r) => r.roll)).size).toBe(1);
    const draws = campaign.ledgerJson().entries.filter((e: any) => e.kind === 'draw');
    expect(draws.length).toBe(1);
    expect(draws[0].position).toBe(1);
    expect('draw_id' in draws[0]).toBe(false); // transport-level only (§6.5)
  });

  it('the same batch_id is idempotent as a unit', async () => {
    const { campaign } = await makeCampaign();
    for (const [slot, modifier] of [['slot-01', 7], ['slot-02', 5]] as const) {
      await campaign.sheetUpdate({ slot, effective_from: '2026-08-14', modifiers: { Perception: modifier } });
      await campaign.profileDefaults({ slot, defaults: { 'perception-secret': 'Perception' } });
    }
    await campaign.sessionOpen();
    await expect(campaign.batch({
      batch_id: 'overridden', check_type: 'perception-secret', dc: 15,
      slots: [{ slot: 'slot-01', modifier: 7 } as any],
    })).rejects.toThrow(/cannot override/);
    const req = {
      batch_id: 'batch-1', check_type: 'perception-secret', dc: 15,
      slots: [{ slot: 'slot-01' }, { slot: 'slot-02' }],
    };
    const first = await campaign.batch(req);
    for (let i = 0; i < 50; i++) {
      const again = await campaign.batch(req);
      expect(again.replay).toBe(true);
      expect(again.entries.map((e) => e.seq)).toEqual(first.entries.map((e) => e.seq));
    }
    const draws = campaign.ledgerJson().entries.filter((e: any) => e.kind === 'draw');
    expect(draws.length).toBe(2);
    expect(draws.map((d: any) => d.position)).toEqual([1, 1]); // one per lane
    expect(verifyLedger(campaign.ledgerJson()).verdict).toBe('VERIFIED');
  });

  it('a failed batch consumes nothing (atomicity)', async () => {
    const { campaign } = await makeCampaign();
    await campaign.sheetUpdate({ slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Perception: 7 } });
    await campaign.profileDefaults({ slot: 'slot-01', defaults: { 'perception-secret': 'Perception' } });
    await campaign.sessionOpen();
    await expect(campaign.batch({
      batch_id: 'bad', check_type: 'perception-secret', dc: 15,
      slots: [{ slot: 'slot-01' }, { slot: 'slot-99' }],
    })).rejects.toThrow(/unknown slot/);
    expect(campaign.ledgerJson().entries.filter((e: any) => e.kind === 'draw').length).toBe(0);
    // and the lane is not burned: the next draw takes position 1
    const d = await campaign.draw({ slot: 'slot-01', check_type: 'perception-secret', modifier: 7, dc: 15 });
    expect(d.entry.position).toBe(1);
  });
});

describe('modifier profiles and planned draws', () => {
  it('uses complete dated player snapshots and does not fall back after removal', async () => {
    const { campaign } = await makeCampaign();
    await campaign.sheetUpdate({
      slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Society: 5, Occultism: 7 },
    });
    await campaign.profileDefaults({ slot: 'slot-01', defaults: { 'rk-general': 'Society' } });
    await campaign.sessionOpen();
    const first = await campaign.draw({ slot: 'slot-01', check_type: 'rk-general', dc: 18 });
    expect(first.modifier).toBe(5);
    await campaign.sheetUpdate({
      slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Occultism: 9 },
    });
    expect(campaign.tableState().sheets['slot-01']).toEqual({ Occultism: 9 });
    await expect(campaign.draw({ slot: 'slot-01', check_type: 'rk-general', dc: 18 }))
      .rejects.toThrow(/no modifier recorded/);
    const alternate = await campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', profile: 'Occultism', dc: 18,
    });
    expect(alternate.modifier).toBe(9);
    expect(alternate.entry.position).toBe(2);
  });

  it('honors effective dates, same-date sequence order, and the strict draw-seq bound', async () => {
    const { campaign, clock } = await makeCampaign();
    await campaign.sheetUpdate({ slot: 'slot-01', effective_from: '2026-08-15', modifiers: { Society: 9 } });
    await campaign.profileDefaults({ slot: 'slot-01', defaults: { 'rk-general': 'Society' } });
    await campaign.sessionOpen();
    await expect(campaign.draw({ slot: 'slot-01', check_type: 'rk-general' })).rejects.toThrow(/no modifier recorded/);
    expect(campaign.tableState().sheets['slot-01']).toEqual({ Default: 0 });
    clock.advance(24 * 3600 * 1000);
    await campaign.sheetUpdate({ slot: 'slot-01', effective_from: '2026-08-15', modifiers: { Society: 10 } });
    const draw = await campaign.draw({ slot: 'slot-01', check_type: 'rk-general' });
    expect(draw.modifier).toBe(10);
    await campaign.sheetUpdate({ slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Society: 99 } });
    expect((campaign as any).playerSheetMod('slot-01', 'Society', draw.entry.seq, '2026-08-15')).toBe(10);
    expect(campaign.tableState().sheets['slot-01']).toEqual({ Society: 10 });
  });

  it('replaces NPC maps, rejects dates, and keeps defaults private', async () => {
    const { campaign, clock } = await makeCampaign();
    await campaign.activationDeclare({ display: 'Vic', role: 'npc', lanes: ['open', 'deep'], nonce: 'n' });
    clock.advance(700 * 1000);
    await campaign.activationComplete();
    await expect(campaign.sheetUpdate({
      slot: 'slot-04', effective_from: '2026-08-14', modifiers: { Stealth: 8 },
    })).rejects.toThrow(/only valid for player/);
    await campaign.sheetUpdate({ slot: 'slot-04', modifiers: { Stealth: 8, Diplomacy: 3 } });
    await campaign.profileDefaults({ slot: 'slot-04', defaults: {
      'npc-secret': 'Stealth', 'public-gm-check': 'Diplomacy',
    } });
    expect(campaign.tableState().profile_defaults['slot-04']['npc-secret']).toBe('Stealth');
    expect(JSON.stringify(campaign.ledgerJson())).not.toContain('Stealth');
    await campaign.sheetUpdate({ slot: 'slot-04', modifiers: { Diplomacy: 4 } });
    expect(campaign.tableState().npc_sheets['slot-04']).toEqual({ Diplomacy: 4 });
    await campaign.sessionOpen();
    await expect(campaign.draw({ slot: 'slot-04', check_type: 'npc-secret', dc: 18 }))
      .rejects.toThrow(/no modifier recorded/);
  });

  it('rejects malformed profile names at both server write boundaries', async () => {
    const { campaign } = await makeCampaign();
    for (const name of ['', ' padded', 'x'.repeat(65), '__proto__', 'constructor', 'prototype', 'bad\nname', '\ud800']) {
      const modifiers = Object.fromEntries([[name, 4]]);
      await expect(campaign.sheetUpdate({
        slot: 'slot-01', effective_from: '2026-08-14', modifiers,
      }), JSON.stringify(name)).rejects.toThrow(/valid profile names/);
      const defaults = Object.fromEntries([['rk-general', name]]);
      await expect(campaign.profileDefaults({ slot: 'slot-01', defaults }), JSON.stringify(name))
        .rejects.toThrow(/invalid profile name/);
    }
  });

  it('enforces override exclusivity and composes canonical attributable contexts', async () => {
    const { campaign } = await makeCampaign();
    await campaign.sheetUpdate({
      slot: 'slot-01', effective_from: '2026-08-14', modifiers: { 'Lore "Roots"': 6 },
    });
    await campaign.profileDefaults({ slot: 'slot-01', defaults: { 'rk-general': 'Lore "Roots"' } });
    await campaign.sessionOpen();
    await expect(campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', profile: 'Lore "Roots"', modifier: 6,
    })).rejects.toThrow(/mutually exclusive/);
    await expect(campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', context: 'question\n@mod manual',
    })).rejects.toThrow(/must not contain/);
    await expect(campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', context: 'question\u2028@mod "Wrong"',
    })).rejects.toThrow(/must not contain/);
    const profiled = await campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', context: '  remembered trail  \n\t', dc: 17,
    });
    const manual = await campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', modifier: 8, context: 'manual check', dc: 17,
    });
    const preview = campaign.disclosePreview('slot-01', 'sealed', 2);
    expect(preview.draws[0].context).toBe('  remembered trail\n@mod "Lore \\"Roots\\""');
    expect(preview.draws[1].context).toBe('manual check\n@mod manual');
    expect(profiled.entry.context_commit).toMatch(/^[0-9a-f]{64}$/);
    expect(manual.entry.context_commit).toMatch(/^[0-9a-f]{64}$/);
    await campaign.disclose({ slot: 'slot-01', lane: 'sealed', through_position: 2 });
    expect(verifyLedger(campaign.ledgerJson()).verdict).toBe('VERIFIED');
  });

  it('rejects directives in announce context without opening an announcement', async () => {
    const { campaign } = await makeCampaign();
    await campaign.sessionOpen();
    await expect(campaign.announce({
      slot: 'slot-01', check_type: 'rk-cosmology', context: 'purpose\n@mod "Society"',
    })).rejects.toThrow(/must not contain/);
    expect(campaign.tableState().open_announce).toBeNull();
  });

  it('reads the clock once so resolution date and draw timestamp cannot diverge', async () => {
    const { campaign } = await makeCampaign();
    await campaign.sheetUpdate({ slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Society: 5 } });
    await campaign.sheetUpdate({ slot: 'slot-01', effective_from: '2026-08-15', modifiers: { Society: 9 } });
    await campaign.profileDefaults({ slot: 'slot-01', defaults: { 'rk-general': 'Society' } });
    await campaign.sessionOpen();
    let reads = 0;
    (campaign as any).now = () => {
      reads++;
      return Date.parse(reads === 1 ? '2026-08-14T23:59:59Z' : '2026-08-15T00:00:01Z');
    };
    const draw = await campaign.draw({ slot: 'slot-01', check_type: 'rk-general' });
    expect(reads).toBe(1);
    expect(draw.entry.ts).toBe('2026-08-14T23:59:59Z');
    expect(draw.modifier).toBe(5);
  });

  it('plans batch sequences and reopens each sealed context byte-identically', async () => {
    const { campaign } = await makeCampaign();
    await campaign.sheetUpdate({ slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Society: 5 } });
    await campaign.sheetUpdate({ slot: 'slot-02', effective_from: '2026-08-14', modifiers: { Occultism: 7 } });
    await campaign.profileDefaults({ slot: 'slot-01', defaults: { 'rk-general': 'Society' } });
    await campaign.profileDefaults({ slot: 'slot-02', defaults: { 'rk-general': 'Occultism' } });
    await campaign.sessionOpen();
    const batch = await campaign.batch({
      batch_id: 'planned', check_type: 'rk-general', dc: 20, context: 'shared question',
      slots: [{ slot: 'slot-01' }, { slot: 'slot-02' }],
    });
    expect(batch.entries.map((e) => e.seq)).toEqual([batch.entries[0].seq, batch.entries[0].seq + 1]);
    expect(new Set(batch.entries.map((e) => e.ts)).size).toBe(1);
    await campaign.disclose({ slot: 'slot-01', lane: 'sealed', through_position: 1 });
    await campaign.disclose({ slot: 'slot-02', lane: 'sealed', through_position: 1 });
    const opened = campaign.ledgerJson().entries.filter((e: any) => e.kind === 'disclose')
      .flatMap((e: any) => e.opened).filter((e: any) => 'context' in e);
    expect(opened.map((e: any) => e.context)).toEqual([
      'shared question\n@mod "Society"', 'shared question\n@mod "Occultism"',
    ]);
    expect(verifyLedger(campaign.ledgerJson()).verdict).toBe('VERIFIED');
  });

  it('cross-checks profile attribution identically in all three verifiers', async () => {
    const { campaign, clock, stateDir } = await makeCampaign();
    await campaign.sheetUpdate({
      slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Society: 5 },
    });
    await campaign.sheetUpdate({
      slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Society: 6 },
    });
    // Present in the ledger but not yet applicable to the first two draws.
    await campaign.sheetUpdate({
      slot: 'slot-01', effective_from: '2026-08-16', modifiers: { Society: 8 },
    });
    await campaign.profileDefaults({ slot: 'slot-01', defaults: { 'rk-general': 'Society' } });
    await campaign.sessionOpen();
    const profiled = await campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', context: 'profiled check',
    });
    const manual = await campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', modifier: 9, context: 'manual check',
    });
    // Same effective date and a later seq would win without the strict seq < draw.seq rule.
    await campaign.sheetUpdate({
      slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Society: 99 },
    });
    clock.advance(2 * 24 * 3600 * 1000);
    const future = await campaign.draw({
      slot: 'slot-01', check_type: 'rk-general', context: 'future check',
    });

    const sealed = await verifyModifierParity(campaign.ledgerJson());
    expect(sealed.verdict).toBe('VERIFIED');
    expect(sealed.modifier_checks.find((c) => c.seq === profiled.entry.seq))
      .toMatchObject({ attribution: 'sealed', status: 'sealed', modifier: 6 });

    await campaign.disclose({ slot: 'slot-01', lane: 'sealed', through_position: 3 });
    const base = campaign.ledgerJson();
    const verified = await verifyModifierParity(base);
    expect(verified.verdict).toBe('VERIFIED');
    expect(verified.modifier_checks.find((c) => c.seq === profiled.entry.seq))
      .toMatchObject({ attribution: 'profile', profile: 'Society', modifier: 6, sheet_modifier: 6, status: 'match' });
    expect(verified.modifier_checks.find((c) => c.seq === manual.entry.seq))
      .toMatchObject({ attribution: 'manual', modifier: 9, sheet_modifier: null, status: 'manual_override' });
    expect(verified.modifier_checks.find((c) => c.seq === future.entry.seq))
      .toMatchObject({ attribution: 'profile', modifier: 8, sheet_modifier: 8, status: 'match' });

    const priorSnapshot = (ledger: any) => ledger.entries.find((e: any) =>
      e.kind === 'sheet-update' && e.seq < profiled.entry.seq && e.modifiers?.Society === 6);
    const mismatch = structuredClone(base);
    priorSnapshot(mismatch).modifiers.Society = 7;
    const mismatchResult = await verifyModifierParity(rehashLedger(mismatch));
    expect(mismatchResult.verdict).toBe('VERIFIED');
    expect(mismatchResult.modifier_checks.find((c) => c.seq === profiled.entry.seq)?.status).toBe('mismatch');

    const omitted = structuredClone(base);
    priorSnapshot(omitted).modifiers = {};
    const omittedResult = await verifyModifierParity(rehashLedger(omitted));
    expect(omittedResult.modifier_checks.find((c) => c.seq === profiled.entry.seq))
      .toMatchObject({ sheet_modifier: null, status: 'unavailable' });

    const material = secretMaterial(stateDir, base);
    const rewriteContext = (source: any, context: string) => {
      const ledger = structuredClone(source);
      const draw = ledger.entries[profiled.entry.seq];
      const links = material.links.get(`${draw.slot}/${draw.lane}`)!;
      draw.context_commit = C.contextCommit(C.preimageAt(links, draw.position), draw.seq, context);
      const opened = ledger.entries.filter((e: any) => e.kind === 'disclose')
        .flatMap((e: any) => e.opened).find((e: any) => e.seq === draw.seq);
      opened.context = context;
      return rehashLedger(ledger);
    };

    const legacy = structuredClone(base);
    priorSnapshot(legacy).modifiers['rk-general'] = 6;
    const legacyResult = await verifyModifierParity(rewriteContext(legacy, 'legacy context'));
    expect(legacyResult.modifier_checks.find((c) => c.seq === profiled.entry.seq))
      .toMatchObject({ attribution: 'legacy', sheet_modifier: 6, status: 'match' });
    expect(legacyResult.advisories).toContain(
      `modifier: seq ${profiled.entry.seq} legacy/unattributed context`);

    for (const context of [
      '@mod "Society"\nnot final',
      'duplicate\n@mod "Society"\n@mod "Society"',
      'invalid\n@mod {"name":"Society"}',
      'noncanonical\n@mod "\\u0053ociety"',
    ]) {
      const result = await verifyModifierParity(rewriteContext(base, context));
      expect(result.verdict).toBe('VERIFIED');
      expect(result.modifier_checks.find((c) => c.seq === profiled.entry.seq))
        .toMatchObject({ attribution: 'malformed', status: 'malformed' });
    }

    // Advisory output remains cross-verifier-identical even when the hard
    // structure verdict has already failed.
    const bothContextForms = structuredClone(base);
    bothContextForms.entries[profiled.entry.seq].context = 'invalid dual form\n@mod manual';
    const dualResult = await verifyModifierParity(rehashLedger(bothContextForms));
    expect(dualResult.verdict).toBe('FAILED');
    expect(dualResult.modifier_checks.find((c) => c.seq === profiled.entry.seq))
      .toMatchObject({ attribution: 'manual', status: 'manual_override' });

    const fractionalModifier = structuredClone(base);
    fractionalModifier.entries[profiled.entry.seq].modifier = 6.5;
    // Floats are not canonical protocol JSON, so this deliberately retains
    // the stale hash and exercises advisory parity on a multiply-invalid file.
    const fractionalResult = await verifyModifierParity(fractionalModifier);
    expect(fractionalResult.verdict).toBe('FAILED');
    expect(fractionalResult.modifier_checks.find((c) => c.seq === profiled.entry.seq))
      .toMatchObject({ attribution: 'profile', modifier: null, status: 'sealed' });
  });

  it('leaves all batch state untouched when a later member lacks a profile', async () => {
    const { campaign, stateDir } = await makeCampaign();
    await campaign.sheetUpdate({ slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Perception: 7 } });
    await campaign.profileDefaults({ slot: 'slot-01', defaults: { 'perception-secret': 'Perception' } });
    await campaign.profileDefaults({ slot: 'slot-02', defaults: {} });
    await campaign.sessionOpen();
    const beforeEntries = campaign.ledgerJson().entries.length;
    const beforePrivate = readFileSync(join(stateDir, 'private.enc'), 'utf8');
    const beforeCursor = new Map((campaign as any).cursor);
    const beforeConcerned = new Map((campaign as any).maxConcerned);
    await expect(campaign.batch({
      batch_id: 'missing', check_type: 'perception-secret', dc: 18,
      slots: [{ slot: 'slot-01' }, { slot: 'slot-02' }],
    })).rejects.toThrow(/no modifier recorded/);
    expect(campaign.ledgerJson().entries.length).toBe(beforeEntries);
    expect(readFileSync(join(stateDir, 'private.enc'), 'utf8')).toBe(beforePrivate);
    expect(new Map((campaign as any).cursor)).toEqual(beforeCursor);
    expect(new Map((campaign as any).maxConcerned)).toEqual(beforeConcerned);
    await campaign.sheetUpdate({ slot: 'slot-02', effective_from: '2026-08-14', modifiers: { Perception: 5 } });
    await campaign.profileDefaults({ slot: 'slot-02', defaults: { 'perception-secret': 'Perception' } });
    const retry = await campaign.batch({
      batch_id: 'retry', check_type: 'perception-secret', dc: 18,
      slots: [{ slot: 'slot-01' }, { slot: 'slot-02' }],
    });
    expect(retry.entries.map((e) => e.position)).toEqual([1, 1]);
  });
});

describe('append-only (§6.3)', () => {
  it('refuses to start on a tampered ledger', async () => {
    const { campaign, stateDir, publicDir, clock } = await makeCampaign();
    await campaign.sessionOpen();
    await campaign.draw({ slot: 'slot-01', check_type: 'rk-general', modifier: 5, dc: 18 });
    await campaign.publish();
    campaign.lock();
    const p = join(stateDir, 'ledger.json');
    const text = readFileSync(p, 'utf8');
    writeFileSync(p, text.replace('"session": 1', '"session": 9'));
    const c2 = new Campaign({ stateDir, publicDir, kdf: KDF, now: clock.now });
    await expect(c2.unlock(PASS)).rejects.toThrow(/refusing to unlock/);
    expect(c2.locked).toBe(true);
  });
});

describe('lock state over HTTP (§6.4, §9.2)', () => {
  it('boots locked, serves public data, refuses to draw, rate-limits unlock', async () => {
    const { campaign, stateDir, publicDir, clock } = await makeCampaign();
    await campaign.sessionOpen();
    await campaign.draw({ slot: 'slot-01', check_type: 'rk-general', modifier: 5, dc: 18 });
    await campaign.publish();
    campaign.lock();
    const fresh = new Campaign({ stateDir, publicDir, kdf: KDF, now: clock.now });
    expect(fresh.locked).toBe(true); // §12.11: comes up locked
    const server = createServer(fresh, { now: clock.now });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      expect((await fetch(`${base}/api/status`)).status).toBe(200);
      expect((await fetch(`${base}/api/ledger`)).status).toBe(200); // already-public data stays readable
      const drawRes = await fetch(`${base}/api/draw`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(drawRes.status).toBe(423); // drawing is impossible while locked
      for (let i = 0; i < 5; i++) {
        const r = await fetch(`${base}/api/unlock`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ passphrase: 'wrong' }),
        });
        expect(r.status).toBe(401);
      }
      const limited = await fetch(`${base}/api/unlock`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase: PASS }),
      });
      expect(limited.status).toBe(429); // rate limit hits even a correct passphrase
      clock.advance(16 * 60_000);
      const ok = await fetch(`${base}/api/unlock`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase: PASS }),
      });
      expect(ok.status).toBe(200);
      const auth = (await ok.json()).auth_token;
      const unauthorized = await fetch(`${base}/api/draw`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(unauthorized.status).toBe(401);
      const sheet = await fetch(`${base}/api/sheet-update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
        body: JSON.stringify({ slot: 'slot-01', effective_from: '2026-08-14', modifiers: { Society: 5 } }),
      });
      expect(sheet.status).toBe(200);
      const defaults = await fetch(`${base}/api/profile-defaults`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
        body: JSON.stringify({ slot: 'slot-01', defaults: { 'rk-general': 'Society' } }),
      });
      expect(defaults.status).toBe(200);
      const draw = await fetch(`${base}/api/draw`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
        body: JSON.stringify({ slot: 'slot-01', check_type: 'rk-general', dc: 12, context: 'via http' }),
      });
      expect(draw.status).toBe(200);
      expect((await draw.json()).roll).toBeGreaterThanOrEqual(1);
    } finally {
      server.close();
    }
  });
});

describe('reveal-all ordering (§7.3.9)', () => {
  it('writes the public entry before returning any value', async () => {
    const { campaign } = await makeCampaign();
    await campaign.sessionOpen();
    await campaign.draw({ slot: 'slot-01', check_type: 'rk-general', modifier: 5, dc: 18, context: 'peeked' });
    const { entry, values } = await campaign.revealAll('all');
    expect(values.length).toBe(1);
    expect(values[0].roll).toBeGreaterThanOrEqual(1);
    const ledger = campaign.ledgerJson();
    const ra = ledger.entries.find((e: any) => e.kind === 'reveal-all');
    expect(ra.seq).toBe(entry.seq); // durably in the ledger players will see
  });
});

describe('restore from backup (§6.7, §12.13)', () => {
  it('wipe state, restore, resume with correct cursors, disclose historical position', async () => {
    const { campaign, stateDir, publicDir, clock } = await makeCampaign();
    await campaign.sessionOpen();
    for (let i = 0; i < 8; i++) {
      await campaign.draw({ slot: 'slot-01', check_type: 'rk-general', modifier: 5, dc: 10 + i, context: `draw ${i}` });
    }
    await campaign.sessionClose();
    await campaign.disclose({ slot: 'slot-01', lane: 'sealed', through_position: 3 });
    campaign.lock();
    // find the latest backup pair, wipe state/, restore only from the backup
    const backupDir = join(stateDir, 'backups');
    const tags = [...new Set(readdirSync(backupDir).map((f) => f.split('-')[0]))].sort();
    const latest = tags[tags.length - 1];
    const restoreDir = tmp();
    cpSync(join(backupDir, `${latest}-ledger.json`), join(restoreDir, 'ledger.json'));
    cpSync(join(backupDir, `${latest}-private.enc`), join(restoreDir, 'private.enc'));
    rmSync(stateDir, { recursive: true, force: true }); // the wipe
    const restored = new Campaign({ stateDir: restoreDir, publicDir, kdf: KDF, now: clock.now });
    await restored.unlock(PASS);
    const table = restored.tableState();
    expect(table.lanes['slot-01/sealed'].drawn).toBe(8);
    expect(table.lanes['slot-01/sealed'].watermark).toBe(3);
    // disclose deeper into history: opens positions 4..6 with their sealed values
    const entry = await restored.disclose({ slot: 'slot-01', lane: 'sealed', through_position: 6 });
    expect(entry.opened.length).toBeGreaterThan(0);
    const res = verifyLedger(restored.ledgerJson());
    expect(res.failures).toEqual([]);
    expect(res.verdict).toBe('VERIFIED');
  });
});

describe('rehearsal mode (§7.8)', () => {
  it('publishes into its own directory so the whole ceremony can be rehearsed', async () => {
    const { campaign, publicDir } = await makeCampaign({ rehearsal: true });
    await campaign.sessionOpen();
    await campaign.draw({ slot: 'slot-01', check_type: 'rk-general', modifier: 5, dc: 18 });
    await campaign.sessionClose();
    const pub = await campaign.publish();
    // the artifact is real and verifiable — this is what makes a dress run
    // of the session-close wizard and the player verifier meaningful
    const artifact = JSON.parse(readFileSync(join(publicDir, 'ledger.json'), 'utf8'));
    expect(verifyLedger(artifact).failures).toEqual([]);
    expect(artifact.head).toBe(pub.head);
    // but it announces itself as throwaway, and never reaches a mirror
    expect(pub.digest).toContain('REHEARSAL');
    expect(pub.mirror).toBeNull();
  });

  it('refuses to publish at all if a git mirror is configured', async () => {
    const { campaign } = await makeCampaign({ rehearsal: true, mirrorCommand: 'true' });
    await campaign.sessionOpen();
    await campaign.draw({ slot: 'slot-01', check_type: 'rk-general', modifier: 5, dc: 18 });
    await expect(campaign.publish()).rejects.toThrow(/must not be configured with a git mirror/);
  });

  it('keeps development rehearsal off both real directories', async () => {
    // Rehearsal publishes, and an activation declaration publishes on its
    // own, so sharing the development public directory would let a dress run
    // overwrite a real development ledger.
    const run = (rehearsalMode: boolean) => spawnSync(
      'node', ['--import', 'tsx', join(TEST_DIR, '../server/index.ts')],
      {
        encoding: 'utf8', timeout: 20_000, cwd: join(TEST_DIR, '..'),
        env: {
          ...process.env, COLUMN_PRINT_DIRS: '1', COLUMN_PORT: '0',
          ...(rehearsalMode ? { COLUMN_REHEARSAL: '1' } : {}),
          COLUMN_STATE_DIR: '', COLUMN_PUBLIC_DIR: '',
        },
      },
    ).stdout.trim().split('\n');
    const [realState, realPublic] = run(false);
    const [rehState, rehPublic] = run(true);
    expect(rehState).not.toBe(realState);
    expect(rehPublic).not.toBe(realPublic);
    expect(rehState.startsWith(realState)).toBe(true); // nested, not scattered
    expect(rehPublic.startsWith(realPublic)).toBe(true);
  }, 40_000);

  it('uses a configured state directory exactly as given', async () => {
    // The module points the unit at a directory and grants write access to
    // exactly that path. The server used to append "rehearsal" to whatever
    // it was told, so any directory not literally named "rehearsal" sent the
    // service outside its own ReadWritePaths. Exercised through the real
    // entry point, since that is where the rewriting lived.
    const dir = tmp();
    const stateDir = join(dir, 'dress-run');
    const publicDir = join(dir, 'dress-public');
    const res = spawnSync('node', ['--import', 'tsx', join(TEST_DIR, '../server/index.ts')], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        COLUMN_REHEARSAL: '1',
        COLUMN_STATE_DIR: stateDir,
        COLUMN_PUBLIC_DIR: publicDir,
        COLUMN_BIND: '127.0.0.1',
        COLUMN_PORT: '0',
        COLUMN_PRINT_DIRS: '1', // print resolved paths and exit
      },
    });
    expect(res.stderr).toBe('');
    expect(res.stdout.trim()).toBe(`${stateDir}\n${publicDir}`);
  }, 40_000);

  it('is structurally unpromotable: real-mode server refuses rehearsal state', async () => {
    const { campaign, stateDir, publicDir, clock } = await makeCampaign({ rehearsal: true });
    campaign.lock();
    // simulate copying state/rehearsal/* over state/ and dropping the env var
    const promoted = new Campaign({ stateDir, publicDir, kdf: KDF, now: clock.now });
    await expect(promoted.unlock(PASS)).rejects.toThrow(/cannot be promoted/);
    expect(promoted.locked).toBe(true);
  });
});

describe('full final reveal', () => {
  it('is atomic against a concurrent attempt to open another session', async () => {
    const { campaign } = await makeCampaign();
    await campaign.sessionOpen();
    await campaign.draw({ slot: 'slot-01', check_type: 'rk-general', modifier: 5, dc: 18 });
    await campaign.sessionClose();
    const [reveal, reopen] = await Promise.allSettled([
      campaign.finalReveal(), campaign.sessionOpen(),
    ]);
    expect(reveal.status).toBe('fulfilled');
    expect(reopen.status).toBe('rejected');
    const ledger = campaign.ledgerJson();
    expect(ledger.entries.at(-1).kind).toBe('final-reveal');
    expect(verifyLedger(ledger).failures).toEqual([]);
  });

  it('phase 5 produces a fully-revealed ledger both verifiers accept', async () => {
    const { campaign, clock, stateDir } = await makeCampaign();
    await campaign.sessionOpen();
    await campaign.draw({ slot: 'slot-01', check_type: 'rk-general', modifier: 5, dc: 18, context: 'one' });
    await campaign.draw({ slot: 'slot-03', check_type: 'world-routine', modifier: 8, dc: 14, context: 'two' });
    await campaign.sessionClose();
    await campaign.activationDeclare({ display: 'Bud', role: 'npc', lanes: ['open'], nonce: 'n1' });
    clock.advance(700_000);
    await campaign.activationComplete();
    await campaign.sessionOpen();
    await campaign.draw({ slot: 'slot-04', check_type: 'public-gm-check', modifier: 2, dc: 10, context: 'npc' });
    await campaign.sessionClose();
    await campaign.finalReveal();
    await campaign.close('test over');
    const ledger = campaign.ledgerJson();
    const res = verifyLedger(ledger);
    expect(res.failures).toEqual([]);
    expect(res.state).toBe('fully revealed');
    expect(JSON.stringify(ledger)).toContain('Bud'); // labels open at final reveal
    const py = spawnSync('python3', [VERIFY_PY, join(stateDir, 'ledger.json')], { encoding: 'utf8' });
    expect(py.stderr).toBe('');
    expect(py.stdout).toContain('VERIFIED (fully revealed)');
    expect(py.status).toBe(0);
  });
});
