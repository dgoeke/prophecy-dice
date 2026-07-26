/**
 * Canonical JSON — spec/protocol.md §2.3 (normative, byte-exact).
 *
 * Rules:
 *  - keys sorted ascending by Unicode CODE POINT (not UTF-16 code unit —
 *    "￿" sorts before "😀");
 *  - no insignificant whitespace;
 *  - minimal escaping: `"` → \",  `\` → \\,  C0 controls → \u00xx
 *    (lowercase hex, no \n/\t shorthands); everything else literal UTF-8;
 *  - all strings (values AND keys) NFC-normalized before output;
 *  - numbers: integers only, |n| ≤ 2^53, no exponent/decimal point/leading
 *    zeros/plus sign; floats are an error;
 *  - null / true / false literal; anything else is an error.
 */

const MAX_INT = 2 ** 53;

/** Compare two strings by Unicode code point, not UTF-16 code unit. */
function cmpCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx - cy;
  }
}

function escapeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20) out += '\\u00' + cp.toString(16).padStart(2, '0');
      else out += ch;
    }
  }
  return out + '"';
}

export function canonicalString(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`canonical JSON: non-integer number ${value}`);
    if (Math.abs(value) > MAX_INT) throw new Error(`canonical JSON: integer out of range ${value}`);
    return String(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'string') return escapeString(value.normalize('NFC'));
  if (Array.isArray(value)) return '[' + value.map(canonicalString).join(',') + ']';
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => [k.normalize('NFC'), v] as const,
    );
    entries.sort((x, y) => cmpCodePoints(x[0], y[0]));
    for (let i = 1; i < entries.length; i++) {
      if (entries[i][0] === entries[i - 1][0]) {
        throw new Error(`canonical JSON: duplicate key after NFC: ${JSON.stringify(entries[i][0])}`);
      }
    }
    return '{' + entries.map(([k, v]) => escapeString(k) + ':' + canonicalString(v)).join(',') + '}';
  }
  throw new Error(`canonical JSON: unsupported type ${typeof value}`);
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalString(value), 'utf8');
}
