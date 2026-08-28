import {
  PINNED_CATALOGUE_TRUST,
  freeCatalogueEntries,
  verifyCatalogueIndexPair,
  type CatalogueEntry,
  type CatalogueTrustPolicy,
} from '@appliance.sh/sdk';
import type { CatalogueFetchResult } from '@/lib/host';

export interface CatalogueViewData {
  entries: CatalogueEntry[];
  stale: boolean;
  verifiedAt: string;
  generation: number;
  refreshError?: string;
}

export async function verifyHostCatalogue(result: CatalogueFetchResult, now = new Date()): Promise<CatalogueViewData> {
  if (result.maxSeenWallClock && now.getTime() < Date.parse(result.maxSeenWallClock)) {
    throw new Error('System clock moved backwards; correct it before refreshing or installing catalogue apps.');
  }
  const developmentPolicy = result.source === 'mock' ? result.developmentTrustPolicy : undefined;
  const basePolicy: CatalogueTrustPolicy = developmentPolicy ?? PINNED_CATALOGUE_TRUST;
  const policy: CatalogueTrustPolicy = { ...basePolicy, highestGeneration: result.highestGeneration };
  const verified = await verifyCatalogueIndexPair({
    indexBytes: new TextEncoder().encode(result.indexJson),
    envelopeBytes: new TextEncoder().encode(result.signatureJson),
    policy,
    now,
    allowExpired: true,
  });
  return {
    entries: freeCatalogueEntries(verified.payload),
    stale: verified.stale,
    verifiedAt: verified.verifiedAt,
    generation: verified.payload.generation,
    refreshError: result.refreshError,
  };
}

export { canonicaliseJson, verifySignatureEnvelope } from '@appliance.sh/sdk';
