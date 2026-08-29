#!/usr/bin/env node
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? 'x86_64-pc-windows-msvc';
const binary = process.argv[3];

if (!binary) {
  console.error('usage: verify-credential-helper-digest.mjs <target-triple> <appliance-credhelper>');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(path.join(scriptDirectory, 'credential-helper-checksums.json'), 'utf8'));
const expected = manifest?.digests?.[target];
if (!/^[a-f0-9]{64}$/.test(expected ?? '')) {
  console.error(`::error::No valid baked credential-helper SHA-256 exists for ${target}.`);
  process.exit(1);
}
if (!fs.existsSync(binary)) {
  console.error(`::error::Credential helper is missing from the release layout: ${binary}`);
  process.exit(1);
}

const actual = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
if (actual !== expected) {
  console.error('::error::Windows CLI and desktop credential helpers do not match byte-for-byte.');
  console.error(`layout: ${binary}`);
  console.error(`actual: ${actual}`);
  console.error(`CLI baked: ${expected}`);
  console.error(
    'Both release paths must carry the helper pinned by packages/cli/scripts/credential-helper-checksums.json.'
  );
  console.error(
    'If the helper changed intentionally, regenerate with: pnpm --filter @appliance.sh/cli credhelper:digest'
  );
  process.exit(1);
}

console.log(`Verified ${binary}: ${actual}`);
