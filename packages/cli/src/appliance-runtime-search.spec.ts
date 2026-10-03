import { getPublicKeyAsync, signAsync } from '@noble/ed25519';
import { catalogueSigningInput, type CatalogueIndex, type CatalogueTrustPolicy } from '@appliance.sh/sdk';
import { expect, it } from 'vitest';
import { searchCatalogue } from './appliance-runtime-search';

it('searches only free entries after verifying the pair', async () => {
  const privateKey = new Uint8Array(32).fill(9);
  const publicKey = await getPublicKeyAsync(privateKey);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey.slice().buffer));
  const keyId = `ed25519:sha256:${Buffer.from(digest).toString('hex')}`;
  const policy: CatalogueTrustPolicy = {
    keys: { [keyId]: `ed25519:${Buffer.from(publicKey).toString('base64url')}` },
    generationFloor: 1,
  };
  const common = {
    version: '1.0.0',
    description: 'A useful app',
    license: 'MIT',
    publisher: { name: 'Fixture', tier: 'known' as const },
    paid: false,
    categories: [],
    bundle: { url: 'https://fixture.appliance.zip', digest: `sha256:${'a'.repeat(64)}` },
  };
  const index: CatalogueIndex = {
    schema: 'appliance.catalogue-index/v1',
    generation: 1,
    issuedAt: '2026-08-20T00:00:00Z',
    expiresAt: '2026-08-28T00:00:00Z',
    entries: [
      { ...common, appId: 'journal', name: 'Journal' },
      { ...common, appId: 'premium', name: 'Premium secret', paid: true },
    ],
  };
  const sig = await signAsync(await catalogueSigningInput(index, 'index'), privateKey);
  const responses = [
    new Response(JSON.stringify(index), { headers: { 'X-Appliance-Catalogue-Snapshot': 'a'.repeat(64) } }),
    new Response(JSON.stringify({ alg: 'ed25519', keyId, role: 'index', sig: Buffer.from(sig).toString('base64url') })),
  ];
  const fetcher = async () => responses.shift()!;

  await expect(
    searchCatalogue('', {
      origin: 'https://example.test',
      fetch: fetcher,
      policy,
      now: new Date('2026-08-27T00:00:00Z'),
    })
  ).resolves.toMatchObject({ entries: [{ appId: 'journal' }] });
});
