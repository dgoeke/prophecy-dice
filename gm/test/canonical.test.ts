import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalString } from '../core/canonical.ts';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '../../spec/vectors.json'), 'utf8'));

describe('canonical JSON vectors (§9.1 item 1)', () => {
  for (const c of vectors.canonical_json) {
    it(c.name, () => {
      const s = canonicalString(c.value);
      expect(s).toBe(c.canonical);
      expect(createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')).toBe(c.sha256);
    });
  }
});

describe('canonical JSON errors', () => {
  it('rejects floats', () => expect(() => canonicalString({ x: 1.5 })).toThrow(/non-integer/));
  it('rejects NaN/Infinity', () => {
    expect(() => canonicalString(NaN)).toThrow();
    expect(() => canonicalString(Infinity)).toThrow();
  });
  it('rejects out-of-range integers', () =>
    expect(() => canonicalString(2 ** 53 + 2)).toThrow(/out of range/));
  it('rejects duplicate keys after NFC', () =>
    // 'café' composed vs 'cafe' + combining acute — distinct JS keys, same NFC
    expect(() => canonicalString({ 'café': 1, 'café': 2 })).toThrow(/duplicate key/));
  it('rejects undefined and functions', () => {
    expect(() => canonicalString(undefined)).toThrow();
    expect(() => canonicalString({ f: () => 1 })).toThrow();
  });
  it('serializes -0 as 0', () => expect(canonicalString(-0)).toBe('0'));
});
