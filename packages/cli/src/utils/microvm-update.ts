import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  PINNED_RELEASE_TRUST,
  VERSION,
  verifyReleaseEnvelope,
  type ReleaseArtifact,
  type ReleaseTrustPolicy,
} from '@appliance.sh/sdk';
import { guestAssetsDir, stageFromRelease } from './api-server-artifact.js';
import { readVmPorts, vmBinary } from './microvm-up.js';

const DISABLED = 'self-update disabled until the production key is pinned (AP-226)';

export interface MicroVmSwapRequest {
  name: string;
  stageDir: string;
  binary: ReleaseArtifact;
  console: ReleaseArtifact;
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
}

export interface MicroVmUpdateResult {
  oldVersion: string;
  newVersion: string;
  keyId: string;
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
      const result = spawnSync(vmBinary(), ['control-plane-capability', name], { encoding: 'utf8' });
      return { ok: result.status === 0, detail: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
    },
    async runningVersion(name) {
      try {
        const port = readVmPorts(name).hostPort;
        const response = await fetcher(`http://api.appliance.localhost:${port}/bootstrap/status`);
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
      const result = spawnSync(vmBinary(), args, { encoding: 'utf8' });
      return { ok: result.status === 0, detail: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
    },
  };
}

export async function updateMicroVm(options: MicroVmUpdateOptions): Promise<MicroVmUpdateResult> {
  const trust = options.trust ?? PINNED_RELEASE_TRUST;
  const keyIds = Object.keys(trust.keys);
  if (keyIds.length === 0) throw new Error(DISABLED);
  if (keyIds.length !== 1) throw new Error('self-update requires exactly one active pinned release key');

  const version = (options.version ?? VERSION).replace(/^v/, '');
  const arch = options.arch ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
  const destination = options.destinationDir ?? guestAssetsDir();
  await stageFromRelease({
    version,
    arch,
    destinationDir: destination,
    fetcher: options.fetcher,
    trust,
    now: options.now,
  });

  const verified = await verifyReleaseEnvelope(
    JSON.parse(fs.readFileSync(path.join(destination, 'control-plane-release.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(destination, 'control-plane-release.sig.json'), 'utf8')),
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
  verifyFile(path.join(destination, 'appliance-api-server'), binary);
  verifyFile(path.join(destination, 'appliance-console.tar.gz'), console);

  // Only after every signed byte is verified do we touch the running VM.
  const transport = options.transport ?? defaultMicroVmUpdateTransport(options.fetcher);
  const capability = await transport.capability(options.name);
  if (!capability.ok) {
    throw new Error(
      `VM '${options.name}' predates in-place update. Restage and reboot it with ` +
        `\`appliance vm stop --name ${options.name} && appliance vm up --name ${options.name} --cluster\`.`
    );
  }
  const oldVersion = (await transport.runningVersion(options.name)) ?? 'unknown';
  const swap = await transport.swap({ name: options.name, stageDir: destination, binary, console });
  if (!swap.ok) throw new Error(`microVM control-plane update rolled back: ${swap.detail}`);
  const running = (await transport.runningVersion(options.name)) ?? version;
  if (running.replace(/^v/, '') !== version) {
    throw new Error(`guest reported update success but is running ${running}, expected ${version}`);
  }
  return { oldVersion, newVersion: version, keyId: verified.envelope.keyId };
}
