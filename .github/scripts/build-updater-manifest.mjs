#!/usr/bin/env node
// Assemble the Tauri updater manifest (`latest.json`) from the per-arch
// build artifacts, for .github/workflows/release-desktop.yml's publish
// job.
//
// The desktop's tauri.conf.json points `plugins.updater.endpoints` at
// `.../releases/latest/download/latest.json`. The running app fetches
// that, compares `version` against its own, and — when behind —
// downloads the matching platform's `url` and verifies it against
// `signature` (the verbatim contents of the Tauri-emitted `.sig`).
//
// Inputs (env, set by the workflow):
//   TAG      release tag, e.g. v1.48.0
//   VERSION  tag without the leading v, e.g. 1.48.0
//   REPO     owner/name, e.g. lab255/appliance.sh
//
// Reads:  dist-artifacts/desktop-<arch>/Appliance_<arch>.app.tar.gz.sig
// Writes: latest.json (cwd)
//
// Skips any arch whose .sig is missing (e.g. an unsigned dry-run build)
// rather than failing — but errors if NO platform could be assembled, so
// a misconfigured signing setup doesn't silently publish an empty feed.

import * as fs from 'node:fs';
import * as path from 'node:path';

const TAG = requireEnv('TAG');
const VERSION = requireEnv('VERSION');
const REPO = requireEnv('REPO');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[updater-manifest] missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

// Map our build jobs onto the updater's platform keys (`<os>-<arch>`).
// macOS updates from the .app tarball; Windows updates in place from
// the NSIS -setup.exe (Tauri v2).
const PLATFORMS = [
  { artifactDir: 'desktop-aarch64', asset: 'Appliance_aarch64.app.tar.gz', key: 'darwin-aarch64' },
  { artifactDir: 'desktop-x86_64', asset: 'Appliance_x86_64.app.tar.gz', key: 'darwin-x86_64' },
  { artifactDir: 'desktop-windows-x86_64', asset: 'Appliance_x86_64-setup.exe', key: 'windows-x86_64' },
];

const artifactsRoot = 'dist-artifacts';
const platforms = {};

for (const { artifactDir, asset, key } of PLATFORMS) {
  const dir = path.join(artifactsRoot, artifactDir);
  const sigPath = path.join(dir, `${asset}.sig`);
  if (!fs.existsSync(sigPath)) {
    console.warn(`[updater-manifest] no signature for ${key} (${sigPath}) — skipping this platform.`);
    continue;
  }
  const signature = fs.readFileSync(sigPath, 'utf8').trim();
  // The updater downloads from the release's asset URL. The artifact is
  // uploaded under its platform-tagged name by the publish job.
  const url = `https://github.com/${REPO}/releases/download/${TAG}/${asset}`;
  platforms[key] = { signature, url };
  console.log(`[updater-manifest] + ${key} -> ${url}`);
}

if (Object.keys(platforms).length === 0) {
  console.error(
    '[updater-manifest] no signed platforms found — refusing to publish an empty manifest. ' +
      'Was TAURI_SIGNING_PRIVATE_KEY set on the build job?'
  );
  process.exit(1);
}

const manifest = {
  version: VERSION,
  // Notes are intentionally left to the GitHub Release body; the updater
  // surfaces this string, so keep it short + generic. The Settings panel
  // already links users to the full release notes.
  notes: `Appliance ${VERSION}. See the release notes on GitHub for details.`,
  pub_date: new Date().toISOString(),
  platforms,
};

fs.writeFileSync('latest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`[updater-manifest] wrote latest.json for ${VERSION} (${Object.keys(platforms).length} platform(s)).`);
