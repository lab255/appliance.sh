#!/usr/bin/env node
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

  const marker = Buffer.from('RSDS');
  const matches = [];
  let cursor = 0;
  while ((cursor = bytes.indexOf(marker, cursor)) !== -1) {
    matches.push(cursor);
    cursor += marker.length;
  }
  if (matches.length !== 1 || matches[0] + 20 > bytes.length) {
    throw new Error(`credential helper must contain exactly one complete CodeView record (found ${matches.length})`);
  }
  bytes.fill(0, matches[0] + 4, matches[0] + 20);
  return bytes;
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
