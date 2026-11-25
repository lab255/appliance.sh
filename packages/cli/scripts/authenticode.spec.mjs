import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { credentialHelperContentDigest, stripAuthenticodeSignature } from './authenticode.mjs';

const OPTIONAL_HEADER = 88;
const CHECKSUM = OPTIONAL_HEADER + 64;
const SECURITY_ENTRY = OPTIONAL_HEADER + 112 + 4 * 8;

// Minimal PE32+ image: unsigned, CheckSum 0, 8-byte-aligned length — the
// shape the normalized credential helper has.
function unsignedPe(size = 1024) {
  const bytes = Buffer.alloc(size, 0x41);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64, 'ascii');
  bytes.writeUInt16LE(0xf0, 84); // optional header size
  bytes.writeUInt16LE(0x20b, OPTIONAL_HEADER);
  bytes.writeUInt32LE(16, OPTIONAL_HEADER + 108); // NumberOfRvaAndSizes
  bytes.writeUInt32LE(0, CHECKSUM);
  bytes.fill(0, SECURITY_ENTRY, SECURITY_ENTRY + 8);
  return bytes;
}

// What signtool / SignerSignEx does: append WIN_CERTIFICATE entries (each
// padded to 8 bytes), point directory 4 at them, and set the checksum.
function sign(unsigned, entries = [{ revision: 0x0200, type: 0x0002, payload: 1413 }]) {
  const blobs = entries.map(({ revision, type, payload }) => {
    const length = 8 + payload;
    const entry = Buffer.alloc(Math.ceil(length / 8) * 8, 0x30);
    entry.writeUInt32LE(length, 0);
    entry.writeUInt16LE(revision, 4);
    entry.writeUInt16LE(type, 6);
    return entry;
  });
  const table = Buffer.concat(blobs);
  const signed = Buffer.concat([unsigned, table]);
  signed.writeUInt32LE(unsigned.length, SECURITY_ENTRY);
  signed.writeUInt32LE(table.length, SECURITY_ENTRY + 4);
  signed.writeUInt32LE(0x0003c2f1, CHECKSUM);
  return signed;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

describe('Authenticode signature stripping', () => {
  it('returns an unsigned image untouched', () => {
    const unsigned = unsignedPe();
    const result = stripAuthenticodeSignature(unsigned);
    expect(result.signed).toBe(false);
    expect(result.bytes.equals(unsigned)).toBe(true);
  });

  it('restores the exact unsigned bytes from a signed image', () => {
    const unsigned = unsignedPe();
    const result = stripAuthenticodeSignature(sign(unsigned));
    expect(result.signed).toBe(true);
    expect(result.bytes.equals(unsigned)).toBe(true);
  });

  it('handles a dual (nested-entry) certificate table', () => {
    const unsigned = unsignedPe();
    const signed = sign(unsigned, [
      { revision: 0x0200, type: 0x0002, payload: 1413 },
      { revision: 0x0200, type: 0x0002, payload: 900 },
    ]);
    expect(stripAuthenticodeSignature(signed).bytes.equals(unsigned)).toBe(true);
  });

  it('pins signed and unsigned helpers to the same content digest', () => {
    const unsigned = unsignedPe();
    const plain = credentialHelperContentDigest(unsigned, createHash);
    const signed = credentialHelperContentDigest(sign(unsigned), createHash);
    expect(plain).toEqual({ digest: sha256(unsigned), signed: false });
    expect(signed).toEqual({ digest: sha256(unsigned), signed: true });
  });

  it('still detects a modified code byte under a signature', () => {
    const unsigned = unsignedPe();
    const signed = sign(unsigned);
    signed[600] ^= 0xff;
    expect(credentialHelperContentDigest(signed, createHash).digest).not.toBe(sha256(unsigned));
  });

  it('hashes non-PE helpers byte-for-byte', () => {
    const elf = Buffer.from('\x7fELF helper');
    expect(credentialHelperContentDigest(elf, createHash)).toEqual({ digest: sha256(elf), signed: false });
  });

  it('rejects data appended after the certificate table', () => {
    const signed = Buffer.concat([sign(unsignedPe()), Buffer.alloc(8, 0x90)]);
    expect(() => stripAuthenticodeSignature(signed)).toThrow(/trailing/);
  });

  it('rejects a certificate table that does not start 8-byte aligned', () => {
    const signed = sign(unsignedPe(1020));
    expect(() => stripAuthenticodeSignature(signed)).toThrow(/trailing/);
  });

  it('rejects a table pointing into the headers', () => {
    const signed = sign(unsignedPe());
    signed.writeUInt32LE(64, SECURITY_ENTRY);
    expect(() => stripAuthenticodeSignature(signed)).toThrow(/trailing/);
  });

  it('rejects non-Authenticode certificate entries', () => {
    const signed = sign(unsignedPe(), [{ revision: 0x0200, type: 0x0001, payload: 64 }]);
    expect(() => stripAuthenticodeSignature(signed)).toThrow(/non-Authenticode/);
  });

  it('rejects a truncated certificate chain', () => {
    const signed = sign(unsignedPe());
    signed.writeUInt32LE(4096, signed.readUInt32LE(SECURITY_ENTRY));
    expect(() => stripAuthenticodeSignature(signed)).toThrow(/truncated/);
  });

  it('rejects non-PE input', () => {
    expect(() => stripAuthenticodeSignature(Buffer.from('MZ but too short'))).toThrow(/valid PE/);
  });
});
