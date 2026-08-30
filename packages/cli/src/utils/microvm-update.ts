import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { VERSION, verifyReleaseEnvelope, type ReleaseArtifact, type ReleaseTrustPolicy } from '@appliance.sh/sdk';
import {
  guestAssetsDir,
  publishOfflineVerifiedRelease,
  releaseTrustFromEnvironment,
  stageFromRelease,
} from './api-server-artifact.js';
import { ensurePrivateDirectory, restrictWindowsAcl } from './fs-acl.js';
import { readVmPorts, vmBinary } from './microvm-up.js';

const PROCESS_TIMEOUT_MS = 180_000;

export interface MicroVmSwapRequest {
  name: string;
  stageDir: string;
  binary: ReleaseArtifact;
  console: ReleaseArtifact;
  onSwapStart?: () => void;
}

export interface MicroVmUpdateTransport {
  capability(name: string): Promise<{ ok: boolean; detail: string }>;
  runningVersion(name: string): Promise<string | null>;
  swap(request: MicroVmSwapRequest): Promise<{ ok: boolean; detail: string }>;
}

export interface MicroVmUpdateOptions {
  name: string;
  version?: string;
  arch?: 'x64' | 'arm64';
  fetcher?: typeof fetch;
  trust?: ReleaseTrustPolicy;
  now?: Date;
  destinationDir?: string;
  transport?: MicroVmUpdateTransport;
  onPhase?: (phase: MicroVmUpdatePhase) => void;
}

export type MicroVmUpdatePhase =
  | 'checking VM capability'
  | 'downloading'
  | 'verifying signature'
  | 'shipping artifacts'
  | 'swapping + health check';

export interface MicroVmUpdateResult {
  oldVersion: string;
  newVersion: string;
  keyId: string;
  alreadyAt: boolean;
}

function artifact(payload: { artifacts: ReleaseArtifact[] }, name: ReleaseArtifact['name']): ReleaseArtifact {
  const found = payload.artifacts.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`signed release is missing ${name}`);
  return found;
}

function verifyFile(file: string, expected: ReleaseArtifact): void {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size !== expected.size) {
    throw new Error(`${expected.name} changed after signed staging (expected ${expected.size} bytes)`);
  }
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== expected.sha256) {
    throw new Error(`${expected.name} changed after signed staging (sha256 mismatch)`);
  }
}

function highWater(directory: string): number | undefined {
  try {
    const value = Number.parseInt(fs.readFileSync(path.join(directory, 'release-generation.high-water'), 'utf8'), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function defaultMicroVmUpdateTransport(fetcher: typeof fetch = fetch): MicroVmUpdateTransport {
  return {
    async capability(name) {
      const result = spawnSync(vmBinary(), ['control-plane-capability', name], {
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT_MS,
      });
      return { ok: result.status === 0, detail: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
    },
    async runningVersion(name) {
      try {
        const port = readVmPorts(name).hostPort;
        const response = await fetcher(`http://api.appliance.localhost:${port}/bootstrap/status`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { serverVersion?: unknown };
        return typeof body.serverVersion === 'string' ? body.serverVersion.replace(/^v/, '') : null;
      } catch {
        return null;
      }
    },
    async swap(request) {
      const args = [
        'control-plane-update',
        request.name,
        '--stage',
        request.stageDir,
        '--binary-sha256',
        request.binary.sha256,
        '--binary-size',
        String(request.binary.size),
        '--console-sha256',
        request.console.sha256,
        '--console-size',
        String(request.console.size),
      ];
      request.onSwapStart?.();
      const result = spawnSync(vmBinary(), args, { encoding: 'utf8', timeout: PROCESS_TIMEOUT_MS });
      return { ok: result.status === 0, detail: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
    },
  };
}

export async function updateMicroVm(options: MicroVmUpdateOptions): Promise<MicroVmUpdateResult> {
  const trust = options.trust ?? releaseTrustFromEnvironment();
  const keyIds = Object.keys(trust.keys);
  if (keyIds.length === 0) {
    throw new Error(
      `in-place update is disabled until the production release key is pinned — restart the Dev Machine to pick up ` +
        `the staged release: \`appliance vm stop --name ${options.name} && appliance vm up --name ${options.name} --cluster\``
    );
  }
  if (keyIds.length !== 1) throw new Error('self-update requires exactly one active pinned release key');

  const version = (options.version ?? VERSION).replace(/^v/, '');
  const arch = options.arch ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
  const destination = options.destinationDir ?? guestAssetsDir();
  const transport = options.transport ?? defaultMicroVmUpdateTransport(options.fetcher);
  options.onPhase?.('checking VM capability');
  const capability = await transport.capability(options.name);
  if (!capability.ok) {
    throw new Error(
      `VM '${options.name}' predates in-place update. Restage and reboot it with ` +
        `\`appliance vm stop --name ${options.name} && appliance vm up --name ${options.name} --cluster\`.`
    );
  }
  const oldVersion = (await transport.runningVersion(options.name)) ?? 'unknown';

  const stagingRoot = path.join(path.dirname(destination), '.control-plane-update-staging');
  ensurePrivateDirectory(stagingRoot);
  const stage = fs.mkdtempSync(path.join(stagingRoot, 'release-'));
  restrictWindowsAcl(stage, { directory: true });
  try {
    await stageFromRelease({
      version,
      arch,
      destinationDir: stage,
      fetcher: options.fetcher,
      trust,
      now: options.now,
      highestGeneration: highWater(destination),
      onPhase: (phase) => options.onPhase?.(phase),
    });

    const verified = await verifyReleaseEnvelope(
      JSON.parse(fs.readFileSync(path.join(stage, 'control-plane-release.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(stage, 'control-plane-release.sig.json'), 'utf8')),
      trust,
      { now: options.now, highestGeneration: highWater(destination) }
    );
    if (verified.payload.version !== version) {
      throw new Error(`signed release version ${verified.payload.version} does not match requested ${version}`);
    }
    const binary = artifact(verified.payload, `appliance-api-server-linux-${arch}`);
    const console = artifact(verified.payload, 'appliance-console.tar.gz');
    if (binary.arch !== arch || console.arch !== 'any') {
      throw new Error(`signed release architecture does not match this ${arch} host`);
    }
    verifyFile(path.join(stage, 'appliance-api-server'), binary);
    verifyFile(path.join(stage, 'appliance-console.tar.gz'), console);

    options.onPhase?.('shipping artifacts');
    const swap = await transport.swap({
      name: options.name,
      stageDir: stage,
      binary,
      console,
      onSwapStart: () => options.onPhase?.('swapping + health check'),
    });
    if (!swap.ok) {
      throw new Error(
        `update rolled back — the previous control plane (v${oldVersion}) is still running and serving: ${swap.detail}`
      );
    }
    const running = await transport.runningVersion(options.name);
    if (!running) throw new Error(`guest reported update success but its running version could not be confirmed`);
    if (running.replace(/^v/, '') !== version) {
      throw new Error(`guest reported update success but is running ${running}, expected ${version}`);
    }
    await publishOfflineVerifiedRelease({
      sourceDir: stage,
      destinationDir: destination,
      version,
      arch,
      trust,
      now: options.now,
      highestGeneration: highWater(destination),
    });
    return {
      oldVersion,
      newVersion: version,
      keyId: verified.envelope.keyId,
      alreadyAt: swap.detail.split(/\r?\n/u).some((line) => line.trim().startsWith('already at ')),
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function microVmSelfUpdateEnabled(trust: ReleaseTrustPolicy = releaseTrustFromEnvironment()): boolean {
  return Object.keys(trust.keys).length > 0;
}
