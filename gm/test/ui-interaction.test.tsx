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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Campaign } from '../server/campaign.ts';
import { createServer } from '../server/http.ts';
import { verifyLedger } from '../core/verify.ts';
import { App } from '../src/App';
import { api } from '../src/api';
import { SUGGESTED_REGISTRY } from '../src/views/Setup';

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
    campaign: 'UI Test', chain_length: 200, context_privacy: 'sealed' as const,
    disclosure_policy: 'test', reserve_total: 10,
    check_types: SUGGESTED_REGISTRY,
    active_slots: [
      { display: 'Alice', role: 'player', lanes: ['sealed', 'open'], nonce: 'a' },
      { display: 'Bob', role: 'player', lanes: ['sealed', 'open'], nonce: 'b' },
      { display: 'Cara', role: 'player', lanes: ['sealed', 'open'], nonce: 'c' },
      { display: 'Dan', role: 'player', lanes: ['sealed', 'open'], nonce: 'd' },
      { display: 'Eve', role: 'player', lanes: ['sealed', 'open'], nonce: 'e' },
      { display: 'Fenn', role: 'npc', lanes: ['open', 'deep'], nonce: 'f' },
      { display: 'Gale', role: 'npc', lanes: ['open', 'deep'], nonce: 'g' },
      { display: 'Hale', role: 'npc', lanes: ['open', 'deep'], nonce: 'h' },
      { display: 'Iris', role: 'npc', lanes: ['open', 'deep'], nonce: 'i' },
      { display: 'the world', role: 'world', lanes: ['open', 'routine', 'deep'], nonce: 'w' },
    ],
  };
  await campaign.freezeGenesisConfiguration(genesisInput);
  await campaign.genesis(genesisInput);
  const today = new Date().toISOString().slice(0, 10);
  await campaign.sheetUpdate({
    slot: 'slot-01', effective_from: today,
    modifiers: { Society: 5, Perception: 7, Occultism: 4 },
  });
  const playerDefaults = Object.fromEntries(SUGGESTED_REGISTRY
    .filter((type) => type.roles.includes('player'))
    .map((type) => [type.id, type.id === 'cosmology-major' ? 'Occultism'
      : type.id === 'perception-secret' || type.id === 'sense-motive' ? 'Perception' : 'Society']));
  await campaign.profileDefaults({ slot: 'slot-01', defaults: playerDefaults });
  await campaign.sheetUpdate({
    slot: 'slot-02', effective_from: today,
    modifiers: { Society: 6, Perception: 5, Occultism: 3 },
  });
  await campaign.profileDefaults({ slot: 'slot-02', defaults: playerDefaults });
  for (const [slot, modifier] of [['slot-03', 4], ['slot-04', 3], ['slot-05', 2]] as const) {
    await campaign.sheetUpdate({
      slot, effective_from: today,
      modifiers: { Society: modifier, Perception: modifier, Occultism: modifier },
    });
    await campaign.profileDefaults({ slot, defaults: playerDefaults });
  }
  await campaign.sessionOpen();
  server = createServer(campaign);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  (globalThis as any).__API_BASE = `http://127.0.0.1:${(server.address() as any).port}`;
  await api('/api/unlock', { passphrase: PASS });
  await api('/api/ui-state', { bench: ['slot-06', 'slot-07', 'slot-08'] });
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

    // A fourth pin must not reshuffle or discard the three keyboard-assigned
    // NPCs; it remains visible as pinned without a numeric hotkey.
    fireEvent.click(screen.getByText(/NPCs —/));
    fireEvent.click(screen.getByRole('button', { name: 'pin' }));
    await waitFor(() => expect((campaign.tableState().ui_state as { bench?: string[] } | null)?.bench)
      .toEqual(['slot-06', 'slot-07', 'slot-08', 'slot-09']));
    expect(screen.getByText(/NPCs — 4 pinned; 3\/3 hotkeys/)).toBeTruthy();

    // The full keyboard map is a usability invariant: five players, three
    // pinned NPCs, and the world's two lanes occupy all ten digit keys.
    for (const [key, name] of [['1', 'Alice'], ['2', 'Bob'], ['3', 'Cara'], ['4', 'Dan'], ['5', 'Eve'], ['6', 'Fenn'], ['7', 'Gale'], ['8', 'Hale'], ['9', 'the world'], ['0', 'the world']]) {
      fireEvent.keyDown(window, { key });
      await waitFor(() => expect(document.querySelector('.armedbar .who')?.textContent).toContain(name));
    }
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.armedbar .who')?.textContent).toContain('press 1–5, 6–8, 9/0');

    // ---- arm once: digit selects the slot, a letter selects the check type
    fireEvent.keyDown(window, { key: '1' });
    const chip = await screen.findByText('rk-general');
    const hotkey = chip.closest('button')!.querySelector('.keycap')!.textContent!;
    fireEvent.keyDown(window, { key: hotkey });
    expect(document.activeElement).toBe(document.body); // zero typing
    expect(document.querySelector('.type-divider')).not.toBeNull();
    expect(screen.getByTitle('from profile Society').textContent).toContain('Society +5');

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
    await waitFor(() => expect(draws()).toHaveLength(7));
    const batch = draws().slice(2);
    expect(batch.map((e: any) => e.slot).sort()).toEqual(['slot-01', 'slot-02', 'slot-03', 'slot-04', 'slot-05']);
    expect(new Set(batch.map((e: any) => e.batch)).size).toBe(1); // atomic, shared id
    expect(document.activeElement).toBe(document.body);

    // the roll appeared in the session log (GM sees the value live)
    await waitFor(() => expect(document.querySelectorAll('.log .roll').length).toBeGreaterThanOrEqual(4));
  }, 20_000);

  it('selects the existing DC when d reopens the editor', async () => {
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: 'd' });
    let input = await screen.findByLabelText('DC') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: '10' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'd' });
    input = await screen.findByLabelText('DC') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(2);

    fireEvent.change(input, { target: { value: '12oops' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(document.body.textContent).toContain('DC must be an integer'));
    expect(screen.getByLabelText('DC')).toBeTruthy();

    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: '12' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'd' });
    input = await screen.findByLabelText('DC') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Escape' });
  });

  it('the privacy key veils results and NPC names instantly (§7.3.10)', async () => {
    fireEvent.keyDown(window, { key: '6' });
    await waitFor(() => expect(document.querySelector('.armedbar .who .veilable')?.textContent).toBe('Fenn'));
    fireEvent.keyDown(window, { key: '.' });
    await waitFor(() => expect(document.querySelectorAll('.log .roll.veiled').length).toBeGreaterThan(0));
    expect(document.querySelector('.armedbar .who .veilable')?.classList).toContain('veiled');
    fireEvent.keyDown(window, { key: '.' });
    await waitFor(() => expect(document.querySelectorAll('.log .roll.veiled')).toHaveLength(0));
    expect(document.querySelector('.armedbar .who .veilable')?.classList).not.toContain('veiled');
  });

  it('cycles alternate profiles, retains refusals, and clears on re-arm, batch, and success', async () => {
    fireEvent.keyDown(window, { key: '1' });
    const rk = await screen.findByText('rk-general');
    fireEvent.keyDown(window, { key: rk.closest('button')!.querySelector('.keycap')!.textContent! });
    const beforeSheets = campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update').length;

    fireEvent.keyDown(window, { key: ',' });
    expect((await screen.findByTitle('pending profile Occultism')).textContent).toContain('Occultism +4');
    fireEvent.click(screen.getByText('make default'));
    await waitFor(() => expect(campaign.tableState().profile_defaults['slot-01']['rk-general']).toBe('Occultism'));
    expect(campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update')).toHaveLength(beforeSheets);
    // Restore the fixture's default through the same action; pending state
    // remains explicit throughout both private default changes.
    fireEvent.keyDown(window, { key: ',' });
    fireEvent.keyDown(window, { key: ',' });
    fireEvent.click(screen.getByText('make default'));
    await waitFor(() => expect(campaign.tableState().profile_defaults['slot-01']['rk-general']).toBe('Society'));
    fireEvent.keyDown(window, { key: ',' });
    expect(screen.getByTitle('pending profile Occultism')).toBeTruthy();

    // A server refusal retains the exact client-side choice.
    await campaign.sessionClose();
    const before = draws().length;
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(document.body.textContent).toContain('draws require an open session'));
    expect(draws()).toHaveLength(before);
    expect(screen.getByTitle('pending profile Occultism')).toBeTruthy();
    await campaign.publish();
    await campaign.sessionOpen();

    // Re-arming a slot clears it.
    fireEvent.keyDown(window, { key: '2' });
    expect(screen.getByTitle('from profile Society').textContent).toContain('Society +6');

    // A check-type change clears it too.
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: ',' });
    const perception = screen.getByText('perception-secret');
    fireEvent.keyDown(window, { key: perception.closest('button')!.querySelector('.keycap')!.textContent! });
    expect(screen.getByTitle('from profile Perception').textContent).toContain('Perception +7');

    // Entering batch clears and disables both override controls.
    fireEvent.keyDown(window, { key: rk.closest('button')!.querySelector('.keycap')!.textContent! });
    fireEvent.keyDown(window, { key: ',' });
    fireEvent.keyDown(window, { key: 'b' });
    const batchProfile = screen.getByTitle('from profile Society') as HTMLButtonElement;
    expect(batchProfile.disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'm' });
    await waitFor(() => expect(document.body.textContent).toContain('manual modifiers are disabled during a batch'));
    fireEvent.keyDown(window, { key: 'Escape' });

    // A successful alternate draw records attribution and returns to default.
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: rk.closest('button')!.querySelector('.keycap')!.textContent! });
    fireEvent.keyDown(window, { key: ',' });
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(draws()).toHaveLength(before + 1));
    const alternate = draws().at(-1);
    expect(alternate.modifier).toBe(4);
    expect(alternate.context_commit).toBeDefined();
    expect(campaign.disclosePreview(alternate.slot, alternate.lane, alternate.position)
      .draws.find((draw: any) => draw.seq === alternate.seq)?.context).toContain('@mod "Occultism"');
    expect(screen.getByTitle('from profile Society')).toBeTruthy();
    expect(campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update')).toHaveLength(beforeSheets);
  }, 20_000);

  it('ritual types open announce-then-reveal instead of drawing (§7.3.4)', async () => {
    fireEvent.keyDown(window, { key: '1' });
    const chip = await screen.findByText('cosmology-major');
    fireEvent.keyDown(window, { key: chip.closest('button')!.querySelector('.keycap')!.textContent! });
    const before = draws().length;
    fireEvent.keyDown(window, { key: 'Enter' });
    // no draw yet — the context sheet is up instead
    await screen.findByText(/RITUAL DRAW/);
    expect(draws()).toHaveLength(before);
    const ritualDc = document.querySelector('.ceremony .dcchip input') as HTMLInputElement;
    fireEvent.change(ritualDc, { target: { value: '17oops' } });
    fireEvent.click(screen.getByText('Announce'));
    await waitFor(() => expect(document.body.textContent).toContain('DC must be an integer'));
    expect(campaign.ledgerJson().entries.at(-1).kind).not.toBe('announce');
    fireEvent.change(ritualDc, { target: { value: '' } });
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

  it('a missing modifier is visible, while m supplies a one-off without changing sheets', async () => {
    // A draw is refused outright without a modifier. The warning is visible
    // first, and the one-off manual value goes only on the draw request. The
    // World normally has its genesis Default; remove the mapping explicitly
    // to exercise the recovery path before 9 arms its routine lane.
    await campaign.profileDefaults({ slot: 'slot-10', defaults: {} });
    cleanup(); render(<App />);
    await screen.findByText('Alice');
    fireEvent.keyDown(window, { key: '9' });
    await screen.findByText('world-routine');

    // the warning is on screen before anything is committed
    const modChip = await screen.findByTitle(/no default profile modifier recorded/);
    expect(modChip.textContent).toContain('not set');

    const before = draws().length;
    const beforeSheets = campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update').length;
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(document.body.textContent).toContain('no modifier recorded'));
    expect(draws()).toHaveLength(before);

    fireEvent.keyDown(window, { key: 'm' });
    const manual = await screen.findByLabelText('manual modifier');
    fireEvent.change(manual, { target: { value: '-2' } });
    fireEvent.keyDown(manual, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTitle('manual override').textContent).toContain('manual -2'));
    expect(campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update')).toHaveLength(beforeSheets);
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(draws()).toHaveLength(before + 1));
    expect(draws().at(-1).mod_commit).toBeDefined();
    expect(campaign.tableState().npc_sheets['slot-10']).toEqual({ Default: 0 });
    expect(campaign.tableState().profile_defaults['slot-10']).toEqual({});
    expect(campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update')).toHaveLength(beforeSheets);
    await campaign.profileDefaults({
      slot: 'slot-10',
      defaults: Object.fromEntries(SUGGESTED_REGISTRY
        .filter((type) => type.roles.includes('world'))
        .map((type) => [type.id, 'Default'])),
    });
  }, 20_000);

  it('saves filled late DCs before close and refuses C without an open session', async () => {
    fireEvent.keyDown(window, { key: '1' });
    const rk = await screen.findByText('rk-general');
    fireEvent.keyDown(window, { key: rk.closest('button')!.querySelector('.keycap')!.textContent! });
    const before = draws().length;
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(draws()).toHaveLength(before + 1));
    const target = draws().at(-1);
    expect(target.dc).toBeUndefined();
    expect(target.dc_commit).toBeUndefined();

    fireEvent.keyDown(window, { key: 'C' });
    const input = await screen.findByLabelText(`DC for draw ${target.seq}`);
    fireEvent.change(input, { target: { value: '19' } });
    // The final action must honor filled rows without requiring each small
    // per-row button to be clicked first.
    fireEvent.click(screen.getByText('Close, disclose open lanes, publish'));
    await screen.findByText(/Published\. Post this digest/);
    await waitFor(() => expect(campaign.status().session_open).toBe(false));
    expect(campaign.ledgerJson().entries.filter((entry: any) =>
      entry.kind === 'dc-late' && entry.target_seq === target.seq)).toHaveLength(1);

    fireEvent.click(screen.getByText('Done'));
    fireEvent.keyDown(window, { key: 'C' });
    expect(document.querySelector('.overlay')).toBeNull();
    expect(await screen.findByText('no session is open — press O to open one or P to publish')).toBeTruthy();

    // Restore the shared fixture for the remaining interaction tests.
    fireEvent.keyDown(window, { key: 'O' });
    await waitFor(() => expect(campaign.status().session_open).toBe(true));
  }, 20_000);

  it('warns before an atomic batch when one player has no default profile', async () => {
    const defaults = { ...campaign.tableState().profile_defaults['slot-05'] };
    delete defaults['rk-general'];
    await api('/api/profile-defaults', { slot: 'slot-05', defaults });
    cleanup(); render(<App />);
    await screen.findByText('Alice');

    fireEvent.keyDown(window, { key: '1' });
    const rk = screen.getByText('rk-general');
    fireEvent.keyDown(window, { key: rk.closest('button')!.querySelector('.keycap')!.textContent! });
    fireEvent.keyDown(window, { key: 'b' });
    expect(await screen.findByText('batch needs a modifier for Eve')).toBeTruthy();

    await api('/api/profile-defaults', { slot: 'slot-05', defaults: { ...defaults, 'rk-general': 'Society' } });
    fireEvent.keyDown(window, { key: 'Escape' });
  }, 20_000);
  it('voiding clears the ANNOUNCED state instead of resurrecting it', async () => {
    // The resolution and the recovery effect race: the overlay closes while
    // the refresh is still in flight, so a stale open_announce could rebuild
    // ANNOUNCED for a ritual that no longer exists — leaving the GM staring
    // at Reveal/Void for something already voided.
    fireEvent.keyDown(window, { key: '2' });
    const chip = await screen.findByText('cosmology-major');
    fireEvent.keyDown(window, { key: chip.closest('button')!.querySelector('.keycap')!.textContent! });
    fireEvent.keyDown(window, { key: ',' });
    expect(screen.getByTitle('pending profile Perception')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Enter' });
    await screen.findByText(/RITUAL DRAW/);
    fireEvent.click(screen.getByText('Announce'));
    await screen.findByText('ANNOUNCED');
    const ritualDc = screen.getByLabelText('ritual DC') as HTMLInputElement;
    ritualDc.focus();
    fireEvent.change(ritualDc, { target: { value: '2' } });
    expect(document.activeElement).toBe(ritualDc);
    fireEvent.change(ritualDc, { target: { value: '23' } });
    expect(document.activeElement).toBe(ritualDc);
    fireEvent.click(screen.getByText('m — manual'));
    fireEvent.change(screen.getByLabelText('ritual manual modifier'), { target: { value: '-4' } });

    const before = draws().length;
    fireEvent.click(screen.getByText(/^Void/));
    await screen.findByText('VOID');
    fireEvent.click(screen.getByText('back'));
    expect(await screen.findByText('ANNOUNCED')).toBeTruthy();
    expect(screen.getByText('Selected Perception +5')).toBeTruthy();
    expect((screen.getByLabelText('ritual DC') as HTMLInputElement).value).toBe('23');
    expect((screen.getByLabelText('ritual manual modifier') as HTMLInputElement).value).toBe('-4');
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
    expect(screen.getByTitle('from profile Occultism')).toBeTruthy();
    expect(verifyLedger(campaign.ledgerJson()).failures).toEqual([]);
  }, 20_000);

  it('recovers the ANNOUNCED state from the server after the client loses it', async () => {
    // An announcement is public and can only be resolved by a draw or a
    // void. If the client forgets it — a reload mid-ritual, or a reveal the
    // server refused — the GM must still be offered both, or the ledger is
    // stuck with an unresolved announce and no UI route to finish it.
    fireEvent.keyDown(window, { key: '1' });
    const chip = await screen.findByText('cosmology-major');
    fireEvent.keyDown(window, { key: chip.closest('button')!.querySelector('.keycap')!.textContent! });
    fireEvent.keyDown(window, { key: ',' });
    expect(screen.getByTitle('pending profile Perception')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Enter' });
    await screen.findByText(/RITUAL DRAW/);
    fireEvent.click(screen.getByText('Announce'));
    await screen.findByText('ANNOUNCED');
    expect(campaign.ledgerJson().entries.at(-1).kind).toBe('announce');

    // throw the client state away, exactly as a browser reload would
    cleanup();
    render(<App />);

    // The overlay comes back, but cannot silently substitute the default for
    // the client-only selection that was lost in the reload.
    await screen.findByText('ANNOUNCED');
    expect((screen.getByText(/^Reveal/) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/^Void/)).toBeTruthy();
    expect(screen.getByText('Confirm a modifier before Reveal.')).toBeTruthy();

    fireEvent.click(screen.getByText('use current default'));
    expect((screen.getByText(/^Reveal/) as HTMLButtonElement).disabled).toBe(false);

    // Both recovery profile controls remain explicit: comma cycles away from
    // the default, and the selector can choose a different named profile.
    fireEvent.keyDown(document.querySelector('.overlay')!, { key: ',' });
    expect(screen.getByText('Selected Perception +7')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('ritual profile'), { target: { value: 'Society' } });
    expect(screen.getByText('Selected Society +5')).toBeTruthy();

    // Enter in the recoverable DC field reveals with the re-entered profile;
    // it must not be swallowed by the form-control keyboard guard.
    const before = draws().length;
    const dc = screen.getByLabelText('ritual DC');
    fireEvent.change(dc, { target: { value: '22' } });
    fireEvent.keyDown(dc, { key: 'Enter' });
    await waitFor(() => expect(draws()).toHaveLength(before + 1));
    const recovered = draws().at(-1);
    expect(recovered.announce_seq).toBeDefined();
    expect(recovered.modifier).toBe(5);
    expect(recovered.dc_commit).toBeDefined();
    expect(campaign.disclosePreview(recovered.slot, recovered.lane, recovered.position)
      .draws.find((draw: any) => draw.seq === recovered.seq)?.context).toContain('@mod "Society"');
    expect(verifyLedger(campaign.ledgerJson()).failures).toEqual([]);
    fireEvent.keyDown(document.querySelector('.overlay')!, { key: 'Enter' });
  }, 20_000);

  it('re-enters a manual modifier after recovering an ANNOUNCED ritual', async () => {
    await waitFor(() => expect(document.querySelector('.overlay')).toBeNull());
    fireEvent.keyDown(window, { key: 'Escape' });
    const aliceCard = screen.getAllByText('Alice').find((element) => element.closest('.slotarm'))!;
    fireEvent.click(aliceCard.closest('button')!);
    const chip = await screen.findByText('cosmology-major');
    fireEvent.keyDown(window, { key: chip.closest('button')!.querySelector('.keycap')!.textContent! });
    fireEvent.keyDown(window, { key: 'Enter' });
    await screen.findByText(/RITUAL DRAW/);
    fireEvent.click(screen.getByText('Announce'));
    await screen.findByText('ANNOUNCED');

    cleanup();
    render(<App />);
    const overlay = (await screen.findByText('ANNOUNCED')).closest('.overlay') as HTMLElement;
    expect((screen.getByText(/^Reveal/) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(overlay, { key: 'm' });
    let manual = await screen.findByLabelText('ritual manual modifier') as HTMLInputElement;
    expect(document.activeElement).toBe(manual);
    fireEvent.change(manual, { target: { value: '-' } });
    expect(document.activeElement).toBe(manual);
    expect(manual.value).toBe('-');
    fireEvent.change(manual, { target: { value: 'not-an-integer' } });
    expect(document.activeElement).toBe(manual);
    expect((screen.getByText(/^Reveal/) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(manual, { target: { value: '-3' } });
    expect(document.activeElement).toBe(manual);
    expect((screen.getByText(/^Reveal/) as HTMLButtonElement).disabled).toBe(false);

    // Enter commits and unmounts the focused input. Focus must return to the
    // ceremony so its next hotkey works without a mysterious background click.
    fireEvent.keyDown(manual, { key: 'Enter' });
    await waitFor(() => expect(document.activeElement).toBe(overlay));
    expect(screen.getByText('Selected manual -3')).toBeTruthy();
    fireEvent.keyDown(overlay, { key: 'm' });
    manual = await screen.findByLabelText('ritual manual modifier') as HTMLInputElement;
    expect(document.activeElement).toBe(manual);
    fireEvent.keyDown(manual, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(overlay));

    // The profile hotkey must likewise remain live after that handoff, and a
    // completed selector choice hands focus back from the <select>.
    fireEvent.keyDown(overlay, { key: ',' });
    await waitFor(() => expect(document.activeElement).toBe(overlay));
    expect(screen.getByText('Selected Perception +7')).toBeTruthy();
    fireEvent.keyDown(overlay, { key: 'm' });
    manual = await screen.findByLabelText('ritual manual modifier') as HTMLInputElement;
    fireEvent.change(manual, { target: { value: '-3' } });

    const before = draws().length;
    fireEvent.click(screen.getByText(/^Reveal/));
    await waitFor(() => expect(draws()).toHaveLength(before + 1));
    const recovered = draws().at(-1);
    expect(recovered.modifier).toBe(-3);
    const preview = campaign.disclosePreview(recovered.slot, recovered.lane, recovered.position)
      .draws.find((draw: any) => draw.seq === recovered.seq);
    expect(preview?.context).toContain('@mod manual');
    // The ceremony emphasizes the resolved check total; the arithmetic below
    // still exposes the raw d20 so natural-1/20 adjustments remain legible.
    expect(document.querySelector('.ceremony .numeral')?.textContent)
      .toBe(String(preview.roll + recovered.modifier));
    expect(document.querySelector('.ceremony .sub')?.textContent)
      .toContain(`${preview.roll} -3 = ${preview.roll - 3}`);
    fireEvent.keyDown(document.querySelector('.overlay')!, { key: 'Enter' });
  }, 20_000);

  it('attributes correction redraws to an explicit target-scoped profile', async () => {
    cleanup();
    render(<App />);
    await screen.findByText('Alice');
    await waitFor(() => expect(document.querySelector('.overlay')).toBeNull());
    const aliceCard = screen.getAllByText('Alice').find((element) => element.closest('.slotarm'))!;
    fireEvent.click(aliceCard.closest('button')!);
    const rk = await screen.findByText('rk-general');
    fireEvent.click(rk.closest('button')!);
    const beforeRoutine = draws().length;
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(draws()).toHaveLength(beforeRoutine + 1));

    fireEvent.keyDown(window, { key: 'U' });
    await screen.findByText('Correct the last draw');
    const target = screen.getByDisplayValue('— no redraw —') as HTMLSelectElement;
    fireEvent.change(target, { target: { value: 'slot-02' } });
    const profile = screen.getByLabelText('correction profile') as HTMLSelectElement;
    fireEvent.change(profile, { target: { value: 'Occultism' } });
    const before = draws().length;
    fireEvent.click(screen.getByText('Write correction'));
    await waitFor(() => expect(draws()).toHaveLength(before + 1));
    const replacement = draws().at(-1);
    expect(replacement.slot).toBe('slot-02');
    expect(campaign.disclosePreview(replacement.slot, replacement.lane, replacement.position)
      .draws.find((draw: any) => draw.seq === replacement.seq)?.context).toContain('@mod "Occultism"');
  }, 20_000);

  it('reuses one replacement draw after an ambiguous correction-draw response', async () => {
    cleanup(); render(<App />);
    await screen.findByText('Alice');
    await waitFor(() => expect(document.querySelector('.overlay')).toBeNull());
    const aliceCard = screen.getAllByText('Alice').find((element) => element.closest('.slotarm'))!;
    fireEvent.click(aliceCard.closest('button')!);
    fireEvent.click((await screen.findByText('rk-general')).closest('button')!);
    const beforeOriginal = draws().length;
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(draws()).toHaveLength(beforeOriginal + 1));

    fireEvent.keyDown(window, { key: 'U' });
    await screen.findByText('Correct the last draw');
    fireEvent.change(screen.getByDisplayValue('— no redraw —'), { target: { value: 'slot-02' } });
    fireEvent.change(screen.getByLabelText('correction profile'), { target: { value: 'Occultism' } });

    const originalFetch = globalThis.fetch;
    let dropDrawResponse = true;
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (dropDrawResponse && String(input).endsWith('/api/draw') && init?.method === 'POST') {
        dropDrawResponse = false;
        throw new TypeError('simulated lost draw response');
      }
      return response;
    };
    try {
      const before = draws().length;
      fireEvent.click(screen.getByText('Write correction'));
      await waitFor(() => expect(draws()).toHaveLength(before + 1));
      expect(await screen.findByText('Correct the last draw')).toBeTruthy();
      fireEvent.click(screen.getByText('Write correction'));
      await waitFor(() => expect(document.querySelector('.overlay')).toBeNull());
      expect(draws()).toHaveLength(before + 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 20_000);

  it('/sheets saves complete named snapshots, defaults, and dateless NPC maps', async () => {
    fireEvent.click(screen.getByText('sheets'));
    const aliceHeading = await screen.findByRole('heading', { name: /Alice/ });
    const alicePane = aliceHeading.closest('.pane') as HTMLElement;
    const today = new Date().toISOString().slice(0, 10);
    expect((within(alicePane).getByLabelText('effective from') as HTMLInputElement).value).toBe(today);
    fireEvent.change(within(alicePane).getByLabelText('Society modifier'), { target: { value: '11' } });
    fireEvent.change(within(alicePane).getByLabelText('profile 1 name'), { target: { value: 'Civics' } });
    fireEvent.click(within(alicePane).getByRole('button', { name: 'delete Perception' }));
    fireEvent.click(within(alicePane).getByText('Save profiles & defaults'));
    await waitFor(() => {
      const latest = campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update' && e.slot === 'slot-01').at(-1);
      expect(latest.modifiers).toEqual({ Civics: 11, Occultism: 4 });
      expect(latest.effective_from).toBe(today);
      expect(campaign.tableState().profile_defaults['slot-01']['rk-general']).toBe('Civics');
      expect(campaign.tableState().profile_defaults['slot-01']['perception-secret']).toBeUndefined();
    });
    await waitFor(() => expect(within(alicePane).getByText('Save profiles & defaults')).toBeTruthy());

    // A future-only rename cannot also become an immediate private default:
    // the combined endpoint rejects both halves, leaving no dangling pointer.
    fireEvent.change(within(alicePane).getByLabelText('profile 2 name'), { target: { value: 'Esoterica' } });
    fireEvent.change(within(alicePane).getByLabelText('effective from'), { target: { value: '2099-01-02' } });
    const beforeFutureRefusal = campaign.ledgerJson().entries
      .filter((entry: any) => entry.kind === 'sheet-update').length;
    fireEvent.click(within(alicePane).getByText('Save profiles & defaults'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('is not available'));
    expect(campaign.ledgerJson().entries.filter((entry: any) => entry.kind === 'sheet-update'))
      .toHaveLength(beforeFutureRefusal);
    expect(campaign.tableState().profile_defaults['slot-01']['cosmology-major']).toBe('Occultism');
    await waitFor(() => expect(within(alicePane).getByText('Save profiles & defaults')).toBeTruthy());

    // Scheduling values under names that already exist now is safe. A reload
    // edits the currently applicable sheet and reports the separate schedule.
    fireEvent.change(within(alicePane).getByLabelText('profile 2 name'), { target: { value: 'Occultism' } });
    fireEvent.change(within(alicePane).getByLabelText('Occultism modifier'), { target: { value: '8' } });
    fireEvent.click(within(alicePane).getByText('Save profiles & defaults'));
    await waitFor(() => expect(campaign.ledgerJson().entries
      .filter((entry: any) => entry.kind === 'sheet-update' && entry.slot === 'slot-01').at(-1))
      .toMatchObject({ effective_from: '2099-01-02', modifiers: { Civics: 11, Occultism: 8 } }));
    expect(campaign.tableState().sheets['slot-01']).toEqual({ Civics: 11, Occultism: 4 });
    await waitFor(() => expect(
      (within(alicePane).getByLabelText('effective from') as HTMLInputElement).value,
    ).toBe(today));
    expect((within(alicePane).getByLabelText('Occultism modifier') as HTMLInputElement).value).toBe('4');

    cleanup();
    render(<App />);
    fireEvent.click(await screen.findByText('sheets'));
    const reloadedAlice = (await screen.findByRole('heading', { name: /Alice/ })).closest('.pane') as HTMLElement;
    expect((within(reloadedAlice).getByLabelText('profile 2 name') as HTMLInputElement).value).toBe('Occultism');
    expect((within(reloadedAlice).getByLabelText('Occultism modifier') as HTMLInputElement).value).toBe('4');
    expect((within(reloadedAlice).getByLabelText('effective from') as HTMLInputElement).value).toBe(today);
    expect((within(reloadedAlice).getByLabelText('cosmology-major') as HTMLSelectElement).selectedOptions[0].textContent)
      .toBe('Occultism');
    expect(within(reloadedAlice).getByText(/separate snapshot is scheduled for 2099-01-02/)).toBeTruthy();

    const beforeNoop = campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update').length;
    fireEvent.click(within(reloadedAlice).getByText('Save profiles & defaults'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('profile snapshot unchanged'));
    await waitFor(() => expect(within(reloadedAlice).getByText('Save profiles & defaults')).toBeTruthy());
    expect(campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update')).toHaveLength(beforeNoop);

    fireEvent.click(within(reloadedAlice).getByRole('button', { name: 'delete Civics' }));
    fireEvent.click(within(reloadedAlice).getByRole('button', { name: 'delete Occultism' }));
    fireEvent.click(within(reloadedAlice).getByText('Save profiles & defaults'));
    expect(screen.getByRole('status').textContent).toContain('public profile snapshot cannot be empty');
    expect(campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update')).toHaveLength(beforeNoop);

    // Invalid input rejects the combined save without changing either side;
    // retrying after correction appends exactly one public entry.
    const bobPane = (await screen.findByRole('heading', { name: /Bob/ })).closest('.pane') as HTMLElement;
    const bobDefaults = { ...campaign.tableState().profile_defaults['slot-02'] };
    fireEvent.change(within(bobPane).getByLabelText('profile 1 name'), { target: { value: 'Diplomacy' } });
    fireEvent.change(within(bobPane).getByLabelText('effective from'), { target: { value: '' } });
    const beforeRefusal = campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update').length;
    fireEvent.click(within(bobPane).getByText('Save profiles & defaults'));
    await waitFor(() => expect(screen.getByRole('status').textContent)
      .toContain('effective_from must be a real'));
    expect(campaign.tableState().profile_defaults['slot-02']).toEqual(bobDefaults);
    expect(campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update')).toHaveLength(beforeRefusal);
    await waitFor(() => expect(within(bobPane).getByText('Save profiles & defaults')).toBeTruthy());

    fireEvent.change(within(bobPane).getByLabelText('effective from'), { target: { value: today } });
    fireEvent.click(within(bobPane).getByText('Save profiles & defaults'));
    await waitFor(() => expect(campaign.ledgerJson().entries.filter((e: any) => e.kind === 'sheet-update'))
      .toHaveLength(beforeRefusal + 1));

    const fennHeading = await screen.findByRole('heading', { name: /Fenn/ });
    const fennPane = fennHeading.closest('.pane') as HTMLElement;
    expect(within(fennPane).queryByLabelText('effective from')).toBeNull();
    fireEvent.click(within(fennPane).getByText('+ add profile'));
    fireEvent.change(within(fennPane).getByLabelText('profile 1 name'), { target: { value: 'Stealth' } });
    fireEvent.change(within(fennPane).getByLabelText('Stealth modifier'), { target: { value: '4' } });
    const npcDefault = within(fennPane).getByLabelText('npc-secret') as HTMLSelectElement;
    const stealth = within(npcDefault).getByRole('option', { name: 'Stealth' }) as HTMLOptionElement;
    fireEvent.change(npcDefault, { target: { value: stealth.value } });
    fireEvent.click(within(fennPane).getByText('Save profiles & defaults'));
    await waitFor(() => {
      expect(campaign.tableState().npc_sheets['slot-06']).toEqual({ Stealth: 4 });
      expect(campaign.tableState().profile_defaults['slot-06']['npc-secret']).toBe('Stealth');
    });
  }, 20_000);

});
