#!/usr/bin/env node
// Copy the Bun-compiled `appliance` CLI binary into the location
// Tauri's `externalBin` resolution expects:
//   packages/desktop/src-tauri/binaries/appliance-<rust-target-triple>
//
// Tauri-build picks each `binaries/<name>-<triple>` up at compile
// time, copies it next to the desktop's main binary in the bundled
// app, and tauri-plugin-shell's sidecar API resolves it transparently
// at runtime (dev + prod).
//
// Run as part of `pnpm --filter @appliance.sh/desktop build` so the
// rust crate always sees an up-to-date binary alongside the host's
// own compile output. The same binaries are also published as GitHub
// Release assets by `.github/workflows/release-cli-binaries.yml` for
// CLI-only users — both the desktop install path and the standalone
// install path point at the same artifacts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const cliDist = path.join(repoRoot, 'packages', 'cli', 'dist');
const credhelperRoot = path.join(repoRoot, 'packages', 'credhelper');
const binariesDir = path.join(desktopRoot, 'src-tauri', 'binaries');

/**
 * Resolve the Rust target triple for the *host* machine. Matches
 * what `tauri-build` looks for in `binaries/<name>-<triple>`.
 *
 * Allows `APPLIANCE_TARGET_TRIPLE` to override for cross-compilation
 * from CI (where we'd compile the CLI for, say, linux-x64 on a Mac
 * runner and place the result alongside the desktop's linux build).
 */
function targetTriple() {
  const override = process.env.APPLIANCE_TARGET_TRIPLE;
  if (override) return override;
  try {
    const rustc = execFileSync('rustc', ['-vV'], { encoding: 'utf-8' });
    for (const line of rustc.split('\n')) {
      const match = line.match(/^host:\s*(\S+)/);
      if (match) return match[1];
    }
  } catch {
    // rustc not available — fall back to a node-based guess. This is
    // only hit on machines without a Rust toolchain installed; in CI
    // and dev the toolchain is always present because cargo runs
    // right after this script.
  }
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`Unsupported host platform/arch combo for sidecar bundling: ${platform}/${arch}`);
}

/**
 * Pick a CLI binary to place next to the desktop. Prefers a triple-
 * matched binary produced by `pnpm --filter @appliance.sh/cli run
 * compile:<target>` (CI / release path), falls back to the generic
 * `dist/appliance` produced by the host-default `compile` script
 * (everyday dev path).
 */
function sourceBinary(triple) {
  const ext = triple.includes('windows') ? '.exe' : '';
  const tripleSpecific = path.join(cliDist, `appliance-${triple}${ext}`);
  if (fs.existsSync(tripleSpecific)) return tripleSpecific;
  const generic = path.join(cliDist, `appliance${ext}`);
  if (fs.existsSync(generic)) return generic;
  throw new Error(`No CLI binary found in ${cliDist}. Run \`pnpm --filter @appliance.sh/cli run compile\` first.`);
}

function buildCredentialHelper(triple) {
  execFileSync(
    'cargo',
    ['build', '--locked', '--release', '--manifest-path', path.join(credhelperRoot, 'Cargo.toml'), '--target', triple],
    { cwd: repoRoot, stdio: 'inherit', windowsHide: true }
  );
  const extension = triple.includes('windows') ? '.exe' : '';
  const source = path.join(credhelperRoot, 'target', triple, 'release', `appliance-credhelper${extension}`);
  if (!fs.existsSync(source)) {
    throw new Error(`Credential helper build did not produce ${source}`);
  }
  return source;
}

function copyExecutable(source, destination, triple) {
  fs.copyFileSync(source, destination);
  if (!triple.includes('windows')) {
    fs.chmodSync(destination, 0o755);
  }
}

function main() {
  const triple = targetTriple();
  const ext = triple.includes('windows') ? '.exe' : '';
  const cliSource = sourceBinary(triple);
  const cliDestination = path.join(binariesDir, `appliance-${triple}${ext}`);
  const helperSource = buildCredentialHelper(triple);
  const helperDestination = path.join(binariesDir, `appliance-credhelper-${triple}${ext}`);

  fs.mkdirSync(binariesDir, { recursive: true });
  copyExecutable(cliSource, cliDestination, triple);
  copyExecutable(helperSource, helperDestination, triple);
  console.log(`copy-cli: ${path.relative(repoRoot, cliSource)} → ${path.relative(repoRoot, cliDestination)}`);
  console.log(`copy-cli: ${path.relative(repoRoot, helperSource)} → ${path.relative(repoRoot, helperDestination)}`);
}

main();
