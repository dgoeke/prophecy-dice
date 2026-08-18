import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validProfileName } from '../core/profile.ts';
import { verifyLedger } from '../core/verify.ts';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '../../spec/vectors.json'), 'utf8'));
const verifierHtml = readFileSync(join(here, '../../verifier/verify.html'), 'utf8');
const publicHtml = readFileSync(join(here, '../../public/verify.html'), 'utf8');
const sheetSeq = vectors.ledger.ledger.entries.find((e: any) => e.kind === 'sheet-update').seq;
const malformedSheet = `structure: seq ${sheetSeq} malformed sheet-update`;
let browserVerify: (ledger: unknown) => Promise<any>;

beforeAll(() => {
  new Function(verifierHtml.match(/<script>([\s\S]*)<\/script>/)![1])();
  browserVerify = (globalThis as any).__column.verifyLedger;
});

const withSheetName = (name: string) => {
  const ledger = structuredClone(vectors.ledger.ledger);
  const sheet = ledger.entries.find((e: any) => e.kind === 'sheet-update');
  sheet.modifiers = Object.fromEntries([[name, 4]]);
  return ledger;
};

describe('modifier profile names', () => {
  const forbidden = ['prototype', ...Object.getOwnPropertyNames(Object.prototype)];
  const invalid = ['', ' Society', 'Society ', 'x'.repeat(65), 'line\nbreak', 'nul\0name', 'line\u2028break', 'Cafe\u0301', '\ud800', ...forbidden];

  it('implements the hardened predicate in TypeScript', () => {
    for (const name of invalid) expect(validProfileName(name), JSON.stringify(name)).toBe(false);
    for (const name of ['Society', 'Brokhold Lore', 'Érudition', '🔥'.repeat(64)]) {
      expect(validProfileName(name), name).toBe(true);
    }
    expect(validProfileName('🔥'.repeat(65))).toBe(false);
  });

  it('relaxes sheet keys beyond the registry in all three verifiers', async () => {
    for (const name of ['Brokhold Lore', '🔥'.repeat(64)]) {
      const ledger = withSheetName(name);
      expect(verifyLedger(ledger).failures).not.toContain(malformedSheet);
      expect((await browserVerify(ledger)).failures).not.toContain(malformedSheet);

      const dir = mkdtempSync(join(tmpdir(), 'column-profile-'));
      try {
        const path = join(dir, 'ledger.json');
        writeFileSync(path, JSON.stringify(ledger));
        const py = spawnSync('python3', [join(here, '../../verifier/verify.py'), path, '--json'], { encoding: 'utf8' });
        expect(py.stderr).toBe('');
        expect(JSON.parse(py.stdout).failures).not.toContain(malformedSheet);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('rejects hardened names in all three verifiers', async () => {
    for (const name of ['__proto__', 'constructor', 'prototype', ' padded', 'x'.repeat(65), '🔥'.repeat(65), 'bad\nname', 'Cafe\u0301', '\ud800']) {
      const ledger = withSheetName(name);
      expect(verifyLedger(ledger).failures).toContain(malformedSheet);
      expect((await browserVerify(ledger)).failures).toContain(malformedSheet);

      const dir = mkdtempSync(join(tmpdir(), 'column-profile-'));
      try {
        const path = join(dir, 'ledger.json');
        writeFileSync(path, JSON.stringify(ledger));
        const py = spawnSync('python3', [join(here, '../../verifier/verify.py'), path, '--json'], { encoding: 'utf8' });
        expect(py.stderr).toBe('');
        expect(JSON.parse(py.stdout).failures).toContain(malformedSheet);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('keeps the distributable HTML verifier byte-identical', () => {
    expect(publicHtml).toBe(verifierHtml);
  });
});
