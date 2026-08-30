import { getPublicKeyAsync, signAsync } from '@noble/ed25519';
import { z } from 'zod';
import { signatureEnvelopeSchema, type SignatureEnvelope } from './catalogue';
import {
  CatalogueTrustError,
  catalogueSigningInput,
  checkTrustGeneration,
  checkTrustedKeyBlacklist,
  checkTrustValidity,
  verifySignatureEnvelope,
} from './catalogue-trust';

const semver = z
  .string()
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const manifestDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const rfc3339 = z.iso.datetime({ offset: true });

const releaseArtifactSchema = z.strictObject({
  name: z.enum(['appliance-api-server-linux-x64', 'appliance-api-server-linux-arm64', 'appliance-console.tar.gz']),
  arch: z.enum(['x64', 'arm64', 'any']),
  sha256,
  size: z.number().int().positive(),
});

export const releaseEnvelopeSchema = z
  .strictObject({
    kind: z.literal('control-plane-release'),
    version: semver,
    generation: z.number().int().nonnegative(),
    notBefore: rfc3339,
    expires: rfc3339,
    artifacts: z.array(releaseArtifactSchema).length(3),
    image: z.strictObject({
      repository: z.string().regex(/^ghcr\.io\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
      manifestDigest,
    }),
  })
  .superRefine((release, context) => {
    const expected = new Map([
      ['appliance-api-server-linux-x64', 'x64'],
      ['appliance-api-server-linux-arm64', 'arm64'],
      ['appliance-console.tar.gz', 'any'],
    ]);
    const seen = new Set<string>();
    for (const [index, artifact] of release.artifacts.entries()) {
      if (seen.has(artifact.name)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate release artifact ${artifact.name}`,
          path: ['artifacts', index],
        });
      }
      seen.add(artifact.name);
      if (artifact.arch !== expected.get(artifact.name)) {
        context.addIssue({
          code: 'custom',
          message: `wrong architecture for ${artifact.name}`,
          path: ['artifacts', index, 'arch'],
        });
      }
    }
    for (const name of expected.keys()) {
      if (!seen.has(name))
        context.addIssue({ code: 'custom', message: `missing release artifact ${name}`, path: ['artifacts'] });
    }
  });

export type ReleaseEnvelope = z.infer<typeof releaseEnvelopeSchema>;
export type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;
export type ReleaseSignatureEnvelope = SignatureEnvelope & { role: 'control-plane-release' };

export interface ReleaseTrustPolicy {
  keys: Readonly<Record<string, string>>;
  generationFloor: number;
  /** Populated only from an already verified signed blacklist. */
  blacklistedKeyIds?: readonly string[] | ReadonlySet<string>;
}

// Public-only development fixture and production pin placeholder: replaced by
// AP-226 with the offline production release keyId and public key.
export const RELEASE_DEV_FIXTURE_PUBLIC_KEY = 'ed25519:GX9rI-FshTLGq8g4-s1ep4m-DHaykgM0A5v6iz02jWE';
export const RELEASE_DEV_FIXTURE_KEY_ID =
  'ed25519:sha256:b600306cfa76723fdec395e53a9b3d9fdb78b1e2d7a23c32fcbcd2dc6d0c4092';

export const PINNED_RELEASE_TRUST: ReleaseTrustPolicy = Object.freeze({
  keys: Object.freeze({ [RELEASE_DEV_FIXTURE_KEY_ID]: RELEASE_DEV_FIXTURE_PUBLIC_KEY }),
  generationFloor: 1,
});

export interface VerifiedReleaseEnvelope {
  payload: ReleaseEnvelope;
  envelope: ReleaseSignatureEnvelope;
  verifiedAt: string;
}

export async function verifyReleaseEnvelope(
  untrustedPayload: unknown,
  untrustedEnvelope: unknown,
  trust: ReleaseTrustPolicy = PINNED_RELEASE_TRUST,
  options: { now?: Date; highestGeneration?: number } = {}
): Promise<VerifiedReleaseEnvelope> {
  const envelopeResult = signatureEnvelopeSchema.safeParse(untrustedEnvelope);
  if (!envelopeResult.success)
    throw new CatalogueTrustError('invalid-schema', 'release signature envelope is malformed');
  const publicKey = trust.keys[envelopeResult.data.keyId];
  if (!publicKey) throw new CatalogueTrustError('unknown-key', 'release signer is not pinned');
  checkTrustedKeyBlacklist(envelopeResult.data.keyId, trust.blacklistedKeyIds, 'release signer');
  const envelope = (await verifySignatureEnvelope(
    untrustedPayload,
    untrustedEnvelope,
    'control-plane-release',
    publicKey
  )) as ReleaseSignatureEnvelope;
  const payloadResult = releaseEnvelopeSchema.safeParse(untrustedPayload);
  if (!payloadResult.success)
    throw new CatalogueTrustError('invalid-schema', 'control-plane release schema is invalid');
  const payload = payloadResult.data;
  checkTrustGeneration(
    payload.generation,
    {
      keys: trust.keys,
      generationFloor: trust.generationFloor,
      highestGeneration: options.highestGeneration,
    },
    'release'
  );
  const now = options.now ?? new Date();
  checkTrustValidity(payload.notBefore, payload.expires, Number.MAX_SAFE_INTEGER, now, false, 'release', 'release');
  return { payload, envelope, verifiedAt: now.toISOString() };
}

function base64url(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

/** CI/test helper. privateKey is a raw 32-byte Ed25519 seed. */
export async function signReleaseEnvelope(
  payload: ReleaseEnvelope,
  privateKey: Uint8Array
): Promise<ReleaseSignatureEnvelope> {
  const parsed = releaseEnvelopeSchema.parse(payload);
  if (privateKey.byteLength !== 32) throw new TypeError('release signing key must be a raw 32-byte Ed25519 seed');
  const publicKey = await getPublicKeyAsync(privateKey);
  const keyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey.slice().buffer));
  const keyId = `ed25519:sha256:${Array.from(keyHash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const sig = await signAsync(await catalogueSigningInput(parsed, 'control-plane-release'), privateKey);
  return { alg: 'ed25519', keyId, role: 'control-plane-release', sig: base64url(sig) };
}
