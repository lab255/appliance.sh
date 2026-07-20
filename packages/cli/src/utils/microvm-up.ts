import chalk from 'chalk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mintApiKey, waitForApiServerUrl, apiServerUrlForHostPort } from '@appliance.sh/helper';
import { createApplianceClient, VERSION as SDK_VERSION } from '@appliance.sh/sdk';
import { saveCredentials } from './credentials.js';
import { readProfiles, removeProfile } from './profile-store.js';
import { ensureApiServerArtifacts } from './api-server-artifact.js';

// Shared microVM bring-up core.
//
// `runUp` stages the api-server guest artifacts, boots the microVM
// (whose boot media embeds them — the control plane runs as a plain
// binary inside the guest, no docker anywhere), waits for the
// ingress-routed api-server, and adopts the VM's credential profile.
// It is the single orchestration both `appliance vm up` (the
// lower-level multi-VM command) and `appliance init` (the one-tap
// onboarding front door) call, so the two can never drift. The
// lower-level VM primitives it leans on — binary resolution, the
// spec-derived ports, the per-VM profile name — live here too so
// `appliance-vm.ts` and `appliance-init.ts` share one copy.

export const DEFAULT_VM_NAME = 'appliance';

// Mirrors VmSpec defaults in packages/vm/src/spec.rs — keep in sync.
// These are the *default* VM's canonical ports; additional VMs get an
// allocated block, read per-VM from their persisted spec (vmPorts).
const DEFAULT_VM_PORTS = {
  hostPort: 8081,
  apiPort: 6443,
  registryPort: 5052,
  egressPort: 5053,
  buildkitPort: 5054,
} as const;

/** A VM's forwarded host ports. */
export type VmPorts = { -readonly [K in keyof typeof DEFAULT_VM_PORTS]: number };

/** What `ensureVmRuntime` hands back: enough for a host-side control
 *  plane to drive the VM's cluster (kubeconfig + forwarded ports). */
export interface VmRuntimeInfo {
  name: string;
  /** Host path of the VM's admin kubeconfig, already rewritten to the
   *  forwarded 127.0.0.1:<apiPort> server address by the engine. */
  kubeconfigPath: string;
  ports: VmPorts;
}

/** The one local profile: the default VM's api-server. What `appliance
 *  dev` / `deploy` resolve when no profile is pinned. */
export const LOCAL_PROFILE = 'local';

/** Pre-cutover name of the default VM's profile. Still dual-written
 *  (and read as a verification fallback) for one release so existing
 *  installs and the desktop's cluster registry keep working. */
export const LEGACY_MICROVM_PROFILE = 'microvm';

/** The credentials profile a VM owns. The default VM owns the `local`
 *  profile (there is ONE local runtime); each additional VM gets its
 *  own `microvm-<name>` profile so multiple VMs coexist without
 *  clobbering each other's credentials. */
export function profileForVm(name: string): string {
  return name === DEFAULT_VM_NAME ? LOCAL_PROFILE : `microvm-${name}`;
}

export function vmDir(name: string): string {
  return path.join(os.homedir(), '.appliance', 'vm', name);
}

/** Read a VM's forwarded host ports from its persisted spec, falling
 *  back to the canonical defaults when the spec isn't written yet.
 *  Module-private: only `ensureVmRuntime` below consumes it. */
function vmPorts(name: string): VmPorts {
  try {
    const raw = fs.readFileSync(path.join(vmDir(name), 'vm.json'), 'utf8');
    const spec = JSON.parse(raw) as Partial<typeof DEFAULT_VM_PORTS>;
    return {
      hostPort: spec.hostPort ?? DEFAULT_VM_PORTS.hostPort,
      apiPort: spec.apiPort ?? DEFAULT_VM_PORTS.apiPort,
      registryPort: spec.registryPort ?? DEFAULT_VM_PORTS.registryPort,
      egressPort: spec.egressPort ?? DEFAULT_VM_PORTS.egressPort,
      buildkitPort: spec.buildkitPort ?? DEFAULT_VM_PORTS.buildkitPort,
    };
  } catch {
    return { ...DEFAULT_VM_PORTS };
  }
}

/** Repo-checkout builds of the engine binary, resolved relative to
 *  this module's emitted file (dist/utils → the repo's packages dir) —
 *  so `appliance dev`/`server start` find it from ANY working
 *  directory, not just the repo root. Empty under the bun single
 *  binary, whose import.meta.url is not a real file. */
function repoVmBinaryCandidates(): string[] {
  if (process.versions.bun) return [];
  try {
    const packagesDir = fileURLToPath(new URL('../../..', import.meta.url));
    return [
      path.join(packagesDir, 'vm', 'target', 'release', 'appliance-vm'),
      path.join(packagesDir, 'vm', 'target', 'debug', 'appliance-vm'),
    ];
  } catch {
    return [];
  }
}

/** Resolve the appliance-vm binary that `runVm` would invoke, or null
 *  when none is runnable. Resolution order: explicit override → managed
 *  install → PATH → the repo build. The desktop installs into
 *  ~/.appliance/bin (and the npm distribution ships per-platform
 *  binaries); the repo paths keep `pnpm`-checkout workflows working.
 *  Returns the path without exiting so callers that only want to inspect
 *  the binary (e.g. the dev-signing preflight) can probe it safely. */
export function resolveVmBinary(): string | null {
  const candidates = [
    process.env.APPLIANCE_VM,
    path.join(os.homedir(), '.appliance', 'bin', 'appliance-vm'),
    'appliance-vm',
    // Repo-checkout fallbacks: relative to this module first (works
    // from any cwd), then the working directory (legacy behavior).
    ...repoVmBinaryCandidates(),
    path.resolve('packages/vm/target/release/appliance-vm'),
    path.resolve('packages/vm/target/debug/appliance-vm'),
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

export function vmBinary(): string {
  const bin = resolveVmBinary();
  if (bin) return bin;
  console.error(
    chalk.red(
      'appliance-vm binary not found. Build it with `cargo build && ./scripts/sign-dev.sh` in packages/vm, or set APPLIANCE_VM.'
    )
  );
  process.exit(1);
}

export function runVm(args: string[]): number {
  const bin = vmBinary();
  const r = spawnSync(bin, args, { stdio: 'inherit' });
  return r.status ?? 1;
}

/** Best-effort engine invocation with output suppressed — for calls
 *  that are allowed to fail quietly (e.g. `egress sync` before the
 *  cluster namespace exists). Returns the exit code; never exits. */
export function runVmQuiet(args: string[]): number {
  const bin = resolveVmBinary();
  if (!bin) return 1;
  const r = spawnSync(bin, args, { stdio: 'ignore' });
  return r.status ?? 1;
}

/** A VM's forwarded host ports, read from its persisted spec. Exported
 *  for status displays; boot flows get the same data via
 *  `ensureVmRuntime`. */
export function readVmPorts(name: string = DEFAULT_VM_NAME): VmPorts {
  return vmPorts(name);
}

/** The engine's `status <name>` JSON report (packages/vm/src/spec.rs
 *  VmStatus, camelCase). Only the fields the summary renders. */
export interface EngineVmStatus {
  name: string;
  exists: boolean;
  running: boolean;
  pid?: number;
  backend: string;
  clusterReady: boolean;
  phase?: string;
  phaseDetail?: string;
  /** Backend availability error (WSL broken, no entitlement, …). */
  message?: string;
  hostPort?: number;
  apiPort?: number;
  registryPort?: number;
  buildkitPort?: number;
  dev?: boolean;
}

/**
 * Render the engine's status JSON as the human summary `appliance vm
 * status` prints: one state line, the facts that matter (URL, ports,
 * dev-ness), and ALWAYS a "Next:" line naming the command that moves
 * this state forward — a non-developer should never have to guess.
 * Pure (returns lines, no printing) for testability.
 */
export function renderVmStatus(s: EngineVmStatus): string[] {
  const lines: string[] = [];
  const title = (state: string) => `VM ${chalk.bold(`'${s.name}'`)} — ${state}`;

  if (!s.exists) {
    lines.push(title('not created yet'));
    lines.push(`  ${chalk.dim('Next:')} appliance init (first-time setup) — or \`appliance vm up\` to just boot it.`);
    return lines;
  }
  if (!s.running) {
    lines.push(title(`${chalk.yellow('stopped')} (state preserved)`));
    if (s.dev) lines.push(`  Dev environment: yes`);
    lines.push(`  ${chalk.dim('Next:')} appliance vm up — or just \`appliance dev\`, which boots it for you.`);
    return lines;
  }

  const pid = s.pid !== undefined ? ` (pid ${s.pid})` : '';
  if (!s.clusterReady) {
    const phase = s.phase ? `${s.phase}${s.phaseDetail ? `: ${s.phaseDetail}` : ''}` : 'starting';
    lines.push(title(`${chalk.cyan('starting')}${pid} — ${phase}`));
    lines.push(
      `  ${chalk.dim('Next:')} watch the boot with \`appliance vm console -f\`; first boots can take a few minutes.`
    );
  } else {
    lines.push(title(`${chalk.green('running')}${pid}`));
    if (s.hostPort !== undefined) {
      lines.push(`  Console + API: ${chalk.cyan(`http://api.appliance.localhost:${s.hostPort}`)}`);
      lines.push(`  Apps deploy to: http://<app>-<env>.appliance.localhost:${s.hostPort}`);
    }
    const ports = [
      s.hostPort !== undefined && `ingress ${s.hostPort}`,
      s.apiPort !== undefined && `kubernetes ${s.apiPort}`,
      s.registryPort !== undefined && `registry ${s.registryPort}`,
      s.buildkitPort !== undefined && `buildkit ${s.buildkitPort}`,
    ].filter(Boolean);
    if (ports.length > 0) lines.push(chalk.dim(`  Ports: ${ports.join(' · ')}`));
    lines.push(
      `  ${chalk.dim('Next:')} appliance dev — deploy + logs + rebuild on save. Park it with \`appliance vm stop\`.`
    );
  }
  if (s.dev) lines.push(`  Dev environment: yes (\`appliance vm shell\` lands in the persistent workspace)`);
  if (s.message) {
    lines.push(chalk.yellow(`  Warning: ${s.message.split('\n')[0]}`));
  }
  return lines;
}

/** Pure decision core for the engine fast-pass: the history must show an
 *  `ingress` phase AND be at least as fresh as the kubeconfig. The
 *  freshness guard closes the engine-downgrade hole — old engines clear
 *  only `bringup.json`, never the history file, so a boot under a
 *  downgraded engine leaves the NEW engine's stale history next to a
 *  kubeconfig the old engine just wrote. History from this boot is
 *  always written after (or in the same instant as) the kubeconfig: the
 *  engine appends `ingress`/`ready` entries after persisting it.
 *  Exported for tests. */
export function historyGuaranteesPlatformReady(
  historyRaw: string,
  historyMtimeMs: number,
  kubeconfigMtimeMs: number
): boolean {
  return historyRaw.includes('"phase":"ingress"') && historyMtimeMs >= kubeconfigMtimeMs;
}

/** True when the engine's bring-up history shows THIS boot gated `ready`
 *  on the FULL platform (an `ingress` phase: registry /v2/ + the
 *  api-server's traefik route answering) — the honest-readiness engine
 *  contract. Old engines never write that phase (or the history file at
 *  all), and a stale history left behind by an engine downgrade fails
 *  the mtime freshness check — either way the CLI keeps the long,
 *  load-bearing wait budgets below; against a new engine the same waits
 *  shrink to fast-pass confirmations. */
function engineGuaranteedPlatformReady(name: string): boolean {
  try {
    const historyPath = path.join(vmDir(name), 'bringup-history.jsonl');
    const raw = fs.readFileSync(historyPath, 'utf8');
    return historyGuaranteesPlatformReady(
      raw,
      fs.statSync(historyPath).mtimeMs,
      fs.statSync(path.join(vmDir(name), 'kubeconfig.yaml')).mtimeMs
    );
  } catch {
    return false;
  }
}

// Deleting a microVM is not a plain engine passthrough. The Rust engine
// removes the VM and its on-disk state, but the credential profile that
// `vm up` minted (`microvm` for the default VM, `microvm-<name>`
// otherwise) lives in the CLI profile store — which the engine knows
// nothing about. Without pruning it, a deleted VM leaves an orphan
// cluster behind in both the CLI and the desktop (both read
// ~/.appliance/profiles.json). So both `appliance vm delete` and
// `appliance cluster rm --delete-vm` route through this one helper.

/** Delete a microVM via the engine, then prune its CLI credential
 *  profile. The profile is only removed once the engine confirms the VM
 *  is gone (exit 0), so a failed delete never strips a usable profile.
 *  Returns the engine's exit code. */
export function deleteVmAndProfile(name: string): number {
  const code = runVm(['delete', name]);
  if (code === 0) {
    const profiles = name === DEFAULT_VM_NAME ? [profileForVm(name), LEGACY_MICROVM_PROFILE] : [profileForVm(name)];
    for (const profile of profiles) {
      if (removeProfile(profile)) {
        console.log(chalk.dim(`removed credential profile '${profile}'`));
      }
    }
  }
  return code;
}

/**
 * Boot (or reuse) the microVM and wait until its cluster endpoint and
 * in-VM registry answer. Does NOT deliver or bootstrap the in-cluster
 * api-server — callers that run the control plane host-side
 * (`appliance server start`, `appliance dev`) stop here; `runUp`
 * continues on to the in-VM api-server.
 *
 * Throws (instead of exiting) on failure so programmatic callers can
 * catch and render their own remediation.
 */
export async function ensureVmRuntime(
  name: string = DEFAULT_VM_NAME,
  opts: {
    timeout?: number;
    resources?: { cpus?: number; memory?: number; dev?: boolean; mount?: string };
  } = {}
): Promise<VmRuntimeInfo> {
  // New engines gate `vm up` on the WHOLE platform (kubeconfig +
  // registry + api-server ingress), which folds the waits below into the
  // engine's own budget — so `up` needs headroom beyond the old
  // kubeconfig-only 600s for a cold, network-pulling first boot.
  const timeout = opts.timeout ?? 900;
  const resources = opts.resources ?? {};
  // Boot the VM + wait for its kubernetes endpoint. Per-VM resource
  // overrides are persisted into the spec by the engine, so they
  // survive restarts; omitting them keeps the VM's current sizing.
  // `--dev` provisions the VM as a development environment (persisted
  // one-way, so a later plain `up` keeps it a dev VM).
  const upArgs = ['up', name, '--timeout', String(timeout)];
  if (resources.cpus !== undefined) upArgs.push('--cpus', String(resources.cpus));
  if (resources.memory !== undefined) upArgs.push('--memory', String(resources.memory));
  if (resources.dev) upArgs.push('--dev');
  // Resolve --mount to an absolute path so it's unambiguous to the
  // engine regardless of its working directory (it canonicalizes too).
  if (resources.mount) upArgs.push('--mount', path.resolve(resources.mount));
  const status = runVm(upArgs);
  if (status !== 0) {
    throw new Error(
      `microVM '${name}' failed to come up (appliance-vm exited ${status}). ` +
        'Inspect the boot log with `appliance vm console`, or run `appliance doctor`.'
    );
  }
  // Read ports AFTER `vm up`: it creates the spec (with allocated
  // ports) when it didn't exist, so an earlier read may be stale.
  const ports = vmPorts(name);
  const kubeconfigPath = path.join(vmDir(name), 'kubeconfig.yaml');
  const kubeconfigDeadline = Date.now() + 30_000;
  while (!fs.existsSync(kubeconfigPath)) {
    if (Date.now() >= kubeconfigDeadline) {
      throw new Error(`expected kubeconfig at ${kubeconfigPath} after appliance-vm up`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  // Confirm the in-VM registry forward — image delivery for the
  // in-cluster api-server and every `appliance deploy` rides this. A T2
  // engine already gated `ready` on it, so this is a fast-pass check;
  // against an older engine (no `ingress` phase in its history) it stays
  // the load-bearing wait it always was — first boot includes the
  // registry:2 image pull.
  const engineReady = engineGuaranteedPlatformReady(name);
  console.log(chalk.cyan(engineReady ? '» confirming the in-VM registry' : '» waiting for the in-VM registry'));
  await waitForRegistry(`http://127.0.0.1:${ports.registryPort}/v2/`, engineReady ? 30_000 : 240_000);

  return { name, kubeconfigPath, ports };
}

export async function runUp(
  name: string,
  imageOverride: string | undefined,
  timeout: number,
  resources: { cpus?: number; memory?: number; dev?: boolean; mount?: string } = {},
  // `showDeployHint` controls the banner's closing `Deploy:` line.
  // `appliance vm up` leaves it on; `appliance init` suppresses it so its
  // own hand-off prints the single, unambiguous next command.
  opts: { showDeployHint?: boolean } = {}
): Promise<void> {
  const profile = profileForVm(name);
  if (imageOverride) {
    console.log(
      chalk.yellow(
        '--image is no longer used: the api-server runs as a guest binary, not a container. ' +
          'Point APPLIANCE_API_SERVER_BINARY at a prebuilt linux binary to override it.'
      )
    );
  }

  // 1. Stage the api-server guest artifacts BEFORE the boot so the
  //    engine embeds them into the boot media. No docker anywhere.
  try {
    await ensureApiServerArtifacts();
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }

  // 2. Boot + wait for the cluster and registry.
  let vm: VmRuntimeInfo;
  try {
    vm = await ensureVmRuntime(name, { timeout, resources });
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
  const ports = vm.ports;

  // 3. Wait for the guest api-server via its ingress route and adopt
  //    the VM's credential profile. First boot includes traefik's own
  //    install, so the cold budget is generous; credentials are minted
  //    with the VM's bootstrap token and kept when they still
  //    authenticate — no-key-sprawl behavior.
  // Existing credentials: the VM's own profile first, then (default VM
  // only) the legacy `microvm` profile from pre-cutover installs — a
  // verified legacy key is adopted into `local` rather than re-minted.
  const profiles = readProfiles().profiles;
  const existing = profiles[profile] ?? (name === DEFAULT_VM_NAME ? profiles[LEGACY_MICROVM_PROFILE] : undefined);
  const apiServerUrl = apiServerUrlForHostPort(ports.hostPort);
  let verified = false;
  if (existing) {
    try {
      await waitForApiServerUrl(apiServerUrl, 60_000);
      const client = createApplianceClient({
        baseUrl: apiServerUrl,
        credentials: { keyId: existing.keyId, secret: existing.secret },
        product: 'cli',
      });
      verified = (await client.listProjects()).success;
    } catch {
      verified = false;
    }
  }
  if (verified && existing) {
    console.log(`${chalk.green('✓')} api-server reachable; profile ${chalk.bold(profile)} already authenticated`);
    persistVmCredentials(name, profile, { apiUrl: apiServerUrl, keyId: existing.keyId, secret: existing.secret });
  } else {
    // Fast-pass against a T2 engine (which already gated `ready` on the
    // api-server's ingress route); the long cold budget stays for older
    // engines, whose first boot installs traefik inside this window.
    const engineReady = engineGuaranteedPlatformReady(name);
    console.log(chalk.cyan(engineReady ? '» confirming the in-VM api-server' : '» waiting for the in-VM api-server'));
    await waitForApiServerUrl(apiServerUrl, engineReady ? 60_000 : 600_000);
    const token = readVmBootstrapToken(name);
    const keyName = name === DEFAULT_VM_NAME ? 'Dev Machine' : `Dev Machine (${name})`;
    const apiKey = await mintApiKey(apiServerUrl, token, keyName);
    persistVmCredentials(name, profile, { apiUrl: apiServerUrl, keyId: apiKey.id, secret: apiKey.secret });
    console.log(`${chalk.green('✓')} api-server ready; credentials saved to profile ${chalk.bold(profile)}`);
  }

  // Version-skew preflight: compare the guest api-server's reported
  // version with this CLI's SDK. Purely advisory (a one-line warn with
  // the fix), and best-effort — an older guest binary without
  // cluster-info must never fail a successful bring-up.
  await warnOnServerVersionSkew(profile, apiServerUrl);

  // Publish the egress policy into the cluster now that the namespace
  // exists, so the api-server can confine workloads per policy. Best-
  // effort: a permissive default policy is a harmless no-op.
  runVm(['egress', 'sync', name]);

  console.log();
  console.log(chalk.green(`MicroVM runtime '${name}' is up.`));
  console.log(`  API server:  ${apiServerUrl}`);
  console.log(`  Ingress:     http://*.appliance.localhost:${ports.hostPort}`);
  console.log(`  Profile:     ${profile}`);
  if (opts.showDeployHint ?? true) {
    console.log(`  Deploy:      appliance deploy <project> <environment> --profile ${profile}`);
  }
  if (resources.dev) {
    const nameFlag = name === DEFAULT_VM_NAME ? '' : ` --name ${name}`;
    const workspace = resources.mount
      ? `/persist/workspace ← ${path.resolve(resources.mount)} (shared from the host)`
      : '/persist/workspace (persists across stop/up)';
    console.log(`  Workspace:   ${workspace}`);
    console.log(`  Shell:       appliance vm dev shell${nameFlag}`);
    console.log(chalk.dim('  (the dev toolchain finishes installing in the background on first boot)'));
  }
}

/** One-line advisory when the guest api-server's version ≠ this CLI's
 *  SDK version (they release in lockstep, so skew means the guest
 *  binary — baked into boot media — lags the CLI, or vice versa).
 *  Best-effort: pre-cluster-info guests and transient errors warn
 *  nothing and never fail the bring-up. */
async function warnOnServerVersionSkew(profile: string, apiServerUrl: string): Promise<void> {
  try {
    const entry = readProfiles().profiles[profile];
    if (!entry) return;
    const client = createApplianceClient({
      baseUrl: apiServerUrl,
      credentials: { keyId: entry.keyId, secret: entry.secret },
      product: 'cli',
    });
    const info = await client.getClusterInfo();
    if (!info.success) return;
    // Normalize the optional v-prefix (the SDK stamps "v1.x.y").
    const server = info.data.serverVersion?.replace(/^v/, '');
    const cli = SDK_VERSION.replace(/^v/, '');
    // Unstamped dev builds ('0.0.0-…') can't be meaningfully compared.
    if (!server || cli.startsWith('0.0.0') || server.startsWith('0.0.0')) return;
    if (server !== cli) {
      console.log(
        chalk.yellow(
          `⚠ control plane is v${server} but this CLI is v${cli} — run \`appliance upgrade\` for how to update.`
        )
      );
    }
  } catch {
    // advisory only
  }
}

async function waitForRegistry(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return;
    } catch {
      // keep polling
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `in-VM registry not reachable at ${url} after ${Math.round(timeoutMs / 1000)}s.\n` +
          'The VM booted but its registry forward never came up. Inspect the boot log with `appliance vm console`, ' +
          'and run `appliance doctor` to confirm the host prerequisites (free ports, virtualization) are healthy.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** Save a VM's credentials to its profile — dual-written to the legacy
 *  `microvm` name for the default VM (one release of back-compat: the
 *  desktop's cluster registry and existing scripts read it). */
function persistVmCredentials(
  name: string,
  profile: string,
  creds: { apiUrl: string; keyId: string; secret: string }
): void {
  saveCredentials(creds, profile);
  if (name === DEFAULT_VM_NAME) {
    saveCredentials(creds, LEGACY_MICROVM_PROFILE);
  }
}

/**
 * Bring the ONE local runtime (the default VM + its guest api-server)
 * up and adopt the `local` profile — the front door `appliance dev`
 * (and the `server start` shim) call. Thin alias over `runUp` so every
 * entry point shares the exact same bring-up.
 */
export async function ensureLocalRuntime(
  resources: { cpus?: number; memory?: number; dev?: boolean; mount?: string } = {}
): Promise<void> {
  await runUp(DEFAULT_VM_NAME, undefined, 900, resources, { showDeployHint: false });
}

/**
 * Read the VM's bootstrap token — generated once by the engine
 * (`appliance-vm up`) and persisted both host-side (here) and inside
 * the guest, where the api-server binary verifies create-key calls
 * against it.
 */
function readVmBootstrapToken(name: string): string {
  const tokenPath = path.join(vmDir(name), 'bootstrap-token');
  try {
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    if (token) return token;
  } catch {
    // fall through to the error below
  }
  throw new Error(
    `no bootstrap token at ${tokenPath} — the VM booted without the api-server staged. ` +
      'Re-run `appliance vm up` (the CLI stages the guest binary first), or check `appliance vm console` for boot errors.'
  );
}
