/**
 * Runs the <script> from verify.html headlessly in Node and holds it to the
 * same frozen vectors as the TS and Python verifiers — including the exact
 * negative-case failure messages. verify.html is a third independent
 * implementation (§6.1: duplication is the point), so it gets the same arbiter.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '../../spec/vectors.json'), 'utf8'));
const html = readFileSync(join(here, '../../verifier/verify.html'), 'utf8');

type Column = {
  verifyLedger: (file: unknown, progress?: (m: string) => void) => Promise<any>;
  canonical: (v: unknown) => string;
  sha256: (b: Uint8Array) => string;
  rollFromPreimage: (p: Uint8Array) => number;
  degreeOf: (roll: number, mod: number, dc: number) => number;
  selfTest: () => Promise<void>;
};
let col: Column;

beforeAll(async () => {
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('no <script> in verify.html');
  // The script guards all DOM access behind `if (globalThis.document)` and
  // publishes its internals on globalThis.__column.
  new Function(m[1])();
  col = (globalThis as any).__column;
  await col.selfTest();
});

describe('verify.html crypto core', () => {
  it('is a single file with no external requests', () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/https?:\/\/[^\s"']*\.(js|css)/);
  });
  it('canonical JSON matches vectors', () => {
    for (const c of vectors.canonical_json) {
      expect(col.canonical(c.value), c.name).toBe(c.canonical);
    }
  });
  it('rolls match vectors', () => {
    for (const ld of vectors.draws) {
      for (const d of ld.draws) {
        expect(col.rollFromPreimage(Buffer.from(d.preimage, 'hex'))).toBe(d.roll);
      }
    }
  });
  it('degrees match vectors', () => {
    for (const d of vectors.degrees) {
      expect(col.degreeOf(d.roll, d.modifier, d.dc)).toBe(d.degree);
    }
  });
});

describe('verify.html ledger verification', () => {
  it('verifies the toy ledger with every roll derived', async () => {
    const res = await col.verifyLedger(vectors.ledger.ledger);
    expect(res.failures).toEqual([]);
    expect(res.verdict).toBe('VERIFIED');
    expect(res.state).toBe('fully revealed');
    for (const er of vectors.ledger.expected_rolls) {
      expect(res.rolls[er.seq], `seq ${er.seq}`).toBe(er.roll);
    }
  });
  for (const neg of vectors.negative_ledgers) {
    it(`negative: ${neg.name}`, async () => {
      const res = await col.verifyLedger(neg.ledger);
      expect(res.verdict).toBe('FAILED');
      expect(res.failures).toContain(neg.expected_message);
    });
  }
});
