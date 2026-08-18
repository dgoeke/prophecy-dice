// @vitest-environment jsdom
/**
 * DOM smoke test for verify.html's report rendering: loads the real page
 * markup into jsdom, runs the real verifier, and renders the report.
 * Catches render-path exceptions the headless logic tests can't see.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '../../spec/vectors.json'), 'utf8'));
const html = readFileSync(join(here, '../../verifier/verify.html'), 'utf8');

let col: any;

beforeAll(async () => {
  document.body.innerHTML = html.match(/<body>([\s\S]*)<script>/)![1];
  new Function(html.match(/<script>([\s\S]*)<\/script>/)![1])();
  col = (globalThis as any).__column;
  await col.selfTest();
});

describe('verify.html rendering', () => {
  it('renders VERIFIED (fully revealed) for the toy ledger', async () => {
    const res = await col.verifyLedger(vectors.ledger.ledger);
    col.render(res);
    const verdict = document.getElementById('verdict')!.textContent!;
    expect(verdict).toContain('VERIFIED (fully revealed)');
    expect(verdict).not.toContain('✗');
    const report = document.getElementById('report')!.textContent!;
    expect(report).toContain('Post-reveal audit');
    expect(report).toContain('unconsumed');
    expect(report).toContain('slot-05'); // never-activated slot named
  });
  it('renders sealed rows as sealed, never as errors (criterion 6)', async () => {
    // truncate before any disclose: state is sealed, verdict still VERIFIED
    const entries = vectors.ledger.ledger.entries;
    const firstDisclose = entries.findIndex((e: any) => e.kind === 'disclose');
    const truncated = {
      format: 'wotw-column-ledger/4',
      head: entries[firstDisclose - 1].hash,
      entries: entries.slice(0, firstDisclose),
    };
    const res = await col.verifyLedger(truncated);
    // an unresolved trailing announce is legal only as the final entry; the
    // truncation point may leave resolved ones — verdict must be VERIFIED
    expect(res.verdict).toBe('VERIFIED');
    expect(res.state).toBe('sealed');
    col.render(res);
    const verdict = document.getElementById('verdict')!.textContent!;
    expect(verdict).toContain('VERIFIED (sealed)');
    expect(verdict).toContain('normal mid-campaign state');
    const report = document.getElementById('report')!.textContent!;
    expect(report).toContain('sealed');
  });
  it('renders FAILED with the specific message for a tampered ledger', async () => {
    const res = await col.verifyLedger(vectors.negative_ledgers[0].ledger);
    col.render(res);
    const verdict = document.getElementById('verdict')!.textContent!;
    expect(verdict).toContain('FAILED');
    expect(verdict).toContain(vectors.negative_ledgers[0].expected_message);
  });
  it('renders every modifier-attribution advisory state', async () => {
    const res = await col.verifyLedger(vectors.ledger.ledger);
    const row = (seq: number, attribution: string, status: string, profile: string | null = null) => ({
      seq, slot: 'slot-01', check_type: 'rk-general', date: '2026-08-14', modifier: 5,
      attribution, profile, sheet_modifier: status === 'unavailable' ? null : 5, status,
    });
    res.modifier_checks = [
      row(1, 'profile', 'match', 'Society'), row(2, 'profile', 'mismatch', 'Occultism'),
      row(3, 'manual', 'manual_override'), row(4, 'legacy', 'legacy'),
      row(5, 'malformed', 'malformed'), row(6, 'profile', 'unavailable', 'Arcana'),
      row(7, 'sealed', 'sealed'),
    ];
    col.render(res);
    const report = document.getElementById('report')!.textContent!;
    for (const phrase of ['Society', 'differs (advisory)', 'manual override', 'deliberate override',
      'legacy / unattributed', 'malformed directive (advisory)',
      'no applicable profile value (advisory)', 'sealed']) {
      expect(report).toContain(phrase);
    }
  });
  it('keeps the disclosure panel non-collapsible and complete (criterion 7)', () => {
    const panel = document.getElementById('panel')!;
    expect(panel.querySelector('details')).toBeNull();
    const text = panel.textContent!;
    for (const phrase of ['omission is undetectable', 'weak for routine',
      'memory is weak', 'statistical audit', 'commitment scheme with delayed opening']) {
      expect(text).toContain(phrase);
    }
  });
});
