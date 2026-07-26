import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBytes } from '../core/canonical.ts';
import * as C from '../core/crypto.ts';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '../../spec/vectors.json'), 'utf8'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (s: string) => Buffer.from(s, 'hex');

describe('external known-answer checks (not from our own vectors)', () => {
  it('SHA-256 of empty string', () => {
    expect(hex(C.sha256(Buffer.alloc(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('HKDF-SHA256 RFC 5869 test case 1', () => {
    const ikm = Buffer.alloc(22, 0x0b);
    const salt = Buffer.from('000102030405060708090a0b0c', 'hex');
    const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');
    expect(hex(C.hkdfSha256(ikm, salt, info, 42))).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });
});

describe('toy ceremony (§9.1 item 2)', () => {
  const S = fromHex(vectors.toy_ceremony.S);
  const transcript = vectors.toy_ceremony.transcript;
  const T = C.sha256(canonicalBytes(transcript));
  const E = C.genesisEntropy(transcript);

  it('transcript hash T', () => {
    expect(hex(T)).toBe(vectors.toy_ceremony.transcript_canonical_sha256);
  });
  it('commitment C = SHA256(S)', () => {
    expect(C.commitmentOf(S)).toBe(transcript.commitment);
  });
  it('genesis entropy uses the player nonce multiset only', () => {
    expect(hex(E)).toBe(vectors.toy_ceremony.genesis_entropy);
  });
  it('configuration commitment freezes routing choices but excludes nonces and time', () => {
    expect(C.configurationCommitment(transcript)).toBe(
      vectors.toy_ceremony.configuration_commitment,
    );
    const changed = structuredClone(transcript);
    changed.created_at = '2099-01-01T00:00:00Z';
    changed.slots.forEach((s: any) => { if (s.status === 'active') s.nonce += '-changed'; });
    expect(C.configurationCommitment(changed)).toBe(transcript.configuration_commitment);
    changed.chain_length += 1;
    expect(C.configurationCommitment(changed)).not.toBe(transcript.configuration_commitment);
  });
  it('GM-controlled transcript prose and world nonce cannot grind genesis roots', () => {
    const changed = structuredClone(transcript);
    changed.campaign = 'a different title';
    changed.created_at = '2099-01-01T00:00:00Z';
    changed.disclosure_policy = 'different prose';
    changed.check_types[0].label = 'different label';
    changed.slots.find((s: any) => s.role === 'world').nonce = 'different-world-nonce';
    const changedE = C.genesisEntropy(changed);
    expect(hex(changedE)).toBe(hex(E));
    expect(hex(C.laneRoot(C.ikmFor(S, changedE), 'slot-01', 'sealed')))
      .toBe(hex(C.laneRoot(C.ikmFor(S, E), 'slot-01', 'sealed')));

    const playerChanged = structuredClone(transcript);
    playerChanged.slots.find((s: any) => s.role === 'player').nonce += '-changed';
    expect(hex(C.genesisEntropy(playerChanged))).not.toBe(hex(E));
  });
  it('all roots and tails', () => {
    const ikm = C.ikmFor(S, E);
    for (const lane of vectors.toy_ceremony.lanes) {
      const root = C.laneRoot(ikm, lane.slot, lane.lane);
      expect(hex(root)).toBe(lane.root);
      const links = C.chainLinks(root, transcript.chain_length);
      expect(hex(links[transcript.chain_length])).toBe(lane.tail);
    }
  });
});

describe('draws (§9.1 item 3)', () => {
  const S = fromHex(vectors.toy_ceremony.S);
  const E = C.genesisEntropy(vectors.toy_ceremony.transcript);
  const N = vectors.toy_ceremony.transcript.chain_length;
  const ikm = C.ikmFor(S, E);

  for (const laneDraws of vectors.draws) {
    it(`${laneDraws.slot}/${laneDraws.lane}`, () => {
      const links = C.chainLinks(C.laneRoot(ikm, laneDraws.slot, laneDraws.lane), N);
      for (const d of laneDraws.draws) {
        const p = C.preimageAt(links, d.position);
        expect(hex(p)).toBe(d.preimage);
        expect(C.rollFromPreimage(p)).toBe(d.roll);
      }
    });
  }
});

describe('lane independence (§9.1 item 4)', () => {
  it('all roots distinct; sealed disclosure disjoint from open lane', () => {
    expect(vectors.lane_independence.all_roots_distinct).toBe(true);
    expect(new Set(vectors.lane_independence.roots).size).toBe(
      vectors.lane_independence.roots.length,
    );
    expect(vectors.lane_independence.sealed_disclosure_disjoint_from_open_lane).toBe(true);
  });
});

describe('prefix disclosure (§9.1 item 5)', () => {
  it('forward-hashing the preimage reaches the tail; earlier positions derive', () => {
    const pd = vectors.prefix_disclosure;
    const tail = vectors.toy_ceremony.lanes.find(
      (l: { slot: string; lane: string }) => l.slot === pd.slot && l.lane === pd.lane,
    )!.tail;
    let x: Buffer = fromHex(pd.preimage);
    for (let i = 0; i < pd.through_position; i++) x = C.chainStep(x);
    expect(hex(x)).toBe(tail);
    // p_{j} for j < k derives by hashing forward from p_k
    for (const d of pd.derived) {
      let q: Buffer = fromHex(pd.preimage);
      for (let i = 0; i < pd.through_position - d.position; i++) q = C.chainStep(q);
      expect(hex(q)).toBe(d.preimage);
      expect(C.rollFromPreimage(q)).toBe(d.roll);
    }
  });
});

describe('degrees of success (§9.1 item 6)', () => {
  for (const d of vectors.degrees) {
    it(`roll ${d.roll} +${d.modifier} vs DC ${d.dc} → ${d.degree}`, () => {
      expect(C.degreeOfSuccess(d.roll, d.modifier, d.dc)).toBe(d.degree);
    });
  }
});

describe('salt derivation (§9.1 item 7b)', () => {
  it('domain separation and seq binding', () => {
    const sd = vectors.salt_derivation;
    const p = fromHex(sd.preimage);
    const seen = new Set<string>();
    for (const c of sd.cases) {
      expect(hex(C.saltDc(p, c.seq))).toBe(c.salt_dc);
      expect(hex(C.saltMod(p, c.seq))).toBe(c.salt_mod);
      expect(hex(C.saltCtx(p, c.seq))).toBe(c.salt_ctx);
      seen.add(c.salt_dc).add(c.salt_mod).add(c.salt_ctx);
    }
    expect(seen.size).toBe(6);
  });
});

describe('commitments (§9.1 item 7)', () => {
  const cm = vectors.commitments;
  const p = fromHex(cm.preimage);

  it('dc_commit', () => expect(C.dcCommit(p, cm.seq, cm.dc)).toBe(cm.dc_commit));
  it('mod_commit', () => expect(C.modCommit(p, cm.seq, cm.modifier)).toBe(cm.mod_commit));
  it('negative modifier commit', () =>
    expect(C.modCommit(p, cm.seq, cm.negative_modifier)).toBe(cm.negative_mod_commit));
  it('context_commit', () =>
    expect(C.contextCommit(p, cm.seq, cm.context)).toBe(cm.context_commit));
  it('context_commit NFC-normalizes', () => {
    expect(C.contextCommit(p, cm.seq, cm.context_nfc)).toBe(cm.context_nfc_commit);
    // composed form must produce the same commitment
    expect(C.contextCommit(p, cm.seq, cm.context_nfc.normalize('NFC'))).toBe(cm.context_nfc_commit);
  });
  it('label_commit from derived salt', () => {
    const S = fromHex(vectors.toy_ceremony.S);
    const E = C.genesisEntropy(vectors.toy_ceremony.transcript);
    const salt = C.labelSalt(S, E, cm.label.slot);
    expect(hex(salt)).toBe(cm.label.salt_label);
    expect(C.labelCommit(salt, cm.label.display, cm.label.role)).toBe(cm.label.label_commit);
  });
});

describe('paired draws (§9.1 item 8)', () => {
  for (const pr of vectors.paired) {
    it(`${pr.pair_rule} at positions ${pr.positions.join(',')}`, () => {
      expect(C.pairedSelect(pr.pair_rule, pr.rolls[0], pr.rolls[1])).toBe(pr.selected);
    });
  }
});

describe('activation (§9.1 item 9)', () => {
  const act = vectors.activation;
  const S = fromHex(vectors.toy_ceremony.S);
  const E = C.genesisEntropy(vectors.toy_ceremony.transcript);
  const N = vectors.toy_ceremony.transcript.chain_length;

  it('A = SHA256(canonical(record))', () => {
    expect(hex(C.sha256(canonicalBytes(act.record)))).toBe(act.A);
  });
  it('beacon wait: round_time ≥ declared_at + 600', () => {
    const b = act.record.beacon;
    const roundTime = b.genesis_time + (b.round - 1) * b.period;
    expect(roundTime).toBe(act.round_time);
    expect(roundTime).toBeGreaterThanOrEqual(act.declared_at_epoch + 600);
  });
  it('lane roots, tails, first draws', () => {
    const ikm = C.ikmFor(S, E, fromHex(act.A));
    for (const lane of act.lanes) {
      const root = C.laneRoot(ikm, lane.slot, lane.lane);
      expect(hex(root)).toBe(lane.root);
      const links = C.chainLinks(root, N);
      expect(hex(links[N])).toBe(lane.tail);
      for (const d of lane.draws) {
        const p = C.preimageAt(links, d.position);
        expect(hex(p)).toBe(d.preimage);
        expect(C.rollFromPreimage(p)).toBe(d.roll);
      }
    }
  });
  it('activation lanes differ from what a genesis derivation would give', () => {
    const genesisIkm = C.ikmFor(S, E);
    for (const lane of act.lanes) {
      expect(hex(C.laneRoot(genesisIkm, lane.slot, lane.lane))).not.toBe(lane.root);
    }
  });
});
