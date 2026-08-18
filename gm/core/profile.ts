/** Modifier-profile identifiers shared by the producer and TS verifier. */

const FORBIDDEN_PROFILE_NAMES = new Set([
  'prototype', 'constructor', '__defineGetter__', '__defineSetter__',
  'hasOwnProperty', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf',
  'propertyIsEnumerable', 'toString', 'valueOf', '__proto__', 'toLocaleString',
]);

const CONTROL_OR_NEWLINE_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const hasUnpairedSurrogate = (value: string): boolean => [...value].some((character) => {
  const code = character.charCodeAt(0);
  return character.length === 1 && code >= 0xd800 && code <= 0xdfff;
});

export function validProfileName(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.normalize('NFC')
    && value === value.trim()
    && [...value].length >= 1
    && [...value].length <= 64
    && !CONTROL_OR_NEWLINE_RE.test(value)
    && !hasUnpairedSurrogate(value)
    && !FORBIDDEN_PROFILE_NAMES.has(value);
}

export type ParsedModDirective =
  | { kind: 'profile'; name: string }
  | { kind: 'manual' }
  | { kind: 'legacy' }
  | { kind: 'malformed' }
  | { kind: 'sealed' };

/** Parse only the canonical final-line audit directive. Never throws. */
export function parseModDirective(context: string): ParsedModDirective {
  const lines = context.split(/\r\n|[\r\n\u2028\u2029]/u);
  const directiveLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^@mod(?:\s|$)/u.test(line));
  if (directiveLines.length === 0) return { kind: 'legacy' };
  if (directiveLines.length !== 1 || directiveLines[0].index !== lines.length - 1) {
    return { kind: 'malformed' };
  }
  const line = directiveLines[0].line;
  if (line === '@mod manual') return { kind: 'manual' };
  if (!line.startsWith('@mod ')) return { kind: 'malformed' };
  const encoded = line.slice(5);
  try {
    const name = JSON.parse(encoded);
    if (typeof name === 'string' && validProfileName(name) && JSON.stringify(name) === encoded) {
      return { kind: 'profile', name };
    }
  } catch { /* advisory parser: malformed input is classified below */ }
  return { kind: 'malformed' };
}

export function hasModDirective(context: string): boolean {
  return parseModDirective(context).kind !== 'legacy';
}

export function validDate(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export interface SheetSnapshot {
  seq: number;
  slot: string;
  effective_from: string;
  modifiers: Record<string, number>;
}

/**
 * Resolve the public player snapshot required by §2.14/§8.4. Callers may
 * pass a per-slot list; the slot check remains here so producer and verifier
 * cannot accidentally diverge on the complete rule.
 */
export function applicableSheet(
  sheets: Iterable<SheetSnapshot>, slot: string, beforeSeq: number, throughDate: string,
): SheetSnapshot | undefined {
  let best: SheetSnapshot | undefined;
  for (const sheet of sheets) {
    if (sheet.slot !== slot || sheet.seq >= beforeSeq || sheet.effective_from > throughDate) continue;
    if (!best || sheet.effective_from > best.effective_from
        || (sheet.effective_from === best.effective_from && sheet.seq > best.seq)) best = sheet;
  }
  return best;
}
