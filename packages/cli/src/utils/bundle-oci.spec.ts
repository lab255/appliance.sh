import { describe, expect, it } from 'vitest';
import { tinyOciTar } from './bundle-oci-fixture.js';
import { validateOciImageTar } from './bundle-oci.js';

describe('OCI image-layout validation', () => {
  it('accepts a valid image whose config matches the declared platform', () => {
    expect(() => validateOciImageTar(tinyOciTar('linux/amd64'), 'linux/amd64')).not.toThrow();
    expect(() => validateOciImageTar(tinyOciTar('linux/arm64'), 'linux/arm64')).not.toThrow();
    expect(() => validateOciImageTar(tinyOciTar('linux/arm64', true), 'linux/arm64')).not.toThrow();
  });

  it('rejects malformed archives and config platform mismatches', () => {
    expect(() => validateOciImageTar(Buffer.from('not a tar'), 'linux/amd64')).toThrow('end marker');
    expect(() => validateOciImageTar(tinyOciTar('linux/arm64'), 'linux/amd64')).toThrow('does not match');
  });
});
