import chalk from 'chalk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import {
  PINNED_RELEASE_TRUST,
  VERSION,
  verifyReleaseEnvelope,
  type ReleaseArtifact,
  type ReleaseTrustPolicy,
} from '@appliance.sh/sdk';
import { ensurePrivateDirectory, restrictWindowsAcl } from './fs-acl.js';

// Staging of the api-server GUEST artifacts: the linux binary the
// microVM runs as its control plane, plus the web-console bundle it
// serves. The appliance-vm engine embeds whatever is staged at
// ~/.appliance/vm/images/guest-assets/ into the boot media — it never
// builds or downloads these itself, so this module is the single
// producer. No docker anywhere: the binary is a bun-compiled
// executable, delivered as a plain file.
//
// Resolution order:
//   1. APPLIANCE_API_SERVER_BINARY — explicit override, copied as-is
//      (plus a sibling appliance-console.tar.gz when one ships next to
//      it, as the desktop's dev staging does).
//   2. Repo checkout — a prebuilt dist/guest binary, or a fresh
//      `bun build --compile` when bun is available.
//   3. GitHub release download pinned to this CLI's VERSION (the same
//      versioned-artifact convention the ghcr image used to follow).

const GUEST_ARCH: 'x64' | 'arm64' = process.arch === 'arm64' ? 'arm64' : 'x64';
const RELEASE_BASE = 'https://github.com/lab255/appliance.sh/releases/download';

export function guestAssetsDir(): string {
  return path.join(os.homedir(), '.appliance', 'vm', 'images', 'guest-assets');
}

function stagedBinaryPath(): string {
  return path.join(guestAssetsDir(), 'appliance-api-server');
}

function stagedConsolePath(): string {
  return path.join(guestAssetsDir(), 'appliance-console.tar.gz');
}

function versionStampPath(): string {
  return path.join(guestAssetsDir(), 'appliance-api-server.version');
}

function releasePayloadPath(): string {
  return path.join(guestAssetsDir(), 'control-plane-release.json');
}

function releaseSignaturePath(): string {
  return path.join(guestAssetsDir(), 'control-plane-release.sig.json');
}

function releaseChecksumsPath(): string {
  return path.join(guestAssetsDir(), 'appliance-api-server.sha256');
}

/** Repo layout probe, resolved relative to this module's emitted file
 *  (dist/utils → the repo's packages dir) — mirrors microvm-up's
 *  repoVmBinaryCandidates. Null under the bun single binary. */
function repoPackagesDir(): string | null {
  if (process.versions.bun) return null;
  try {
    const packagesDir = fileURLToPath(new URL('../../..', import.meta.url));
    return fs.existsSync(path.join(packagesDir, 'api-server', 'package.json')) ? packagesDir : null;
  } catch {
    return null;
  }
}

/**
 * Make sure the guest api-server binary (and console bundle, best
 * effort) are staged for the VM engine to embed. Idempotent and
 * version-stamped: a matching stamp short-circuits. Set
 * APPLIANCE_REBUILD_API_SERVER=1 to force a restage (repo iteration).
 */
export async function ensureApiServerArtifacts(options: { allowUnsigned?: boolean } = {}): Promise<void> {
  const force = process.env.APPLIANCE_REBUILD_API_SERVER === '1';
  let override = process.env.APPLIANCE_API_SERVER_BINARY;
  if (override && !fs.existsSync(override)) {
    // A stale export in a shell profile must not brick bring-up when
    // valid staged artifacts (or the repo/release paths) can serve —
    // warn loudly and proceed as if the override were unset.
    console.warn(
      chalk.yellow(
        `APPLIANCE_API_SERVER_BINARY points at a missing file (${override}) — ignoring the override; ` +
          'staging falls back to the repo build or the release download.'
      )
    );
    override = undefined;
  }
  // Release/repo staging is keyed by the SDK version, but an override
  // binary changes without a version bump (desktop dev builds), so its
  // stamp carries the source file's identity instead — a matching
  // VERSION stamp must not keep an older staged binary in place.
  const stamp = override ? overrideStamp(override) : `${VERSION}:${GUEST_ARCH}`;
  const packagesDir = override ? null : repoPackagesDir();
  if (!force && fs.existsSync(stagedBinaryPath())) {
    try {
      // A published release is re-fetched and re-verified before every boot.
      // Repo/override dev sources retain the fast identity-stamp path.
      if (fs.readFileSync(versionStampPath(), 'utf8').trim() === stamp && (override || packagesDir)) return;
    } catch {
      // no stamp — restage
    }
  }

  ensurePrivateDirectory(guestAssetsDir());

  if (override) {
    console.log(chalk.cyan(`» staging api-server guest binary from ${override}`));
    atomicStageFile(stagedBinaryPath(), fs.readFileSync(override));
    // Console bundle: staged when a tarball ships next to the override
    // binary; the API serves headless without it. No sibling means the
    // override build carries no console — keeping a previously staged
    // tarball would pair an old web console with the new server (the
    // exact skew this module exists to prevent), so drop it.
    const consoleTar = overrideConsolePath(override);
    if (fs.existsSync(consoleTar)) {
      atomicStageFile(stagedConsolePath(), fs.readFileSync(consoleTar));
      console.log(chalk.dim('staged web console bundle'));
    } else {
      fs.rmSync(stagedConsolePath(), { force: true });
      console.log(chalk.dim('no console bundle next to the override binary — the VM serves API only'));
    }
    clearReleaseEvidence();
    atomicStageFile(versionStampPath(), Buffer.from(stamp));
    return;
  }

  if (packagesDir) {
    await stageFromRepo(packagesDir);
  } else {
    await stageFromRelease({ allowUnsigned: options.allowUnsigned });
  }
  atomicStageFile(versionStampPath(), Buffer.from(stamp));
}

/** The console tarball the desktop's dev staging ships next to the
 *  override binary. */
function overrideConsolePath(override: string): string {
  return path.join(path.dirname(override), 'appliance-console.tar.gz');
}

/** Size+mtime identify an override build, so a changed override
 *  restages while an unchanged one still short-circuits. The sibling
 *  console tarball's identity (or absence) is folded in so a
 *  console-only rebuild — same binary, new tarball — restages too. */
function overrideStamp(override: string): string {
  const st = fs.statSync(override);
  let consolePart = 'no-console';
  try {
    const ct = fs.statSync(overrideConsolePath(override));
    consolePart = `${ct.size}:${Math.floor(ct.mtimeMs)}`;
  } catch {
    // no sibling tarball — the stamp records its absence, so adding
    // one later restages
  }
  return `override:${GUEST_ARCH}:${st.size}:${Math.floor(st.mtimeMs)}:${consolePart}`;
}

async function stageFromRepo(packagesDir: string): Promise<void> {
  const apiServerDir = path.join(packagesDir, 'api-server');
  const prebuilt = path.join(apiServerDir, 'dist', 'guest', `appliance-api-server-linux-${GUEST_ARCH}`);

  if (!fs.existsSync(prebuilt) || process.env.APPLIANCE_REBUILD_API_SERVER === '1') {
    console.log(chalk.cyan(`» compiling api-server guest binary (linux-${GUEST_ARCH}, bun)`));
    const r = spawnSync(
      'bun',
      ['build', 'src/main.ts', '--compile', `--target=bun-linux-${GUEST_ARCH}-musl`, `--outfile=${prebuilt}`],
      { cwd: apiServerDir, stdio: 'inherit' }
    );
    if (r.status !== 0) {
      throw new Error(
        'could not compile the api-server guest binary. Install bun (https://bun.sh) and retry, ' +
          `or run \`pnpm --filter @appliance.sh/api-server compile:guest-${GUEST_ARCH}\` and try again, ` +
          'or point APPLIANCE_API_SERVER_BINARY at a prebuilt linux binary.'
      );
    }
  }
  atomicStageFile(stagedBinaryPath(), fs.readFileSync(prebuilt));
  console.log(chalk.dim(`staged api-server guest binary (${prebuilt})`));

  // Console bundle: best-effort — the API serves headless without it.
  const consoleDist = path.join(packagesDir, 'console', 'dist');
  if (fs.existsSync(path.join(consoleDist, 'index.html'))) {
    const temporaryConsole = `${stagedConsolePath()}.${process.pid}.archive.tmp`;
    await tarGzDirectory(consoleDist, temporaryConsole);
    const consoleBytes = fs.readFileSync(temporaryConsole);
    fs.rmSync(temporaryConsole, { force: true });
    atomicStageFile(stagedConsolePath(), consoleBytes);
    console.log(chalk.dim('staged web console bundle'));
  } else {
    console.log(
      chalk.dim('console bundle not built (pnpm --filter @appliance.sh/console build) — the VM serves API only')
    );
  }
  clearReleaseEvidence();
}

export interface StageFromReleaseOptions {
  version?: string;
  arch?: 'x64' | 'arm64';
  fetcher?: typeof fetch;
  releaseBase?: string;
  destinationDir?: string;
  trust?: ReleaseTrustPolicy;
  now?: Date;
  highestGeneration?: number;
  allowUnsigned?: boolean;
  cliVersion?: string;
}

/** Download and verify every release byte before the first staging write. */
export async function stageFromRelease(options: StageFromReleaseOptions = {}): Promise<void> {
  const version = (options.version ?? VERSION).replace(/^v/, '');
  const arch = options.arch ?? GUEST_ARCH;
  const fetcher = options.fetcher ?? fetch;
  const base = `${options.releaseBase ?? RELEASE_BASE}/v${version}`;
  const destination = options.destinationDir ?? guestAssetsDir();
  const releaseName = `control-plane release v${version}`;
  let payloadResponse: Response;
  let signatureResponse: Response;
  try {
    [payloadResponse, signatureResponse] = await Promise.all([
      releaseFetch(fetcher, `${base}/control-plane-release.json`),
      releaseFetch(fetcher, `${base}/control-plane-release.sig.json`),
    ]);
  } catch (cause) {
    throw new Error(`${releaseName} metadata download failed; no guest assets were written: ${errorDetail(cause)}`);
  }

  if (!payloadResponse.ok || !signatureResponse.ok) {
    if (!options.allowUnsigned) {
      throw new Error(
        `${releaseName} is unsigned (pre-MV0 release); refusing to stage it before writing any guest assets`
      );
    }
    const cliVersion = options.cliVersion ?? VERSION;
    if (isReleaseBuild(cliVersion)) {
      throw new Error(`--allow-unsigned is refused by release build ${cliVersion}; ${releaseName} was not staged`);
    }
    console.warn(
      chalk.bgRed.white.bold(
        ` WARNING: UNSIGNED DEV STAGING ENABLED for ${releaseName}; authenticity and rollback protection are disabled `
      )
    );
    await stageUnsignedRelease(base, version, arch, destination, fetcher);
    return;
  }

  let rawPayload: unknown;
  let rawEnvelope: unknown;
  try {
    rawPayload = JSON.parse(await payloadResponse.text());
    rawEnvelope = JSON.parse(await signatureResponse.text());
  } catch {
    throw new Error(`${releaseName} has malformed signed metadata; no guest assets were written`);
  }
  let verified;
  try {
    verified = await verifyReleaseEnvelope(rawPayload, rawEnvelope, options.trust ?? PINNED_RELEASE_TRUST, {
      now: options.now,
      highestGeneration: options.highestGeneration ?? stagedHighestGeneration(destination),
    });
  } catch (cause) {
    throw new Error(
      `${releaseName} signature verification failed; no guest assets were written: ${errorDetail(cause)}`
    );
  }
  if (verified.payload.version !== version) {
    throw new Error(
      `${releaseName} metadata names version ${verified.payload.version}; refusing cross-version staging before writing`
    );
  }
  const binaryName = `appliance-api-server-linux-${arch}` as const;
  const binary = releaseArtifact(verified.payload.artifacts, binaryName, arch, releaseName);
  const consoleArtifact = releaseArtifact(verified.payload.artifacts, 'appliance-console.tar.gz', 'any', releaseName);
  console.log(chalk.cyan(`» downloading verified api-server guest assets (${releaseName}, ${arch})`));
  const [binaryBytes, consoleBytes] = await Promise.all([
    fetchArtifact(fetcher, `${base}/${binary.name}`, binary, releaseName),
    fetchArtifact(fetcher, `${base}/${consoleArtifact.name}`, consoleArtifact, releaseName),
  ]);

  // Everything above is in memory and verified. Only now may staging mutate.
  ensurePrivateDirectory(destination);
  atomicStageFile(path.join(destination, 'appliance-api-server'), binaryBytes);
  atomicStageFile(path.join(destination, 'appliance-console.tar.gz'), consoleBytes);
  const checksums = `${binary.sha256}  appliance-api-server\n${consoleArtifact.sha256}  appliance-console.tar.gz\n`;
  atomicStageFile(path.join(destination, 'appliance-api-server.sha256'), Buffer.from(checksums));
  atomicStageFile(
    path.join(destination, 'control-plane-release.json'),
    Buffer.from(`${JSON.stringify(verified.payload)}\n`)
  );
  atomicStageFile(
    path.join(destination, 'control-plane-release.sig.json'),
    Buffer.from(`${JSON.stringify(verified.envelope)}\n`)
  );
  console.log(chalk.dim(`staged release signed by keyId ${verified.envelope.keyId}`));
}

export function isReleaseBuild(version: string = VERSION): boolean {
  const normalized = version.replace(/^v/, '');
  return !normalized.startsWith('0.0.0') && !normalized.includes('-dev');
}

function releaseArtifact(
  artifacts: ReleaseArtifact[],
  name: ReleaseArtifact['name'],
  arch: ReleaseArtifact['arch'],
  releaseName: string
): ReleaseArtifact {
  const artifact = artifacts.find((candidate) => candidate.name === name);
  if (!artifact || artifact.arch !== arch) {
    throw new Error(`${releaseName} does not bind ${name} to architecture ${arch}; no guest assets were written`);
  }
  return artifact;
}

async function stageUnsignedRelease(
  base: string,
  version: string,
  arch: 'x64' | 'arm64',
  destination: string,
  fetcher: typeof fetch
): Promise<void> {
  const releaseName = `unsigned control-plane release v${version}`;
  const binaryName = `appliance-api-server-linux-${arch}`;
  const [binaryResponse, consoleResponse] = await Promise.all([
    releaseFetch(fetcher, `${base}/${binaryName}`),
    releaseFetch(fetcher, `${base}/appliance-console.tar.gz`),
  ]);
  if (!binaryResponse.ok) throw new Error(`${releaseName} binary download failed: HTTP ${binaryResponse.status}`);
  const binary = Buffer.from(await binaryResponse.arrayBuffer());
  if (binary.length === 0) throw new Error(`${releaseName} binary is empty`);
  const consoleBytes = consoleResponse.ok ? Buffer.from(await consoleResponse.arrayBuffer()) : null;
  ensurePrivateDirectory(destination);
  atomicStageFile(path.join(destination, 'appliance-api-server'), binary);
  if (consoleBytes?.length) atomicStageFile(path.join(destination, 'appliance-console.tar.gz'), consoleBytes);
  else fs.rmSync(path.join(destination, 'appliance-console.tar.gz'), { force: true });
  for (const file of ['control-plane-release.json', 'control-plane-release.sig.json', 'appliance-api-server.sha256']) {
    fs.rmSync(path.join(destination, file), { force: true });
  }
}

async function fetchArtifact(
  fetcher: typeof fetch,
  url: string,
  artifact: ReleaseArtifact,
  releaseName: string
): Promise<Buffer> {
  const response = await releaseFetch(fetcher, url);
  if (!response.ok) throw new Error(`${releaseName} asset ${artifact.name} download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== artifact.size || digest !== artifact.sha256) {
    throw new Error(
      `${releaseName} asset ${artifact.name} failed signed size/SHA-256 verification (expected ${artifact.size}/${artifact.sha256}, got ${bytes.length}/${digest}); no guest assets were written`
    );
  }
  return bytes;
}

function releaseFetch(fetcher: typeof fetch, url: string): Promise<Response> {
  return fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
}

function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function stagedHighestGeneration(directory: string): number | undefined {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(directory, 'control-plane-release.json'), 'utf8')) as {
      generation?: unknown;
    };
    return typeof payload.generation === 'number' && Number.isSafeInteger(payload.generation) && payload.generation >= 0
      ? payload.generation
      : undefined;
  } catch {
    return undefined;
  }
}

function clearReleaseEvidence(): void {
  for (const file of [releasePayloadPath(), releaseSignaturePath(), releaseChecksumsPath()]) {
    fs.rmSync(file, { force: true });
  }
}

function hardenStagedFile(file: string): void {
  fs.chmodSync(file, 0o444);
  restrictWindowsAcl(file);
}

function atomicStageFile(file: string, bytes: Uint8Array): void {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
  hardenStagedFile(temporary);
  fs.rmSync(file, { force: true });
  fs.renameSync(temporary, file);
  hardenStagedFile(file);
}

function tarGzDirectory(dir: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(dest);
    const archive = archiver('tar', { gzip: true });
    output.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(dir, false);
    void archive.finalize();
  });
}
