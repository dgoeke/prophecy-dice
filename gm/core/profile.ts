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
    && value === value.trim()
    && [...value].length >= 1
    && [...value].length <= 64
    && !CONTROL_OR_NEWLINE_RE.test(value)
    && !hasUnpairedSurrogate(value)
    && !FORBIDDEN_PROFILE_NAMES.has(value);
}
