import { getPublicKeyAsync, signAsync } from '@noble/ed25519';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOGUE_INDEX_MAX_BYTES,
  CatalogueTrustError,
  RFC0001_FIXTURE_PUBLIC_KEY,
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
        id: 'journal',
        name: 'Journal',
        version: '1.2.0',
        description: 'Private daily notes.',
        license: 'MIT',
        publisher: { name: 'Lab 255', keyId },
        tier: 'known-publisher',
        url: 'https://journal.appliance.zip',
        digest: `sha256:${'a'.repeat(64)}`,
      },
    ],
    ...overrides,
  };
}

async function pair(payload: CatalogueIndex, role: SignatureEnvelope['role'] = 'index') {
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
        RFC0001_FIXTURE_PUBLIC_KEY
      )
    ).resolves.toMatchObject({ role: 'index' });
  });

  it('accepts a valid bounded index', async () => {
    await expect(verifyCatalogueIndexPair(await pair(index()))).resolves.toMatchObject({ stale: false });
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
