/**
 * Ledger entry hashing — spec/protocol.md §3.1 (normative).
 *
 * hash = hex(SHA256(canonical_json(entry_without_hash_field)))
 * The hash covers the public entry only; drawn values never appear in
 * draw entries (§5.5) — they arrive later in `disclose`.
 */

import { canonicalBytes } from './canonical.ts';
import { sha256 } from './crypto.ts';

export const ZERO64 = '0'.repeat(64);
export const LEDGER_FORMAT = 'wotw-column-ledger/4';

export type Entry = Record<string, unknown> & {
  seq: number;
  ts: string;
  session: number;
  kind: string;
  prev: string;
  hash?: string;
};

export function entryHash(entry: Record<string, unknown>): string {
  const { hash: _hash, ...rest } = entry;
  return sha256(canonicalBytes(rest)).toString('hex');
}
