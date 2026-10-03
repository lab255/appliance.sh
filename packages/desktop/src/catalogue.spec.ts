import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { canonicaliseJson, verifyCatalogueIndexPair } from '@appliance.sh/sdk';
import { fetchDesktopCatalogue } from './catalogue';

it('verifies a producer-signed snapshot with platform Link headers and preserves the native cache floors', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const keyId = `ed25519:sha256:${createHash('sha256').update(raw).digest('hex')}`;
  const policy = { keys: { [keyId]: `ed25519:${raw.toString('base64url')}` }, generationFloor: 2 };
  const payload = {
    schema: 'appliance.catalogue-index/v1',
    generation: 9,
    issuedAt: '2026-10-01T00:00:00Z',
    expiresAt: '2026-10-08T00:00:00Z',
    entries: [
      {
        appId: 'org.journal',
        name: 'Journal',
        version: 'stable',
        license: 'MIT OR Apache-2.0',
        description: 'Notes',
        paid: false,
        categories: ['operations', 'collaboration'],
        publisher: { name: 'Community', tier: 'unknown' },
        bundle: { url: 'https://example.test/journal.zip', digest: `sha256:${'a'.repeat(64)}` },
      },
    ],
  };
  // Mirrors packages/signing: JCS -> SHA256 -> role + NUL + digest -> Ed25519.
  const input = Buffer.concat([
    Buffer.from('appliance/index\0'),
    createHash('sha256').update(canonicaliseJson(payload)).digest(),
  ]);
  const envelope = { alg: 'ed25519', keyId, role: 'index', sig: sign(null, input, privateKey).toString('base64url') };
  const snapshot = 'a'.repeat(64);
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    String(url).includes('.sig?')
      ? new Response(canonicaliseJson(envelope) + '\n')
      : new Response(canonicaliseJson(payload) + '\n', {
          headers: {
            'X-Appliance-Catalogue-Snapshot': snapshot,
            Link: `</_next/x.js>; rel=preload; title="platform, preload", </catalogue/index.json.sig?snapshot=${snapshot}>; rel="signature"`,
          },
        })
  );
  const now = new Date('2026-10-03T00:00:00Z');
  const pair = await fetchDesktopCatalogue(null, { fetch: fetcher, policy, now });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://www.appliance.sh/catalogue/index.json',
    `https://www.appliance.sh/catalogue/index.json.sig?snapshot=${snapshot}`,
  ]);
  await expect(
    verifyCatalogueIndexPair({
      indexBytes: Buffer.from(pair.indexJson),
      envelopeBytes: Buffer.from(pair.signatureJson),
      policy,
      now,
    })
  ).resolves.toMatchObject({ payload });
  const cached = { ...pair, highestGeneration: 10, maxSeenWallClock: now.toISOString() };
  await expect(fetchDesktopCatalogue(cached, { fetch: fetcher, policy, now })).resolves.toMatchObject({
    source: 'cache',
    highestGeneration: 10,
    refreshError: expect.stringContaining('below floor'),
  });
});
