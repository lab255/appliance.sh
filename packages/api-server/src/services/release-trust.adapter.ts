import { z } from '@appliance.sh/sdk';

const semver = z
  .string()
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const manifestDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const rfc3339 = z.iso.datetime({ offset: true });

export const controlPlaneReleaseSchema = z.strictObject({
  kind: z.literal('control-plane-release'),
  version: semver,
  generation: z.number().int().nonnegative(),
  notBefore: rfc3339,
  expires: rfc3339,
  artifacts: z
    .array(
      z.strictObject({
        name: z.enum([
          'appliance-api-server-linux-x64',
          'appliance-api-server-linux-arm64',
          'appliance-console.tar.gz',
        ]),
        arch: z.enum(['x64', 'arm64', 'any']),
        sha256,
        size: z.number().int().positive(),
      })
    )
    .length(3),
  image: z.strictObject({
    repository: z.string().regex(/^ghcr\.io\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
    manifestDigest,
  }),
});

export type ControlPlaneRelease = z.infer<typeof controlPlaneReleaseSchema>;

export interface VerifiedControlPlaneRelease {
  payload: ControlPlaneRelease;
  envelope: unknown;
  verifiedAt: string;
}

export type ReleaseVerifier = (
  payload: unknown,
  envelope: unknown,
  options?: { now?: Date; highestGeneration?: number }
) => Promise<VerifiedControlPlaneRelease>;

type Mv0Sdk = {
  PINNED_RELEASE_TRUST?: unknown;
  verifyReleaseEnvelope?: (
    payload: unknown,
    envelope: unknown,
    trust?: unknown,
    options?: { now?: Date; highestGeneration?: number }
  ) => Promise<{ payload: unknown; envelope: unknown; verifiedAt: string }>;
};

/**
 * Thin AP-225 adapter. It compiles on the CU0 base, where MV0 is not yet
 * merged, and automatically binds to MV0's public SDK exports after Morgan's
 * rebase. Missing production trust fails closed as unknown-key.
 */
export const verifyProductionRelease: ReleaseVerifier = async (payload, envelope, options = {}) => {
  const sdk = (await import('@appliance.sh/sdk')) as unknown as Mv0Sdk;
  if (!sdk.verifyReleaseEnvelope || !sdk.PINNED_RELEASE_TRUST) {
    throw Object.assign(new Error('release signing trust is unavailable until AP-225 is merged'), {
      name: 'CatalogueTrustError',
      code: 'unknown-key',
    });
  }
  const verified = await sdk.verifyReleaseEnvelope(payload, envelope, sdk.PINNED_RELEASE_TRUST, options);
  return {
    payload: controlPlaneReleaseSchema.parse(verified.payload),
    envelope: verified.envelope,
    verifiedAt: verified.verifiedAt,
  };
};
