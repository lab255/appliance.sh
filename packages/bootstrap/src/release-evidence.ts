import {
  fetchReleaseEvidence,
  PINNED_RELEASE_TRUST,
  SELF_UPDATE_DISABLED_AP226,
  type ReleaseTrustPolicy,
  type ResolvedReleaseEvidence,
} from '@appliance.sh/sdk';
import { latestGhcrTag } from './ghcr-latest';

export { SELF_UPDATE_DISABLED_AP226 };

export interface ResolveReleaseEvidenceOptions {
  version?: string;
  image?: string;
  fetcher?: typeof globalThis.fetch;
  releaseBase?: string;
  trust?: ReleaseTrustPolicy;
  now?: Date;
  latest?: (input?: { image?: string }) => Promise<string>;
}

export type { ResolvedReleaseEvidence };

/** Fetch and verify the small signed release pair before any mutation request is sent. */
export async function resolveReleaseEvidence(
  options: ResolveReleaseEvidenceOptions = {}
): Promise<ResolvedReleaseEvidence> {
  const trust = options.trust ?? PINNED_RELEASE_TRUST;
  if (Object.keys(trust.keys).length === 0) throw new Error(SELF_UPDATE_DISABLED_AP226);
  const version = normalizeVersion(
    options.version ?? (await (options.latest ?? latestGhcrTag)({ image: options.image }))
  );
  return fetchReleaseEvidence({
    version,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.releaseBase ? { releaseBase: options.releaseBase } : {}),
    trust,
    ...(options.now ? { now: options.now } : {}),
  });
}

function normalizeVersion(value: string): string {
  const version = value.trim().replace(/^v/, '');
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid control-plane release version: ${value}`);
  }
  return version;
}
