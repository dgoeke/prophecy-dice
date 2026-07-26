/**
 * Storage primitives: atomic writes, AES-256-GCM under a scrypt key (§6.4),
 * rotating backups (§6.3, §6.7).
 */

import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync,
  readdirSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** temp file in the same directory, fsync, rename (§6.3). */
export function atomicWrite(path: string, data: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + '.tmp';
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // open(2)'s requested mode is masked by the process umask. The GM service
  // deliberately runs with UMask=0077, but explicit publication files must
  // still be readable by the separate static-server user.
  chmodSync(path, mode);
  // rename durability requires syncing the containing directory as well as
  // the file. Without this, a power loss can forget the new directory entry.
  const dirFd = openSync(dirname(path), 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

export interface Kdf { N: number; r: number; p: number }
/** scrypt N=2^17, r=8, p=1 (§6.4). Tests may lower N. */
export const DEFAULT_KDF: Kdf = { N: 2 ** 17, r: 8, p: 1 };

export function deriveKey(passphrase: string, salt: Buffer, kdf: Kdf): Buffer {
  return scryptSync(passphrase, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 1024 * 1024 * 1024 });
}

export interface KdfHeader extends Kdf { salt: string }

export function encryptJson(obj: unknown, key: Buffer, kdf: KdfHeader): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
  return JSON.stringify({
    v: 1, kdf,
    nonce: nonce.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
  });
}

/** Throws on wrong passphrase or tampering (GCM auth). */
export function decryptJson(fileText: string, passphrase: string): { obj: any; key: Buffer; kdf: KdfHeader } {
  const f = JSON.parse(fileText);
  const b64 = (v: unknown, bytes: number): v is string =>
    typeof v === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(v)
    && Buffer.from(v, 'base64').length === bytes
    && Buffer.from(v, 'base64').toString('base64') === v;
  const kdf = f?.kdf;
  if (f?.v !== 1 || !kdf || !Number.isInteger(kdf.N)
      || kdf.N < 2 || kdf.N > 2 ** 18 || (kdf.N & (kdf.N - 1)) !== 0
      || !Number.isInteger(kdf.r) || kdf.r < 1 || kdf.r > 16
      || !Number.isInteger(kdf.p) || kdf.p < 1 || kdf.p > 8
      || !b64(kdf.salt, 16) || !b64(f.nonce, 12) || !b64(f.tag, 16)
      || typeof f.ct !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.ct)) {
    throw new Error('malformed encrypted private state');
  }
  const key = deriveKey(passphrase, Buffer.from(f.kdf.salt, 'base64'), f.kdf);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.nonce, 'base64'));
  d.setAuthTag(Buffer.from(f.tag, 'base64'));
  const pt = Buffer.concat([d.update(Buffer.from(f.ct, 'base64')), d.final()]);
  return { obj: JSON.parse(pt.toString('utf8')), key, kdf: f.kdf };
}

export function newKdfHeader(kdf: Kdf): KdfHeader {
  return { ...kdf, salt: randomBytes(16).toString('base64') };
}

/** Snapshot the ledger+private pair; keep the last `keep` pairs (§6.3). */
export function rotateBackup(stateDir: string, seq: number, keep = 20): void {
  const dir = join(stateDir, 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tag = String(seq).padStart(8, '0');
  for (const name of ['ledger.json', 'private.enc']) {
    const src = join(stateDir, name);
    if (existsSync(src)) copyFileSync(src, join(dir, `${tag}-${name}`));
  }
  const tags = [...new Set(readdirSync(dir).map((f) => f.split('-')[0]))].sort();
  for (const old of tags.slice(0, Math.max(0, tags.length - keep))) {
    for (const name of ['ledger.json', 'private.enc']) {
      const p = join(dir, `${old}-${name}`);
      if (existsSync(p)) unlinkSync(p);
    }
  }
}
