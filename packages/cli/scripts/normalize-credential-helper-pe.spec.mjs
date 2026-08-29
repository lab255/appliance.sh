import { describe, expect, it } from 'vitest';
import { normalizePeForDistribution } from './normalize-credential-helper-pe.mjs';

function fixture(timestamp, guidByte, codeViewRecords = 1) {
  const bytes = Buffer.alloc(768, 0x41);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64, 'ascii');
  bytes.writeUInt32LE(timestamp, 72);
  bytes.writeUInt16LE(1, 70); // one section
  bytes.writeUInt16LE(0xf0, 84); // PE32+ optional header size
  const optionalHeader = 88;
  bytes.writeUInt16LE(0x20b, optionalHeader);
  bytes.writeUInt32LE(16, optionalHeader + 108); // NumberOfRvaAndSizes
  bytes.writeUInt32LE(0x1000, optionalHeader + 112 + 6 * 8); // debug RVA
  bytes.writeUInt32LE(28 * codeViewRecords, optionalHeader + 112 + 6 * 8 + 4);
  const section = optionalHeader + 0xf0;
  bytes.writeUInt32LE(0x200, section + 8); // virtual size
  bytes.writeUInt32LE(0x1000, section + 12); // virtual address
  bytes.writeUInt32LE(0x200, section + 16); // raw size
  bytes.writeUInt32LE(0x100, section + 20); // raw pointer
  for (let index = 0; index < codeViewRecords; index++) {
    const debug = 0x100 + index * 28;
    const record = 0x190 + index * 0x40;
    bytes.writeUInt32LE(2, debug + 12); // IMAGE_DEBUG_TYPE_CODEVIEW
    bytes.writeUInt32LE(48, debug + 16);
    bytes.writeUInt32LE(0x1090 + index * 0x40, debug + 20);
    bytes.writeUInt32LE(record, debug + 24);
    bytes.write('RSDS', record, 'ascii');
    bytes.fill(guidByte + index, record + 4, record + 20);
    bytes.write('appliance_credhelper.pdb\0', record + 24, 'ascii');
  }
  // A marker outside IMAGE_DIRECTORY_ENTRY_DEBUG must never be normalized.
  bytes.write('RSDS', 0x2e0, 'ascii');
  return bytes;
}

describe('credential helper PE normalization', () => {
  it('removes timestamp and unpublished PDB identity nondeterminism', () => {
    const first = normalizePeForDistribution(fixture(123, 0xaa));
    const second = normalizePeForDistribution(fixture(456, 0xbb));
    expect(first).toEqual(second);
    expect(first.readUInt32LE(72)).toBe(0);
    expect(first.subarray(0x194, 0x1a4)).toEqual(Buffer.alloc(16));
    expect(first.toString('ascii', 0x2e0, 0x2e4)).toBe('RSDS');
  });

  it('refuses malformed or ambiguous inputs', () => {
    expect(() => normalizePeForDistribution(Buffer.from('not PE'))).toThrow(/valid PE/);
    const duplicate = fixture(1, 1, 2);
    expect(() => normalizePeForDistribution(duplicate)).toThrow(/exactly one/);
  });
});
