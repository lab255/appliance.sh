import { describe, expect, it } from 'vitest';
import { peImports, redistributableRuntimeImports } from './pe-imports.mjs';

const OPTIONAL_HEADER = 88;
const DIRECTORIES = OPTIONAL_HEADER + 112;
const SECTION_TABLE = OPTIONAL_HEADER + 0xf0;

// Minimal PE32+ image with one section (RVA 0x1000 -> file 0x200) holding a
// regular import table and, optionally, a delay-load table.
function pe({ imports = [], delayImports = [] } = {}) {
  const bytes = Buffer.alloc(0x800);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64, 'ascii');
  bytes.writeUInt16LE(1, 70);
  bytes.writeUInt16LE(0xf0, 84);
  bytes.writeUInt16LE(0x20b, OPTIONAL_HEADER);
  bytes.writeUInt32LE(16, OPTIONAL_HEADER + 108);
  bytes.writeUInt32LE(0x600, SECTION_TABLE + 8);
  bytes.writeUInt32LE(0x1000, SECTION_TABLE + 12);
  bytes.writeUInt32LE(0x600, SECTION_TABLE + 16);
  bytes.writeUInt32LE(0x200, SECTION_TABLE + 20);
  const rva = (fileOffset) => fileOffset - 0x200 + 0x1000;
  let strings = 0x600;
  const writeName = (name) => {
    const at = strings;
    bytes.write(`${name}\0`, at, 'ascii');
    strings += name.length + 1;
    return rva(at);
  };
  const table = (start, names, stride, nameField, directory) => {
    if (names.length === 0) return;
    bytes.writeUInt32LE(rva(start), DIRECTORIES + directory * 8);
    names.forEach((name, index) => bytes.writeUInt32LE(writeName(name), start + index * stride + nameField));
  };
  table(0x200, imports, 20, 12, 1);
  table(0x400, delayImports, 32, 4, 13);
  return bytes;
}

describe('PE import inspection', () => {
  it('lists regular and delay-load imports', () => {
    const image = pe({ imports: ['KERNEL32.dll', 'ntdll.dll'], delayImports: ['SHELL32.dll'] });
    expect(peImports(image)).toEqual(['KERNEL32.dll', 'ntdll.dll', 'SHELL32.dll']);
  });

  it('flags the VC++ redistributable runtime (the v1.64.1 helper/engine failure)', () => {
    const image = pe({
      imports: ['kernel32.dll', 'VCRUNTIME140.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'],
      delayImports: ['MSVCP140.dll', 'vcruntime140_1.dll'],
    });
    expect(redistributableRuntimeImports(image)).toEqual(['VCRUNTIME140.dll', 'MSVCP140.dll', 'vcruntime140_1.dll']);
  });

  it('accepts a statically linked image that only uses Windows-provided DLLs', () => {
    const image = pe({ imports: ['kernel32.dll', 'bcrypt.dll', 'api-ms-win-crt-heap-l1-1-0.dll', 'ucrtbase.dll'] });
    expect(redistributableRuntimeImports(image)).toEqual([]);
  });

  it('handles an image with no import directory', () => {
    expect(peImports(pe())).toEqual([]);
  });

  it('rejects non-PE input', () => {
    expect(() => peImports(Buffer.from('\x7fELF not a PE image at all, padded out....................'))).toThrow(
      /valid PE/
    );
  });
});
