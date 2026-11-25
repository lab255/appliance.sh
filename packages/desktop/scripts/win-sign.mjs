#!/usr/bin/env node
// Windows Authenticode signing via Azure Trusted Signing (AP-202).
//
// Wired as `bundle.windows.signCommand` in tauri.release.conf.json, so the
// Tauri bundler calls it once per file with the path as the only argument
// (cwd = src-tauri). The bundler covers the main exe, every externalBin
// sidecar (signed in place in src-tauri/binaries/ — appliance.exe and
// appliance-credhelper.exe), .exe/.dll resources (vm-bin\appliance-vm.exe),
// the NSIS plugin DLLs, the uninstaller and the -setup.exe itself.
//
// Same contract as OpenBook's packages/app/scripts/win-sign.mjs, which signs
// with the same Lab255 certificate profile:
//   - all six Azure values absent  -> skip (unsigned dev / fork / dry-run build)
//   - WINDOWS_SIGNING_REQUIRED=1    -> absence is fatal instead of a skip
//   - partially configured          -> fatal (never ship a half-signed bundle)
//   - trusted-signing-cli failure   -> fatal (the bundler aborts the build)
//
// trusted-signing-cli (pinned 0.9.0 in release-desktop.yml) authenticates with
// AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET from the environment
// and drives signtool (SIGNTOOL_PATH) with the Trusted Signing dlib.

import { spawnSync } from 'node:child_process';

const REQUIRED = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_SIGNING_ENDPOINT',
  'AZURE_SIGNING_ACCOUNT',
  'AZURE_SIGNING_PROFILE',
];

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
const signingRequired = process.env.WINDOWS_SIGNING_REQUIRED?.trim() === '1';

if (missing.length === REQUIRED.length && !signingRequired) {
  console.log('[win-sign] Azure Trusted Signing not configured; leaving the file unsigned.');
  process.exit(0);
}
if (missing.length > 0) {
  console.error(`[win-sign] Windows signing configuration incomplete; missing: ${missing.join(', ')}`);
  process.exit(1);
}

const [file] = process.argv.slice(2);
if (!file) {
  console.error('[win-sign] no file path was provided by the Tauri bundler.');
  process.exit(1);
}

console.log(`[win-sign] signing ${file}`);
const result = spawnSync(
  'trusted-signing-cli',
  [
    '--endpoint',
    process.env.AZURE_SIGNING_ENDPOINT.trim(),
    '--account',
    process.env.AZURE_SIGNING_ACCOUNT.trim(),
    '--certificate',
    process.env.AZURE_SIGNING_PROFILE.trim(),
    '--fd',
    'SHA256',
    '--tr',
    'http://timestamp.acs.microsoft.com',
    '--td',
    'SHA256',
    file,
  ],
  { stdio: 'inherit' }
);

if (result.error) {
  console.error(`[win-sign] failed to run trusted-signing-cli: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
