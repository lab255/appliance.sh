import { describe, expect, it } from 'vitest';
import { canonicalizeJson, computeBundleDigest } from './bundle-digest.js';

describe('RFC 8785 canonical JSON', () => {
  it('sorts object keys recursively and uses ECMAScript primitive serialization', () => {
    expect(canonicalizeJson({ z: [3, { b: -0, a: '€' }], a: 1e30 })).toBe('{"a":1e+30,"z":[3,{"a":"€","b":0}]}');
  });

  it('rejects values outside the JSON data model', () => {
    expect(() => canonicalizeJson({ value: Number.NaN })).toThrow('non-finite');
    expect(() => canonicalizeJson({ value: undefined })).toThrow('not serialisable');
  });
});

describe('bundle digest', () => {
  it('sorts by UTF-8 path bytes, length-frames content, and excludes metadata', () => {
    expect(
      computeBundleDigest([
        { path: 'payload/a', data: Buffer.from('abc') },
        { path: 'digest', data: Buffer.from('ignored') },
        { path: 'appliance.json', data: Buffer.from('{}') },
        { path: 'signature.sig', data: Buffer.from('ignored') },
      ])
    ).toBe('sha256:2d22184b91560b900a3999545fc8b9f532baa977f595b2bd806a27cf99efbd14');
  });
});
