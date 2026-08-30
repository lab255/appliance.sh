import { getPublicKeyAsync } from '@noble/ed25519';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  releaseEnvelopeSchema,
  signReleaseEnvelope,
  verifyReleaseEnvelope,
  type ReleaseEnvelope,
  type ReleaseTrustPolicy,
} from './release-trust';

const privateKey = new Uint8Array(32).fill(42);
const wrongPrivateKey = new Uint8Array(32).fill(43);
let trust: ReleaseTrustPolicy;

async function wireKey(seed: Uint8Array): Promise<[string, string]> {
  const publicKey = await getPublicKeyAsync(seed);
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', publicKey)).toString('hex');
  return [`ed25519:sha256:${hash}`, `ed25519:${Buffer.from(publicKey).toString('base64url')}`];
}

beforeAll(async () => {
  const [keyId, publicKey] = await wireKey(privateKey);
  trust = { keys: { [keyId]: publicKey }, generationFloor: 10 };
});

function release(overrides: Partial<ReleaseEnvelope> = {}): ReleaseEnvelope {
  return {
    kind: 'control-plane-release',
    version: '1.57.0',
    generation: 12,
    notBefore: '2026-08-29T00:00:00Z',
    expires: '2027-08-29T00:00:00Z',
    artifacts: [
      { name: 'appliance-api-server-linux-x64', arch: 'x64', sha256: 'a'.repeat(64), size: 100 },
      { name: 'appliance-api-server-linux-arm64', arch: 'arm64', sha256: 'b'.repeat(64), size: 101 },
      { name: 'appliance-console.tar.gz', arch: 'any', sha256: 'c'.repeat(64), size: 102 },
    ],
    image: { repository: 'ghcr.io/appliance-sh/api-server', manifestDigest: `sha256:${'d'.repeat(64)}` },
    ...overrides,
  };
}

const now = new Date('2026-08-30T00:00:00Z');

describe('control-plane release trust', () => {
  it('accepts a valid release envelope', async () => {
    const payload = release();
    const envelope = await signReleaseEnvelope(payload, privateKey);
    await expect(verifyReleaseEnvelope(payload, envelope, trust, { now, highestGeneration: 11 })).resolves.toMatchObject({
      payload: { version: '1.57.0', generation: 12 },
      envelope: { keyId: envelope.keyId, role: 'control-plane-release' },
    });
  });

  it('rejects a release signed by the wrong key', async () => {
    const payload = release();
    await expect(
      verifyReleaseEnvelope(payload, await signReleaseEnvelope(payload, wrongPrivateKey), trust, { now })
    ).rejects.toMatchObject({ code: 'unknown-key' });
  });

  it('rejects a tampered artifact sha256', async () => {
    const signed = release();
    const envelope = await signReleaseEnvelope(signed, privateKey);
    const tampered = release({ artifacts: signed.artifacts.map((artifact, index) => index ? artifact : { ...artifact, sha256: 'f'.repeat(64) }) });
    await expect(verifyReleaseEnvelope(tampered, envelope, trust, { now })).rejects.toMatchObject({ code: 'bad-signature' });
  });

  it('rejects a wrong artifact architecture in the payload schema', () => {
    const payload = release();
    payload.artifacts[0] = { ...payload.artifacts[0]!, arch: 'arm64' };
    expect(releaseEnvelopeSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a generation below the high-water mark', async () => {
    const payload = release({ generation: 11 });
    await expect(
      verifyReleaseEnvelope(payload, await signReleaseEnvelope(payload, privateKey), trust, { now, highestGeneration: 12 })
    ).rejects.toMatchObject({ code: 'generation-below-floor' });
  });

  it('rejects an expired release', async () => {
    const payload = release({ expires: '2026-08-29T12:00:00Z' });
    await expect(verifyReleaseEnvelope(payload, await signReleaseEnvelope(payload, privateKey), trust, { now })).rejects.toMatchObject({
      code: 'expired',
    });
  });

  it('rejects a signer from the verified blacklist', async () => {
    const payload = release();
    const envelope = await signReleaseEnvelope(payload, privateKey);
    await expect(
      verifyReleaseEnvelope(payload, envelope, { ...trust, blacklistedKeyIds: [envelope.keyId] }, { now })
    ).rejects.toMatchObject({ code: 'blacklisted-key' });
  });
});
