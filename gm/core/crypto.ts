/**
 * Cryptographic primitives — spec/protocol.md §2 (normative, byte-exact).
 *
 * Do not "improve" the crypto: every constant and concatenation order is
 * load-bearing for cross-implementation agreement with verify.html and
 * verify.py. The arbiter is spec/vectors.json.
 */

import { createHash, hkdfSync } from 'node:crypto';
import { canonicalBytes } from './canonical.ts';

// ---- §2.2 constants (UTF-8, no trailing NUL) -------------------------------

export const SALT = Buffer.from('wotw-column/1/salt', 'utf8');
export const TAG_CHAIN = Buffer.from('wotw-column/1/chain', 'utf8');
export const TAG_DIE = Buffer.from('wotw-column/1/die/20', 'utf8');
export const TAG_CONTEXT = Buffer.from('wotw-column/1/context', 'utf8');
export const TAG_DC = Buffer.from('wotw-column/1/dc', 'utf8');
export const TAG_MOD = Buffer.from('wotw-column/1/mod', 'utf8');
export const TAG_LABEL = Buffer.from('wotw-column/1/label', 'utf8');
export const TAG_ENTROPY = Buffer.from('wotw-column/1/genesis-entropy', 'utf8');
export const TAG_CONFIG = Buffer.from('wotw-column/1/genesis-configuration', 'utf8');
export const INFO_PREFIX = 'wotw-column/1/slot/';
export const TAG_SALT_DC = Buffer.from('wotw-column/1/salt/dc', 'utf8');
export const TAG_SALT_MOD = Buffer.from('wotw-column/1/salt/mod', 'utf8');
export const TAG_SALT_CTX = Buffer.from('wotw-column/1/salt/context', 'utf8');
export const LABEL_INFO = '/#label'; // '#' cannot occur in a lane name

export const LANE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

// ---- §2.1 primitives -------------------------------------------------------

export function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** HKDF-SHA256 (RFC 5869), extract-then-expand, full form. */
export function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

/** §2.3: minimal signed decimal — no '+', no leading zeros, "0" for zero. */
export function decimalString(n: number): string {
  if (!Number.isInteger(n) || Math.abs(n) > 2 ** 53) {
    throw new Error(`decimal_string: not a valid protocol integer: ${n}`);
  }
  return String(Object.is(n, -0) ? 0 : n);
}

// ---- §2.4 master secret and commitment -------------------------------------

export function commitmentOf(S: Uint8Array): string {
  return sha256(S).toString('hex');
}

// ---- §2.7 root derivation ---------------------------------------------------

/**
 * Genesis entropy is deliberately isolated from the full transcript.
 *
 * The full transcript contains GM-controlled free text and a world nonce. If
 * its hash entered the KDF, the GM could vary any of those fields after seeing
 * the players' nonces and cheaply search for favorable columns. Instead, only
 * the NFC-normalized player nonces contribute, sorted by UTF-8 bytes so roster
 * ordering is not another search knob.
 */
export function genesisEntropy(transcript: any): Buffer {
  const nonces = (transcript?.slots ?? [])
    .filter((s: any) => s?.status === 'active' && s?.role === 'player')
    .map((s: any) => {
      if (typeof s.nonce !== 'string' || s.nonce.length === 0) {
        throw new Error('every active player needs a non-empty string nonce');
      }
      return s.nonce.normalize('NFC');
    });
  if (nonces.length === 0) throw new Error('at least one active player nonce is required');
  nonces.sort((a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return sha256(TAG_ENTROPY, canonicalBytes(nonces));
}

/**
 * The exact ceremony choices that can route or select rolls, with entropy and
 * wall-clock time removed. Players witness this commitment before entering
 * their nonces; the final transcript carries it for mechanical comparison.
 */
export function genesisConfiguration(transcript: any): any {
  return {
    version: transcript.version,
    commitment: transcript.commitment,
    chain_length: transcript.chain_length,
    campaign: transcript.campaign,
    context_privacy: transcript.context_privacy,
    disclosure_policy: transcript.disclosure_policy,
    check_types: transcript.check_types,
    slots: (transcript.slots ?? []).map((s: any) => ({
      id: s.id, display: s.display, role: s.role, status: s.status,
      lanes: s.lanes, nonce: null,
    })),
    beacon: transcript.beacon,
  };
}

export function configurationCommitment(transcript: any): string {
  return sha256(TAG_CONFIG, canonicalBytes(genesisConfiguration(transcript))).toString('hex');
}

/** IKM = S || E (genesis-active slot) or S || E || A (later activation). */
export function ikmFor(S: Uint8Array, E: Uint8Array, A?: Uint8Array): Buffer {
  return A ? Buffer.concat([S, E, A]) : Buffer.concat([S, E]);
}

export function laneRoot(ikm: Uint8Array, slotId: string, laneName: string): Buffer {
  if (!LANE_NAME_RE.test(laneName)) throw new Error(`invalid lane name: ${laneName}`);
  const info = Buffer.from(INFO_PREFIX + slotId + '/' + laneName, 'utf8');
  return hkdfSha256(ikm, SALT, info, 32);
}

/** §2.8: label salt — IKM is S || E only (never A: A contains label_commit). */
export function labelSalt(S: Uint8Array, E: Uint8Array, slotId: string): Buffer {
  const info = Buffer.from(INFO_PREFIX + slotId + LABEL_INFO, 'utf8');
  return hkdfSha256(Buffer.concat([S, E]), SALT, info, 32);
}

// ---- §2.10 hash chain -------------------------------------------------------

export function chainStep(x: Uint8Array): Buffer {
  return sha256(TAG_CHAIN, x);
}

/** links[0] = root … links[N] = tail. N=20000 → ~640 KB, milliseconds. */
export function chainLinks(root: Uint8Array, n: number): Buffer[] {
  const links: Buffer[] = new Array(n + 1);
  links[0] = Buffer.from(root);
  for (let i = 1; i <= n; i++) links[i] = chainStep(links[i - 1]);
  return links;
}

/** §2.11: draw k consumes p_k = link[N − k]. */
export function preimageAt(links: Buffer[], position: number): Buffer {
  const n = links.length - 1;
  if (position < 1 || position > n) throw new Error(`position ${position} out of range 1..${n}`);
  return links[n - position];
}

/** §2.11: roll = 1 + (int_be(SHA256(TAG_DIE || p)) mod 20). No rejection sampling. */
export function rollFromPreimage(p: Uint8Array): number {
  const d = sha256(TAG_DIE, p);
  let acc = 0;
  for (const byte of d) acc = (acc * 256 + byte) % 20;
  return 1 + acc;
}

// ---- §2.12 derived salts and commitments ------------------------------------

function fieldSalt(tag: Buffer, p: Uint8Array, seq: number): Buffer {
  return sha256(tag, p, Buffer.from(decimalString(seq), 'utf8'));
}

export const saltDc = (p: Uint8Array, seq: number) => fieldSalt(TAG_SALT_DC, p, seq);
export const saltMod = (p: Uint8Array, seq: number) => fieldSalt(TAG_SALT_MOD, p, seq);
export const saltCtx = (p: Uint8Array, seq: number) => fieldSalt(TAG_SALT_CTX, p, seq);

export function dcCommit(p: Uint8Array, seq: number, dc: number): string {
  return sha256(TAG_DC, saltDc(p, seq), Buffer.from(decimalString(dc), 'utf8')).toString('hex');
}

export function modCommit(p: Uint8Array, seq: number, modifier: number): string {
  return sha256(TAG_MOD, saltMod(p, seq), Buffer.from(decimalString(modifier), 'utf8')).toString('hex');
}

/** Context is NFC-normalized before hashing (matches canonical-JSON form). */
export function contextCommit(p: Uint8Array, seq: number, context: string): string {
  return sha256(TAG_CONTEXT, saltCtx(p, seq), Buffer.from(context.normalize('NFC'), 'utf8')).toString('hex');
}

export function labelCommit(salt: Uint8Array, display: string, role: string): string {
  return sha256(TAG_LABEL, salt, canonicalBytes({ display, role })).toString('hex');
}

// ---- §2.14 degree of success (derived, never trusted) -----------------------

export function degreeOfSuccess(roll: number, modifier: number, dc: number): 0 | 1 | 2 | 3 {
  const total = roll + modifier;
  let degree: number;
  if (total >= dc + 10) degree = 3;
  else if (total >= dc) degree = 2;
  else if (total <= dc - 10) degree = 0;
  else degree = 1;
  if (roll === 20) degree = Math.min(degree + 1, 3);
  if (roll === 1) degree = Math.max(degree - 1, 0);
  return degree as 0 | 1 | 2 | 3;
}

/** §3.2 paired draws: fortune keeps the higher roll, misfortune the lower. */
export function pairedSelect(rule: 'fortune' | 'misfortune', first: number, second: number): number {
  return rule === 'fortune' ? Math.max(first, second) : Math.min(first, second);
}
