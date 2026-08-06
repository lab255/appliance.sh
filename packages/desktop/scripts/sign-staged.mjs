#!/usr/bin/env node
// Developer-ID-sign the binaries staged into src-tauri/ right before
// the bundler packages them, so Apple's notary service accepts the
// archive.
//
// MUST run as the release overlay's `beforeBundleCommand`
// (tauri.release.conf.json), NOT earlier in the script chain: `tauri
// build` first runs beforeBuildCommand (`pnpm build`), which re-runs
// vm:build + vm:bundle and re-stages a fresh AD-HOC-signed copy over
// anything signed before it — that clobber sank the first fix attempt
// (run 31097880178). beforeBundleCommand is the only hook between that
// re-staging and the resource copy into the .app.
//
// Why: Tauri signs the app shell and its externalBin sidecars, but
// bundle.resources are copied into Contents/Resources verbatim — a
// Mach-O staged there keeps whatever signature it arrived with. The
// appliance-vm engine arrives AD-HOC signed (packages/vm/scripts/
// sign-dev.sh, for local runnability), and notarization rejects the
// whole archive over it: "not signed with a valid Developer ID
// certificate", "no secure timestamp", "hardened runtime not enabled".
// Signing the staged file here fixes the copy Tauri bundles; the
// desktop's microvm_install re-signs it again after extracting it from
// the bundle, so runtime behavior is unchanged.
//
// Coverage: sweeps every staging dir for Mach-O files, so a newly
// staged binary can't reintroduce the failure. binaries/ (the CLI
// sidecar) is swept too even though Tauri re-signs its bundled copy —
// belt and braces, and it keeps this script the single answer to
// "which staged binaries are signed?". apiserver-bin/ holds Linux ELF
// guest binaries + tarballs; the Mach-O filter skips those.
//
// No-op (same contract as notarize-macos.mjs / sign-macos.mjs) without
// a resolvable Developer ID identity — dev builds and secret-less
// forks keep their ad-hoc signatures. A codesign failure once an
// identity IS resolved is fatal: better to fail the build than ship a
// bundle notarization will reject.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMachO, resolveSigningIdentity, signBinary } from './macos-signing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const srcTauri = path.join(desktopRoot, 'src-tauri');

function log(msg) {
  console.log(`[sign-staged] ${msg}`);
}

// Per-staging-dir entitlements. Hardened-runtime entitlements attach to
// the binary being signed, so each staged binary needs its OWN set:
//   - vm-bin: com.apple.security.virtualization (vz.entitlements) —
//     Virtualization.framework is entitlement-gated; same file
//     sign-dev.sh applies ad-hoc.
//   - binaries: the Bun-compiled CLI JITs JavaScript, which the
//     hardened runtime forbids without the allow-jit family
//     (entitlements.plist — same set the .app signature uses).
//   - apiserver-bin: ELF-only in practice; no entitlements if a
//     Mach-O ever lands there.
const STAGING_DIRS = [
  { dir: path.join(srcTauri, 'vm-bin'), entitlements: path.join(repoRoot, 'packages', 'vm', 'vz.entitlements') },
  { dir: path.join(srcTauri, 'binaries'), entitlements: path.join(__dirname, 'entitlements.plist') },
  { dir: path.join(srcTauri, 'apiserver-bin'), entitlements: null },
];

function machOFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter(isMachO);
}

function main() {
  if (process.platform !== 'darwin') {
    return; // nothing to codesign off-macOS
  }
  const identity = resolveSigningIdentity();
  if (!identity) {
    log('no Developer ID identity (env or keychain) — staged binaries keep their ad-hoc signatures.');
    return;
  }
  log(`signing staged binaries with "${identity}" (hardened runtime + timestamp)…`);
  let signed = 0;
  for (const { dir, entitlements } of STAGING_DIRS) {
    for (const file of machOFiles(dir)) {
      const rel = path.relative(desktopRoot, file);
      log(`  ${rel}${entitlements ? ` (entitlements: ${path.relative(repoRoot, entitlements)})` : ''}`);
      signBinary(file, identity, { entitlements });
      signed++;
    }
  }
  log(signed > 0 ? `${signed} staged binar${signed === 1 ? 'y' : 'ies'} signed.` : 'no staged Mach-O binaries found.');
}

main();
