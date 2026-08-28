import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  keyIdForPublicKey,
  publicKeyFromWire,
  signEnvelope,
  signaturePreimage,
  validateEnvelope,
  verifyEnvelope,
} from './bundle-sign.js';

const VECTOR_PUBLIC_KEY = 'ed25519:A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
const VECTOR_KEY_ID = 'ed25519:sha256:56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c';
const VECTOR_PAYLOAD = { digest: `sha256:${'0'.repeat(64)}` };
const VECTOR_ENVELOPE = {
  alg: 'ed25519' as const,
  keyId: VECTOR_KEY_ID as `ed25519:sha256:${string}`,
  role: 'bundle' as const,
  sig: '2EAyh4IFCLycDQkiorQnwjyI6ZsOdKdZPklSsnKVm2sNOW5BX30QwqmpIv3VMg257WoPQouuKgl3q6tls6dFAA',
};

describe('RFC 0001 Ed25519 envelopes', () => {
  it('passes the normative bundle vector including the signing preimage', () => {
    expect(signaturePreimage(VECTOR_PAYLOAD, 'bundle').toString('hex')).toBe(
      '6170706c69616e63652f62756e646c6500e2869b082e9bdd62eca146dd5b83336050273af313f1b0a19aaeb1eb3f96b580'
    );
    expect(verifyEnvelope(VECTOR_PAYLOAD, 'bundle', VECTOR_ENVELOPE, VECTOR_PUBLIC_KEY)).toBe(true);
    expect(
      keyIdForPublicKey(publicKeyFromWire(VECTOR_PUBLIC_KEY).export({ type: 'spki', format: 'der' }).subarray(-32))
    ).toBe(VECTOR_KEY_ID);
  });

  it('domain-separates roles and rejects unknown envelope fields', () => {
    expect(() => verifyEnvelope(VECTOR_PAYLOAD, 'index', VECTOR_ENVELOPE, VECTOR_PUBLIC_KEY)).toThrow(
      'role must be index'
    );
    expect(() => validateEnvelope({ ...VECTOR_ENVELOPE, extra: true })).toThrow('missing or unknown');
  });

  it('signs and verifies generated development keys', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const keyId = keyIdForPublicKey(raw);
    const envelope = signEnvelope({ digest: `sha256:${'1'.repeat(64)}` }, 'bundle', { privateKey, keyId });
    expect(verifyEnvelope({ digest: `sha256:${'1'.repeat(64)}` }, 'bundle', envelope, publicKey)).toBe(true);
    expect(verifyEnvelope({ digest: `sha256:${'2'.repeat(64)}` }, 'bundle', envelope, publicKey)).toBe(false);
  });
});
