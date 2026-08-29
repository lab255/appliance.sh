#!/usr/bin/env node
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const target = 'x86_64-pc-windows-msvc';
const rustToolchain = '1.96.0';
const cargoXwinVersion = '0.23.1';
const sysrootName = 'windows-msvc-sysroot-2026-08-07.tar.xz';
const sysrootUrl =
  'https://github.com/trcrsired/windows-msvc-sysroot/releases/download/2026-08-07/windows-msvc-sysroot.tar.xz';
const checksumFile = path.join(scriptDirectory, 'credential-helper-sysroot.sha256');
const digestManifest = path.join(scriptDirectory, 'credential-helper-checksums.json');
const checkOnly = process.argv.includes('--check');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env ?? process.env,
  });
  if (result.error || result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ''}` : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail}`);
  }
  return options.capture ? result.stdout.trim() : '';
}

function regenerationFallback() {
  const version = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'packages/cli/package.json'), 'utf8')).version;
  console.error(`cargo-xwin ${cargoXwinVersion} is required to regenerate the Windows helper digest.`);
  console.error(`Install it: cargo install cargo-xwin --version ${cargoXwinVersion} --locked`);
  console.error('Then run: pnpm --filter @appliance.sh/cli credhelper:digest');
  console.error('GitHub build:');
  console.error(`  gh workflow run release-cli-binaries.yml --ref "$(git branch --show-current)" -f tag=v${version}`);
  console.error('Local Actions build:');
  console.error(`  act workflow_dispatch -W .github/workflows/release-cli-binaries.yml --input tag=v${version}`);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function download(url, destination, redirectsLeft = 5) {
  await new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many sysroot redirects'));
          if (!response.headers.location.startsWith('https://')) {
            return reject(new Error('refusing non-HTTPS sysroot redirect'));
          }
          download(response.headers.location, destination, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`sysroot download returned HTTP ${response.statusCode}`));
          return;
        }
        const partial = `${destination}.partial`;
        const output = fs.createWriteStream(partial);
        response.pipe(output);
        output.on('finish', () =>
          output.close(() => {
            fs.renameSync(partial, destination);
            resolve();
          })
        );
        output.on('error', reject);
      })
      .on('error', reject);
  });
}

const versionOutput = spawnSync('cargo', ['xwin', '--version'], { encoding: 'utf8' });
if (versionOutput.status !== 0 || !`${versionOutput.stdout}${versionOutput.stderr}`.includes(cargoXwinVersion)) {
  regenerationFallback();
  process.exit(1);
}

const expectedSysrootDigest = fs.readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0];
const cacheRoot = path.resolve(
  process.env.APPLIANCE_CREDHELPER_CACHE_DIR ?? path.join(os.tmpdir(), 'appliance-credhelper-digest')
);
const archive = path.resolve(process.env.APPLIANCE_CREDHELPER_SYSROOT_ARCHIVE ?? path.join(cacheRoot, sysrootName));
fs.mkdirSync(path.dirname(archive), { recursive: true });
if (!fs.existsSync(archive) || sha256(archive) !== expectedSysrootDigest) {
  fs.rmSync(archive, { force: true });
  console.log(`Downloading pinned MSVC sysroot to ${archive}`);
  await download(sysrootUrl, archive);
}
const actualSysrootDigest = sha256(archive);
if (actualSysrootDigest !== expectedSysrootDigest) {
  throw new Error(`MSVC sysroot SHA-256 mismatch (expected ${expectedSysrootDigest}, got ${actualSysrootDigest})`);
}

const xwinCache = path.join(cacheRoot, 'cargo-xwin-cache');
const extractedSysroot = path.join(xwinCache, 'windows-msvc-sysroot');
const extractionStamp = path.join(extractedSysroot, 'APPLIANCE_SYSROOT_SHA256');
if (!fs.existsSync(extractionStamp) || fs.readFileSync(extractionStamp, 'utf8').trim() !== expectedSysrootDigest) {
  fs.rmSync(extractedSysroot, { recursive: true, force: true });
  fs.mkdirSync(extractedSysroot, { recursive: true });
  run('tar', ['-xJf', archive, '-C', extractedSysroot]);
  fs.writeFileSync(extractionStamp, `${expectedSysrootDigest}\n`);
  // cargo-xwin treats DONE as proof that the local sysroot cache is complete.
  fs.writeFileSync(path.join(extractedSysroot, 'DONE'), `sha256:${expectedSysrootDigest}\n`);
}

run('rustup', ['target', 'add', '--toolchain', rustToolchain, target]);
run(
  'cargo',
  [
    `+${rustToolchain}`,
    'xwin',
    'build',
    '--locked',
    '--release',
    '--cross-compiler',
    'clang',
    '--xwin-version',
    '17',
    '--xwin-cache-dir',
    xwinCache,
    '--manifest-path',
    'packages/credhelper/Cargo.toml',
    '--target',
    target,
  ],
  { env: { ...process.env, RUSTFLAGS: '-Clink-arg=/timestamp:0' } }
);

const binary = path.join(repositoryRoot, 'packages/credhelper/target', target, 'release/appliance-credhelper.exe');
run('node', [path.join(scriptDirectory, 'normalize-credential-helper-pe.mjs'), binary]);
const digest = sha256(binary);
const manifest = JSON.parse(fs.readFileSync(digestManifest, 'utf8'));

if (checkOnly) {
  const baked = manifest?.digests?.[target];
  if (baked !== digest) {
    console.error('::error::Windows credential-helper digest drifted from the value baked into the npm package.');
    console.error(`built: ${digest}`);
    console.error(`baked: ${baked ?? '<missing>'}`);
    console.error('Regenerate with: pnpm --filter @appliance.sh/cli credhelper:digest');
    process.exit(1);
  }
  console.log(`Verified ${target}: ${digest}`);
} else {
  manifest.digests ??= {};
  manifest.digests[target] = digest;
  delete manifest.comment;
  fs.writeFileSync(digestManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${digestManifest}: ${digest}`);
}
