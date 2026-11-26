// This module is imported by Vitest; keep it free of an executable hashbang.
// Production callers invoke it explicitly with Node:
//   node packages/cli/scripts/pe-imports.mjs <file.exe|.dll>...
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * DLLs that are NOT part of Windows: they come from the Visual C++
 * redistributable, which a fresh Windows 11 install does not have. A shipped
 * binary that imports one dies with STATUS_DLL_NOT_FOUND (0xC0000135) before
 * main(), and CI can't see it because GitHub's Windows runners carry the
 * redistributable. The Universal CRT (ucrtbase / api-ms-win-crt-*) ships with
 * Windows 10+, so it is fine. Build with `-C target-feature=+crt-static`.
 */
export const REDISTRIBUTABLE_RUNTIME = /^(vcruntime|msvcp|vccorlib|concrt|vcomp|msvcr)\d+[a-z_\d]*\.dll$/i;

/** Names of the DLLs a PE image imports (regular + delay-load), in table order. */
export function peImports(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('not a valid PE image');
  }
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 24 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') {
    throw new Error('PE image has no valid PE header');
  }
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalHeaderSize = bytes.readUInt16LE(pe + 20);
  const optionalHeader = pe + 24;
  const magic = bytes.readUInt16LE(optionalHeader);
  const directories = optionalHeader + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : NaN);
  if (Number.isNaN(directories)) throw new Error('PE image has no valid optional header');
  const directoryCount = bytes.readUInt32LE(optionalHeader + (magic === 0x20b ? 108 : 92));
  const sectionTable = optionalHeader + optionalHeaderSize;
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const section = sectionTable + index * 40;
    sections.push({
      virtualAddress: bytes.readUInt32LE(section + 12),
      size: Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16)),
      rawPointer: bytes.readUInt32LE(section + 20),
    });
  }
  const offset = (rva) => {
    for (const s of sections) {
      if (rva >= s.virtualAddress && rva < s.virtualAddress + s.size) return s.rawPointer + (rva - s.virtualAddress);
    }
    throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
  };
  const cString = (start) => {
    let end = start;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return bytes.toString('ascii', start, end);
  };
  const names = [];
  // [directory index, descriptor size, offset of the name RVA in a descriptor]
  for (const [index, stride, nameField] of [
    [1, 20, 12], // IMAGE_DIRECTORY_ENTRY_IMPORT
    [13, 32, 4], // IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT
  ]) {
    if (directoryCount <= index) continue;
    const rva = bytes.readUInt32LE(directories + index * 8);
    if (!rva) continue;
    for (let descriptor = offset(rva); ; descriptor += stride) {
      if (descriptor + stride > bytes.length) throw new Error('import table is truncated');
      const nameRva = bytes.readUInt32LE(descriptor + nameField);
      if (!nameRva) break;
      names.push(cString(offset(nameRva)));
    }
  }
  return names;
}

/** The imports of `bytes` that need the VC++ redistributable. */
export function redistributableRuntimeImports(bytes) {
  return peImports(bytes).filter((name) => REDISTRIBUTABLE_RUNTIME.test(name));
}

function main(files) {
  if (files.length === 0) {
    console.error('usage: pe-imports.mjs <file.exe|.dll>...');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const offending = redistributableRuntimeImports(fs.readFileSync(file));
    if (offending.length > 0) {
      failed = true;
      console.error(
        `::error::${file} imports ${offending.join(', ')} (VC++ redistributable, absent on fresh Windows). ` +
          'Build it with `-C target-feature=+crt-static`.'
      );
    } else {
      console.log(`OK ${file}: no VC++ redistributable imports`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
