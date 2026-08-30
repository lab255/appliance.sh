import {
  PINNED_RELEASE_TRUST,
  verifyReleaseEnvelope,
  type ReleaseTrustPolicy,
  type SelfUpdateReleaseEvidence,
} from '@appliance.sh/sdk';
import { latestGhcrTag } from './ghcr-latest';

const RELEASE_BASE = 'https://github.com/lab255/appliance.sh/releases/download';
export const SELF_UPDATE_DISABLED_AP226 =
  'self-update disabled until the production key is pinned (AP-226)';

export interface ResolveReleaseEvidenceOptions {
  version?: string;
  image?: string;
  fetcher?: typeof globalThis.fetch;
  releaseBase?: string;
  trust?: ReleaseTrustPolicy;
  now?: Date;
  latest?: (input?: { image?: string }) => Promise<string>;
}

export interface ResolvedReleaseEvidence {
  version: string;
  targetDigest: string;
  release: SelfUpdateReleaseEvidence;
}

/** Fetch and verify the small signed release pair before any mutation request is sent. */
export async function resolveReleaseEvidence(
  options: ResolveReleaseEvidenceOptions = {}
): Promise<ResolvedReleaseEvidence> {
  const trust = options.trust ?? PINNED_RELEASE_TRUST;
  if (Object.keys(trust.keys).length === 0) throw new Error(SELF_UPDATE_DISABLED_AP226);

  const version = normalizeVersion(
    options.version ?? (await (options.latest ?? latestGhcrTag)({ image: options.image }))
  );
  const base = `${options.releaseBase ?? RELEASE_BASE}/v${version}`;
  const fetcher = options.fetcher ?? globalThis.fetch;
  const [payloadResponse, envelopeResponse] = await Promise.all([
    fetcher(`${base}/control-plane-release.json`, { headers: { accept: 'application/json' } }),
    fetcher(`${base}/control-plane-release.sig.json`, { headers: { accept: 'application/json' } }),
  ]);
  if (!payloadResponse.ok || !envelopeResponse.ok) {
    throw new Error(
      `signed release evidence for v${version} is unavailable (${payloadResponse.status}/${envelopeResponse.status})`
    );
  }

  let payload: unknown;
  let envelope: unknown;
  try {
    [payload, envelope] = await Promise.all([payloadResponse.json(), envelopeResponse.json()]);
  } catch {
    throw new Error(`signed release evidence for v${version} is malformed`);
  }
  const verified = await verifyReleaseEnvelope(payload, envelope, trust, { now: options.now });
  if (verified.payload.version !== version) {
    throw new Error(
      `signed release evidence names v${verified.payload.version}, not requested v${version}`
    );
  }
  return {
    version,
    targetDigest: verified.payload.image.manifestDigest,
    release: { payload: verified.payload, envelope: verified.envelope },
  };
}

function normalizeVersion(value: string): string {
  const version = value.trim().replace(/^v/, '');
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid control-plane release version: ${value}`);
  }
  return version;
}
