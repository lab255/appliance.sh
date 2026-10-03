import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  checkTrustGeneration,
  fetchCataloguePair,
  verifyCatalogueIndexPair,
  type CatalogueTrustPolicy,
} from '@appliance.sh/sdk';
import { withProfilesLock } from './profiles-lock';

interface IndexCache {
  indexJson: string;
  signatureJson: string;
  highestGeneration: number;
  maxSeenWallClock: string;
}

function read(file: string): IndexCache | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as IndexCache;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function caches(root: string) {
  const directory = path.join(path.dirname(root), 'catalogue');
  const file = path.join(directory, 'verified-cli-index.json');
  // Keep native storage and its monotonic writer intact; inherit its upgrade floor.
  const values = [read(file), read(path.join(directory, 'verified-pair.json'))].filter(
    (value): value is IndexCache => !!value
  );
  return { directory, file, values };
}

function policyFor(values: IndexCache[], policy: CatalogueTrustPolicy, now: Date): CatalogueTrustPolicy {
  for (const cache of values) {
    if (!Number.isSafeInteger(cache.highestGeneration) || cache.highestGeneration < 0)
      throw new Error('Invalid cached catalogue generation');
    if (!Number.isFinite(Date.parse(cache.maxSeenWallClock)) || now.getTime() < Date.parse(cache.maxSeenWallClock))
      throw new Error('System clock moved backwards or catalogue cache clock is invalid');
  }
  return {
    ...policy,
    highestGeneration: Math.max(policy.highestGeneration ?? 0, ...values.map((value) => value.highestGeneration)),
  };
}

export async function cachedCatalogueIndex(root: string, policy: CatalogueTrustPolicy, now: Date) {
  const { values } = caches(root);
  const effective = policyFor(values, policy, now);
  for (const cache of values.sort((a, b) => b.highestGeneration - a.highestGeneration)) {
    try {
      return await verifyCatalogueIndexPair({
        indexBytes: Buffer.from(cache.indexJson),
        envelopeBytes: Buffer.from(cache.signatureJson),
        policy: effective,
        now,
        allowExpired: true,
      });
    } catch {
      /* A retired signer never resets the persisted high-water mark. */
    }
  }
  return undefined;
}

export async function loadCatalogueIndex(options: {
  root: string;
  origin: string;
  fetch?: typeof fetch;
  policy: CatalogueTrustPolicy;
  now: Date;
  allowExpired?: boolean;
}) {
  const { directory, file, values } = caches(options.root);
  const policy = policyFor(values, options.policy, options.now);
  try {
    const pair = await fetchCataloguePair({
      origin: options.origin,
      role: 'index',
      fetch: options.fetch,
      verify: (indexBytes, envelopeBytes) =>
        verifyCatalogueIndexPair({ indexBytes, envelopeBytes, policy, now: options.now }),
    });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    withProfilesLock(`${file}.lock`, () => {
      const current = policyFor(caches(options.root).values, policy, options.now);
      checkTrustGeneration(pair.verified.payload.generation, current);
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(
        temporary,
        JSON.stringify({
          indexJson: Buffer.from(pair.payloadBytes).toString('utf8'),
          signatureJson: Buffer.from(pair.envelopeBytes).toString('utf8'),
          highestGeneration: pair.verified.payload.generation,
          maxSeenWallClock: options.now.toISOString(),
        }),
        { mode: 0o600 }
      );
      fs.renameSync(temporary, file);
    });
    return pair.verified;
  } catch (error) {
    const cached = await cachedCatalogueIndex(options.root, policy, options.now);
    if (cached && (!cached.stale || options.allowExpired)) return cached;
    throw error;
  }
}
