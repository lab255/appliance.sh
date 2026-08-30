import {
  fetchReleaseEvidence,
  PINNED_RELEASE_TRUST,
  SELF_UPDATE_DISABLED_AP226,
  type ReleaseTrustPolicy,
  type ResolvedReleaseEvidence,
} from '@appliance.sh/sdk';
import { latestGhcrTag } from '@appliance.sh/bootstrap/ghcr-latest';

export { SELF_UPDATE_DISABLED_AP226 };
export type { ResolvedReleaseEvidence };

export interface ResolveReleaseEvidenceOptions {
  version?: string;
  image?: string;
  fetcher?: typeof globalThis.fetch;
  releaseBase?: string;
  trust?: ReleaseTrustPolicy;
  now?: Date;
  latest?: (input?: { image?: string }) => Promise<string>;
}

/** CLI resolver adds latest-tag selection to the SDK's offline verifier. */
export async function resolveReleaseEvidence(
  options: ResolveReleaseEvidenceOptions = {}
): Promise<ResolvedReleaseEvidence> {
  const trust = options.trust ?? PINNED_RELEASE_TRUST;
  if (Object.keys(trust.keys).length === 0) throw new Error(SELF_UPDATE_DISABLED_AP226);
  const version = options.version ?? (await (options.latest ?? latestGhcrTag)({ image: options.image }));
  return fetchReleaseEvidence({
    version,
    trust,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.releaseBase ? { releaseBase: options.releaseBase } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
