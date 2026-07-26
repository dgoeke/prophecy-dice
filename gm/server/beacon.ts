/**
 * Randomness beacon provider (§2.8, §4.5). Default: drand HTTPS API.
 * Injectable so tests can control rounds and time.
 */
import { createHash } from 'node:crypto';

export interface BeaconRound {
  chain: string;        // "drand:<chain hash>"
  round: number;
  genesis_time: number; // unix seconds
  period: number;       // seconds
}

export interface BeaconProvider {
  /** Pick a future round publishing at least minDelaySec from now. */
  declare(minDelaySec: number): Promise<BeaconRound>;
  /** Fetch the randomness of a published round. Throws if not yet published. */
  fetch(round: number): Promise<string>;
}

/** League of Entropy default chain (30s period). */
export const DRAND_DEFAULT_CHAIN = '8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce';
const DRAND_DEFAULT_GENESIS = 1595431050;
const DRAND_DEFAULT_PERIOD = 30;

export class DrandBeacon implements BeaconProvider {
  private info: { genesis_time: number; period: number } | null = null;
  constructor(
    private endpoint = 'https://api.drand.sh',
    private chainHash = DRAND_DEFAULT_CHAIN,
    private now: () => number = Date.now,
  ) {}

  private async chainInfo() {
    if (!this.info) {
      const r = await fetch(`${this.endpoint}/${this.chainHash}/info`);
      if (!r.ok) throw new Error(`drand info: HTTP ${r.status}`);
      const j = await r.json();
      if (j.hash !== this.chainHash) throw new Error('drand info: chain hash mismatch');
      if (!Number.isInteger(j.genesis_time) || !Number.isInteger(j.period)
          || j.genesis_time < 0 || j.period < 1) {
        throw new Error('drand info: malformed genesis_time/period');
      }
      if (this.chainHash === DRAND_DEFAULT_CHAIN
          && (j.genesis_time !== DRAND_DEFAULT_GENESIS || j.period !== DRAND_DEFAULT_PERIOD)) {
        throw new Error('drand info: parameters do not match the known default chain');
      }
      this.info = { genesis_time: j.genesis_time, period: j.period };
    }
    return this.info;
  }

  async declare(minDelaySec: number): Promise<BeaconRound> {
    const { genesis_time, period } = await this.chainInfo();
    const target = Math.floor(this.now() / 1000) + minDelaySec;
    const round = Math.ceil((target - genesis_time) / period) + 1;
    return { chain: `drand:${this.chainHash}`, round, genesis_time, period };
  }

  async fetch(round: number): Promise<string> {
    const r = await fetch(`${this.endpoint}/${this.chainHash}/public/${round}`);
    if (!r.ok) throw new Error(`drand round ${round}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.round !== round) throw new Error(`drand: response is for round ${j.round}, expected ${round}`);
    if (typeof j.randomness !== 'string' || !/^[0-9a-f]{64}$/.test(j.randomness)) {
      throw new Error('drand: malformed randomness');
    }
    if (typeof j.signature !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(j.signature)
        || createHash('sha256').update(Buffer.from(j.signature, 'hex')).digest('hex') !== j.randomness) {
      throw new Error('drand: randomness does not match the response signature');
    }
    return j.randomness;
  }
}
