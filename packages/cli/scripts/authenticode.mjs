// This module is imported by Vitest and by the npm postinstall; keep it free
// of an executable hashbang and of non-builtin imports.

/**
 * Authenticode-aware content identity for the Windows credential helper.
 *
 * The npm package pins the SHA-256 of the *unsigned, normalized* helper
 * (credential-helper-checksums.json). Release builds Authenticode-sign the
 * helper (AP-202) so Smart App Control lets `appliance.exe` launch it, and a
 * signature cannot be pinned ahead of time: the RFC 3161 timestamp differs on
 * every signing. Signing only touches three places in a PE image:
 *
 *   1. the optional-header CheckSum field,
 *   2. data directory 4 (IMAGE_DIRECTORY_ENTRY_SECURITY: file offset + size),
 *   3. the attribute certificate table appended at the end of the file.
 *
 * Removing exactly those (truncate at the table, zero the directory entry and
 * the checksum) restores the unsigned bytes byte-for-byte, provided the
 * unsigned image had CheckSum 0 and an 8-byte-aligned length — both true for
 * the lld-link + normalize-credential-helper-pe.mjs recipe. Every mapped
 * section byte stays covered by the pin; only the signature blob is excluded,
 * and Windows itself validates that blob before it will run the helper.
 *
 * Anything that does not look like a signtool-shaped table (not at EOF,
 * misaligned, malformed WIN_CERTIFICATE chain) is rejected rather than
 * silently stripped.
 */
export function stripAuthenticodeSignature(input) {
  if (!Buffer.isBuffer(input) || input.length < 0x80 || input.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('not a valid PE image');
  }
  const peOffset = input.readUInt32LE(0x3c);
  if (peOffset + 24 > input.length || input.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('PE image has no valid PE header');
  }
  const optionalHeaderSize = input.readUInt16LE(peOffset + 20);
  const optionalHeader = peOffset + 24;
  const magic = input.readUInt16LE(optionalHeader);
  const dataDirectoryOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
  const directoryCountOffset = magic === 0x10b ? 92 : magic === 0x20b ? 108 : 0;
  if (!dataDirectoryOffset || optionalHeaderSize < dataDirectoryOffset + 5 * 8) {
    throw new Error('PE image has no valid optional header');
  }
  if (input.readUInt32LE(optionalHeader + directoryCountOffset) <= 4) {
    return { bytes: input, signed: false };
  }
  const checksumField = optionalHeader + 64;
  const securityEntry = optionalHeader + dataDirectoryOffset + 4 * 8;
  const tableOffset = input.readUInt32LE(securityEntry); // a file offset, not an RVA
  const tableSize = input.readUInt32LE(securityEntry + 4);
  if (tableOffset === 0 && tableSize === 0) {
    return { bytes: input, signed: false };
  }

  const headerEnd = optionalHeader + optionalHeaderSize;
  if (tableSize < 8 || tableOffset < headerEnd || tableOffset % 8 !== 0 || tableOffset + tableSize !== input.length) {
    throw new Error('PE attribute certificate table is not a single trailing signtool-shaped table');
  }
  for (let entry = tableOffset; entry < input.length; ) {
    if (entry + 8 > input.length) throw new Error('PE attribute certificate table is truncated');
    const length = input.readUInt32LE(entry);
    const revision = input.readUInt16LE(entry + 4);
    const type = input.readUInt16LE(entry + 6);
    if (length < 8 || revision !== 0x0200 || type !== 0x0002) {
      throw new Error('PE attribute certificate table holds a non-Authenticode entry');
    }
    entry += Math.ceil(length / 8) * 8;
    if (entry > input.length) throw new Error('PE attribute certificate table is truncated');
  }

  const bytes = Buffer.from(input.subarray(0, tableOffset));
  bytes.fill(0, checksumField, checksumField + 4);
  bytes.fill(0, securityEntry, securityEntry + 8);
  return { bytes, signed: true };
}

/**
 * SHA-256 over the helper's unsigned content: an Authenticode-signed PE is
 * hashed with its signature stripped (see above); anything else — including
 * the unsigned helper and non-Windows helpers — is hashed byte-for-byte.
 * `createHash` is injected so this module stays import-free.
 */
export function credentialHelperContentDigest(bytes, createHash) {
  const isPe = bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'MZ';
  const { bytes: content, signed } = isPe ? stripAuthenticodeSignature(bytes) : { bytes, signed: false };
  return { digest: createHash('sha256').update(content).digest('hex'), signed };
}
