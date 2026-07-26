/**
 * §9.2 fuzz pass: random mutations of a valid ledger must produce clean,
 * specific failures — never unhandled exceptions. Every mutation leaves the
 * entry hash stale (nothing is rehashed), so FAILED is always the correct
 * verdict; the interesting property is that the verifier survives arbitrary
 * garbage in any field.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyLedger } from '../core/verify.ts';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '../../spec/vectors.json'), 'utf8'));
const good = vectors.ledger.ledger;

// deterministic PRNG so failures reproduce
let seed = 0x5eed;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];

const GARBAGE: any[] = [
  null, true, false, -1, 0, 2 ** 53, 'garbage', '', 'ffff', [], {}, [{}], { x: [null] },
  '0'.repeat(64), 'zz'.repeat(32), 1.5, -0.0001, [[[[]]]],
];

function mutate(l: any): any {
  const kind = Math.floor(rnd() * 10);
  const es = l.entries;
  const i = Math.floor(rnd() * es.length);
  const e = es[i];
  const keys = Object.keys(e);
  switch (kind) {
    case 0: delete e[pick(keys)]; break;
    case 1: {
      const k = pick(keys);
      const g = pick(GARBAGE);
      // guarantee an actual change — a no-op "mutation" would rightly verify
      e[k] = JSON.stringify(e[k]) === JSON.stringify(g) ? `mutated-${k}` : g;
      break;
    }
    case 2: e[`extra_${Math.floor(rnd() * 100)}`] = pick(GARBAGE); break;
    case 3: e.seq = e.seq + 1 + Math.floor(rnd() * 5); break;
    case 4: if (i + 1 < es.length) [es[i], es[i + 1]] = [es[i + 1], es[i]]; else es.pop(); break;
    case 5: es.splice(i, 1); break;
    case 6: es.splice(i, 0, JSON.parse(JSON.stringify(e))); break;
    case 7: e.hash = 'ff'.repeat(32); break;
    case 8: l.head = pick(GARBAGE); break;
    default: e.kind = pick(['draw', 'disclose', 'unheard-of', 'genesis', ''].filter((k) => k !== e.kind)); break;
  }
  return l;
}

describe('fuzz (§9.2)', () => {
  it('300 mutated ledgers: FAILED with specific messages, zero exceptions', () => {
    for (let n = 0; n < 300; n++) {
      const l = mutate(JSON.parse(JSON.stringify(good)));
      let res: any;
      expect(() => { res = verifyLedger(l); }, `mutation #${n}`).not.toThrow();
      expect(res.verdict, `mutation #${n}`).toBe('FAILED');
      expect(res.failures.length, `mutation #${n}`).toBeGreaterThan(0);
    }
  }, 60_000);

  it('degenerate inputs never throw', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}, { entries: 'no' }, { format: 'wotw-column-ledger/4', entries: [] }]) {
      expect(() => verifyLedger(bad)).not.toThrow();
      expect(verifyLedger(bad).verdict).toBe('FAILED');
    }
  });

  it('TS and browser verifiers agree byte-for-byte on 300 mutated ledgers', async () => {
    // §9.2 diagnostic-parity contract: exact message parity is promised only
    // for frozen vectors; arbitrary garbage requires verdict agreement and
    // crash-freedom. The two JS-family implementations share enough structure
    // that we hold them to the stronger full-list parity as a regression
    // tripwire; Python's cascades may legitimately differ (verdict-only, below).
    const html = readFileSync(join(here, '../../verifier/verify.html'), 'utf8');
    new Function(html.match(/<script>([\s\S]*)<\/script>/)![1])();
    const col = (globalThis as any).__column;
    seed = 0xacce55; // fresh deterministic seed
    for (let n = 0; n < 300; n++) {
      const l = mutate(JSON.parse(JSON.stringify(good)));
      let ts: any = null;
      let bw: any = null;
      expect(() => { ts = verifyLedger(l); }, `TS crash at mutation #${n}`).not.toThrow();
      await expect(col.verifyLedger(l), `browser crash at mutation #${n}`).resolves.toBeTruthy()
        .then(async () => { bw = await col.verifyLedger(l); });
      expect(bw.verdict, `verdict at mutation #${n}`).toBe(ts.verdict);
      expect(bw.failures.slice().sort(), `failures at mutation #${n}`)
        .toEqual(ts.failures.slice().sort());
    }
  }, 120_000);

  it('all three agree on the verdict when cascades legitimately differ', async () => {
    // transcript: [] makes the implementations bail at different depths, so
    // their failure lists differ — the §9.2 contract requires only that all
    // three still say FAILED without crashing.
    const l = JSON.parse(JSON.stringify(good));
    l.entries[0].transcript = [];
    const ts = verifyLedger(l);
    expect(ts.verdict).toBe('FAILED');
    const html = readFileSync(join(here, '../../verifier/verify.html'), 'utf8');
    new Function(html.match(/<script>([\s\S]*)<\/script>/)![1])();
    const bw = await (globalThis as any).__column.verifyLedger(l);
    expect(bw.verdict).toBe('FAILED');
    const dir = mkdtempSync(join(tmpdir(), 'column-parity-'));
    try {
      const p = join(dir, 'l.json');
      writeFileSync(p, JSON.stringify(l));
      const py = spawnSync('python3', [join(here, '../../verifier/verify.py'), p, '--json'], { encoding: 'utf8' });
      expect(py.stderr).toBe('');
      expect(JSON.parse(py.stdout).verdict).toBe('FAILED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verify.py survives type-confusion in every scalar field', () => {
    // Python raises where JavaScript coerces: unhashable dict keys, ordering
    // comparisons, arithmetic on non-numbers. A malformed ledger must still
    // produce a clean FAILED rather than a traceback.
    const dir = mkdtempSync(join(tmpdir(), 'column-pyhash-'));
    const FIELDS = ['kind', 'slot', 'lane', 'check_type', 'initiator', 'session', 'seq',
      'position', 'target_seq', 'announce_seq', 'batch', 'paired_with', 'through_position',
      'preimage', 'opened', 'secret', 'labels', 'declaration', 'activation_record', 'tails'];
    const VALUES: any[] = [[], {}, [1, 2], { a: 1 }, 1.5, -0.5, '', true, null];
    try {
      let n = 0;
      for (const field of FIELDS) {
        for (const value of VALUES) {
          const l = JSON.parse(JSON.stringify(good));
          // apply to the first entry that carries the field, else entry 1
          const target = l.entries.find((e: any) => field in e) ?? l.entries[1];
          target[field] = value;
          const p = join(dir, 'm.json');
          writeFileSync(p, JSON.stringify(l));
          const py = spawnSync('python3', [join(here, '../../verifier/verify.py'), p, '--json'],
            { encoding: 'utf8' });
          expect(py.stderr, `${field}=${JSON.stringify(value)}`).not.toContain('Traceback');
          expect(py.status, `${field}=${JSON.stringify(value)}`).toBe(1);
          n++;
        }
      }
      expect(n).toBeGreaterThan(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('verify.py survives a sample of the same mutations (exit 1, no traceback)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'column-fuzz-'));
    try {
      for (let n = 0; n < 10; n++) {
        const l = mutate(JSON.parse(JSON.stringify(good)));
        const p = join(dir, `f${n}.json`);
        writeFileSync(p, JSON.stringify(l));
        const py = spawnSync('python3', [join(here, '../../verifier/verify.py'), p], { encoding: 'utf8' });
        expect(py.status, `mutation #${n}: ${py.stderr}`).toBe(1);
        expect(py.stderr, `mutation #${n}`).toBe('');
        expect(py.stdout).toContain('FAILED');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
