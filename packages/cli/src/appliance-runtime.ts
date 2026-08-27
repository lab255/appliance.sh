import chalk from 'chalk';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { ApplianceV2 } from '@appliance.sh/sdk';
import { loadRuntimeBundle, unpackRuntimeBundle } from './appliance-runtime-bundle.js';
import { runVm } from './utils/microvm-up.js';
import { runVmCapture } from './utils/sandbox.js';
import {
  readRuntimeRegistry,
  removeRuntimeRecord,
  runtimeRoot,
  updateRuntimeRecord,
  upsertRuntimeRecord,
  writeRuntimeRegistry,
  type RuntimeHostPort,
  type RuntimeRecord,
} from './utils/runtime-registry.js';

export const RUNTIME_POOL_VM = 'appliance-runtime';

export interface RuntimePlan {
  appId: string;
  version: string;
  principalIp: string;
  uid: number;
  share: { tag: string; hostPath: string; readOnly: true };
  imagePath: string;
  env: Record<string, string>;
  ports: Array<RuntimeHostPort & { relay: number; target: string }>;
  resources: { cpus: number; memoryMib: number; diskGib: number; pids: number };
}

export function manifestToRuntimePlan(
  manifest: ApplianceV2,
  installDir: string,
  principalIp: string,
  uid: number,
  hostPorts: RuntimeHostPort[]
): RuntimePlan {
  if (manifest.type !== 'container') throw new Error(`${manifest.type} runnable bundles are not yet supported`);
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  const target = manifest.payload.images[platform];
  if (!target) throw new Error(`bundle has no payload for host runtime platform ${platform}`);
  const requested = manifest.resources ?? {};
  const ports = manifest.ports ?? [];
  const published = ports.filter((port) => port.expose === 'host');
  if (published.some((port) => port.protocol !== 'tcp')) throw new Error('UDP published ports are not yet supported');
  if (hostPorts.length !== published.length) throw new Error('host port allocation does not match manifest');
  const shareTag = `ap-${createHash('sha256').update(`${manifest.name}/payload`).digest('hex').slice(0, 32)}`;
  return {
    appId: manifest.name,
    version: manifest.version,
    principalIp,
    uid,
    share: { tag: shareTag, hostPath: installDir, readOnly: true },
    imagePath: target.path,
    env: manifest.env,
    ports: published.map((port, index) => ({
      ...hostPorts[index],
      relay: 22000 + uid - 20000 + index,
      target: principalIp,
    })),
    resources: {
      cpus: requested.cpus ?? 1,
      memoryMib: requested.memoryMib ?? 512,
      diskGib: requested.diskGib ?? 2,
      pids: 256,
    },
  };
}

export async function runRuntimeCommand(verb: string, args: string[]): Promise<void> {
  switch (verb) {
    case 'run':
      await runtimeRun(args);
      return;
    case 'ps':
      runtimePs(args);
      return;
    case 'stop':
      runtimeStop(args);
      return;
    case 'logs':
      await runtimeLogs(args);
      return;
    default: {
      const { runRuntimeStub } = await import('./appliance-runtime-stub.js');
      runRuntimeStub(verb, args.some((arg) => arg === '--help' || arg === '-h'));
    }
  }
}

async function runtimeRun(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: appliance runtime run <path-to-app.appliance.zip>');
    console.log('Runs one container-type bundle in the pooled appliance-runtime VM; Ctrl-C stops the app.');
    return;
  }
  const input = args.find((arg) => !arg.startsWith('-'));
  if (!input) fail('Usage: appliance runtime run <path-to-app.appliance.zip>', 2);
  if (/^https?:\/\//.test(input)) fail('runtime run URLs are not yet supported; download the bundle and pass a local path', 2);
  const bundlePath = path.resolve(input);
  let loaded: ReturnType<typeof loadRuntimeBundle>;
  try {
    loaded = loadRuntimeBundle(bundlePath);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 2);
  }
  if (loaded.manifest.type !== 'container') {
    fail(`${loaded.manifest.type} runnable bundle '${loaded.manifest.name}' is not yet supported`, 2);
  }
  const existing = readRuntimeRegistry().find((entry) => entry.appId === loaded.manifest.name);
  if (existing && (existing.state === 'starting' || existing.state === 'running')) {
    fail(`runtime instance '${existing.appId}' is already running in ${existing.poolVm}`, 2);
  }

  const installDir = path.join(runtimeRoot(), 'apps', loaded.manifest.name, loaded.manifest.version);
  console.log(chalk.cyan(`» validating and unpacking ${path.basename(bundlePath)}`));
  unpackRuntimeBundle(bundlePath, installDir, loaded);
  const records = readRuntimeRegistry().filter((entry) => entry.appId !== loaded.manifest.name);
  const principalIp = allocatePrincipalIp(records);
  const uid = allocateUid(records);
  const hostPorts = await allocatePublishedPorts(loaded.manifest, records);
  let plan: RuntimePlan;
  try {
    plan = manifestToRuntimePlan(loaded.manifest, installDir, principalIp, uid, hostPorts);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 2);
  }

  const now = new Date().toISOString();
  const record: RuntimeRecord = {
    appId: plan.appId,
    version: plan.version,
    state: 'starting',
    principalIp,
    hostPorts,
    startedAt: now,
    updatedAt: now,
    poolVm: RUNTIME_POOL_VM,
    poolRestartPending: false,
    bundlePath,
    installDir,
    shareTag: plan.share.tag,
    uid,
  };
  upsertRuntimeRecord(record);

  console.log(chalk.cyan('» reconciling the pooled appliance-runtime VM (2 vCPU / 4096 MiB)'));
  const prepared = vmJson(['runtime', 'prepare', RUNTIME_POOL_VM, JSON.stringify(plan)]);
  const restartRequired = Boolean(prepared.restartRequired);
  if (restartRequired) {
    updateRuntimeRecord(plan.appId, { poolRestartPending: true });
    console.log(chalk.yellow('pool restart required to attach the app\'s boot-time VirtioFS share; running apps will pause'));
    const stop = runVm(['stop', RUNTIME_POOL_VM]);
    if (stop !== 0) fail(`could not stop ${RUNTIME_POOL_VM} for share reconciliation`, 1);
  }
  const up = runVm(['up', RUNTIME_POOL_VM, '--runtime', '--timeout', '900']);
  if (up !== 0) {
    updateRuntimeRecord(plan.appId, { state: 'failed', poolRestartPending: restartRequired });
    fail(`pooled VM '${RUNTIME_POOL_VM}' failed to become core-ready`, 1);
  }
  const started = vmJson(['runtime', 'start', RUNTIME_POOL_VM, JSON.stringify(plan)]);
  if (started.state !== 'running') {
    updateRuntimeRecord(plan.appId, { state: 'failed', exitCode: numberOrUndefined(started.exitCode) });
    fail(`runtime supervisor did not start '${plan.appId}': ${String(started.message ?? 'unknown error')}`, 1);
  }
  updateRuntimeRecord(plan.appId, { state: 'running', poolRestartPending: false });
  for (const port of hostPorts) {
    console.log(`${chalk.green('✓')} ${port.name}: http://127.0.0.1:${port.host} → ${principalIp}:${port.guest}/tcp`);
  }
  console.log(chalk.dim(`streaming ${plan.appId} logs; Ctrl-C stops the app but leaves ${RUNTIME_POOL_VM} running`));

  let stopping = false;
  const stopOnSignal = () => {
    if (stopping) return;
    stopping = true;
    console.log();
    runtimeStop([plan.appId], false);
    process.exit(130);
  };
  process.once('SIGINT', stopOnSignal);
  try {
    await followLogs(plan.appId, true);
  } finally {
    process.removeListener('SIGINT', stopOnSignal);
  }
}

function runtimePs(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: appliance runtime ps [--json]');
    return;
  }
  const json = args.includes('--json');
  const kept: RuntimeRecord[] = [];
  for (const record of readRuntimeRegistry()) {
    const status = vmJson(['runtime', 'status', record.poolVm, record.appId], true);
    if (status.state === 'missing') continue;
    const state = status.state === 'running' ? 'running' : status.state === 'exited' ? 'exited' : record.state;
    const updated: RuntimeRecord = {
      ...record,
      state,
      exitCode: numberOrUndefined(status.exitCode) ?? record.exitCode,
      updatedAt: new Date().toISOString(),
    };
    kept.push(updated);
  }
  // ps owns stale pruning: only entries the guest still recognizes survive.
  writeRuntimeRegistry(kept);
  if (json) {
    console.log(JSON.stringify(kept, null, 2));
    return;
  }
  if (kept.length === 0) {
    console.log('No runtime apps.');
    return;
  }
  console.log('APP\tVERSION\tSTATE\tPRINCIPAL\tPORTS\tUPTIME\tPOOL');
  for (const record of kept) {
    const state = record.state === 'exited' ? `exited (${record.exitCode ?? '?'})` : record.state;
    const ports = record.hostPorts.map((port) => `${port.name}=127.0.0.1:${port.host}->${port.guest}`).join(',') || '-';
    const pending = record.poolRestartPending ? ' · pool restart pending' : '';
    console.log(
      `${record.appId}\t${record.version}\t${state}\t${record.principalIp}\t${ports}\t${formatUptime(record.startedAt)}\t${record.poolVm}${pending}`
    );
  }
}

function runtimeStop(args: string[], print = true): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: appliance runtime stop <app>');
    return;
  }
  const appId = args.find((arg) => !arg.startsWith('-'));
  if (!appId) fail('Usage: appliance runtime stop <app>', 2);
  const record = readRuntimeRegistry().find((entry) => entry.appId === appId);
  if (!record) fail(`runtime app '${appId}' is not registered`, 2);
  const result = vmJson(['runtime', 'stop', record.poolVm, appId], true);
  if (result.state !== 'stopped' && result.state !== 'missing') fail(`failed to stop '${appId}'`, 1);
  removeRuntimeRecord(appId);
  if (print) console.log(`${chalk.green('✓')} stopped ${appId}; pooled VM ${record.poolVm} remains running`);
}

async function runtimeLogs(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: appliance runtime logs <app> [-f|--follow]');
    return;
  }
  const appId = args.find((arg) => !arg.startsWith('-'));
  if (!appId) fail('Usage: appliance runtime logs <app> [-f|--follow]', 2);
  if (!readRuntimeRegistry().some((entry) => entry.appId === appId)) fail(`runtime app '${appId}' is not registered`, 2);
  await followLogs(appId, args.includes('-f') || args.includes('--follow'));
}

async function followLogs(appId: string, follow: boolean): Promise<void> {
  let seen = '';
  for (;;) {
    const record = readRuntimeRegistry().find((entry) => entry.appId === appId);
    if (!record) return;
    const logs = runVmCapture(['runtime', 'logs', record.poolVm, appId]);
    if (logs.status === 0) {
      const next = logs.stdout;
      const delta = next.startsWith(seen) ? next.slice(seen.length) : next;
      if (delta) process.stdout.write(delta + (delta.endsWith('\n') ? '' : '\n'));
      seen = next;
    }
    const status = vmJson(['runtime', 'status', record.poolVm, appId], true);
    if (status.state === 'exited') {
      const exitCode = numberOrUndefined(status.exitCode) ?? 1;
      updateRuntimeRecord(appId, { state: 'exited', exitCode });
      if (follow) console.log(chalk.yellow(`${appId} exited (${exitCode})`));
      return;
    }
    if (!follow) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function allocatePublishedPorts(manifest: ApplianceV2, records: RuntimeRecord[]): Promise<RuntimeHostPort[]> {
  if (manifest.type !== 'container') return [];
  const requested = (manifest.ports ?? []).filter((port) => port.expose === 'host');
  const used = new Set(records.flatMap((record) => record.hostPorts.map((port) => port.host)));
  const result: RuntimeHostPort[] = [];
  for (const port of requested) {
    if (port.protocol !== 'tcp') fail(`port '${port.name}' uses unsupported protocol ${port.protocol}`, 2);
    let selected: number | undefined;
    for (let candidate = 20000; candidate <= 29999; candidate += 1) {
      if (!used.has(candidate) && (await portIsFree(candidate))) {
        selected = candidate;
        break;
      }
    }
    if (!selected) fail('no free runtime host port in 20000-29999', 1);
    used.add(selected);
    result.push({ name: port.name, host: selected, guest: port.guest, protocol: 'tcp' });
  }
  return result;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function allocatePrincipalIp(records: RuntimeRecord[]): string {
  const used = new Set(records.map((entry) => entry.principalIp));
  for (let leaf = 10; leaf <= 239; leaf += 1) {
    const ip = `192.168.127.${leaf}`;
    if (!used.has(ip)) return ip;
  }
  throw new Error('runtime principal address pool is exhausted');
}

function allocateUid(records: RuntimeRecord[]): number {
  const used = new Set(records.map((entry) => entry.uid));
  for (let uid = 20000; uid <= 20239; uid += 1) if (!used.has(uid)) return uid;
  throw new Error('runtime principal UID pool is exhausted');
}

function vmJson(args: string[], tolerateFailure = false): Record<string, unknown> {
  const result = runVmCapture(args);
  if (result.status !== 0) {
    if (tolerateFailure) return { state: 'missing' };
    fail(`appliance-vm ${args.slice(0, 2).join(' ')} failed`, 1);
  }
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    if (tolerateFailure) return { state: 'missing' };
    fail('runtime engine returned malformed JSON', 1);
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatUptime(startedAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function fail(message: string, code: number): never {
  console.error(chalk.red(message));
  process.exit(code);
}
