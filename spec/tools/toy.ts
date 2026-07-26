/**
 * The toy ceremony (§9.1 item 2) — shared between the vector generator and
 * the toy-ledger builder. S = 32 zero bytes, N = 64, beacon null.
 *
 * context_privacy is "sealed" so the ledger vector exercises context
 * commitments and their disclosure.
 */

import { canonicalBytes } from '../../gm/core/canonical.ts';
import * as C from '../../gm/core/crypto.ts';

export const S = Buffer.alloc(32);
export const N = 64;

export const CHECK_TYPES = [
  { id: 'rk-cosmology', label: 'Recall Knowledge — cosmology', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: true },
  { id: 'rk-general', label: 'Recall Knowledge — general', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: false },
  { id: 'perception-secret', label: 'Secret Perception', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: false },
  { id: 'world-routine', label: 'World — routine', lane: 'routine', roles: ['world'], seal_dc: true, seal_modifier: true, ritual: false },
  { id: 'world-plot', label: 'World — plot', lane: 'deep', roles: ['world'], seal_dc: true, seal_modifier: true, ritual: true },
  { id: 'public-gm-check', label: 'Public GM check', lane: 'open', roles: ['player', 'npc', 'world'], seal_dc: false, seal_modifier: false, ritual: false },
  { id: 'lore-mystery', label: 'Lore — the mystery', lane: 'sealed', roles: ['player'], seal_dc: true, seal_modifier: false, ritual: false },
  { id: 'world-only-open', label: 'World hazard (public)', lane: 'open', roles: ['world'], seal_dc: false, seal_modifier: false, ritual: false },
  { id: 'npc-secret', label: 'NPC secret check', lane: 'shadow', roles: ['npc'], seal_dc: true, seal_modifier: true, ritual: false },
];

const transcriptBase = {
  version: 'wotw-column/1',
  commitment: C.commitmentOf(S),
  chain_length: N,
  created_at: '2026-08-14T19:32:11Z',
  campaign: 'Toy Campaign',
  context_privacy: 'sealed',
  disclosure_policy: 'Toy: open at session close; sealed two arcs behind.',
  check_types: CHECK_TYPES,
  slots: [
    { id: 'slot-01', display: 'Alice', role: 'player', status: 'active', lanes: ['sealed', 'open'], nonce: 'alice-nonce' },
    { id: 'slot-02', display: 'Bob', role: 'player', status: 'active', lanes: ['sealed', 'open'], nonce: 'bob-nonce' },
    { id: 'slot-03', display: 'the world', role: 'world', status: 'active', lanes: ['open', 'routine', 'deep'], nonce: 'world-nonce' },
    { id: 'slot-04', display: null, role: null, status: 'deferred', lanes: null, nonce: null },
    { id: 'slot-05', display: null, role: null, status: 'deferred', lanes: null, nonce: null },
  ],
  beacon: null,
};
export const transcript = {
  ...transcriptBase,
  configuration_commitment: C.configurationCommitment(transcriptBase),
};

export const E = C.genesisEntropy(transcript);
export const genesisIkm = C.ikmFor(S, E);

export const GENESIS_LANES: Array<[string, string]> = [
  ['slot-01', 'sealed'], ['slot-01', 'open'],
  ['slot-02', 'sealed'], ['slot-02', 'open'],
  ['slot-03', 'open'], ['slot-03', 'routine'], ['slot-03', 'deep'],
];

/** laneKey "slot/lane" → links[0..N] for all genesis-active lanes. */
export function genesisChains(): Map<string, Buffer[]> {
  const m = new Map<string, Buffer[]>();
  for (const [slot, lane] of GENESIS_LANES) {
    m.set(`${slot}/${lane}`, C.chainLinks(C.laneRoot(genesisIkm, slot, lane), N));
  }
  return m;
}
