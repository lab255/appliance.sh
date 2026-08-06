// Shared macOS Developer-ID signing helpers for the desktop build
// scripts (sign-staged.mjs, notarize-macos.mjs).
//
// The signing identity is DERIVED from the keychain, not configured:
// rotating the Developer ID certificate changes its identity string,
// so a hardcoded APPLE_SIGNING_IDENTITY secret goes stale silently —
// the scripts that gate on it then no-op while the build still looks
// signed. Deriving asks the keychain search list for whatever
// "Developer ID Application" identity is present: in CI that is
// exactly the one cert the release workflow just imported into its
// temp keychain; locally it's the developer's own cert, if any.
// APPLE_SIGNING_IDENTITY still wins when set, as an explicit override
// (e.g. a machine with several Developer ID certs).

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Resolve the Developer ID Application identity to sign with:
 * APPLE_SIGNING_IDENTITY when set, otherwise the first valid
 * "Developer ID Application" identity in the keychain search list.
 * Returns null when neither exists (dev builds, secret-less forks,
 * non-macOS platforms) — callers no-op on null.
 */
export function resolveSigningIdentity() {
  const explicit = process.env.APPLE_SIGNING_IDENTITY;
  if (explicit) return explicit;
  if (process.platform !== 'darwin') return null;
  let out;
  try {
    out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf-8' });
  } catch {
    return null;
  }
  // Matching lines look like:
  //   1) A1B2C3… "Developer ID Application: Acme, Inc. (TEAMID1234)"
  for (const line of out.split('\n')) {
    const m = line.match(/"(Developer ID Application: [^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Extract the 10-char team id from the "(TEAMID1234)" suffix of a
 * Developer ID identity string, or null. Lets notarization fall back
 * when APPLE_TEAM_ID isn't set — the identity always carries the team.
 */
export function teamIdFromIdentity(identity) {
  const m = /\(([A-Z0-9]{10})\)"?\s*$/.exec(identity || '');
  return m ? m[1] : null;
}

/**
 * True when the file starts with a Mach-O (thin or universal) magic.
 * Staging dirs also hold Linux ELF guest binaries and tarballs, which
 * codesign can't sign and notarization ignores — callers use this to
 * skip them.
 */
export function isMachO(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) !== 4) return false;
    const magic = buf.readUInt32BE(0);
    return [
      0xfeedface, // MH_MAGIC (32-bit)
      0xcefaedfe, // MH_CIGAM
      0xfeedfacf, // MH_MAGIC_64
      0xcffaedfe, // MH_CIGAM_64 (how an arm64/x86_64 slice reads big-endian)
      0xcafebabe, // FAT_MAGIC (universal)
      0xbebafeca, // FAT_CIGAM
    ].includes(magic);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Developer-ID-sign one binary to notarization grade: hardened runtime
 * + secure timestamp, replacing any existing (ad-hoc) signature.
 */
export function signBinary(file, identity, { entitlements } = {}) {
  const args = ['--force', '--options', 'runtime', '--timestamp', '-s', identity];
  if (entitlements) args.push('--entitlements', entitlements);
  args.push(file);
  execFileSync('codesign', args, { stdio: 'inherit' });
}
