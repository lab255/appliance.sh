// This module is imported by Vitest; keep it free of an executable hashbang.
// Production callers invoke it explicitly with Node.
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Normalize non-runtime PE metadata emitted by lld-link. `/timestamp:0`
 * handles the COFF timestamp at link time; this repeats that defensively and
 * clears the CodeView GUID for a PDB we do not publish. No mapped code/data is
 * changed, and the result is byte-reproducible across clean target dirs.
 */
export function normalizePeForDistribution(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 0x80 || bytes.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('credential helper is not a valid PE image');
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 24 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('credential helper has no valid PE header');
  }
  bytes.fill(0, peOffset + 8, peOffset + 12);

  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20);
  const optionalHeader = peOffset + 24;
  const magic = bytes.readUInt16LE(optionalHeader);
  const dataDirectoryOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
  const directoryCountOffset = magic === 0x10b ? 92 : magic === 0x20b ? 108 : 0;
  if (!dataDirectoryOffset || optionalHeaderSize < dataDirectoryOffset + 7 * 8) {
    throw new Error('credential helper has no valid PE optional header');
  }
  const directoryCount = bytes.readUInt32LE(optionalHeader + directoryCountOffset);
  if (directoryCount <= 6) {
    throw new Error('credential helper has no CodeView debug directory');
  }
  const debugDirectoryEntry = optionalHeader + dataDirectoryOffset + 6 * 8;
  const debugRva = bytes.readUInt32LE(debugDirectoryEntry);
  const debugSize = bytes.readUInt32LE(debugDirectoryEntry + 4);
  const sectionTable = optionalHeader + optionalHeaderSize;
  const debugOffset = rvaToFileOffset(bytes, debugRva, debugSize, sectionTable, sectionCount);
  if (debugSize === 0 || debugSize % 28 !== 0 || debugOffset === null) {
    throw new Error('credential helper has an invalid PE debug directory');
  }

  const codeViewRecords = [];
  for (let offset = debugOffset; offset < debugOffset + debugSize; offset += 28) {
    if (bytes.readUInt32LE(offset + 12) !== 2) continue; // IMAGE_DEBUG_TYPE_CODEVIEW
    const dataSize = bytes.readUInt32LE(offset + 16);
    const dataRva = bytes.readUInt32LE(offset + 20);
    const rawPointer = bytes.readUInt32LE(offset + 24);
    const dataOffset = rawPointer || rvaToFileOffset(bytes, dataRva, dataSize, sectionTable, sectionCount);
    if (dataOffset === null || dataSize < 20 || dataOffset + dataSize > bytes.length) continue;
    if (bytes.toString('ascii', dataOffset, dataOffset + 4) === 'RSDS') codeViewRecords.push(dataOffset);
  }
  if (codeViewRecords.length !== 1) {
    throw new Error(
      `credential helper must contain exactly one complete CodeView record (found ${codeViewRecords.length})`
    );
  }
  bytes.fill(0, codeViewRecords[0] + 4, codeViewRecords[0] + 20);
  return bytes;
}

function rvaToFileOffset(bytes, rva, size, sectionTable, sectionCount) {
  for (let index = 0; index < sectionCount; index++) {
    const section = sectionTable + index * 40;
    if (section + 40 > bytes.length) return null;
    const virtualSize = bytes.readUInt32LE(section + 8);
    const virtualAddress = bytes.readUInt32LE(section + 12);
    const rawSize = bytes.readUInt32LE(section + 16);
    const rawPointer = bytes.readUInt32LE(section + 20);
    const span = Math.max(virtualSize, rawSize);
    if (rva < virtualAddress || rva + size > virtualAddress + span) continue;
    const offset = rawPointer + (rva - virtualAddress);
    if (offset + size <= bytes.length && rva + size <= virtualAddress + rawSize) return offset;
  }
  return null;
}

function main(filePath) {
  if (!filePath) throw new Error('usage: normalize-credential-helper-pe.mjs <appliance-credhelper.exe>');
  const bytes = fs.readFileSync(filePath);
  normalizePeForDistribution(bytes);
  fs.writeFileSync(filePath, bytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]);
}
