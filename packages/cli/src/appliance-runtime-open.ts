import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { applianceV2Input, type ApplianceV2, type InstalledApp } from '@appliance.sh/sdk';
import { currentWorkspaceTarget, resolveInstalledApp } from './utils/installed-apps.js';
import { readBundleManifest } from './utils/bundle-read.js';
import {
  readRuntimeRegistry,
  updateRuntimeRecord,
  type RuntimeRecord,
} from './utils/runtime-registry.js';
import {
  engineRuntimeStatusBackend,
  isWarmRuntimeState,
  reconcileRuntimeRecord,
  type RuntimeStatusBackend,
} from './utils/runtime-reconcile.js';
import { resolveVmBinary } from './utils/microvm-up.js';
import { openExternalUrl } from './utils/open-external-url.js';

export interface RuntimeOpenDescriptor {
  appId: string;
  target: string;
  name: string;
  version: string;
  license: string;
  ui: { type: 'web' | 'native' | 'none'; port?: string; path?: string };
  state: 'starting' | 'running' | 'degraded' | 'stopped' | 'exited' | 'failed';
  exitCode?: number;
  url?: string;
  hostPort?: number;
  egressHostCount: number;
  openMetric?: RuntimeOpenMetricContext;
}

export interface RuntimeOpenMetricContext {
  kind: 'cold' | 'warm' | 'reopen';
  startedAtMs: number;
}

interface DesktopIpcRegistration {
  version: 1;
  pid: number;
  port: number;
  token: string;
}

export interface RuntimeOpenRoute {
  sendDesktop(descriptor: RuntimeOpenDescriptor): Promise<boolean>;
  openBrowser(url: string): void;
}

export interface RuntimeOpenBackend extends RuntimeStatusBackend {
  runDetached(selector: string, target: string, acceptUnknownPublisher: boolean): Promise<void>;
}

export interface RuntimeOpenDependencies {
  backend: RuntimeOpenBackend;
  readRecords(): RuntimeRecord[];
  updateRecord(appId: string, update: Partial<Omit<RuntimeRecord, 'appId'>>): RuntimeRecord | null;
  describe(selector: string, target: string): RuntimeOpenDescriptor;
}

const RUNTIME_POOL_VM = 'appliance-runtime';

export function desktopIpcFile(home = os.homedir()): string {
  return path.join(home, '.appliance', 'runtime', 'desktop-ipc.json');
}

export function describeRuntimeApp(
  selector: string,
  target = currentWorkspaceTarget(),
  options: {
    installed?: InstalledApp;
    record?: RuntimeRecord;
  } = {}
): RuntimeOpenDescriptor {
  const installed = options.installed ?? resolveInstalledApp(selector, target);
  if (!installed) throw new Error(`installed app '${selector}' was not found in workspace '${target}'`);
  const opened = readBundleManifest(installed.bundlePath);
  if (opened.classification !== 'runnable') throw new Error(`installed app '${installed.name}' is not runnable`);
  const manifest = applianceV2Input.parse(opened.manifest);
  const record = options.record ?? readRuntimeRegistry().find((candidate) => candidate.appId === installed.appId);
  const state = record?.state ?? 'stopped';
  const ui = runtimeUi(manifest);
  const portName = runtimeUiPortName(manifest);
  const hostPort = portName ? record?.hostPorts.find((candidate) => candidate.name === portName)?.host : undefined;
  const pathName = ui.type === 'web' ? ui.path : undefined;
  const url = hostPort == null ? undefined : runtimeOpenUrl(hostPort, pathName);

  return {
    appId: installed.appId,
    target,
    name: installed.name,
    version: installed.version,
    license: installed.license,
    ui:
      ui.type === 'web'
        ? { type: 'web', port: portName, path: pathName }
        : ui.type === 'native'
          ? { type: 'native' }
          : { type: 'none' },
    state,
    ...(record?.exitCode == null ? {} : { exitCode: record.exitCode }),
    ...(url ? { url } : {}),
    ...(hostPort == null ? {} : { hostPort }),
    egressHostCount: effectiveEgressHostCount(installed),
  };
}

export async function routeRuntimeOpen(
  descriptor: RuntimeOpenDescriptor,
  route: RuntimeOpenRoute
): Promise<'desktop' | 'browser'> {
  if (!descriptor.url) throw new Error(`installed app '${descriptor.name}' has no web UI`);
  if (await route.sendDesktop(descriptor)) return 'desktop';
  route.openBrowser(descriptor.url);
  return 'browser';
}

export function runtimeOpenJson(descriptor: RuntimeOpenDescriptor, route: 'desktop' | 'browser') {
  return {
    descriptor,
    route,
    metrics: { appOpenTtv: descriptor.openMetric },
  };
}

export async function sendRuntimeOpenToDesktop(
  descriptor: RuntimeOpenDescriptor,
  file = desktopIpcFile()
): Promise<boolean> {
  let registration: DesktopIpcRegistration;
  try {
    registration = JSON.parse(fs.readFileSync(file, 'utf8')) as DesktopIpcRegistration;
    if (
      registration.version !== 1 ||
      !Number.isInteger(registration.port) ||
      registration.port < 1 ||
      registration.port > 65535 ||
      typeof registration.token !== 'string' ||
      registration.token.length < 16
    ) {
      return false;
    }
  } catch {
    return false;
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: registration.port });
    const timer = setTimeout(() => socket.destroy(), 500);
    socket.setEncoding('utf8');
    let response = '';
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ token: registration.token, action: 'open', descriptor })}\n`);
    });
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\n')) socket.end();
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(response.trim() === 'ok');
    });
  });
}

export async function runRuntimeOpen(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: appliance runtime open <app> [--target <workspace>] [--print] [--json]');
    console.log('Opens the dedicated Appliance app window when Desktop is running, otherwise the default browser.');
    return;
  }
  const selector = firstPositional(args, ['--target']);
  if (!selector) throw new Error('Usage: appliance runtime open <app>');
  const target = currentWorkspaceTarget(optionValue(args, '--target'));
  const startedAtMs = Date.now();
  let descriptor = describeRuntimeApp(selector, target);

  if (args.includes('--describe')) {
    console.log(JSON.stringify(descriptor));
    return;
  }
  if (descriptor.ui.type !== 'web') {
    throw new Error(
      `'${descriptor.name}' has no web UI. View its logs with: appliance runtime logs ${descriptor.appId}`
    );
  }
  const prepared = await reconcileAndStartRuntimeOpen(
    selector,
    target,
    descriptor,
    args.includes('--accept-unknown-publisher')
  );
  descriptor = prepared.descriptor;
  if (!descriptor.url || descriptor.hostPort == null) {
    throw new Error(`'${descriptor.name}' did not publish its manifest UI port`);
  }
  await waitForTcpPort(descriptor.hostPort, 15_000);
  if (args.includes('--print')) {
    console.log(descriptor.url);
    return;
  }
  descriptor = { ...descriptor, openMetric: { kind: prepared.kind, startedAtMs } };
  const routed = await routeRuntimeOpen(descriptor, {
    sendDesktop: sendRuntimeOpenToDesktop,
    openBrowser: openExternalUrl,
  });
  if (args.includes('--json')) {
    console.log(JSON.stringify(runtimeOpenJson(descriptor, routed)));
    return;
  }
  console.log(
    chalk.dim(routed === 'desktop' ? `Opened ${descriptor.name} in Appliance Desktop` : `Opening ${descriptor.url}`)
  );
}

export async function reconcileAndStartRuntimeOpen(
  selector: string,
  target: string,
  initial: RuntimeOpenDescriptor,
  acceptUnknownPublisher: boolean,
  dependencies: RuntimeOpenDependencies = defaultRuntimeOpenDependencies
): Promise<{ descriptor: RuntimeOpenDescriptor; kind: RuntimeOpenMetricContext['kind'] }> {
  let descriptor = initial;
  if (isWarmRuntimeState(descriptor.state)) {
    const record = dependencies.readRecords().find((candidate) => candidate.appId === descriptor.appId);
    if (record) {
      const reconciled = reconcileRuntimeRecord(record, dependencies.backend);
      if (reconciled.record.state !== record.state || reconciled.record.exitCode !== record.exitCode) {
        dependencies.updateRecord(record.appId, {
          state: reconciled.record.state,
          exitCode: reconciled.record.exitCode,
        });
      }
      descriptor = dependencies.describe(selector, target);
    } else {
      descriptor = { ...descriptor, state: 'stopped', exitCode: undefined };
    }
  }

  const warm = isWarmRuntimeState(descriptor.state);
  if (!warm) {
    await dependencies.backend.runDetached(selector, target, acceptUnknownPublisher);
    descriptor = dependencies.describe(selector, target);
  }
  return { descriptor, kind: warm ? 'warm' : 'cold' };
}

const defaultRuntimeOpenDependencies: RuntimeOpenDependencies = {
  backend: {
    ...engineRuntimeStatusBackend,
    async runDetached(selector, target, acceptUnknownPublisher) {
      const { runRuntimeCommand } = await import('./appliance-runtime.js');
      await runRuntimeCommand('run', [
        selector,
        '--target',
        target,
        '--detach',
        '--json',
        ...(acceptUnknownPublisher ? ['--accept-unknown-publisher'] : []),
      ]);
    },
  },
  readRecords: readRuntimeRegistry,
  updateRecord: updateRuntimeRecord,
  describe: describeRuntimeApp,
};

export function runtimeUiPortName(manifest: ApplianceV2): string | undefined {
  const ui = runtimeUi(manifest);
  return ui.type === 'web' ? (ui.service ? `${ui.service}.${ui.port}` : ui.port) : undefined;
}

export function runtimeOpenUrl(hostPort: number, pathName = '/'): string {
  return `http://127.0.0.1:${hostPort}${pathName}`;
}

export function waitForTcpPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(250);
      let finished = false;
      socket.once('connect', () => {
        if (finished) return;
        finished = true;
        socket.destroy();
        resolve();
      });
      const retry = () => {
        if (finished) return;
        finished = true;
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`app port ${port} was not ready within ${timeoutMs}ms`));
        else setTimeout(attempt, Math.min(100, deadline - Date.now()));
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}

function runtimeUi(
  manifest: ApplianceV2
): { type: 'web'; port: string; path: string; service?: string } | { type: 'native' } | { type: 'none' } {
  if (!manifest.ui) return { type: 'none' };
  if (manifest.ui.type === 'native') return { type: 'native' };
  return manifest.ui;
}

function effectiveEgressHostCount(installed: InstalledApp): number {
  const binary = resolveVmBinary();
  if (binary) {
    const result = spawnSync(binary, ['runtime-policy', 'get', RUNTIME_POOL_VM, installed.appId], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0) {
      try {
        const policy = JSON.parse(result.stdout) as { policy?: { allow?: unknown[] } };
        if (Array.isArray(policy.policy?.allow)) return policy.policy.allow.length;
      } catch {
        // The installed controls summary remains the safe display fallback.
      }
    }
  }
  return installed.controlsSummary.egressHosts.length;
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function firstPositional(args: string[], valueOptions: string[]): string | undefined {
  const consumed = new Set<number>();
  for (let index = 0; index < args.length; index += 1) {
    if (valueOptions.includes(args[index] ?? '')) consumed.add(index + 1);
  }
  return args.find((arg, index) => !arg.startsWith('-') && !consumed.has(index));
}
