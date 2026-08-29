#!/usr/bin/env node
// Postinstall hook for the npm-published `@appliance.sh/cli`. Fetches
// the Bun-compiled CLI binary that matches the host platform/arch
// from the GitHub Release matching this package's version, drops it
// at `bin/appliance-bin` (or `.exe` on Windows), and chmods +x.
//
// The binary is published by
// `.github/workflows/release-cli-binaries.yml`, which is dispatched
// by `.github/workflows/release.yml` right after `nx release` cuts
// the version. There's a short race window (~5 min after publish)
// where npm has the new version but the GitHub Release doesn't yet
// have its assets uploaded — we retry with backoff to cover it.

import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  credentialHelperAssetName,
  credentialHelperInstallPath,
  expectedCredentialHelperDigest,
  verifyDownloadedSha256,
} from './binary-integrity.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(__dirname, '..');
const binDir = path.join(pkgDir, 'bin');

// ---- early exits ------------------------------------------------------

if (process.env.APPLIANCE_SKIP_BINARY_DOWNLOAD === '1') {
  console.log('appliance-cli: APPLIANCE_SKIP_BINARY_DOWNLOAD=1 set, skipping.');
  process.exit(0);
}

// Workspace dev installs (pnpm install at the monorepo root) run this
// script in every workspace package. We don't want to download an
// in-development version — the binary is built locally by
// `pnpm run compile`. Detect by looking for a pnpm-workspace.yaml in
// an ancestor directory.
if (isInsideWorkspace(pkgDir)) {
  console.log('appliance-cli: workspace install detected, skipping binary download.');
  console.log('  (run `pnpm --filter @appliance.sh/cli run compile` to build a local binary.)');
  process.exit(0);
}

// ---- resolve target binary --------------------------------------------

const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
const triple = resolveHostTriple();
if (!triple) {
  console.error(
    `appliance-cli: no prebuilt binary for ${process.platform}/${process.arch}. ` +
      'Open an issue at https://github.com/lab255/appliance.sh/issues.'
  );
  process.exit(1);
}
const ext = process.platform === 'win32' ? '.exe' : '';
const assetName = `appliance-${triple}${ext}`;
const version = pkg.version;
const url = `https://github.com/lab255/appliance.sh/releases/download/v${version}/${assetName}`;
const destBin = path.join(binDir, `appliance-bin${ext}`);

// ---- download with retry ----------------------------------------------

fs.mkdirSync(binDir, { recursive: true });

try {
  await downloadWithRetry(url, destBin, retryOptions());
  if (process.platform !== 'win32') fs.chmodSync(destBin, 0o755);
  console.log(`appliance-cli: installed ${assetName} (v${version}) at ${destBin}`);

  // Windows callers require the typed Credential Manager companion. Keep the
  // naming/digest tables per-target so adding another helper consumer later is
  // data-only, while installing only the Windows helper for this card.
  if (process.platform === 'win32') {
    await installCredentialHelper({ triple, version });
  }
} catch (err) {
  console.error(`appliance-cli: installation failed: ${err.message ?? err}`);
  process.exit(1);
}

// ---- helpers ----------------------------------------------------------

function resolveHostTriple() {
  const { platform, arch } = process;
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  return null;
}

function isInsideWorkspace(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return true;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      if (json.workspaces) return true;
    } catch {
      // No or unreadable package.json — keep climbing.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

function retryOptions() {
  return {
    attempts: 6,
    // 5/10/20/40/80s — covers the typical ~5 minute window between npm
    // publish and the GitHub Release asset upload completing.
    delayMs: (n) => Math.min(5000 * 2 ** n, 80_000),
  };
}

async function installCredentialHelper({ triple, version }) {
  const destination = credentialHelperInstallPath(pkgDir, process.platform);
  const candidate = `${destination}.verifying.${process.pid}`;

  fs.rmSync(candidate, { force: true });
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'credential-helper-checksums.json'), 'utf-8'));
    const expectedDigest = expectedCredentialHelperDigest(manifest, triple);
    const helperAsset = credentialHelperAssetName(triple);
    const helperUrl = `https://github.com/lab255/appliance.sh/releases/download/v${version}/${helperAsset}`;
    await downloadWithRetry(helperUrl, candidate, retryOptions());
    verifyDownloadedSha256(candidate, expectedDigest);
    // The candidate is verified before the canonical helper is replaced. On
    // any later failure, remove both paths so install remains fail-closed.
    fs.rmSync(destination, { force: true });
    fs.renameSync(candidate, destination);
    console.log(`appliance-cli: installed ${helperAsset} (sha256 ${expectedDigest}) at ${destination}`);
  } catch (error) {
    fs.rmSync(candidate, { force: true });
    fs.rmSync(destination, { force: true });
    console.warn(
      `appliance-cli: credential helper is not yet available (${error.message ?? error}); ` +
        'continuing without it. Credential operations will fail until the helper is installed.'
    );
    return;
  }
}

async function downloadWithRetry(srcUrl, dest, opts) {
  const { attempts, delayMs } = opts;
  for (let n = 0; n < attempts; n++) {
    try {
      await downloadFollowingRedirects(srcUrl, dest);
      return;
    } catch (err) {
      const transient = err && (err.status === 404 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT');
      const lastAttempt = n === attempts - 1;
      if (!transient || lastAttempt) {
        console.error(`appliance-cli: download failed: ${err.message ?? err}`);
        console.error(`  URL: ${srcUrl}`);
        if (err && err.status === 404 && !lastAttempt) {
          console.error('  (asset may still be uploading from a fresh release — retrying)');
        }
        if (lastAttempt) {
          console.error('  After multiple retries — check your network and retry, or download manually:');
          console.error('  https://github.com/lab255/appliance.sh/releases');
        }
        throw err;
      }
      const wait = delayMs(n);
      console.warn(
        `appliance-cli: download attempt ${n + 1}/${attempts} failed (${err.status ?? err.code ?? 'error'}). ` +
          `Retrying in ${Math.round(wait / 1000)}s…`
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function downloadFollowingRedirects(srcUrl, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(srcUrl, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        if (!res.headers.location.startsWith('https://')) {
          reject(new Error('refusing non-HTTPS redirect'));
          return;
        }
        res.resume();
        downloadFollowingRedirects(res.headers.location, dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error(`HTTP ${res.statusCode} ${res.statusMessage}`);
        err.status = res.statusCode;
        reject(err);
        return;
      }
      const tmp = `${dest}.partial.${process.pid}`;
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => {
        out.close((err) => {
          if (err) {
            fs.rmSync(tmp, { force: true });
            reject(err);
            return;
          }
          try {
            fs.renameSync(tmp, dest);
            resolve();
          } catch (renameErr) {
            fs.rmSync(tmp, { force: true });
            reject(renameErr);
          }
        });
      });
      out.on('error', (err) => {
        fs.rmSync(tmp, { force: true });
        reject(err);
      });
    });
    req.on('error', reject);
  });
}
