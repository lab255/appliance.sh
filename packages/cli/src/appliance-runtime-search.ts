import {
  PINNED_CATALOGUE_TRUST,
  freeCatalogueEntries,
  verifyCatalogueIndexPair,
  type CatalogueEntry,
  type CatalogueTrustPolicy,
} from '@appliance.sh/sdk';

const DEFAULT_CATALOGUE_ORIGIN = 'https://www.appliance.sh';

function catalogueOrigin(): string {
  const raw = process.env.APPLIANCE_CATALOGUE_URL?.trim() || DEFAULT_CATALOGUE_ORIGIN;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('APPLIANCE_CATALOGUE_URL must use HTTPS (except localhost development)');
  }
  return url.toString().replace(/\/$/, '');
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`catalogue request failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function searchCatalogue(
  query: string,
  options: { origin?: string; fetch?: typeof fetch; policy?: CatalogueTrustPolicy; now?: Date } = {}
): Promise<{ entries: CatalogueEntry[]; stale: boolean; verifiedAt: string }> {
  const origin = (options.origin ?? catalogueOrigin()).replace(/\/$/, '');
  const fetcher = options.fetch ?? fetch;
  const [indexResponse, signatureResponse] = await Promise.all([
    fetcher(`${origin}/catalogue/index.json`, { headers: { Accept: 'application/json' } }),
    fetcher(`${origin}/catalogue/index.json.sig`, { headers: { Accept: 'application/json' } }),
  ]);
  const [indexBytes, envelopeBytes] = await Promise.all([
    responseBytes(indexResponse),
    responseBytes(signatureResponse),
  ]);
  const verified = await verifyCatalogueIndexPair({
    indexBytes,
    envelopeBytes,
    policy: options.policy ?? PINNED_CATALOGUE_TRUST,
    now: options.now,
    allowExpired: true,
  });
  const needle = query.trim().toLocaleLowerCase();
  const entries = freeCatalogueEntries(verified.payload).filter((entry) => {
    if (!needle) return true;
    return [entry.id, entry.name, entry.description, entry.license, entry.publisher.name, entry.category ?? '']
      .join('\n')
      .toLocaleLowerCase()
      .includes(needle);
  });
  return { entries, stale: verified.stale, verifiedAt: verified.verifiedAt };
}

export async function runRuntimeSearch(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: appliance runtime search <query>');
    console.log('Search the verified free-app catalogue. APPLIANCE_CATALOGUE_URL overrides the origin.');
    return;
  }
  const query = argv.filter((argument) => !argument.startsWith('-')).join(' ');
  const result = await searchCatalogue(query);
  if (result.stale) {
    console.error('Warning: catalogue index is stale; results are read-only and cannot be installed.');
  }
  if (result.entries.length === 0) {
    console.log('No free apps matched.');
    return;
  }
  console.log('NAME\tVERSION\tLICENSE\tPUBLISHER');
  for (const entry of result.entries) {
    console.log(`${entry.name}\t${entry.version}\t${entry.license}\t${entry.publisher.name}`);
  }
  console.error(`Verified signed index at ${result.verifiedAt}.`);
}
