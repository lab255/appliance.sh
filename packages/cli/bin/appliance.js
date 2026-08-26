#!/usr/bin/env node
// Tiny shim invoked via the `appliance` global bin. Exec's the
// platform-matched, Bun-compiled CLI binary that scripts/install-
// binary.mjs downloaded into this directory at npm-install time.
//
// Fall-back ordering, top to bottom:
//   1. ./appliance-bin       — production install (postinstall downloaded)
//   2. ../dist/appliance     — local workspace dev (`pnpm run compile`)
//   3. error                 — neither present; ask the user to reinstall

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ext = process.platform === 'win32' ? '.exe' : '';
const candidates = [
  path.join(__dirname, `appliance-bin${ext}`),
  path.resolve(__dirname, '..', 'dist', `appliance${ext}`),
];

const binary = candidates.find((p) => fs.existsSync(p));
if (!binary) {
  console.error('appliance: CLI binary not found.');
  console.error('Reinstall to fetch the platform-matched binary:');
  console.error('  npm i -g @appliance.sh/cli');
  console.error('Or download manually from:');
  console.error('  https://github.com/lab255/appliance.sh/releases/latest');
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
