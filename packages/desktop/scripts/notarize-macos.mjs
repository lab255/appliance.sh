#!/usr/bin/env node
// Production macOS signing + notarization for the Appliance desktop
// bundle, as the release-build counterpart to scripts/sign-macos.mjs.
//
// What this does (only when the relevant env vars are present):
//   1. Re-sign the bundled .app with a real "Developer ID Application"
//      identity + the hardened runtime + a secure-timestamp, so the
//      bundle is Gatekeeper-eligible (ad-hoc / self-signed builds are
//      not, and notarytool rejects them).
//   2. Submit the signed .app (and each produced .dmg) to Apple's
//      notarization service via `notarytool` and wait for the verdict.
//   3. Staple the notarization ticket onto the .app and .dmg so they
//      pass Gatekeeper OFFLINE (first launch on a machine that can't
//      reach Apple still works).
//
// Why a SEPARATE script from sign-macos.mjs:
//   sign-macos.mjs exists purely for *local dev*: it re-signs with a
//   stable self-signed cert so the macOS Keychain stops re-prompting on
//   every rebuild. That cert is intentionally NOT a Developer ID and
//   CANNOT notarize. Production release builds need the Apple-issued
//   identity + the notarization round-trip, which this script owns. The
//   two never run together — the release workflow invokes this one; a
//   plain `pnpm tauri:build` keeps running sign-macos.mjs.
//
// SAFE TO RUN ANYWHERE — this is a strict no-op unless ALL of the
// production credentials are present in the environment, exactly like
// sign-macos.mjs no-ops without its dev cert. So local builds, CI
// builds without secrets, and non-macOS platforms all skip cleanly.
//
// Signing identity + team:
//   Derived from the keychain search list (the first valid "Developer
//   ID Application" identity — in CI, the one cert the release
//   workflow imported; see macos-signing.mjs). The team id comes from
//   the identity's "(TEAMID1234)" suffix. Env overrides both:
//   APPLE_SIGNING_IDENTITY  e.g. "Developer ID Application: Acme, Inc. (TEAMID1234)"
//   APPLE_TEAM_ID           10-char Apple Developer Team ID
// Required env (to actually notarize):
//   Notarization auth — EITHER:
//     a) App-Store-Connect API key (preferred for CI):
//        APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_API_KEY_PATH (path to the .p8)
//     b) Apple ID + app-specific password:
//        APPLE_ID, APPLE_PASSWORD  (APPLE_TEAM_ID doubles as the notarytool team)
//
// Optional env:
//   APPLE_NOTARIZE=0        force-skip notarization (still re-signs)
//   APPLIANCE_ENTITLEMENTS  path to a custom entitlements plist
//                           (defaults to scripts/entitlements.plist)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveSigningIdentity, teamIdFromIdentity } from './macos-signing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');

function log(msg) {
  console.log(`[notarize-macos] ${msg}`);
}

// Non-macOS platforms have nothing to sign/notarize.
if (process.platform !== 'darwin') {
  process.exit(0);
}

const IDENTITY = resolveSigningIdentity();
const TEAM_ID = process.env.APPLE_TEAM_ID || teamIdFromIdentity(IDENTITY);

// Without a Developer ID identity there's nothing production-grade to
// do — leave the (ad-hoc or dev-cert) signature from `tauri build`
// untouched. Mirrors sign-macos.mjs's "cert absent → no-op" contract.
if (!IDENTITY || !TEAM_ID) {
  log('no Developer ID identity in env or keychain — skipping production signing + notarization.');
  process.exit(0);
}

// ---- locate the freshly built bundle -----------------------------------

const macosBundleDir = path.join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'macos');
const dmgBundleDir = path.join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'dmg');

function findApp() {
  try {
    const app = fs.readdirSync(macosBundleDir).find((e) => e.endsWith('.app'));
    return app ? path.join(macosBundleDir, app) : null;
  } catch {
    return null;
  }
}

function findDmgs() {
  try {
    return fs
      .readdirSync(dmgBundleDir)
      .filter((e) => e.endsWith('.dmg'))
      .map((e) => path.join(dmgBundleDir, e));
  } catch {
    return [];
  }
}

const appPath = findApp();
if (!appPath) {
  log(`no .app found in ${macosBundleDir} — nothing to sign. (Did \`tauri build\` run?)`);
  process.exit(0);
}

// ---- 1. Developer ID re-sign with hardened runtime ---------------------
//
// Tauri can already Developer-ID-sign when APPLE_SIGNING_IDENTITY is in
// the env at build time, but we re-sign defensively + explicitly with
// --options runtime (hardened runtime) and --timestamp so the result is
// notarization-eligible regardless of the Tauri version's defaults. The
// embedded sidecars (appliance CLI, appliance-vm) are sealed under the
// same identity via --deep so the bundle verifies as a whole.

// Hardened-runtime entitlements for the notarized build (scripts/
// entitlements.plist — kept comment-free so `codesign`'s DER entitlement
// encoding never trips over XML comments). Why each one is present:
//   - allow-jit / allow-unsigned-executable-memory: the Bun-compiled
//     `appliance` CLI and the bootstrap `node` both JIT JavaScript, which
//     the hardened runtime forbids by default.
//   - allow-dyld-environment-variables / disable-library-validation: let
//     the shell launch our-identity-signed sidecars that load their own
//     (differently-signed / unsigned) libraries — Bun single-file
//     executables embed their runtime this way.
// Keychain access needs no entitlement (gated by signing identity, not a
// hardened-runtime capability); network client access is the GUI default.
// Keep the list MINIMAL — some entitlements (e.g. get-task-allow) fail
// notarization outright.
const entitlements = process.env.APPLIANCE_ENTITLEMENTS || path.join(__dirname, 'entitlements.plist');
const haveEntitlements = fs.existsSync(entitlements);

log(`signing ${path.basename(appPath)} with "${IDENTITY}" (hardened runtime)…`);
try {
  const args = [
    '--force',
    '--deep',
    '--options',
    'runtime', // hardened runtime — required for notarization
    '--timestamp', // secure timestamp from Apple's TSA
    '-s',
    IDENTITY,
  ];
  if (haveEntitlements) {
    args.push('--entitlements', entitlements);
    log(`using entitlements ${path.relative(desktopRoot, entitlements)}`);
  } else {
    log('no entitlements file — signing without one (the embedded JIT-free binaries need none).');
  }
  args.push(appPath);
  execFileSync('codesign', args, { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
  log('signature verified.');
} catch (err) {
  log(`signing failed: ${err.message}`);
  process.exit(1);
}

// ---- 2. notarization auth resolution -----------------------------------

if (process.env.APPLE_NOTARIZE === '0') {
  log('APPLE_NOTARIZE=0 — re-signed but skipping the notarization round-trip.');
  process.exit(0);
}

/** Build the `notarytool` auth flags from whichever credential set is
 *  present, or null when neither is fully configured. */
function notaryAuthArgs() {
  const { APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_API_KEY_PATH, APPLE_ID, APPLE_PASSWORD } = process.env;
  if (APPLE_API_KEY_ID && APPLE_API_ISSUER && APPLE_API_KEY_PATH) {
    return ['--key', APPLE_API_KEY_PATH, '--key-id', APPLE_API_KEY_ID, '--issuer', APPLE_API_ISSUER];
  }
  if (APPLE_ID && APPLE_PASSWORD) {
    return ['--apple-id', APPLE_ID, '--password', APPLE_PASSWORD, '--team-id', TEAM_ID];
  }
  return null;
}

const authArgs = notaryAuthArgs();
if (!authArgs) {
  // We DID re-sign (good for Gatekeeper on the building machine), but
  // can't notarize without creds. Don't fail the build — mirror the
  // no-op ethos. The release workflow is what guarantees creds.
  log('no notarization credentials (need APPLE_API_KEY_* or APPLE_ID + APPLE_PASSWORD) — signed but NOT notarized.');
  process.exit(0);
}

// ---- 3. submit + staple ------------------------------------------------
//
// notarytool wants a single file: zip the .app, submit, then staple the
// ticket back onto the .app. DMGs are submitted + stapled directly.

function notarizeFile(file) {
  log(`submitting ${path.basename(file)} to notarytool (this can take a few minutes)…`);
  execFileSync('xcrun', ['notarytool', 'submit', file, ...authArgs, '--wait'], { stdio: 'inherit' });
}

function staple(target) {
  log(`stapling ticket onto ${path.basename(target)}…`);
  execFileSync('xcrun', ['stapler', 'staple', target], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'validate', target], { stdio: 'inherit' });
}

try {
  // Notarize the .app via a throwaway zip (the .app itself can't be fed
  // to notarytool directly — it needs a single-file container).
  const appZip = path.join(macosBundleDir, `${path.basename(appPath, '.app')}-notarize.zip`);
  execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, appZip], { stdio: 'inherit' });
  notarizeFile(appZip);
  fs.rmSync(appZip, { force: true });
  staple(appPath); // staple the .app itself, not the zip

  // Then each DMG. The DMG wraps the now-stapled .app, but the DMG also
  // needs its own ticket so the download passes Gatekeeper before mount.
  const dmgs = findDmgs();
  if (dmgs.length === 0) {
    log('no .dmg found to notarize (only the .app was produced).');
  }
  for (const dmg of dmgs) {
    notarizeFile(dmg);
    staple(dmg);
  }

  log('done — bundle is Developer-ID-signed, notarized, and stapled.');
} catch (err) {
  log(`notarization failed: ${err.message}`);
  process.exit(1);
}
