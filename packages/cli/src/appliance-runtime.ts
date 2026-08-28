import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  PINNED_CATALOGUE_TRUST,
  type ApplianceV2,
  type ApplianceV2Service,
  type EntitlementGrant,
} from '@appliance.sh/sdk';
import { ensurePooledRuntime, runVm, vmBinary, vmDir } from './utils/microvm-up.js';
import { runVmCapture } from './utils/sandbox.js';
import { computeBundleDigest } from './utils/bundle-digest.js';
import { readBundleManifest, unpackBundle, verifyBundle, type VerifyBundleResult } from './utils/bundle-read.js';
import { controlsSummaryForManifest, currentWorkspaceTarget, resolveInstalledApp } from './utils/installed-apps.js';
import {
  assertIndexBinding,
  assertNotBlacklisted,
  findLocalEvidence,
  loadBlacklist,
  markUnknownPublisherWarned,
  promptForUnknownPublisher,
  readCachedIndex,
  runRuntimeInstallCommand,
  runRuntimeListCommand,
  runRuntimeUninstallCommand,
  unknownPublisherWarningDue,
} from './appliance-runtime-install.js';
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
import {
  applianceHome,
  assertManifestEntitled,
  latestEntitlement,
  readEntitlementStore,
  stampEntitlementUsage,
} from './utils/entitlements.js';

export const RUNTIME_POOL_VM = 'appliance-runtime';

interface RuntimePlanBase {
  appId: string;
  version: string;
  principalIp: string;
  uid: number;
  share: { tag: string; hostPath: string; readOnly: true };
  ports: Array<RuntimeHostPort & { relay: number; target: string }>;
  resources: { cpus: number; memoryMib: number; diskGib: number; pids: number };
}

type RuntimeHealth =
  | {
      type: 'http';
      port: number;
      path: string;
      intervalSeconds: number;
      timeoutSeconds: number;
      failureThreshold: number;
    }
  | {
      type: 'tcp';
      port: number;
      intervalSeconds: number;
      timeoutSeconds: number;
      failureThreshold: number;
    }
  | {
      type: 'exec';
      command: string[];
      intervalSeconds: number;
      timeoutSeconds: number;
      failureThreshold: number;
    };

type RuntimeLeafWorkload =
  | { kind: 'container'; imagePath: string; env: Record<string, string> }
  | {
      kind: 'binary';
      target: {
        path: string;
        entrypoint: string;
        args: string[];
        env: Record<string, string>;
        cwd: string;
      };
    };

export type RuntimeServicePlan = RuntimeLeafWorkload & {
  name: string;
  path: string[];
  isolation: 'shared' | 'vm';
  dependsOn: string[];
  required: boolean;
  health?: RuntimeHealth;
  restart: { policy: 'never' | 'on-failure' | 'always'; maxAttempts: number; backoffSeconds: number };
  ports: Array<{ name: string; guest: number; protocol: 'tcp' | 'udp'; primary: boolean }>;
  resources: { cpus: number; memoryMib: number; diskGib: number; pids: number };
};

export type RuntimePlan = RuntimePlanBase &
  (RuntimeLeafWorkload | { kind: 'compound'; services: RuntimeServicePlan[] });

export type LoadedRuntimeBundle = VerifyBundleResult;

export interface EffectiveRuntimePolicy {
  version: 1;
  app: string;
  vm: string;
  principal: string;
  source: string;
  policy: { default: 'deny'; allow: string[]; deny: []; mitm: false };
  allowPorts: Record<string, number[]>;
}

export function manifestToRuntimePolicy(
  manifest: ApplianceV2,
  principalIp: string,
  effectiveGrants?: EntitlementGrant[]
): EffectiveRuntimePolicy {
  const allowed = new Map<string, Set<number>>();
  const rules = effectiveGrants
    ? effectiveGrants.flatMap((grant) => (grant.control === 'egress-host' ? [grant.value] : []))
    : (manifest.network?.egress ?? []);
  for (const rule of rules) {
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
  hostPorts: RuntimeHostPort[],
  runtimeArch: NodeJS.Architecture = process.arch
): RuntimePlan {
  const platform = runtimeLinuxPlatform(runtimeArch);
  const workloadFor = (
    service: Exclude<ApplianceV2, { type: 'compound' }> | Exclude<ApplianceV2Service, { type: 'compound' }>,
    env: Record<string, string>
  ): RuntimeLeafWorkload =>
    service.type === 'container'
      ? (() => {
          const image = service.payload.images[platform];
          if (!image) throw missingRuntimeTarget(manifest.name, platform, 'images');
          return { kind: 'container' as const, imagePath: image.path, env };
        })()
      : (() => {
          const target = service.payload.targets[platform];
          if (!target)
            throw missingRuntimeTarget(
              manifest.name,
              platform,
              'targets',
              service.native?.macos ? ' macOS native targets are out of scope.' : ''
            );
          return {
            kind: 'binary' as const,
            target: {
              path: target.root,
              entrypoint: target.entrypoint,
              args: target.args,
              env,
              cwd: '.',
            },
          };
        })();
  let workload: RuntimeLeafWorkload | { kind: 'compound'; services: RuntimeServicePlan[] };
  let requested: { cpus?: number; memoryMib?: number; diskGib?: number };
  let published: Array<{ name: string; guest: number; protocol: 'tcp' | 'udp' }>;
  if (manifest.type === 'compound') {
    const leaves = compoundLeaves(manifest);
    const leafEgress = leaves.find(({ service }) => service.network?.egress !== undefined);
    if (leafEgress) {
      throw new Error(
        'compound apps declare network.egress at the root (shared principal); ' +
          `move ${leafEgress.path.join('.')}.network.egress to the top level`
      );
    }
    const isolated = leaves.find(({ isolation }) => isolation === 'vm');
    if (isolated) throw new Error(`service '${isolated.name}' requests isolation: vm, which is not yet supported`);
    const services = leaves.map(({ name, path: servicePath, service }) => {
      const ports = service.ports ?? [];
      const healthConfig = service.health;
      const health =
        healthConfig?.type === 'http' || healthConfig?.type === 'tcp'
          ? {
              ...healthConfig,
              port: ports.find((port) => port.name === healthConfig.port)?.guest ?? 0,
            }
          : healthConfig;
      const serviceResources = service.resources ?? {};
      return {
        name,
        path: servicePath,
        isolation: 'shared',
        dependsOn: [...service.dependsOn],
        required: service.required,
        health,
        restart: service.restart,
        ports: ports.map((port) => ({
          name: port.name,
          guest: port.guest,
          protocol: port.protocol,
          primary: port.primary ?? false,
        })),
        resources: {
          cpus: serviceResources.cpus ?? 1,
          memoryMib: serviceResources.memoryMib ?? 512,
          diskGib: serviceResources.diskGib ?? 2,
          pids: 256,
        },
        ...workloadFor(service, { ...service.env }),
      } satisfies RuntimeServicePlan;
    });
    workload = { kind: 'compound', services };
    requested = {
      cpus: services.reduce((sum, service) => sum + service.resources.cpus, 0),
      memoryMib: services.reduce((sum, service) => sum + service.resources.memoryMib, 0),
      diskGib: services.reduce((sum, service) => sum + service.resources.diskGib, 0),
    };
    published = leaves.flatMap(({ name, service }) =>
      (service.ports ?? [])
        .filter((port) => port.expose === 'host' && port.primary)
        .map((port) => ({ ...port, name: `${name}.${port.name}` }))
    );
  } else {
    workload = workloadFor(manifest, manifest.env);
    requested = manifest.resources ?? {};
    published = (manifest.ports ?? []).filter((port) => port.expose === 'host');
  }
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
    ...workload,
    ports: published.map((port, index) => ({
      ...hostPorts[index],
      relay: 22000 + (uid - 20000) * 16 + index,
      target: principalIp,
    })),
    resources: {
      cpus: requested.cpus ?? 1,
      memoryMib: requested.memoryMib ?? 512,
      diskGib: requested.diskGib ?? 2,
      pids: workload.kind === 'compound' ? workload.services.length * 256 : 256,
    },
  };
}

function compoundLeaves(manifest: Extract<ApplianceV2, { type: 'compound' }>): Array<{
  name: string;
  path: string[];
  isolation: 'shared' | 'vm';
  service: Exclude<ApplianceV2Service, { type: 'compound' }>;
}> {
  const leaves: Array<{
    name: string;
    path: string[];
    isolation: 'shared' | 'vm';
    service: Exclude<ApplianceV2Service, { type: 'compound' }>;
  }> = [];
  for (const [name, service] of Object.entries(manifest.services)) {
    const isolation = service.isolation ?? 'shared';
    if (service.type === 'compound') {
      for (const [childName, child] of Object.entries(service.services)) {
        if (child.type === 'compound')
          throw new Error(`service containment exceeds depth two at '${name}/${childName}'`);
        leaves.push({ name: childName, path: [name, childName], isolation, service: child });
      }
    } else {
      leaves.push({ name, path: [name], isolation, service });
    }
  }
  return leaves.sort((a, b) => a.name.localeCompare(b.name));
}

function runtimeLinuxPlatform(arch: NodeJS.Architecture): 'linux/amd64' | 'linux/arm64' {
  if (arch === 'arm64') return 'linux/arm64';
  if (arch === 'x64') return 'linux/amd64';
  throw new Error(
    `host architecture '${arch}' is not supported by the Linux Runtime VM; build on an amd64 or arm64 host`
  );
}

function missingRuntimeTarget(
  appName: string,
  platform: 'linux/amd64' | 'linux/arm64',
  branch: 'images' | 'targets',
  suffix = ''
): Error {
  return new Error(
    `bundle '${appName}' has no payload for host runtime platform ${platform}; ` +
      `add payload.${branch}["${platform}"] and repackage.${suffix}`
  );
}

export async function runRuntimeCommand(verb: string, args: string[]): Promise<void> {
  switch (verb) {
    case 'install':
      await runRuntimeInstallCommand(args);
      return;
    case 'uninstall':
      await runRuntimeUninstallCommand(args, (appId) => runtimeStop([appId], false));
      return;
    case 'list':
      runRuntimeListCommand(args);
      return;
    case 'entitlements': {
      const { runRuntimeEntitlementsCommand } = await import('./appliance-runtime-entitlements.js');
      await runRuntimeEntitlementsCommand(args, rewriteEffectivePolicyAfterRevocation);
      return;
    }
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
    console.log(
      'Runs one container, binary, or compound bundle in the pooled appliance-runtime VM; Ctrl-C stops the app.'
    );
    console.log('The argument may also be an installed app name; use --accept-unknown-publisher for headless opens.');
    return;
  }
  const input = firstPositional(args, ['--target']);
  if (!input) fail('Usage: appliance runtime run <path-to-app.appliance.zip>', 2);
  if (/^https?:\/\//.test(input))
    fail('runtime run URLs are not yet supported; download the bundle and pass a local path', 2);
  const target = currentWorkspaceTarget(optionValue(args, '--target'));
  const inputPath = path.resolve(input);
  const inputIsFile = fs.existsSync(inputPath) && fs.statSync(inputPath).isFile();
  const installed = inputIsFile ? null : resolveInstalledApp(input, target);
  const originalBundlePath = installed?.bundlePath ?? inputPath;
  let opened: VerifiedRuntimeOpenCopy | null = null;
  try {
    opened = stageAndVerifyRuntimeOpenCopy(originalBundlePath, installed?.digest);
    const { loaded, bundlePath } = opened;
    const now = new Date();
    const blacklist = await loadBlacklist({
      fetcher: fetch,
      policy: PINNED_CATALOGUE_TRUST,
      now,
      root: runtimeRoot(),
      networkInstall: false,
      preOpen: true,
    });
    if (blacklist) {
      assertNotBlacklisted(
        blacklist,
        loaded.manifest.name,
        loaded.manifest.version,
        loaded.digest,
        loaded.manifest.publisher.keyId
      );
    }

    const index = await readCachedIndex(PINNED_CATALOGUE_TRUST, now, runtimeRoot());
    const evidence = findLocalEvidence(index, bundlePath);
    if (installed?.verification.indexBound) {
      const expectedGeneration = installed.verification.indexBound.generation;
      if (!index || index.stale || index.payload.generation !== expectedGeneration) {
        throw new Error(
          `Installed publisher evidence for '${installed.name}' is not bound to the current verified index generation.`
        );
      }
      if (!evidence || evidence.generation !== expectedGeneration) {
        throw new Error(`The current verified index no longer binds '${installed.name}' to this exact bundle.`);
      }
      assertIndexBinding(evidence.entry, loaded.digest, loaded.manifest);
    }

    const signature = loaded.signature ? (loaded.signature.valid ? 'valid' : 'invalid') : 'unsigned';
    const knownPublisher = Boolean(evidence && signature === 'valid');
    const warningDue =
      !knownPublisher &&
      (!installed || unknownPublisherWarningDue(installed, now) || installed.verification.signature !== signature);
    if (warningDue) {
      const automatedAcceptance = args.includes('--accept-unknown-publisher');
      const rememberedAcceptance = args.includes('--remember-unknown-publisher');
      const interactiveAcceptance =
        !automatedAcceptance &&
        !rememberedAcceptance &&
        (await promptForUnknownPublisher(
          {
            appId: loaded.manifest.name,
            name: evidence?.entry.name ?? installed?.name ?? loaded.manifest.name,
            version: loaded.manifest.version,
            license: loaded.manifest.license,
            source: installed?.source ?? 'file',
            digest: loaded.digest,
            signature,
            publisher: loaded.manifest.publisher.name,
            controlsSummary: installed?.controlsSummary ?? controlsSummaryForManifest(loaded.manifest),
          },
          'open'
        ));
      if (!automatedAcceptance && !rememberedAcceptance && !interactiveAcceptance) {
        throw new Error('Unknown Publisher acknowledgement required; pass --accept-unknown-publisher for this run');
      }
      // Headless acceptance is one-shot. Desktop's explicit remember action
      // and an interactive TTY acknowledgement are time-bounded in the store.
      if (installed && (rememberedAcceptance || interactiveAcceptance)) {
        markUnknownPublisherWarned(installed, target);
      }
    }
  } catch (error) {
    if (opened) fs.rmSync(opened.bundlePath, { force: true });
    fail(error instanceof Error ? error.message : String(error), 2);
  }
  if (!opened) fail('Runtime pre-open verification did not produce an immutable bundle copy.', 2);
  const { bundlePath, loaded } = opened;
  if (installed && loaded.digest !== installed.digest) {
    fs.rmSync(bundlePath, { force: true });
    fail(`installed bundle integrity check failed for '${installed.name}'`, 2);
  }
  let effectiveGrants: EntitlementGrant[];
  try {
    effectiveGrants = assertRuntimeRunEntitled(loaded.manifest);
  } catch (error) {
    fs.rmSync(bundlePath, { force: true });
    fail(error instanceof Error ? error.message : String(error), 2);
  }
  const existing = readRuntimeRegistry().find((entry) => entry.appId === loaded.manifest.name);
  if (existing && (existing.state === 'starting' || existing.state === 'running')) {
    fs.rmSync(bundlePath, { force: true });
    fail(`runtime instance '${existing.appId}' is already running in ${existing.poolVm}`, 2);
  }

  const installDir = path.join(runtimeRoot(), 'apps', loaded.manifest.name, loaded.manifest.version);
  console.log(chalk.cyan(`» validating and unpacking ${path.basename(bundlePath)}`));
  let installChanged: boolean;
  try {
    installChanged = installRuntimeBundle(bundlePath, installDir, loaded);
  } finally {
    fs.rmSync(bundlePath, { force: true });
  }
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
    bundlePath: originalBundlePath,
    installDir,
    shareTag: plan.share.tag,
    uid,
    signatureKeyId: loaded.signature?.keyId,
    signatureValid: loaded.signature?.valid,
  };
  upsertRuntimeRecord(record);

  console.log(chalk.cyan('» reconciling the pooled appliance-runtime VM (2 vCPU / 4096 MiB)'));
  const prepared = vmJson(['runtime', 'prepare', RUNTIME_POOL_VM, JSON.stringify(plan)]);
  // Re-read at the last possible moment so a concurrent revoke between the
  // pre-open check and policy installation can never widen the live policy.
  try {
    effectiveGrants = assertRuntimeRunEntitled(loaded.manifest);
  } catch (error) {
    updateRuntimeRecord(plan.appId, { state: 'failed' });
    fail(error instanceof Error ? error.message : String(error), 2);
  }
  installEffectiveRuntimePolicy(manifestToRuntimePolicy(loaded.manifest, principalIp, effectiveGrants));
  stampUsageBestEffort(
    loaded.manifest.name,
    effectiveGrants.filter((grant) => grant.control === 'egress-host').map((grant) => grant.id)
  );
  const restartRequired = runtimePoolRestartRequired(plan.kind, installChanged, Boolean(prepared.restartRequired));
  if (restartRequired) {
    updateRuntimeRecord(plan.appId, { poolRestartPending: true });
    console.log(
      chalk.yellow("pool restart required to attach the app's boot-time VirtioFS share; running apps will pause")
    );
    const stop = runVm(['stop', RUNTIME_POOL_VM]);
    if (stop !== 0) fail(`could not stop ${RUNTIME_POOL_VM} for share reconciliation`, 1);
    // Workloads must not race the asynchronous VZ shutdown: the next boot
    // must attach the reconciled share regardless of payload kind.
    await waitForRuntimePoolStop();
  }
  try {
    ensurePooledRuntime();
  } catch {
    updateRuntimeRecord(plan.appId, { state: 'failed', poolRestartPending: restartRequired });
    fail(`pooled VM '${RUNTIME_POOL_VM}' failed to become core-ready`, 1);
  }
  const started = vmJson(['runtime', 'start', RUNTIME_POOL_VM, JSON.stringify(plan)]);
  if (started.state !== 'running' && started.state !== 'degraded' && started.state !== 'exited') {
    updateRuntimeRecord(plan.appId, { state: 'failed', exitCode: numberOrUndefined(started.exitCode) });
    const culprit = typeof started.culprit === 'string' ? ` (culprit: ${started.culprit})` : '';
    fail(
      `runtime supervisor did not start '${plan.appId}'${culprit}: ${String(started.message ?? 'unknown error')}`,
      1
    );
  }
  const initialExitCode = started.state === 'exited' ? (numberOrUndefined(started.exitCode) ?? 1) : undefined;
  updateRuntimeRecord(plan.appId, {
    state: initialExitCode === undefined ? (started.state === 'degraded' ? 'degraded' : 'running') : 'exited',
    exitCode: initialExitCode,
    poolRestartPending: false,
  });
  stampUsageBestEffort(
    loaded.manifest.name,
    effectiveGrants.filter((grant) => grant.control === 'published-port').map((grant) => grant.id)
  );
  const urls = hostPorts.map((port) => `http://127.0.0.1:${port.host}`);
  if (args.includes('--json')) console.log(JSON.stringify({ appId: plan.appId, urls }));
  else {
    for (const port of hostPorts) {
      console.log(`${chalk.green('✓')} ${port.name}: http://127.0.0.1:${port.host} → ${principalIp}:${port.guest}/tcp`);
    }
  }
  if (args.includes('--detach')) return;
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
  const statuses = new Map<string, RuntimeAppStatus>();
  for (const record of readRuntimeRegistry()) {
    const queried = runVmCapture(['runtime', 'status', record.poolVm, record.appId]);
    if (queried.status !== 0) {
      kept.push(record);
      continue;
    }
    let status: RuntimeAppStatus;
    try {
      status = JSON.parse(queried.stdout) as RuntimeAppStatus;
    } catch {
      kept.push(record);
      continue;
    }
    if (status.state === 'missing') continue;
    const state = runtimeState(status.state) ?? record.state;
    const updated: RuntimeRecord = {
      ...record,
      state,
      exitCode: numberOrUndefined(status.exitCode) ?? record.exitCode,
      updatedAt: new Date().toISOString(),
    };
    kept.push(updated);
    statuses.set(record.appId, status);
  }
  // ps owns stale pruning: only entries the guest still recognizes survive.
  writeRuntimeRegistry(kept);
  if (json) {
    console.log(
      JSON.stringify(
        kept.map((record) => ({
          ...record,
          culprit: statuses.get(record.appId)?.culprit,
          services: statuses.get(record.appId)?.services ?? [],
        })),
        null,
        2
      )
    );
    return;
  }
  if (kept.length === 0) {
    console.log('No runtime apps.');
    return;
  }
  console.log('APP\tVERSION\tSTATE\tPRINCIPAL\tPORTS\tSIGNATURE\tUPTIME\tPOOL');
  for (const record of kept) {
    const status = statuses.get(record.appId);
    const culprit = typeof status?.culprit === 'string' ? status.culprit : undefined;
    const state =
      record.state === 'exited'
        ? `exited (${record.exitCode ?? '?'})`
        : record.state === 'failed' && culprit
          ? `failed (culprit: ${culprit}, exit: ${record.exitCode ?? '?'})`
          : record.state;
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
    for (const service of statuses.get(record.appId)?.services ?? []) {
      const health = service.health === 'none' ? '-' : service.health;
      const required = service.required ? 'required' : 'optional';
      console.log(
        `  ↳ ${service.name}\t-\t${service.state}\t${required}\thealth=${health}, restarts=${service.restarts}\t-\t-\t${service.endpoint ?? 'shared'}`
      );
    }
  }
}

export function runtimeStop(args: string[], print = true): void {
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

export interface VerifiedRuntimeOpenCopy {
  bundlePath: string;
  loaded: LoadedRuntimeBundle;
}

export function stageAndVerifyRuntimeOpenCopy(
  source: string,
  expectedDigest?: string,
  directory = path.join(runtimeRoot(), 'preopen')
): VerifiedRuntimeOpenCopy {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const destination = path.join(
    directory,
    `open-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.appliance.zip`
  );
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o400);
  try {
    const bounded = readBundleManifest(destination);
    if (bounded.classification !== 'runnable') {
      throw new Error('runtime run requires a manifest v2 runnable bundle');
    }
    const loaded = verifyBundle(destination, {
      resolvePublicKey: (keyId) => PINNED_CATALOGUE_TRUST.keys[keyId],
    });
    if (expectedDigest && loaded.digest !== expectedDigest) {
      throw new Error('installed bundle integrity check failed for the exact immutable pre-open copy');
    }
    return { bundlePath: destination, loaded };
  } catch (cause) {
    fs.rmSync(destination, { force: true });
    throw cause;
  }
}

function firstPositional(args: string[], valueOptions: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (valueOptions.includes(args[index]!)) {
      index += 1;
      continue;
    }
    if (!args[index]!.startsWith('-')) return args[index];
  }
  return undefined;
}

async function runtimeLogs(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: appliance runtime logs <app> [--service <name>] [-f|--follow]');
    return;
  }
  const appId = args.find((arg) => !arg.startsWith('-'));
  if (!appId) fail('Usage: appliance runtime logs <app> [--service <name>] [-f|--follow]', 2);
  if (!readRuntimeRegistry().some((entry) => entry.appId === appId))
    fail(`runtime app '${appId}' is not registered`, 2);
  const service = optionValue(args, '--service');
  await followLogs(appId, args.includes('-f') || args.includes('--follow'), service);
}

async function followLogs(appId: string, follow: boolean, selectedService?: string): Promise<number | undefined> {
  const offsets = new Map<string, number>();
  for (;;) {
    const record = readRuntimeRegistry().find((entry) => entry.appId === appId);
    if (!record) return undefined;
    const status = vmJson(['runtime', 'status', record.poolVm, appId], true) as RuntimeAppStatus;
    const services = status.services ?? [];
    if (selectedService && services.length > 0 && !services.some((service) => service.name === selectedService)) {
      fail(`runtime app '${appId}' has no service '${selectedService}'`, 2);
    }
    const targets: Array<string | undefined> =
      services.length > 0
        ? selectedService
          ? [selectedService]
          : services.map((service) => service.name)
        : [undefined];
    let receivedData = false;
    for (const service of targets) {
      const key = service ?? '';
      const logArgs = ['runtime', 'logs', record.poolVm, appId, String(offsets.get(key) ?? 0)];
      if (service) logArgs.push('--service', service);
      const logs = runVmCapture(logArgs);
      if (logs.status !== 0) continue;
      try {
        const chunk = JSON.parse(logs.stdout) as { offset?: unknown; data?: unknown; service?: unknown };
        if (typeof chunk.offset === 'number' && typeof chunk.data === 'string') {
          offsets.set(key, chunk.offset);
          const decoded = Buffer.from(chunk.data, 'base64').toString('utf8');
          receivedData ||= decoded.length > 0;
          const safe = sanitizeRuntimeLog(decoded);
          if (safe) {
            const rendered = service ? prefixServiceLog(service, safe) : safe;
            process.stdout.write(rendered + (rendered.endsWith('\n') ? '' : '\n'));
          }
        }
      } catch {
        // A malformed log response is transient; status below still reports
        // the task outcome without replaying unsafe bytes.
      }
    }
    if (receivedData) continue;
    if (status.state === 'exited' || status.state === 'failed') {
      const exitCode = numberOrUndefined(status.exitCode) ?? 1;
      updateRuntimeRecord(appId, { state: status.state, exitCode });
      const culprit = typeof status.culprit === 'string' ? `, culprit: ${status.culprit}` : '';
      if (follow) console.log(chalk.yellow(`${appId} ${status.state} (${exitCode}${culprit})`));
      return exitCode;
    }
    if (!follow) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

interface RuntimeServiceStatus {
  id: string;
  name: string;
  state: string;
  required: boolean;
  health: string;
  restarts: number;
  endpoint?: string | null;
}

interface RuntimeAppStatus extends Record<string, unknown> {
  state?: unknown;
  exitCode?: unknown;
  culprit?: unknown;
  services?: RuntimeServiceStatus[];
}

function runtimeState(value: unknown): RuntimeRecord['state'] | undefined {
  return typeof value === 'string' && ['starting', 'running', 'degraded', 'stopped', 'exited', 'failed'].includes(value)
    ? (value as RuntimeRecord['state'])
    : undefined;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('-')) fail(`${name} requires a value`, 2);
  return value;
}

export function prefixServiceLog(service: string, value: string): string {
  return value
    .split('\n')
    .map((line, index, lines) => (line.length > 0 || index < lines.length - 1 ? `[${service}] ${line}` : ''))
    .join('\n');
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

function installRuntimeBundle(bundlePath: string, destination: string, verified: LoadedRuntimeBundle): boolean {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (runtimeInstallMatches(destination, verified.digest)) {
    removePreviousRuntimeInstalls(destination);
    return false;
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
    return true;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(destination) && fs.existsSync(previous)) fs.renameSync(previous, destination);
    throw error;
  }
}

export function runtimePoolRestartRequired(
  kind: RuntimePlan['kind'],
  installChanged: boolean,
  prepareRequiresRestart: boolean
): boolean {
  // Replacing an installed directory preserves its path but changes its inode.
  // A running VZ VirtioFS device still holds the old directory and must reboot
  // before compound leaves can import the replacement payloads. Keep legacy
  // single-workload reconciliation unchanged in this stacked increment.
  return prepareRequiresRestart || (kind === 'compound' && installChanged);
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
  try {
    const spec = JSON.parse(fs.readFileSync(path.join(vmDir(RUNTIME_POOL_VM), 'vm.json'), 'utf8')) as {
      published?: Array<{
        host?: number;
        container?: number;
        runtimeTarget?: { principal?: string; address?: string };
      }>;
    };
    const expected = publishedManifestPorts(manifest);
    const published = (spec.published ?? []).filter((port) => port.runtimeTarget?.principal === manifest.name);
    if (published.length !== expected.length || published.some((port) => !port.runtimeTarget?.address))
      return undefined;
    const principalIp = published[0]?.runtimeTarget?.address;
    if (published.some((port) => port.runtimeTarget?.address !== principalIp)) return undefined;
    const leaf = Number.parseInt(principalIp?.split('.').slice(-1)[0] ?? '', 10);
    if (!principalIp || !Number.isInteger(leaf) || leaf < 10 || leaf > 239) return undefined;
    const relayBase = 22000 + (leaf - 10) * 16;
    const ordered = [...published].sort((a, b) => (a.container ?? 0) - (b.container ?? 0));
    const hostPorts = expected.map((port, index) => {
      const existing = ordered[index];
      if (!existing || typeof existing.host !== 'number' || existing.container !== relayBase + index) {
        throw new Error('published relay shape changed');
      }
      return { name: port.name, host: existing.host, guest: port.guest, protocol: 'tcp' as const };
    });
    return { principalIp, uid: 20000 + leaf - 10, hostPorts };
  } catch {
    return undefined;
  }
}

export function installEffectiveRuntimePolicy(policy: EffectiveRuntimePolicy): void {
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

export function assertRuntimeRunEntitled(manifest: ApplianceV2, home = applianceHome()): EntitlementGrant[] {
  const store = readEntitlementStore({ home });
  return assertManifestEntitled(manifest, latestEntitlement(store.records, manifest.name));
}

export interface RevocationRewriteDependencies {
  readRuntimeRecords?: () => RuntimeRecord[];
  readManifest?: (bundlePath: string) => ApplianceV2;
  readCurrentGrants?: (appId: string) => EntitlementGrant[];
  installPolicy?: (policy: EffectiveRuntimePolicy) => void;
  stopRuntime?: (args: string[], print: boolean) => void;
}

export function rewriteEffectivePolicyAfterRevocation(
  appId: string,
  grantId: string,
  dependencies: RevocationRewriteDependencies = {}
): void {
  const runtime = (dependencies.readRuntimeRecords ?? readRuntimeRegistry)().find(
    (record) => record.appId === appId && (record.state === 'running' || record.state === 'starting')
  );
  if (!runtime) return;
  const manifest = dependencies.readManifest
    ? dependencies.readManifest(runtime.bundlePath)
    : verifyBundle(runtime.bundlePath, {
        resolvePublicKey: (keyId) => PINNED_CATALOGUE_TRUST.keys[keyId],
      }).manifest;
  const grants = dependencies.readCurrentGrants
    ? dependencies.readCurrentGrants(appId)
    : (latestEntitlement(readEntitlementStore().records, appId)?.grants ?? []);
  (dependencies.installPolicy ?? installEffectiveRuntimePolicy)(
    manifestToRuntimePolicy(manifest, runtime.principalIp, grants)
  );
  if (grantId.startsWith('port:') || grantId.startsWith('resources:')) {
    (dependencies.stopRuntime ?? runtimeStop)([appId], false);
  }
}

function stampUsageBestEffort(appId: string, grantIds: string[]): void {
  try {
    stampEntitlementUsage(appId, grantIds, { home: applianceHome() });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(
      chalk.yellow(`Warning: entitlement usage could not be persisted; latest use remains in memory only. ${detail}`)
    );
  }
}

async function allocatePublishedPorts(manifest: ApplianceV2, records: RuntimeRecord[]): Promise<RuntimeHostPort[]> {
  const requested = publishedManifestPorts(manifest);
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

function publishedManifestPorts(
  manifest: ApplianceV2
): Array<{ name: string; guest: number; protocol: 'tcp' | 'udp' }> {
  if (manifest.type !== 'compound') return (manifest.ports ?? []).filter((port) => port.expose === 'host');
  return compoundLeaves(manifest).flatMap(({ name, service }) =>
    (service.ports ?? [])
      .filter((port) => port.expose === 'host' && port.primary)
      .map((port) => ({ ...port, name: `${name}.${port.name}` }))
  );
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

async function waitForRuntimePoolStop(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = runVmCapture(['status', RUNTIME_POOL_VM]);
    if (status.status === 0) {
      try {
        const parsed = JSON.parse(status.stdout) as { running?: unknown };
        if (parsed.running === false) return;
      } catch {
        // The engine may be between process teardown and status-file cleanup.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`timed out waiting for ${RUNTIME_POOL_VM} to stop for payload share reconciliation`, 1);
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
