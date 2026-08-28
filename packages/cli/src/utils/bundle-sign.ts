import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from 'node:crypto';
import * as fs from 'node:fs';
import { canonicalJsonBytes } from './bundle-digest.js';

export type SignatureRole = 'bundle' | 'index' | 'blacklist' | 'delegation' | 'revocation' | 'entitlement' | 'sync';

export interface SignatureEnvelope {
  alg: 'ed25519';
  keyId: `ed25519:sha256:${string}`;
  role: SignatureRole;
  sig: string;
}

export interface DevSigningKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyWire: `ed25519:${string}`;
  keyId: `ed25519:sha256:${string}`;
}

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const KEY_ID_PATTERN = /^ed25519:sha256:[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Read a development Ed25519 key. Accepted forms are a PKCS#8 PEM file or
 * JSON containing {"privateKey":"ed25519:<32-byte-base64url-seed>"}.
 */
export function readDevSigningKey(filePath: string): DevSigningKey {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  let privateKey: KeyObject;

  if (text.startsWith('-----BEGIN PRIVATE KEY-----')) {
    privateKey = createPrivateKey(text);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Signing key must be PKCS#8 PEM or JSON with an ed25519: base64url privateKey seed.');
    }
    if (!isPlainObject(parsed) || typeof parsed.privateKey !== 'string') {
      throw new Error('Signing key JSON must contain a privateKey string.');
    }
    privateKey = privateKeyFromWire(parsed.privateKey);
  }

  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Signing key must be Ed25519.');
  const publicKey = createPublicKey(privateKey);
  const rawPublicKey = rawPublicKeyBytes(publicKey);
  return {
    privateKey,
    publicKey,
    publicKeyWire: `ed25519:${rawPublicKey.toString('base64url')}`,
    keyId: keyIdForPublicKey(rawPublicKey),
  };
}

export function signEnvelope(
  payload: unknown,
  role: SignatureRole,
  key: Pick<DevSigningKey, 'privateKey' | 'keyId'>
): SignatureEnvelope {
  const signature = ed25519Sign(null, signaturePreimage(payload, role), key.privateKey);
  return { alg: 'ed25519', keyId: key.keyId, role, sig: signature.toString('base64url') };
}

export function verifyEnvelope(
  payload: unknown,
  expectedRole: SignatureRole,
  envelope: SignatureEnvelope,
  publicKey: string | KeyObject
): boolean {
  validateEnvelope(envelope, expectedRole);
  const key = typeof publicKey === 'string' ? publicKeyFromWire(publicKey) : publicKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Signature public key must be Ed25519.');
  if (keyIdForPublicKey(rawPublicKeyBytes(key)) !== envelope.keyId) return false;
  const signature = decodeBase64Url(envelope.sig, 64, 'signature');
  return ed25519Verify(null, signaturePreimage(payload, expectedRole), key, signature);
}

export function signaturePreimage(payload: unknown, role: SignatureRole): Buffer {
  const payloadHash = createHash('sha256').update(canonicalJsonBytes(payload)).digest();
  return Buffer.concat([Buffer.from(`appliance/${role}\0`, 'utf8'), payloadHash]);
}

export function keyIdForPublicKey(publicKey: Uint8Array): `ed25519:sha256:${string}` {
  if (publicKey.byteLength !== 32) throw new Error('Ed25519 public key must be exactly 32 bytes.');
  return `ed25519:sha256:${createHash('sha256').update(publicKey).digest('hex')}`;
}

export function publicKeyFromWire(wire: string): KeyObject {
  if (!wire.startsWith('ed25519:')) throw new Error('Public key must start with ed25519:.');
  const raw = decodeBase64Url(wire.slice('ed25519:'.length), 32, 'public key');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function validateEnvelope(value: unknown, expectedRole: SignatureRole = 'bundle'): SignatureEnvelope {
  if (!isPlainObject(value)) throw new Error('Signature envelope must be an object.');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'alg,keyId,role,sig') throw new Error('Signature envelope has missing or unknown fields.');
  if (value.alg !== 'ed25519') throw new Error('Signature envelope algorithm must be ed25519.');
  if (value.role !== expectedRole) throw new Error(`Signature envelope role must be ${expectedRole}.`);
  if (typeof value.keyId !== 'string' || !KEY_ID_PATTERN.test(value.keyId)) {
    throw new Error('Signature envelope keyId is malformed.');
  }
  if (typeof value.sig !== 'string') throw new Error('Signature envelope sig must be a string.');
  decodeBase64Url(value.sig, 64, 'signature');
  return value as unknown as SignatureEnvelope;
}

function privateKeyFromWire(wire: string): KeyObject {
  if (!wire.startsWith('ed25519:')) throw new Error('Private key seed must start with ed25519:.');
  const seed = decodeBase64Url(wire.slice('ed25519:'.length), 32, 'private key seed');
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

function rawPublicKeyBytes(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(der) || der.length !== ED25519_SPKI_PREFIX.length + 32) {
    throw new Error('Unsupported Ed25519 public key encoding.');
  }
  if (!der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new Error('Unsupported Ed25519 public key encoding.');
  }
  return der.subarray(ED25519_SPKI_PREFIX.length);
}

function decodeBase64Url(value: string, size: number, label: string): Buffer {
  if (!BASE64URL_PATTERN.test(value) || value.includes('=')) throw new Error(`${label} must be unpadded base64url.`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== size || decoded.toString('base64url') !== value) {
    throw new Error(`${label} must encode exactly ${size} bytes.`);
  }
  return decoded;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
