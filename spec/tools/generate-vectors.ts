/**
 * Generates spec/vectors.json — all §9.1 items (1–11, plus 7b).
 * Once frozen, regeneration must be byte-identical; the vectors are the
 * arbiter for cross-implementation agreement (§0).
 *
 * Run: cd gm && npm run gen-vectors
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBytes, canonicalString } from '../../gm/core/canonical.ts';
import * as C from '../../gm/core/crypto.ts';
import { verifyLedger } from '../../gm/core/verify.ts';
import { S, N, transcript, E, genesisIkm, GENESIS_LANES } from './toy.ts';
import { buildToyLedger, buildNegatives } from './build-toy-ledger.ts';

const specDir = dirname(dirname(fileURLToPath(import.meta.url)));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// ---- item 1: canonical JSON -------------------------------------------------

const CANONICAL_CASES: Array<{ name: string; value: unknown }> = [
  { name: 'empty object', value: {} },
  { name: 'key ordering by code point', value: { b: 1, a: 2, A: 3, 'a-b': 4 } },
  {
    name: 'escaping: quote, backslash, C0 controls',
    value: { s: 'quote" back\\ nl\n tab\t bell\u0007 nul\u0000 esc' },
  },
  {
    name: 'NFC: decomposed key and value compose',
    // 'cafe' + COMBINING ACUTE ACCENT — must canonicalize to composed U+00E9
    value: { 'café': 'café' },
  },
  {
    name: 'nesting',
    value: { a: [1, [2, { z: null, y: true }], false], b: {} },
  },
  {
    name: 'integer bounds',
    value: { max: 9007199254740992, min: -9007199254740992, zero: 0, neg: -37 },
  },
  {
    name: 'astral plane: code-point sort, not UTF-16',
    // U+FFFF < U+1F600 by code point, but naive UTF-16 sort says otherwise
    value: { '\u{1F600}': 1, '￿': 2 },
  },
  { name: 'empty string key, empty array', value: { '': [] } },
  { name: 'bare array', value: [true, false, null, 'x'] },
  { name: 'non-ascii literal output', value: { k: 'héllo ß 世界' } },
];

const canonical_json = CANONICAL_CASES.map(({ name, value }) => {
  const s = canonicalString(value);
  return { name, value, canonical: s, sha256: hex(C.sha256(Buffer.from(s, 'utf8'))) };
});

// ---- item 2: toy ceremony ---------------------------------------------------

type LaneData = { slot: string; lane: string; root: Buffer; links: Buffer[]; tail: Buffer };
const laneData: LaneData[] = GENESIS_LANES.map(([slot, lane]) => {
  const root = C.laneRoot(genesisIkm, slot, lane);
  const links = C.chainLinks(root, N);
  return { slot, lane, root, links, tail: links[N] };
});
const laneOf = (slot: string, lane: string) => laneData.find((l) => l.slot === slot && l.lane === lane)!;

const toy_ceremony = {
  S: hex(S),
  transcript,
  transcript_canonical_sha256: hex(C.sha256(canonicalBytes(transcript))),
  genesis_entropy: hex(E),
  configuration_commitment: C.configurationCommitment(transcript),
  lanes: laneData.map((l) => ({ slot: l.slot, lane: l.lane, root: hex(l.root), tail: hex(l.tail) })),
};

// ---- item 3: first 10 draws per lane ---------------------------------------

const draws = laneData.map((l) => ({
  slot: l.slot,
  lane: l.lane,
  draws: Array.from({ length: 10 }, (_, i) => {
    const position = i + 1;
    const p = C.preimageAt(l.links, position);
    return { position, preimage: hex(p), roll: C.rollFromPreimage(p) };
  }),
}));

// ---- item 4: lane independence ---------------------------------------------

const allRoots = laneData.map((l) => hex(l.root));
const sealed01 = laneOf('slot-01', 'sealed');
const open01 = laneOf('slot-01', 'open');
const openLinkSet = new Set(open01.links.map(hex));
const sealedDisclosed = Array.from({ length: 7 }, (_, i) => hex(C.preimageAt(sealed01.links, i + 1)));
const lane_independence = {
  roots: allRoots,
  all_roots_distinct: new Set(allRoots).size === allRoots.length,
  note: 'disclosing slot-01/sealed through position 7 exposes no slot-01/open link',
  sealed_disclosure_disjoint_from_open_lane: sealedDisclosed.every((p) => !openLinkSet.has(p)),
};

// ---- item 5: prefix disclosure ---------------------------------------------

const THROUGH = 7;
const discPre = C.preimageAt(sealed01.links, THROUGH);
{
  // sanity: chain_step^7(p_7) must equal the published tail
  let x: Buffer = discPre;
  for (let i = 0; i < THROUGH; i++) x = C.chainStep(x);
  if (!x.equals(sealed01.tail)) throw new Error('prefix disclosure sanity check failed');
}
const prefix_disclosure = {
  slot: 'slot-01',
  lane: 'sealed',
  through_position: THROUGH,
  preimage: hex(discPre),
  forward_hash_reaches_tail: true,
  derived: Array.from({ length: THROUGH }, (_, i) => {
    const position = i + 1;
    const p = C.preimageAt(sealed01.links, position);
    return { position, preimage: hex(p), roll: C.rollFromPreimage(p) };
  }),
};

// ---- item 6: degrees of success --------------------------------------------

const DEGREE_CASES: Array<[number, number, number]> = [
  [10, 5, 5], [10, 5, 6], [10, 5, 15], [10, 5, 16], [10, 5, 25], [10, 5, 24],
  [20, 0, 25], [20, 0, 10], [20, 0, 35], [20, 0, 21],
  [1, 10, 11], [1, 10, 1], [1, 10, 21], [1, 30, 11],
  [5, -2, 4], [5, -2, 13], [12, 8, 10], [2, 0, 12],
];
const degrees = DEGREE_CASES.map(([roll, modifier, dc]) => ({
  roll, modifier, dc, degree: C.degreeOfSuccess(roll, modifier, dc),
}));

// ---- items 7/7b: commitments and salt derivation ---------------------------

const commitP = C.preimageAt(sealed01.links, 1);
const SEQ_A = 42;
const SEQ_B = 43;

const salt_derivation = {
  preimage: hex(commitP),
  cases: [SEQ_A, SEQ_B].map((seq) => ({
    seq,
    salt_dc: hex(C.saltDc(commitP, seq)),
    salt_mod: hex(C.saltMod(commitP, seq)),
    salt_ctx: hex(C.saltCtx(commitP, seq)),
  })),
  all_six_distinct: true, // checked below
};
{
  const six = salt_derivation.cases.flatMap((c) => [c.salt_dc, c.salt_mod, c.salt_ctx]);
  salt_derivation.all_six_distinct = new Set(six).size === 6;
  if (!salt_derivation.all_six_distinct) throw new Error('salt derivation collision');
}

const labelSalt04 = C.labelSalt(S, E, 'slot-04');
const commitments = {
  preimage: hex(commitP),
  seq: SEQ_A,
  dc: 22,
  dc_commit: C.dcCommit(commitP, SEQ_A, 22),
  modifier: 14,
  mod_commit: C.modCommit(commitP, SEQ_A, 14),
  context: 'example sealed context',
  context_commit: C.contextCommit(commitP, SEQ_A, 'example sealed context'),
  context_nfc: 'café example', // decomposed on purpose; NFC before hashing
  context_nfc_commit: C.contextCommit(commitP, SEQ_A, 'café example'),
  negative_modifier: -3,
  negative_mod_commit: C.modCommit(commitP, SEQ_A, -3),
  label: {
    slot: 'slot-04',
    display: 'Bud',
    role: 'npc',
    salt_label: hex(labelSalt04),
    label_commit: C.labelCommit(labelSalt04, 'Bud', 'npc'),
  },
};

// ---- item 8: paired draws ---------------------------------------------------

const sealed02 = laneOf('slot-02', 'sealed');
const pr3 = C.rollFromPreimage(C.preimageAt(sealed02.links, 3));
const pr4 = C.rollFromPreimage(C.preimageAt(sealed02.links, 4));
const pr5 = C.rollFromPreimage(C.preimageAt(sealed02.links, 5));
const pr6 = C.rollFromPreimage(C.preimageAt(sealed02.links, 6));
const paired = [
  { slot: 'slot-02', lane: 'sealed', positions: [3, 4], rolls: [pr3, pr4], pair_rule: 'fortune', selected: C.pairedSelect('fortune', pr3, pr4) },
  { slot: 'slot-02', lane: 'sealed', positions: [5, 6], rolls: [pr5, pr6], pair_rule: 'misfortune', selected: C.pairedSelect('misfortune', pr5, pr6) },
];

// ---- item 9: activation -----------------------------------------------------

const DECLARED_AT = '2026-09-01T18:00:00Z';
const declaredEpoch = Math.floor(Date.parse(DECLARED_AT) / 1000);
const PERIOD = 30;
const ROUND = 100;
// choose genesis_time so round_time = declared_at + 700 (≥ the required +600)
const genesisTime = declaredEpoch + 700 - (ROUND - 1) * PERIOD;

const activationRecord = {
  version: 'wotw-column/1',
  slot: 'slot-04',
  lanes: ['sealed', 'open'],
  label_commit: commitments.label.label_commit,
  nonce: 'activation-nonce',
  declared_at: DECLARED_AT,
  beacon: {
    chain: 'drand:toy-chain',
    round: ROUND,
    randomness: hex(C.sha256(Buffer.from('toy-beacon-randomness', 'utf8'))),
    genesis_time: genesisTime,
    period: PERIOD,
  },
};

const A = C.sha256(canonicalBytes(activationRecord));
const actIkm = C.ikmFor(S, E, A);
const activation = {
  record: activationRecord,
  declared_at_epoch: declaredEpoch,
  round_time: genesisTime + (ROUND - 1) * PERIOD,
  A: hex(A),
  lanes: (['sealed', 'open'] as const).map((lane) => {
    const root = C.laneRoot(actIkm, 'slot-04', lane);
    const links = C.chainLinks(root, N);
    return {
      slot: 'slot-04',
      lane,
      root: hex(root),
      tail: hex(links[N]),
      draws: Array.from({ length: 5 }, (_, i) => {
        const position = i + 1;
        const p = C.preimageAt(links, position);
        return { position, preimage: hex(p), roll: C.rollFromPreimage(p) };
      }),
    };
  }),
};

// ---- items 10–11: the full ledger and negative cases -----------------------

const toy = buildToyLedger();
{
  const res = verifyLedger(toy.ledger);
  if (res.verdict !== 'VERIFIED') {
    throw new Error(`toy ledger fails own verifier:\n${res.failures.join('\n')}`);
  }
  if (res.state !== 'fully revealed') throw new Error(`toy ledger state ${res.state}`);
  for (const { seq, roll } of toy.expectedRolls) {
    if (res.rolls[seq] !== roll) throw new Error(`roll mismatch at seq ${seq}`);
  }
}
const negatives = buildNegatives(toy);
for (const n of negatives) {
  const res = verifyLedger(n.ledger);
  if (res.verdict !== 'FAILED') throw new Error(`negative "${n.name}" did not fail`);
  if (!res.failures.includes(n.expected_message)) {
    throw new Error(`negative "${n.name}" missing expected message:\n  want: ${n.expected_message}\n  got:\n${res.failures.map((f) => '    ' + f).join('\n')}`);
  }
}

const ledger = {
  entry_count: toy.ledger.entries.length,
  ledger: toy.ledger,
  expected_rolls: toy.expectedRolls,
};

const negative_ledgers = negatives;

// ---- write ------------------------------------------------------------------

const vectors = {
  format: 'wotw-column-vectors/1',
  frozen: true,
  canonical_json,
  toy_ceremony,
  draws,
  lane_independence,
  prefix_disclosure,
  degrees,
  salt_derivation,
  commitments,
  paired,
  activation,
  ledger,
  negative_ledgers,
};

// ASCII-safe output so no editor or transport can renormalize the tricky
// unicode inputs (decomposed sequences, astral-plane keys).
const json = JSON.stringify(vectors, null, 2).replace(
  /[\u0080-\uffff]/g,
  (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
);
const out = join(specDir, 'vectors.json');
writeFileSync(out, json + '\n');
console.log(`wrote ${out} (${json.length} bytes, ledger ${toy.ledger.entries.length} entries, ${negatives.length} negatives)`);
