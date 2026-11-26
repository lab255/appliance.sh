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
//
// Diagnostics: Tauri captures a signCommand's stdout/stderr and, without
// --verbose, reports only "failed to run node" (v1.64.0's first signed build).
// Everything this script and trusted-signing-cli print is therefore also
// appended to $WIN_SIGN_LOG, which release-desktop.yml prints on failure.
//
// `win-sign.mjs --check-credentials` requests an Entra ID token for the
// code-signing scope and exits non-zero with Azure's AADSTS error, so a wrong
// tenant / client ID / secret fails the job in seconds instead of after the
// ~10 minute Rust build.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

const REQUIRED = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_SIGNING_ENDPOINT',
  'AZURE_SIGNING_ACCOUNT',
  'AZURE_SIGNING_PROFILE',
];

const logFile = process.env.WIN_SIGN_LOG?.trim();

function record(stream, message) {
  stream.write(`${message}\n`);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${message}\n`);
    } catch {
      // Diagnostics must never change the signing outcome.
    }
  }
}
const info = (message) => record(process.stdout, `[win-sign] ${message}`);
const fail = (message) => {
  record(process.stderr, `[win-sign] ERROR: ${message}`);
  process.exit(1);
};

const env = (name) => process.env[name]?.trim() ?? '';
const missing = REQUIRED.filter((name) => !env(name));
const signingRequired = env('WINDOWS_SIGNING_REQUIRED') === '1';

if (missing.length === REQUIRED.length && !signingRequired) {
  info('Azure Trusted Signing not configured; leaving the file unsigned.');
  process.exit(0);
}
if (missing.length > 0) {
  fail(`Windows signing configuration incomplete; missing: ${missing.join(', ')}`);
}

const [arg] = process.argv.slice(2);

if (arg === '--check-credentials') {
  // Never process.exit() after fetch(): on Windows, exiting while undici's
  // sockets are closing aborts Node with a libuv assertion
  // (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c) and exit 127,
  // even when the token request succeeded (v1.64.1). Set exitCode and let
  // the event loop drain instead.
  process.exitCode = (await checkCredentials()) ? 0 : 1;
} else {
  signFile(arg);
}

function signFile(file) {
  if (!file) fail('no file path was provided by the Tauri bundler.');
  info(`signing ${file}`);
  const result = spawnSync(
    'trusted-signing-cli',
    [
      '--endpoint',
      env('AZURE_SIGNING_ENDPOINT'),
      '--account',
      env('AZURE_SIGNING_ACCOUNT'),
      '--certificate',
      env('AZURE_SIGNING_PROFILE'),
      '--fd',
      'SHA256',
      '--tr',
      'http://timestamp.acs.microsoft.com',
      '--td',
      'SHA256',
      file,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  for (const [stream, text] of [
    [process.stdout, result.stdout],
    [process.stderr, result.stderr],
  ]) {
    const trimmed = text?.trimEnd();
    if (trimmed) record(stream, trimmed);
  }
  if (result.error) fail(`could not run trusted-signing-cli: ${result.error.message}`);
  if (result.status !== 0) fail(`trusted-signing-cli exited ${result.status ?? result.signal} for ${file}`);
  info(`signed ${file}`);
}

/** Resolves true when Entra ID issues a code-signing token; logs the AADSTS error otherwise. */
async function checkCredentials() {
  const error = (message) => {
    record(process.stderr, `[win-sign] ERROR: ${message}`);
    return false;
  };
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env('AZURE_CLIENT_ID'),
    client_secret: env('AZURE_CLIENT_SECRET'),
    scope: 'https://codesigning.azure.net/.default',
  });
  let response;
  try {
    response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(env('AZURE_TENANT_ID'))}/oauth2/v2.0/token`,
      { method: 'POST', body, signal: AbortSignal.timeout(30_000) }
    );
  } catch (cause) {
    return error(`could not reach Entra ID: ${cause.message}`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const description = String(payload.error_description ?? '').split(/\r?\n/)[0];
    return error(
      `Azure rejected the signing credentials (HTTP ${response.status} ${payload.error ?? ''}): ${description}\n` +
        'Check the publish environment: AZURE_TENANT_ID = Directory (tenant) ID, AZURE_CLIENT_ID = ' +
        'Application (client) ID (not the Object ID), AZURE_CLIENT_SECRET = the secret *value*.'
    );
  }
  info('Entra ID issued a code-signing token for the configured service principal.');
  return true;
}
