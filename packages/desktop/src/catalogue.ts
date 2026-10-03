import {
  fetchCataloguePair,
  verifyCatalogueIndexPair,
  PINNED_CATALOGUE_TRUST,
  type CatalogueTrustPolicy,
} from '@appliance.sh/sdk';
import type { CatalogueFetchResult } from '@appliance.sh/app';

/** Desktop transport boundary; the native cache remains the monotonic storage authority. */
export async function fetchDesktopCatalogue(
  cached: CatalogueFetchResult | null,
  options: {
    fetch?: typeof fetch;
    policy?: CatalogueTrustPolicy;
    now?: Date;
  } = {}
): Promise<CatalogueFetchResult> {
  const now = options.now ?? new Date();
  try {
    if (cached?.maxSeenWallClock && now.getTime() < Date.parse(cached.maxSeenWallClock))
      throw new Error('System clock moved backwards');
    const { payloadBytes, envelopeBytes } = await fetchCataloguePair({
      origin: 'https://www.appliance.sh',
      role: 'index',
      fetch: options.fetch,
      verify: (indexBytes, envelopeBytes) =>
        verifyCatalogueIndexPair({
          indexBytes,
          envelopeBytes,
          now,
          policy: {
            ...(options.policy ?? PINNED_CATALOGUE_TRUST),
            highestGeneration: Math.max(options.policy?.highestGeneration ?? 0, cached?.highestGeneration ?? 0),
          },
        }),
    });
    return {
      indexJson: new TextDecoder().decode(payloadBytes),
      signatureJson: new TextDecoder().decode(envelopeBytes),
      fetchedAt: now.toISOString(),
      source: 'network',
      highestGeneration: cached?.highestGeneration,
      maxSeenWallClock: cached?.maxSeenWallClock,
    };
  } catch (cause) {
    if (!cached) throw cause;
    return {
      ...cached,
      source: 'cache',
      refreshError: cause instanceof Error ? cause.message : 'catalogue refresh failed',
    };
  }
}
