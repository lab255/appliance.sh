import { createHash } from 'node:crypto';

export interface BundleDigestEntry {
  path: string;
  data: Uint8Array;
}

/**
 * RFC 8785 (JCS) canonicalisation without an external dependency.
 *
 * JSON.stringify already supplies RFC 8785's ECMAScript string and number
 * serialisation. JCS additionally requires recursively sorting object member
 * names by UTF-16 code units and rejecting values JSON cannot represent.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('RFC 8785 JSON cannot contain non-finite numbers');
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new TypeError('RFC 8785 JSON values must be plain objects');
      }
      return `{${Object.keys(value as Record<string, unknown>)
        .sort(compareUtf16)
        .map((key) => {
          const member = (value as Record<string, unknown>)[key];
          if (member === undefined || typeof member === 'function' || typeof member === 'symbol') {
            throw new TypeError(`RFC 8785 JSON member ${JSON.stringify(key)} is not serialisable`);
          }
          return `${JSON.stringify(key)}:${canonicalizeJson(member)}`;
        })
        .join(',')}}`;
    default:
      throw new TypeError(`RFC 8785 JSON cannot contain ${typeof value}`);
  }
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalizeJson(value), 'utf8');
}

/** Compute the RFC 0001 length-framed digest over regular bundle entries. */
export function computeBundleDigest(entries: Iterable<BundleDigestEntry>): `sha256:${string}` {
  const sorted = [...entries]
    .filter((entry) => entry.path !== 'digest' && entry.path !== 'signature.sig')
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const hash = createHash('sha256');
  for (const entry of sorted) {
    hash.update(entry.path, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(String(entry.data.byteLength), 'ascii');
    hash.update(Buffer.from([0]));
    hash.update(entry.data);
  }
  return `sha256:${hash.digest('hex')}`;
}

function compareUtf16(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}
