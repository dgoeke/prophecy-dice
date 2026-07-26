import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { DrandBeacon, DRAND_DEFAULT_CHAIN } from '../server/beacon.ts';

const response = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
}) as Response;

afterEach(() => vi.unstubAllGlobals());

describe('drand response validation', () => {
  it('binds known chain metadata, round, and randomness to the response signature', async () => {
    const signature = 'ab'.repeat(96);
    const randomness = createHash('sha256').update(Buffer.from(signature, 'hex')).digest('hex');
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({
        hash: DRAND_DEFAULT_CHAIN, genesis_time: 1595431050, period: 30,
      }))
      .mockResolvedValueOnce(response({ round: 10, signature, randomness }));
    vi.stubGlobal('fetch', fetch);
    const beacon = new DrandBeacon('https://example.invalid', DRAND_DEFAULT_CHAIN, () => 1595431050_000);
    const declaration = await beacon.declare(600);
    expect(declaration.chain).toBe(`drand:${DRAND_DEFAULT_CHAIN}`);
    await expect(beacon.fetch(10)).resolves.toBe(randomness);
  });

  it('rejects a default-chain endpoint that lies about chain parameters', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      hash: DRAND_DEFAULT_CHAIN, genesis_time: 1, period: 30,
    })));
    const beacon = new DrandBeacon('https://example.invalid');
    await expect(beacon.declare(600)).rejects.toThrow(/known default chain/);
  });

  it('rejects randomness that is not SHA-256 of the supplied signature', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      round: 10, signature: 'ab'.repeat(96), randomness: '00'.repeat(32),
    })));
    const beacon = new DrandBeacon('https://example.invalid');
    await expect(beacon.fetch(10)).rejects.toThrow(/does not match/);
  });
});
