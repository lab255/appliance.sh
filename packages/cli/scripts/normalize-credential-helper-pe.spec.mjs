import { describe, expect, it } from 'vitest';
import { normalizePeForDistribution } from './normalize-credential-helper-pe.mjs';

function fixture(timestamp, guidByte) {
  const bytes = Buffer.alloc(256, 0x41);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64, 'ascii');
  bytes.writeUInt32LE(timestamp, 72);
  bytes.write('RSDS', 128, 'ascii');
  bytes.fill(guidByte, 132, 148);
  bytes.write('appliance_credhelper.pdb\0', 152, 'ascii');
  return bytes;
}

describe('credential helper PE normalization', () => {
  it('removes timestamp and unpublished PDB identity nondeterminism', () => {
    const first = normalizePeForDistribution(fixture(123, 0xaa));
    const second = normalizePeForDistribution(fixture(456, 0xbb));
    expect(first).toEqual(second);
    expect(first.readUInt32LE(72)).toBe(0);
    expect(first.subarray(132, 148)).toEqual(Buffer.alloc(16));
  });

  it('refuses malformed or ambiguous inputs', () => {
    expect(() => normalizePeForDistribution(Buffer.from('not PE'))).toThrow(/valid PE/);
    const duplicate = fixture(1, 1);
    duplicate.write('RSDS', 200, 'ascii');
    expect(() => normalizePeForDistribution(duplicate)).toThrow(/exactly one/);
  });
});
