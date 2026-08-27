import { catalogueBlacklistSchema, catalogueIndexSchema, signatureEnvelopeSchema } from './catalogue';
import type { CatalogueBlacklist, CatalogueEntry, CatalogueIndex, SignatureEnvelope } from './catalogue';

export const CATALOGUE_INDEX_MAX_BYTES = 10 * 1024 * 1024;
export const CATALOGUE_BLACKLIST_MAX_BYTES = 1024 * 1024;
export const CATALOGUE_INDEX_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const CATALOGUE_BLACKLIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// RFC 0001's public, non-secret interoperability identity. This is the
// currently shipped catalogue pin until owners publish a root-authorised
// production delegation. Never add a private key alongside this value.
export const RFC0001_FIXTURE_PUBLIC_KEY = 'ed25519:A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
export const RFC0001_FIXTURE_KEY_ID = 'ed25519:sha256:56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c';

export interface CatalogueTrustPolicy {
  keys: Readonly<Record<string, string>>;
  generationFloor: number;
  highestGeneration?: number;
}

export const PINNED_CATALOGUE_TRUST: CatalogueTrustPolicy = Object.freeze({
  keys: Object.freeze({ [RFC0001_FIXTURE_KEY_ID]: RFC0001_FIXTURE_PUBLIC_KEY }),
  generationFloor: 1,
});

export class CatalogueTrustError extends Error {
  constructor(
    readonly code:
      | 'oversize'
      | 'invalid-json'
      | 'invalid-schema'
      | 'wrong-role'
      | 'unknown-key'
      | 'key-id-mismatch'
      | 'bad-signature'
      | 'generation-below-floor'
      | 'invalid-validity'
      | 'expired'
      | 'clock-rollback',
    message: string
  ) {
    super(message);
    this.name = 'CatalogueTrustError';
  }
}

const encoder = new TextEncoder();

function assertUnicodeScalarString(value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('RFC 8785 rejects lone UTF-16 surrogates');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('RFC 8785 rejects lone UTF-16 surrogates');
    }
  }
}

/** RFC 8785 JSON Canonicalization Scheme for I-JSON values. */
export function canonicaliseJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('RFC 8785 rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicaliseJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys
      .map((key) => {
        assertUnicodeScalarString(key);
        const member = object[key];
        if (member === undefined || typeof member === 'function' || typeof member === 'symbol') {
          throw new TypeError('RFC 8785 rejects non-JSON object members');
        }
        return `${JSON.stringify(key)}:${canonicaliseJson(member)}`;
      })
      .join(',')}}`;
  }
  throw new TypeError('RFC 8785 accepts JSON values only');
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function decodeBase64url(value: string, expectedBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new CatalogueTrustError('invalid-schema', 'invalid base64url encoding');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let bytes: Uint8Array;
  if (typeof Buffer !== 'undefined') bytes = new Uint8Array(Buffer.from(padded, 'base64'));
  else {
    const binary = atob(padded);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  if (bytes.byteLength !== expectedBytes) {
    throw new CatalogueTrustError('invalid-schema', `expected ${expectedBytes} decoded bytes`);
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
}

export async function catalogueSigningInput(payload: unknown, role: SignatureEnvelope['role']): Promise<Uint8Array> {
  const hash = await sha256(encoder.encode(canonicaliseJson(payload)));
  return concatBytes(encoder.encode(`appliance/${role}`), new Uint8Array([0]), hash);
}

async function verifyEd25519(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', publicKey.slice().buffer, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature.slice().buffer, message.slice().buffer);
  } catch {
    // Safari versions without WebCrypto Ed25519 use noble. Noble is audited,
    // constant-time where JavaScript permits, and receives raw bytes only.
    const noble = await import('@noble/ed25519');
    return noble.verifyAsync(signature, message, publicKey);
  }
}

export async function verifySignatureEnvelope(
  payload: unknown,
  untrustedEnvelope: unknown,
  expectedRole: SignatureEnvelope['role'],
  publicKeyWire: string
): Promise<SignatureEnvelope> {
  const parsed = signatureEnvelopeSchema.safeParse(untrustedEnvelope);
  if (!parsed.success) throw new CatalogueTrustError('invalid-schema', 'signature envelope is malformed');
  const envelope = parsed.data;
  if (envelope.role !== expectedRole) {
    throw new CatalogueTrustError('wrong-role', `expected a ${expectedRole} signature`);
  }
  if (!publicKeyWire.startsWith('ed25519:')) {
    throw new CatalogueTrustError('invalid-schema', 'public key wire form is malformed');
  }
  const publicKey = decodeBase64url(publicKeyWire.slice('ed25519:'.length), 32);
  const computedKeyId = `ed25519:sha256:${hex(await sha256(publicKey))}`;
  if (computedKeyId !== envelope.keyId) {
    throw new CatalogueTrustError('key-id-mismatch', 'signature key id does not match the pinned public key');
  }
  const signature = decodeBase64url(envelope.sig, 64);
  if (!(await verifyEd25519(signature, await catalogueSigningInput(payload, expectedRole), publicKey))) {
    throw new CatalogueTrustError('bad-signature', 'catalogue signature could not be verified');
  }
  return envelope;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CatalogueTrustError('invalid-json', 'catalogue metadata is not valid UTF-8 JSON');
  }
}

function checkGeneration(generation: number, policy: CatalogueTrustPolicy): void {
  const floor = Math.max(policy.generationFloor, policy.highestGeneration ?? 0);
  if (generation < floor) {
    throw new CatalogueTrustError(
      'generation-below-floor',
      `catalogue generation ${generation} is below floor ${floor}`
    );
  }
}

function checkValidity(
  issuedAtValue: string,
  expiresAtValue: string,
  maxSpan: number,
  now: Date,
  allowExpired: boolean
): boolean {
  const issuedAt = Date.parse(issuedAtValue);
  const expiresAt = Date.parse(expiresAtValue);
  const current = now.getTime();
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > maxSpan
  ) {
    throw new CatalogueTrustError('invalid-validity', 'catalogue validity window exceeds its RFC cap');
  }
  if (issuedAt > current) throw new CatalogueTrustError('invalid-validity', 'catalogue index is not valid yet');
  if (current > expiresAt && !allowExpired) throw new CatalogueTrustError('expired', 'catalogue index has expired');
  return current > expiresAt;
}

export interface VerifiedCatalogue<T> {
  payload: T;
  envelope: SignatureEnvelope;
  stale: boolean;
  verifiedAt: string;
}

async function verifyPair<T extends { generation: number; issuedAt: string; expiresAt: string }>(options: {
  payloadBytes: Uint8Array;
  envelopeBytes: Uint8Array;
  maxBytes: number;
  maxSpan: number;
  expectedRole: 'index' | 'blacklist';
  parse: (value: unknown) => T;
  policy: CatalogueTrustPolicy;
  now?: Date;
  allowExpired?: boolean;
}): Promise<VerifiedCatalogue<T>> {
  if (options.payloadBytes.byteLength + options.envelopeBytes.byteLength > options.maxBytes) {
    throw new CatalogueTrustError('oversize', 'catalogue metadata exceeds its pre-parse size cap');
  }
  const payload = options.parse(parseJson(options.payloadBytes));
  const envelopeValue = parseJson(options.envelopeBytes);
  checkGeneration(payload.generation, options.policy);
  const envelopeResult = signatureEnvelopeSchema.safeParse(envelopeValue);
  if (!envelopeResult.success) throw new CatalogueTrustError('invalid-schema', 'signature envelope is malformed');
  const publicKey = options.policy.keys[envelopeResult.data.keyId];
  if (!publicKey) throw new CatalogueTrustError('unknown-key', 'catalogue signer is not pinned');
  const envelope = await verifySignatureEnvelope(payload, envelopeValue, options.expectedRole, publicKey);
  const now = options.now ?? new Date();
  const stale = checkValidity(payload.issuedAt, payload.expiresAt, options.maxSpan, now, options.allowExpired ?? false);
  return { payload, envelope, stale, verifiedAt: now.toISOString() };
}

function parseIndex(value: unknown): CatalogueIndex {
  const parsed = catalogueIndexSchema.safeParse(value);
  if (!parsed.success) throw new CatalogueTrustError('invalid-schema', 'catalogue index schema is invalid');
  return parsed.data;
}

function parseBlacklist(value: unknown): CatalogueBlacklist {
  const parsed = catalogueBlacklistSchema.safeParse(value);
  if (!parsed.success) throw new CatalogueTrustError('invalid-schema', 'catalogue blacklist schema is invalid');
  return parsed.data;
}

export function verifyCatalogueIndexPair(options: {
  indexBytes: Uint8Array;
  envelopeBytes: Uint8Array;
  policy?: CatalogueTrustPolicy;
  now?: Date;
  allowExpired?: boolean;
}): Promise<VerifiedCatalogue<CatalogueIndex>> {
  return verifyPair({
    payloadBytes: options.indexBytes,
    envelopeBytes: options.envelopeBytes,
    maxBytes: CATALOGUE_INDEX_MAX_BYTES,
    maxSpan: CATALOGUE_INDEX_MAX_AGE_MS,
    expectedRole: 'index',
    parse: parseIndex,
    policy: options.policy ?? PINNED_CATALOGUE_TRUST,
    now: options.now,
    allowExpired: options.allowExpired,
  });
}

export function verifyCatalogueBlacklistPair(options: {
  blacklistBytes: Uint8Array;
  envelopeBytes: Uint8Array;
  policy?: CatalogueTrustPolicy;
  now?: Date;
  allowExpired?: boolean;
}): Promise<VerifiedCatalogue<CatalogueBlacklist>> {
  return verifyPair({
    payloadBytes: options.blacklistBytes,
    envelopeBytes: options.envelopeBytes,
    maxBytes: CATALOGUE_BLACKLIST_MAX_BYTES,
    maxSpan: CATALOGUE_BLACKLIST_MAX_AGE_MS,
    expectedRole: 'blacklist',
    parse: parseBlacklist,
    policy: options.policy ?? PINNED_CATALOGUE_TRUST,
    now: options.now,
    allowExpired: options.allowExpired,
  });
}

/** Paid entries are discarded before search, filters, counts, or rendering. */
export function freeCatalogueEntries(index: CatalogueIndex): CatalogueEntry[] {
  return index.entries.filter((entry) => entry.paid !== true);
}
