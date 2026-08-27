import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { ApplianceV2 } from '@appliance.sh/sdk';
import { ensurePooledRuntime, runVm, vmBinary, vmDir } from './utils/microvm-up.js';
import { runVmCapture } from './utils/sandbox.js';
import { computeBundleDigest } from './utils/bundle-digest.js';
import { readBundleManifest, unpackBundle, verifyBundle, type VerifyBundleResult } from './utils/bundle-read.js';
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

type LoadedRuntimeBundle = VerifyBundleResult;

export interface EffectiveRuntimePolicy {
  version: 1;
  app: string;
  vm: string;
  principal: string;
  source: string;
  policy: { default: 'deny'; allow: string[]; deny: []; mitm: false };
  allowPorts: Record<string, number[]>;
}

export function manifestToRuntimePolicy(manifest: ApplianceV2, principalIp: string): EffectiveRuntimePolicy {
  const allowed = new Map<string, Set<number>>();
  for (const rule of manifest.network?.egress ?? []) {
    const host = rule.host.startsWith('*.') ? rule.host.slice(2) : rule.host;
    const ports = allowed.get(host) ?? new Set<number>();
    for (const port of rule.ports) ports.add(port);
    allowed.set(host, ports);
  }
  const allow = [...allowed.keys()].sort();
  return {
    version: 1,
    app: manifest.name,
    vm: RUNTIME_POOL_VM,
    principal: manifest.name,
    source: principalIp,
    policy: { default: 'deny', allow, deny: [], mitm: false },
    allowPorts: Object.fromEntries(allow.map((host) => [host, [...(allowed.get(host) ?? [])].sort((a, b) => a - b)])),
  };
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
  if (published.length > 16) throw new Error('runtime apps may publish at most 16 ports');
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
      relay: 22000 + (uid - 20000) * 16 + index,
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
      runRuntimeStub(
        verb,
        args.some((arg) => arg === '--help' || arg === '-h')
      );
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
  if (/^https?:\/\//.test(input))
    fail('runtime run URLs are not yet supported; download the bundle and pass a local path', 2);
  const bundlePath = path.resolve(input);
  let loaded: LoadedRuntimeBundle;
  try {
    const bounded = readBundleManifest(bundlePath);
    if (bounded.classification !== 'runnable') throw new Error('runtime run requires a manifest v2 runnable bundle');
    loaded = verifyBundle(bundlePath);
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
  installRuntimeBundle(bundlePath, installDir, loaded);
  const records = readRuntimeRegistry().filter((entry) => entry.appId !== loaded.manifest.name);
  const persisted = persistedRuntimeAllocation(loaded.manifest);
  const principalIp = persisted?.principalIp ?? allocatePrincipalIp(records);
  const uid = persisted?.uid ?? allocateUid(records);
  const hostPorts = persisted?.hostPorts ?? (await allocatePublishedPorts(loaded.manifest, records));
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
    signatureKeyId: loaded.signature?.keyId,
    signatureValid: loaded.signature?.valid,
  };
  upsertRuntimeRecord(record);

  console.log(chalk.cyan('» reconciling the pooled appliance-runtime VM (2 vCPU / 4096 MiB)'));
  const prepared = vmJson(['runtime', 'prepare', RUNTIME_POOL_VM, JSON.stringify(plan)]);
  installEffectiveRuntimePolicy(manifestToRuntimePolicy(loaded.manifest, principalIp));
  const restartRequired = Boolean(prepared.restartRequired);
  if (restartRequired) {
    updateRuntimeRecord(plan.appId, { poolRestartPending: true });
    console.log(
      chalk.yellow("pool restart required to attach the app's boot-time VirtioFS share; running apps will pause")
    );
    const stop = runVm(['stop', RUNTIME_POOL_VM]);
    if (stop !== 0) fail(`could not stop ${RUNTIME_POOL_VM} for share reconciliation`, 1);
  }
  try {
    ensurePooledRuntime();
  } catch {
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
    const exitCode = await followLogs(plan.appId, true);
    if (exitCode !== undefined) process.exitCode = exitCode;
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
    const queried = runVmCapture(['runtime', 'status', record.poolVm, record.appId]);
    if (queried.status !== 0) {
      kept.push(record);
      continue;
    }
    let status: Record<string, unknown>;
    try {
      status = JSON.parse(queried.stdout) as Record<string, unknown>;
    } catch {
      kept.push(record);
      continue;
    }
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
  console.log('APP\tVERSION\tSTATE\tPRINCIPAL\tPORTS\tSIGNATURE\tUPTIME\tPOOL');
  for (const record of kept) {
    const state = record.state === 'exited' ? `exited (${record.exitCode ?? '?'})` : record.state;
    const ports = record.hostPorts.map((port) => `${port.name}=127.0.0.1:${port.host}->${port.guest}`).join(',') || '-';
    const signature = record.signatureKeyId
      ? record.signatureValid
        ? `valid:${record.signatureKeyId}`
        : `unverified:${record.signatureKeyId}`
      : 'unsigned';
    const pending = record.poolRestartPending ? ' · pool restart pending' : '';
    console.log(
      `${record.appId}\t${record.version}\t${state}\t${record.principalIp}\t${ports}\t${signature}\t${formatUptime(record.startedAt)}\t${record.poolVm}${pending}`
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
  if (!readRuntimeRegistry().some((entry) => entry.appId === appId))
    fail(`runtime app '${appId}' is not registered`, 2);
  await followLogs(appId, args.includes('-f') || args.includes('--follow'));
}

async function followLogs(appId: string, follow: boolean): Promise<number | undefined> {
  let offset = 0;
  for (;;) {
    const record = readRuntimeRegistry().find((entry) => entry.appId === appId);
    if (!record) return undefined;
    const logs = runVmCapture(['runtime', 'logs', record.poolVm, appId, String(offset)]);
    let receivedData = false;
    if (logs.status === 0) {
      try {
        const chunk = JSON.parse(logs.stdout) as { offset?: unknown; data?: unknown };
        if (typeof chunk.offset === 'number' && typeof chunk.data === 'string') {
          offset = chunk.offset;
          const decoded = Buffer.from(chunk.data, 'base64').toString('utf8');
          receivedData = decoded.length > 0;
          const safe = sanitizeRuntimeLog(decoded);
          if (safe) process.stdout.write(safe + (safe.endsWith('\n') ? '' : '\n'));
        }
      } catch {
        // A malformed log response is transient; status below still reports
        // the task outcome without replaying unsafe bytes.
      }
    }
    if (receivedData) continue;
    const status = vmJson(['runtime', 'status', record.poolVm, appId], true);
    if (status.state === 'exited') {
      const exitCode = numberOrUndefined(status.exitCode) ?? 1;
      updateRuntimeRecord(appId, { state: 'exited', exitCode });
      if (follow) console.log(chalk.yellow(`${appId} exited (${exitCode})`));
      return exitCode;
    }
    if (!follow) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export function sanitizeRuntimeLog(value: string): string {
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
  const withoutAnsi = value.replace(ansi, '');
  let safe = '';
  for (const character of withoutAnsi) {
    const code = character.charCodeAt(0);
    if (character === '\n' || character === '\t' || code >= 0x20) safe += character;
  }
  return safe.split(String.fromCharCode(0x7f)).join('');
}

function installRuntimeBundle(bundlePath: string, destination: string, verified: LoadedRuntimeBundle): void {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (runtimeInstallMatches(destination, verified.digest)) {
    removePreviousRuntimeInstalls(destination);
    return;
  }

  const staging = `${destination}.staging-${process.pid}-${Date.now()}`;
  const previous = `${destination}.previous-${process.pid}-${Date.now()}`;
  try {
    unpackBundle(bundlePath, staging);
    if (!runtimeInstallMatches(staging, verified.digest)) {
      throw new Error('unpacked Runtime bundle digest does not match verified archive');
    }
    if (fs.existsSync(destination)) fs.renameSync(destination, previous);
    fs.renameSync(staging, destination);
    if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true, force: true });
    removePreviousRuntimeInstalls(destination);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(destination) && fs.existsSync(previous)) fs.renameSync(previous, destination);
    throw error;
  }
}

function runtimeInstallMatches(destination: string, digest: string): boolean {
  try {
    const root = fs.realpathSync(destination);
    if (!fs.lstatSync(root).isDirectory()) return false;
    if (fs.readFileSync(path.join(root, 'digest'), 'utf8') !== `${digest}\n`) return false;
    const entries: Array<{ path: string; data: Buffer }> = [];
    const walk = (directory: string): void => {
      for (const name of fs.readdirSync(directory)) {
        const absolute = path.join(directory, name);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error('installed Runtime bundle contains a symlink');
        if (stat.isDirectory()) {
          walk(absolute);
        } else if (stat.isFile()) {
          const relative = path.relative(root, absolute).split(path.sep).join('/');
          if (relative !== 'digest' && relative !== 'signature.sig') {
            entries.push({ path: relative, data: fs.readFileSync(absolute) });
          }
        } else {
          throw new Error('installed Runtime bundle contains an unsupported file type');
        }
      }
    };
    walk(root);
    return computeBundleDigest(entries) === digest;
  } catch {
    return false;
  }
}

function removePreviousRuntimeInstalls(destination: string): void {
  const parent = path.dirname(destination);
  const prefix = `${path.basename(destination)}.previous-`;
  for (const name of fs.readdirSync(parent)) {
    if (name.startsWith(prefix)) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
  }
}

function persistedRuntimeAllocation(
  manifest: ApplianceV2
): { principalIp: string; uid: number; hostPorts: RuntimeHostPort[] } | undefined {
  if (manifest.type !== 'container') return undefined;
  try {
    const spec = JSON.parse(fs.readFileSync(path.join(vmDir(RUNTIME_POOL_VM), 'vm.json'), 'utf8')) as {
      published?: Array<{
        host?: number;
        container?: number;
        runtimeTarget?: { principal?: string; address?: string };
      }>;
    };
    const expected = (manifest.ports ?? []).filter((port) => port.expose === 'host');
    const published = (spec.published ?? []).filter((port) => port.runtimeTarget?.principal === manifest.name);
    if (published.length !== expected.length || published.some((port) => !port.runtimeTarget?.address))
      return undefined;
    const remaining = [...published];
    const hostPorts = expected.map((port) => {
      const index = remaining.findIndex((candidate) => candidate.container === port.guest);
      const existing = index < 0 ? undefined : remaining.splice(index, 1)[0];
      if (!existing || typeof existing.host !== 'number') throw new Error('published port shape changed');
      return { name: port.name, host: existing.host, guest: port.guest, protocol: 'tcp' as const };
    });
    const principalIp = published[0]?.runtimeTarget?.address;
    if (published.some((port) => port.runtimeTarget?.address !== principalIp)) return undefined;
    const leaf = Number.parseInt(principalIp?.split('.').slice(-1)[0] ?? '', 10);
    if (!principalIp || !Number.isInteger(leaf) || leaf < 10 || leaf > 239) return undefined;
    return { principalIp, uid: 20000 + leaf - 10, hostPorts };
  } catch {
    return undefined;
  }
}

function installEffectiveRuntimePolicy(policy: EffectiveRuntimePolicy): void {
  const result = spawnSync(vmBinary(), ['runtime-policy', 'set', policy.vm, policy.principal], {
    encoding: 'utf8',
    input: `${JSON.stringify(policy)}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`could not install effective Runtime policy for '${policy.app}'${detail ? `: ${detail}` : ''}`, 1);
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
