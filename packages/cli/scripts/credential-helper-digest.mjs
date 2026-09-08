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
const sysrootName = 'windows-msvc-sysroot-2026-08-07.tar.xz';
const sysrootUrl =
  'https://github.com/trcrsired/windows-msvc-sysroot/releases/download/2026-08-07/windows-msvc-sysroot.tar.xz';
const checksumFile = path.join(scriptDirectory, 'credential-helper-sysroot.sha256');
const digestManifest = path.join(scriptDirectory, 'credential-helper-checksums.json');
const checkOnly = process.argv.includes('--check');

// Pin provenance must be the canonical Ubuntu CI compiler host. Even matching
// Rust versions can emit different code layouts on other compiler hosts.
if (!checkOnly && (process.platform !== 'linux' || process.arch !== 'x64' || process.env.CI !== 'true')) {
  console.error('Only the canonical Linux x64 CI build may regenerate the credential-helper pin.');
  console.error('Download its credential-helper-linux artifact and use that SHA-256; local --check is diagnostic.');
  process.exit(1);
}

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

// Fail before downloading the sysroot when the pinned compiler is unavailable.
let rustVersion;
try {
  rustVersion = run('rustc', [`+${rustToolchain}`, '-vV'], { capture: true });
} catch (error) {
  console.error(error.message);
  console.error('Install rustup, then install the pinned credential-helper toolchain:');
  console.error(`  rustup toolchain install ${rustToolchain} --profile minimal --target ${target}`);
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

fs.mkdirSync(cacheRoot, { recursive: true });
const extractedSysroot = path.join(cacheRoot, 'windows-msvc-sysroot');
const extractionStamp = path.join(extractedSysroot, 'APPLIANCE_SYSROOT_SHA256');
if (!fs.existsSync(extractionStamp) || fs.readFileSync(extractionStamp, 'utf8').trim() !== expectedSysrootDigest) {
  fs.rmSync(extractedSysroot, { recursive: true, force: true });
  // The archive already contains the windows-msvc-sysroot directory.
  // Git Bash's GNU tar interprets a drive-letter path as a remote archive.
  const tar =
    process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe') : 'tar';
  run(tar, ['-xJf', archive, '-C', cacheRoot]);
  fs.writeFileSync(extractionStamp, `${expectedSysrootDigest}\n`);
}

// Use Rust's bundled linker on EVERY host. Native link.exe and a host-installed
// lld-link are not equivalent, even with identical source and a fixed timestamp.

const host = rustVersion.match(/^host: (.+)$/m)?.[1];
if (!host) throw new Error('rustc did not report its host triple');
const rustSysroot = run('rustc', [`+${rustToolchain}`, '--print', 'sysroot'], { capture: true });
const linker = path.join(
  rustSysroot,
  'lib/rustlib',
  host,
  'bin',
  `rust-lld${process.platform === 'win32' ? '.exe' : ''}`
);
const libraryPath = path.join(extractedSysroot, 'lib/x86_64-unknown-windows-msvc');
const cargoHome = path.resolve(process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'));
const targetDirectory = path.resolve(
  process.env.APPLIANCE_CREDHELPER_TARGET_DIR ?? path.join(repositoryRoot, 'packages/credhelper/target')
);
console.log(rustVersion);
console.log(run(linker, ['-flavor', 'link', '--version'], { capture: true }));
run('rustup', ['target', 'add', '--toolchain', rustToolchain, target]);
const flags = [
  '-C',
  `linker=${linker}`,
  '-C',
  'linker-flavor=lld-link',
  '-L',
  `native=${libraryPath}`,
  '-C',
  'link-arg=/timestamp:0',
  '-C',
  'link-arg=/pdbaltpath:appliance-credhelper.pdb',
  '-C',
  `link-arg=/map:${path.join(targetDirectory, 'credential-helper.map')}`,
  '--remap-path-prefix',
  `${repositoryRoot}=/appliance`,
  '--remap-path-prefix',
  `${cargoHome}=/cargo`,
  '--remap-path-prefix',
  `${rustSysroot}=/rust`,
];
run(
  'cargo',
  [
    `+${rustToolchain}`,
    'build',
    '--locked',
    '--release',
    '--manifest-path',
    'packages/credhelper/Cargo.toml',
    '--target',
    target,
    '--target-dir',
    targetDirectory,
  ],
  { env: { ...process.env, CARGO_INCREMENTAL: '0', CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') } }
);

const binary = path.join(targetDirectory, target, 'release/appliance-credhelper.exe');
run(process.execPath, [path.join(scriptDirectory, 'normalize-credential-helper-pe.mjs'), binary]);
const digest = sha256(binary);
// Keep evidence even when the baked-pin guard below fails.
fs.writeFileSync(`${binary}.sha256`, `${digest}  appliance-credhelper.exe\n`);
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
