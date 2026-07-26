import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLedger } from '../core/verify.ts';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '../../spec/vectors.json'), 'utf8'));

describe('toy ledger (§9.1 item 10)', () => {
  const res = verifyLedger(vectors.ledger.ledger);

  it('verifies with no failures', () => {
    expect(res.failures).toEqual([]);
    expect(res.verdict).toBe('VERIFIED');
  });
  it('is fully revealed with 80 entries', () => {
    expect(res.state).toBe('fully revealed');
    expect(res.entries).toBe(vectors.ledger.entry_count);
    expect(res.entries).toBe(80);
  });
  it('derives every expected roll', () => {
    for (const er of vectors.ledger.expected_rolls) {
      expect(res.rolls[er.seq], `seq ${er.seq}`).toBe(er.roll);
    }
  });
  it('exercises every entry kind', () => {
    const kinds = new Set(vectors.ledger.ledger.entries.map((e: any) => e.kind));
    for (const k of ['genesis', 'session-open', 'session-close', 'announce', 'draw', 'void',
      'correction', 'dc-late', 'out-of-band', 'disclose', 'sheet-update',
      'activation-declare', 'activate', 'retire-slot', 'note', 'reveal-all', 'final-reveal', 'closed']) {
      expect(kinds.has(k), `kind ${k}`).toBe(true);
    }
  });
});

describe('negative ledgers (§9.1 item 11)', () => {
  it('has exactly 24 cases', () => {
    expect(vectors.negative_ledgers.length).toBe(24);
  });
  for (const neg of vectors.negative_ledgers) {
    it(`${neg.name} → "${neg.expected_message}"`, () => {
      const res = verifyLedger(neg.ledger);
      expect(res.verdict).toBe('FAILED');
      expect(res.failures).toContain(neg.expected_message);
    });
  }
});
