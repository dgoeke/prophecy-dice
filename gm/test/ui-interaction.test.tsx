// @vitest-environment jsdom
/**
 * Acceptance criterion 4, verified by script — not by inspection:
 *   "A routine draw is one keystroke with zero typing; a party-wide batch
 *    is two interactions."
 *
 * The real React app is mounted in jsdom against a REAL server (Campaign +
 * node:http on an ephemeral port). Keyboard events go through the app's
 * actual handler; assertions read the server's ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Campaign } from '../server/campaign.ts';
import { createServer } from '../server/http.ts';
import { verifyLedger } from '../core/verify.ts';
import { App } from '../src/App';
import { api } from '../src/api';

const PASS = 'test-passphrase';
const KDF = { N: 2 ** 12, r: 8, p: 1 };
const dirs: string[] = [];
let campaign: Campaign;
let server: ReturnType<typeof createServer>;

const draws = () => campaign.ledgerJson().entries.filter((e: any) => e.kind === 'draw');

beforeAll(async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'column-ui-'));
  const publicDir = mkdtempSync(join(tmpdir(), 'column-ui-pub-'));
  dirs.push(stateDir, publicDir);
  campaign = new Campaign({ stateDir, publicDir, kdf: KDF, minPrecommitAgeMs: 0 });
  await campaign.precommit(PASS);
  const genesisInput = {
    campaign: 'UI Test', chain_length: 200, context_privacy: 'plain' as const,
    disclosure_policy: 'test', reserve_total: 6,
    check_types: [
      { id: 'rk-general', label: 'Recall Knowledge — general', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: false },
      { id: 'perception-secret', label: 'Secret Perception', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: false },
      { id: 'rk-cosmology', label: 'RK — cosmology', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: true },
      { id: 'world-routine', label: 'World — routine', lane: 'routine', roles: ['world'], seal_dc: true, seal_modifier: true, ritual: false },
    ],
    active_slots: [
      { display: 'Alice', role: 'player', lanes: ['sealed', 'open'], nonce: 'a' },
      { display: 'Bob', role: 'player', lanes: ['sealed', 'open'], nonce: 'b' },
      { display: 'the world', role: 'world', lanes: ['open', 'routine'], nonce: 'w' },
    ],
  };
  await campaign.freezeGenesisConfiguration(genesisInput);
  await campaign.genesis(genesisInput);
  await campaign.sheetUpdate({
    slot: 'slot-01', effective_from: '2026-08-14',
    modifiers: { 'rk-general': 5, 'perception-secret': 7, 'rk-cosmology': 4 },
  });
  await campaign.sheetUpdate({
    slot: 'slot-02', effective_from: '2026-08-14',
    modifiers: { 'rk-general': 6, 'perception-secret': 5, 'rk-cosmology': 3 },
  });
  await campaign.sessionOpen();
  server = createServer(campaign);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  (globalThis as any).__API_BASE = `http://127.0.0.1:${(server.address() as any).port}`;
  await api('/api/unlock', { passphrase: PASS });
});

afterAll(() => {
  cleanup();
  server?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('the /table keyboard (§7.3, criterion 4)', () => {
  it('one keystroke draws; a batch is two interactions; zero typing throughout', async () => {
    render(<App />);
    // the table view loads with the roster
    await screen.findByText('Alice');

    // ---- arm once: digit selects the slot, a letter selects the check type
    fireEvent.keyDown(window, { key: '1' });
    const chip = await screen.findByText('rk-general');
    const hotkey = chip.closest('button')!.querySelector('.keycap')!.textContent!;
    fireEvent.keyDown(window, { key: hotkey });
    expect(document.activeElement).toBe(document.body); // zero typing

    // ---- first draw
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(draws()).toHaveLength(1));
    expect(draws()[0].slot).toBe('slot-01');
    expect(draws()[0].check_type).toBe('rk-general');

    // ---- THE criterion: arming is sticky, so a routine draw is ONE keystroke
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(draws()).toHaveLength(2));
    expect(draws()[1].position).toBe(2);
    expect(document.activeElement).toBe(document.body); // still zero typing

    // ---- party-wide batch: exactly two interactions ('b', Enter)
    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(draws()).toHaveLength(4));
    const batch = draws().slice(2);
    expect(batch.map((e: any) => e.slot).sort()).toEqual(['slot-01', 'slot-02']);
    expect(new Set(batch.map((e: any) => e.batch)).size).toBe(1); // atomic, shared id
    expect(document.activeElement).toBe(document.body);

    // the roll appeared in the session log (GM sees the value live)
    const rolls = document.querySelectorAll('.log .roll');
    expect(rolls.length).toBeGreaterThanOrEqual(4);
  }, 20_000);

  it('the privacy key veils results and NPC names instantly (§7.3.10)', async () => {
    fireEvent.keyDown(window, { key: '.' });
    await waitFor(() => expect(document.querySelectorAll('.log .roll.veiled').length).toBeGreaterThan(0));
    fireEvent.keyDown(window, { key: '.' });
    await waitFor(() => expect(document.querySelectorAll('.log .roll.veiled')).toHaveLength(0));
  });

  it('ritual types open announce-then-reveal instead of drawing (§7.3.4)', async () => {
    fireEvent.keyDown(window, { key: '1' });
    const chip = await screen.findByText('rk-cosmology');
    fireEvent.keyDown(window, { key: chip.closest('button')!.querySelector('.keycap')!.textContent! });
    const before = draws().length;
    fireEvent.keyDown(window, { key: 'Enter' });
    // no draw yet — the context sheet is up instead
    await screen.findByText(/RITUAL DRAW/);
    expect(draws()).toHaveLength(before);
    // announce, then reveal
    fireEvent.click(screen.getByText('Announce'));
    await screen.findByText('ANNOUNCED');
    expect(campaign.ledgerJson().entries.at(-1).kind).toBe('announce');
    fireEvent.click(screen.getByText(/^Reveal/));
    await waitFor(() => expect(draws()).toHaveLength(before + 1));
    expect(draws().at(-1).announce_seq).toBeDefined();
    // the giant numeral is on screen
    await waitFor(() => expect(document.querySelector('.ceremony .numeral')).toBeTruthy());
    fireEvent.keyDown(document.querySelector('.overlay')!, { key: 'Enter' });
  }, 20_000);

  it('a missing modifier is visible before Enter and fixable with one key', async () => {
    // A draw is refused outright without a modifier. Discovering that from
    // the error, mid-scene, is the failure this guards against: the armed
    // bar has to say so first, and `m` has to fix it without leaving /table.
    // 9 arms the world's routine lane; the world has no sheet in this fixture
    fireEvent.keyDown(window, { key: '9' });
    await screen.findByText('world-routine');

    // the warning is on screen before anything is committed
    const modChip = await screen.findByTitle(/no modifier recorded/);
    expect(modChip.textContent).toContain('not set');

    // pressing m opens the inline field; entering a value records the sheet
    const before = draws().length;
    fireEvent.keyDown(window, { key: 'm' });
    const input = await waitFor(() => {
      const el = document.querySelector('.dcchip input') as HTMLInputElement;
      expect(el).toBeTruthy();
      return el;
    });
    fireEvent.keyDown(input, { key: 'Enter', target: { value: '6' } });
    await waitFor(() => expect(screen.getByTitle('from the sheet').textContent).toContain('+6'));
    expect(draws()).toHaveLength(before); // recording a modifier is not a draw

    // and now the draw the GM originally wanted just works, one keystroke
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(draws()).toHaveLength(before + 1));
    expect(draws().at(-1).slot).toBe('slot-03');
    // world-routine seals its modifier, so the value is committed not published
    expect(draws().at(-1).mod_commit).toMatch(/^[0-9a-f]{64}$/);
  }, 20_000);
  it('voiding clears the ANNOUNCED state instead of resurrecting it', async () => {
    // The resolution and the recovery effect race: the overlay closes while
    // the refresh is still in flight, so a stale open_announce could rebuild
    // ANNOUNCED for a ritual that no longer exists — leaving the GM staring
    // at Reveal/Void for something already voided.
    fireEvent.keyDown(window, { key: '2' });
    const chip = await screen.findByText('rk-cosmology');
    fireEvent.keyDown(window, { key: chip.closest('button')!.querySelector('.keycap')!.textContent! });
    fireEvent.keyDown(window, { key: 'Enter' });
    await screen.findByText(/RITUAL DRAW/);
    fireEvent.click(screen.getByText('Announce'));
    await screen.findByText('ANNOUNCED');

    const before = draws().length;
    fireEvent.click(screen.getByText(/^Void/));
    await screen.findByText('VOID');
    fireEvent.click(screen.getByText('Write the void'));

    // the void lands and the overlay stays gone
    await waitFor(() => expect(
      campaign.ledgerJson().entries.filter((e: any) => e.kind === 'void'),
    ).toHaveLength(1));
    await waitFor(() => expect(document.querySelector('.overlay')).toBeNull());
    // give the recovery effect every chance to resurrect it
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector('.overlay')).toBeNull();
    expect(screen.queryByText('ANNOUNCED')).toBeNull();

    expect(draws()).toHaveLength(before); // a void consumes no position
    expect(verifyLedger(campaign.ledgerJson()).failures).toEqual([]);
  }, 20_000);

  it('recovers the ANNOUNCED state from the server after the client loses it', async () => {
    // An announcement is public and can only be resolved by a draw or a
    // void. If the client forgets it — a reload mid-ritual, or a reveal the
    // server refused — the GM must still be offered both, or the ledger is
    // stuck with an unresolved announce and no UI route to finish it.
    fireEvent.keyDown(window, { key: '1' });
    const chip = await screen.findByText('rk-cosmology');
    fireEvent.keyDown(window, { key: chip.closest('button')!.querySelector('.keycap')!.textContent! });
    fireEvent.keyDown(window, { key: 'Enter' });
    await screen.findByText(/RITUAL DRAW/);
    fireEvent.click(screen.getByText('Announce'));
    await screen.findByText('ANNOUNCED');
    expect(campaign.ledgerJson().entries.at(-1).kind).toBe('announce');

    // throw the client state away, exactly as a browser reload would
    cleanup();
    render(<App />);

    // the overlay comes back, offering both resolutions
    await screen.findByText('ANNOUNCED');
    expect(screen.getByText(/^Reveal/)).toBeTruthy();
    expect(screen.getByText(/^Void/)).toBeTruthy();

    // and revealing from the recovered overlay resolves it correctly
    const before = draws().length;
    fireEvent.click(screen.getByText(/^Reveal/));
    await waitFor(() => expect(draws()).toHaveLength(before + 1));
    expect(draws().at(-1).announce_seq).toBeDefined();
    expect(verifyLedger(campaign.ledgerJson()).failures).toEqual([]);
    fireEvent.keyDown(document.querySelector('.overlay')!, { key: 'Enter' });
  }, 20_000);

});
