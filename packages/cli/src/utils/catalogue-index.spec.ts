import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicaliseJson } from '@appliance.sh/sdk';
import { loadCatalogueIndex } from './catalogue-index';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('keeps CLI/native floors across refresh races, offline use and signer replacement', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogue-cache-'));
  directories.push(directory);
  const root = path.join(directory, 'runtime');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const keyId = `ed25519:sha256:${createHash('sha256').update(raw).digest('hex')}`;
  const policy = { keys: { [keyId]: `ed25519:${raw.toString('base64url')}` }, generationFloor: 2 };
  let generation = 8;
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const payload = {
      schema: 'appliance.catalogue-index/v1',
      generation,
      issuedAt: '2026-10-01T00:00:00Z',
      expiresAt: '2026-10-08T00:00:00Z',
      entries: [],
    };
    const sig = sign(
      null,
      Buffer.concat([
        Buffer.from('appliance/index\0'),
        createHash('sha256').update(canonicaliseJson(payload)).digest(),
      ]),
      privateKey
    ).toString('base64url');
    return String(url).includes('.sig?')
      ? new Response(JSON.stringify({ alg: 'ed25519', keyId, role: 'index', sig }))
      : new Response(JSON.stringify(payload), { headers: { 'X-Appliance-Catalogue-Snapshot': 'a'.repeat(64) } });
  });
  const options = {
    root,
    origin: 'https://example.test',
    fetch: fetcher,
    policy,
    now: new Date('2026-10-03T00:00:00Z'),
  };
  await expect(loadCatalogueIndex(options)).resolves.toMatchObject({ payload: { generation: 8 } });
  generation = 7;
  await expect(loadCatalogueIndex(options)).resolves.toMatchObject({ payload: { generation: 8 } });
  const offline = async () => {
    throw new Error('offline');
  };
  await expect(loadCatalogueIndex({ ...options, fetch: offline })).resolves.toMatchObject({
    payload: { generation: 8 },
  });
  await expect(loadCatalogueIndex({ ...options, fetch: offline, now: new Date('2026-10-02') })).rejects.toThrow(
    'clock moved backwards'
  );
  await expect(
    loadCatalogueIndex({ ...options, fetch: offline, now: new Date('2026-10-09'), allowExpired: true })
  ).resolves.toMatchObject({ stale: true });
  await expect(loadCatalogueIndex({ ...options, fetch: offline, now: new Date('2026-10-09') })).rejects.toThrow(
    'offline'
  );
  const native = path.join(directory, 'catalogue', 'verified-pair.json');
  fs.writeFileSync(
    native,
    JSON.stringify({
      indexJson: '{}',
      signatureJson: '{}',
      highestGeneration: 100,
      maxSeenWallClock: options.now.toISOString(),
    })
  );
  await expect(loadCatalogueIndex(options)).rejects.toMatchObject({ code: 'generation-below-floor' });
});

it('keeps blacklist generations separate from index generations and pins exact blacklist snapshots', async () => {
  const { loadBlacklist } = await import('../appliance-runtime-install');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blacklist-cache-'));
  directories.push(directory);
  const root = path.join(directory, 'runtime');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const keyId = `ed25519:sha256:${createHash('sha256').update(raw).digest('hex')}`;
  const policy = { keys: { [keyId]: `ed25519:${raw.toString('base64url')}` }, generationFloor: 2 };
  const payload = {
    schema: 'appliance.blacklist/v1',
    generation: 3,
    issuedAt: '2026-10-01T00:00:00Z',
    expiresAt: '2026-10-08T00:00:00Z',
    entries: [{ appId: 'org.withdrawn', reason: 'withdrawn' }],
  };
  const sig = sign(
    null,
    Buffer.concat([
      Buffer.from('appliance/blacklist\0'),
      createHash('sha256').update(canonicaliseJson(payload)).digest(),
    ]),
    privateKey
  ).toString('base64url');
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    String(url).includes('.sig?')
      ? new Response(JSON.stringify({ alg: 'ed25519', keyId, role: 'blacklist', sig }))
      : new Response(JSON.stringify(payload), { headers: { 'X-Appliance-Catalogue-Snapshot': 'b'.repeat(64) } })
  );
  fs.mkdirSync(path.join(directory, 'catalogue'));
  fs.writeFileSync(path.join(directory, 'catalogue', 'verified-pair.json'), JSON.stringify({ highestGeneration: 100 }));
  const options = {
    root,
    catalogueOrigin: 'https://example.test',
    fetcher,
    policy,
    now: new Date('2026-10-03T00:00:00Z'),
    networkInstall: true,
  };
  await expect(loadBlacklist(options)).resolves.toMatchObject({ payload });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://example.test/catalogue/blacklist.json',
    `https://example.test/catalogue/blacklist.json.sig?snapshot=${'b'.repeat(64)}`,
  ]);
  const cacheFile = path.join(directory, 'catalogue', 'verified-blacklist.json');
  const legacyCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  delete legacyCache.generation;
  fs.writeFileSync(cacheFile, JSON.stringify(legacyCache));
  fetcher.mockClear();
  await expect(loadBlacklist(options)).resolves.toMatchObject({ payload });
  expect(fetcher).not.toHaveBeenCalled();
  // Neither malformed JSON nor a forged high generation in an unsigned legacy
  // payload may become a floor before the pair has been reverified.
  for (const blacklistJson of ['not JSON', JSON.stringify({ ...payload, generation: Number.MAX_SAFE_INTEGER })]) {
    fs.writeFileSync(cacheFile, JSON.stringify({ ...legacyCache, blacklistJson }));
    fetcher.mockClear();
    await expect(loadBlacklist(options)).resolves.toMatchObject({ payload });
    expect(fetcher).toHaveBeenCalledTimes(2);
  }
  fetcher.mockRejectedValue(new Error('offline'));
  await expect(loadBlacklist({ ...options, now: new Date('2026-10-04') })).resolves.toMatchObject({ payload });
  await expect(loadBlacklist({ ...options, now: new Date('2026-10-02') })).rejects.toThrow('clock moved backwards');
});
