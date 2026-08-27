import { describe, expect, it } from 'vitest';
import { validateBundleEntries, type BundleEntry } from './appliance-runtime-bundle.js';

const manifest: BundleEntry = {
  path: 'appliance.json',
  expandedBytes: 100,
  compressedBytes: 80,
  kind: 'file',
};

describe('runtime bundle safety limits', () => {
  it('accepts normalized root manifest and payload entries', () => {
    expect(() =>
      validateBundleEntries(
        [manifest, { path: 'payload/images/journal.oci.tar', expandedBytes: 1024, compressedBytes: 900, kind: 'file' }],
        1200
      )
    ).not.toThrow();
  });

  it.each(['../escape', '/absolute', 'payload\\evil', 'payload//evil', 'payload/./evil'])(
    'rejects unsafe path %s',
    (unsafePath) => {
      expect(() =>
        validateBundleEntries(
          [manifest, { path: unsafePath, expandedBytes: 1, compressedBytes: 1, kind: 'file' }],
          200
        )
      ).toThrow(/unsafe bundle path/);
    }
  );

  it('rejects case collisions, manifest overflow, entry overflow, and zip bombs', () => {
    expect(() =>
      validateBundleEntries(
        [manifest, { ...manifest, path: 'APPLIANCE.JSON' }],
        200
      )
    ).toThrow(/case-colliding/);
    expect(() => validateBundleEntries([{ ...manifest, expandedBytes: 256 * 1024 + 1 }], 200)).toThrow(/256 KiB/);
    expect(() =>
      validateBundleEntries([manifest, { path: 'payload/big', expandedBytes: 4 * 1024 ** 3 + 1, compressedBytes: 1, kind: 'file' }], 200)
    ).toThrow(/exceeds 4 GiB/);
    expect(() =>
      validateBundleEntries(
        [manifest, { path: 'payload/bomb', expandedBytes: 65 * 1024 ** 2, compressedBytes: 1, kind: 'file' }],
        200
      )
    ).toThrow(/100:1/);
  });
});
