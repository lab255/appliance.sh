import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { signReleaseEnvelope, type ReleaseEnvelope, type ReleaseTrustPolicy } from '@appliance.sh/sdk';
import { resolveReleaseEvidence, SELF_UPDATE_DISABLED_AP226 } from './release-evidence.js';

beforeAll(() => {
  if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
});

const now = new Date('2026-08-30T12:00:00Z');
const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const digest = `sha256:${'d'.repeat(64)}`;

async function fixture() {
  const payload: ReleaseEnvelope = {
    kind: 'control-plane-release',
    version: '1.58.0',
    generation: 15800,
    notBefore: '2026-08-30T00:00:00Z',
    expires: '2026-09-30T00:00:00Z',
    artifacts: [
      { name: 'appliance-api-server-linux-x64', arch: 'x64', sha256: '1'.repeat(64), size: 1 },
      { name: 'appliance-api-server-linux-arm64', arch: 'arm64', sha256: '2'.repeat(64), size: 1 },
      { name: 'appliance-console.tar.gz', arch: 'any', sha256: '3'.repeat(64), size: 1 },
    ],
    image: { repository: 'ghcr.io/lab255/appliance-api-server', manifestDigest: digest },
  };
  const envelope = await signReleaseEnvelope(payload, privateKey);
  const { getPublicKeyAsync } = await import('@noble/ed25519');
  const rawPublicKey = await getPublicKeyAsync(privateKey);
  const trust: ReleaseTrustPolicy = {
    keys: { [envelope.keyId]: `ed25519:${Buffer.from(rawPublicKey).toString('base64url')}` },
    generationFloor: 1,
  };
  return { payload, envelope, trust };
}

describe('release evidence', () => {
  it('fails before network access while AP-226 pins are empty', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(resolveReleaseEvidence({ version: '1.58.0', fetcher })).rejects.toThrow(SELF_UPDATE_DISABLED_AP226);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('downloads, verifies offline, and extracts the signed manifest digest', async () => {
    const { payload, envelope, trust } = await fixture();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return Response.json(url.endsWith('.sig.json') ? envelope : payload);
    });
    await expect(
      resolveReleaseEvidence({ version: 'v1.58.0', fetcher, trust, now, releaseBase: 'https://release.test' })
    ).resolves.toEqual({ version: '1.58.0', targetDigest: digest, release: { payload, envelope } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects a version mismatch and malformed evidence', async () => {
    const { payload, envelope, trust } = await fixture();
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      Response.json(String(input).endsWith('.sig.json') ? envelope : { ...payload, version: '1.59.0' })
    );
    await expect(resolveReleaseEvidence({ version: '1.58.0', fetcher, trust, now })).rejects.toThrow();
  });

  it('uses latestGhcrTag resolution when --version is omitted', async () => {
    const { payload, envelope, trust } = await fixture();
    const latest = vi.fn(async () => '1.58.0');
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      Response.json(String(input).endsWith('.sig.json') ? envelope : payload)
    );
    await resolveReleaseEvidence({ latest, fetcher, trust, now });
    expect(latest).toHaveBeenCalledWith({ image: undefined });
  });
});
