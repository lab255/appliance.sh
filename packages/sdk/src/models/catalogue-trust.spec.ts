import { getPublicKeyAsync, signAsync } from '@noble/ed25519';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOGUE_INDEX_MAX_BYTES,
  CatalogueTrustError,
  catalogueSigningInput,
  canonicaliseJson,
  verifyCatalogueIndexPair,
  verifySignatureEnvelope,
} from './catalogue-trust';
import type { CatalogueIndex, SignatureEnvelope } from './catalogue';

const encoder = new TextEncoder();
const privateKey = new Uint8Array(32).fill(7);
let publicKeyWire: string;
let keyId: string;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
}

beforeAll(async () => {
  const publicKey = await getPublicKeyAsync(privateKey);
  publicKeyWire = `ed25519:${base64url(publicKey)}`;
  keyId = `ed25519:sha256:${await sha256(publicKey)}`;
});

function index(overrides: Partial<CatalogueIndex> = {}): CatalogueIndex {
  return {
    schema: 'appliance.catalogue-index/v1',
    generation: 4,
    issuedAt: '2026-08-20T00:00:00Z',
    expiresAt: '2026-08-27T00:00:00Z',
    entries: [
      {
        appId: 'journal',
        name: 'Journal',
        version: '1.2.0',
        description: 'Private daily notes.',
        license: 'MIT',
        publisher: { name: 'Lab 255', keyId, publicKey: publicKeyWire, tier: 'known' as const },
        paid: false,
        categories: [],
        bundle: { url: 'https://journal.appliance.zip', digest: `sha256:${'a'.repeat(64)}` },
      },
    ],
    ...overrides,
  };
}

async function pair(payload: unknown, role: SignatureEnvelope['role'] = 'index') {
  const signature = await signAsync(await catalogueSigningInput(payload, role), privateKey);
  const envelope: SignatureEnvelope = { alg: 'ed25519', keyId, role, sig: base64url(signature) };
  return {
    indexBytes: encoder.encode(JSON.stringify(payload)),
    envelopeBytes: encoder.encode(JSON.stringify(envelope)),
    policy: { keys: { [keyId]: publicKeyWire }, generationFloor: 1 },
    now: new Date('2026-08-26T00:00:00Z'),
  };
}

describe('catalogue trust', () => {
  it('canonicalises and passes RFC 0001’s index signature vector', async () => {
    const payload = { generation: 1, schema: 'appliance.catalogue-index/v1' };
    expect(canonicaliseJson(payload)).toBe('{"generation":1,"schema":"appliance.catalogue-index/v1"}');
    expect(Buffer.from(await catalogueSigningInput(payload, 'index')).toString('hex')).toBe(
      '6170706c69616e63652f696e6465780040f2ae9c775126e40f60dd6337f5f024c7ecb9a1eae19e679b1a65c917d16a44'
    );
    await expect(
      verifySignatureEnvelope(
        payload,
        {
          alg: 'ed25519',
          keyId: 'ed25519:sha256:56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c',
          role: 'index',
          sig: 'sSRtIzTuKIHX1YjieIXDbGpWdcbRtWfHx-eiifnpls-KjlagcD2Ir0EOkgUMTuHaHtR8qiN2VA68nFlHO9RbBw',
        },
        'index',
        'ed25519:A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg'
      )
    ).resolves.toMatchObject({ role: 'index' });
  });

  it('accepts a valid bounded index', async () => {
    await expect(verifyCatalogueIndexPair(await pair(index()))).resolves.toMatchObject({ stale: false });
  });

  it('verifies the raw parsed object before schema parsing transforms values', async () => {
    const payload = index();
    payload.entries[0]!.name = ' Journal ';
    await expect(verifyCatalogueIndexPair(await pair(payload))).resolves.toMatchObject({
      payload: { entries: [{ name: ' Journal ' }] },
    });
  });

  it('rejects a bad signature', async () => {
    const options = await pair(index());
    const envelope = JSON.parse(new TextDecoder().decode(options.envelopeBytes));
    envelope.sig = `${envelope.sig.slice(0, -1)}A`;
    options.envelopeBytes = encoder.encode(JSON.stringify(envelope));
    await expect(verifyCatalogueIndexPair(options)).rejects.toMatchObject({ code: 'bad-signature' });
  });

  it('rejects expired metadata unless stale rendering is explicitly requested', async () => {
    const options = await pair(index({ expiresAt: '2026-08-22T00:00:00Z' }));
    await expect(verifyCatalogueIndexPair(options)).rejects.toMatchObject({ code: 'expired' });
    await expect(verifyCatalogueIndexPair({ ...options, allowExpired: true })).resolves.toMatchObject({ stale: true });
  });

  it('rejects the wrong envelope role', async () => {
    const options = await pair(index(), 'blacklist');
    await expect(verifyCatalogueIndexPair(options)).rejects.toMatchObject({ code: 'wrong-role' });
  });

  it('rejects a generation below the policy floor', async () => {
    const options = await pair(index({ generation: 3 }));
    await expect(
      verifyCatalogueIndexPair({ ...options, policy: { ...options.policy, generationFloor: 4 } })
    ).rejects.toMatchObject({ code: 'generation-below-floor' });
  });

  it('rejects an oversized pair before parsing', async () => {
    await expect(
      verifyCatalogueIndexPair({
        indexBytes: new Uint8Array(CATALOGUE_INDEX_MAX_BYTES + 1),
        envelopeBytes: new Uint8Array(),
        policy: { keys: {}, generationFloor: 1 },
      })
    ).rejects.toEqual(expect.objectContaining<CatalogueTrustError>({ code: 'oversize' }));
  });

  it('rejects validity spans over fourteen days', async () => {
    const options = await pair(index({ issuedAt: '2026-08-01T00:00:00Z', expiresAt: '2026-08-20T00:00:01Z' }));
    await expect(verifyCatalogueIndexPair(options)).rejects.toMatchObject({ code: 'invalid-validity' });
  });
});

it('rejects the public RFC0001 fixture identity in production defaults', async () => {
  const options = await pair(index());
  const envelope = JSON.parse(new TextDecoder().decode(options.envelopeBytes));
  envelope.keyId = 'ed25519:sha256:56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c';
  await expect(
    verifyCatalogueIndexPair({ ...options, policy: undefined, envelopeBytes: encoder.encode(JSON.stringify(envelope)) })
  ).rejects.toMatchObject({ code: 'unknown-key' });
});

it('accepts either single signer during release-distributed dual-pin overlap', async () => {
  const otherPrivate = new Uint8Array(32).fill(8);
  const otherPublic = await getPublicKeyAsync(otherPrivate);
  const otherId = `ed25519:sha256:${await sha256(otherPublic)}`;
  const options = await pair(index());
  const policy = {
    keys: { ...options.policy.keys, [otherId]: `ed25519:${base64url(otherPublic)}` },
    generationFloor: 2,
  };
  await expect(verifyCatalogueIndexPair({ ...options, policy })).resolves.toMatchObject({ envelope: { keyId } });
  const sig = base64url(await signAsync(await catalogueSigningInput(index(), 'index'), otherPrivate));
  await expect(
    verifyCatalogueIndexPair({
      ...options,
      policy,
      envelopeBytes: encoder.encode(JSON.stringify({ alg: 'ed25519', role: 'index', keyId: otherId, sig })),
    })
  ).resolves.toMatchObject({ envelope: { keyId: otherId } });
});

it('preserves canonical tiers, dotted IDs, category arrays, paid entries and publisher keys', async () => {
  const payload = index();
  payload.entries = (['first-party', 'known', 'unknown'] as const).map((tier, i) => ({
    ...payload.entries[0]!,
    appId: `org.app-${i}`,
    version: 'stable release',
    license: 'MIT OR Apache-2.0',
    publisher: { name: 'Publisher', tier, keyId, publicKey: publicKeyWire },
    categories: ['operations', 'collaboration'],
    paid: i === 1,
    bundle: { url: 'https://downloads.example.test/releases/app.zip', digest: `sha256:${'a'.repeat(64)}` },
  }));
  await expect(verifyCatalogueIndexPair(await pair(payload))).resolves.toMatchObject({ payload });
  payload.entries[0]!.publisher.keyId = `ed25519:sha256:${'0'.repeat(64)}`;
  await expect(verifyCatalogueIndexPair(await pair(payload))).rejects.toMatchObject({ code: 'key-id-mismatch' });
});

it('rejects legacy shape, delisted rows, preview flags and unsafe generations', async () => {
  for (const payload of [
    { ...index(), 'unsigned-preview': true },
    { ...index(), generation: 0 },
    { ...index(), generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...index(), entries: [{ ...index().entries[0], delisted: true }] },
    { ...index(), entries: [{ ...index().entries[0], id: 'legacy' }] },
  ])
    await expect(verifyCatalogueIndexPair(await pair(payload))).rejects.toMatchObject({ code: 'invalid-schema' });
});

it('verifies every blacklist reason and enforces its separate seven-day validity cap', async () => {
  const { verifyCatalogueBlacklistPair } = await import('./catalogue-trust');
  const payload = {
    schema: 'appliance.blacklist/v1',
    generation: 4,
    issuedAt: '2026-08-20T00:00:00Z',
    expiresAt: '2026-08-27T00:00:00Z',
    entries: ['malware', 'compromised', 'key-compromise', 'withdrawn'].map((reason) => ({
      appId: 'org.app',
      version: 'stable',
      reason,
    })),
  };
  const options = await pair(payload, 'blacklist');
  await expect(verifyCatalogueBlacklistPair({ ...options, blacklistBytes: options.indexBytes })).resolves.toMatchObject(
    { payload }
  );
  const long = await pair({ ...payload, expiresAt: '2026-08-28T00:00:00Z' }, 'blacklist');
  await expect(verifyCatalogueBlacklistPair({ ...long, blacklistBytes: long.indexBytes })).rejects.toMatchObject({
    code: 'invalid-validity',
  });
});
