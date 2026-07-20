import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import chalk from 'chalk';
import type { EngineVmStatus } from './microvm-up.js';

// Shared plumbing for the `appliance up`/`down`/`logs`/`status` sandbox
// commands (docs/up.md). These drive the in-guest Docker engine inside
// the ONE managed microVM, building + running a project's own container
// definition from the host workspace shared over VirtioFS.
//
// The binary resolution + run helpers deliberately mirror
// `appliance-vm.ts` (the microVM engine driver) so both surfaces resolve
// the same `appliance-vm` Rust binary the same way.

/** The single managed VM everything shares: the deploy runtime (k3s +
 *  registry + buildkitd + the guest api-server) AND the dev/agent
 *  sandbox sessions. One thing to boot, one lifecycle, one mental
 *  model — `up`, `agent`, and `dev` all land in the same machine. */
export const DEFAULT_SANDBOX_VM = 'appliance';

/** The retired dedicated sandbox VM's name — used only to hint at
 *  reclaiming its disk after the merge. */
export const RETIRED_SANDBOX_VM = 'appliance-sbx';

/** Guest path the host workspace is shared at (set by `--mount`). */
const GUEST_WORKSPACE = '/persist/workspace';

/** Marker the in-guest bootstrap drops once dockerd is provisioned. */
const DOCKER_READY_MARKER = '/persist/.docker-ready';

// ---- appliance-vm binary + run helpers (mirrors appliance-vm.ts) -------

/** Resolve the `appliance-vm` binary: explicit override → managed
 *  install → PATH → repo build. Identical order to appliance-vm.ts. */
export function vmBinary(): string {
  const candidates = [
    process.env.APPLIANCE_VM,
    path.join(os.homedir(), '.appliance', 'bin', 'appliance-vm'),
    'appliance-vm',
    path.resolve('packages/vm/target/release/appliance-vm'),
    path.resolve('packages/vm/target/debug/appliance-vm'),
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  console.error(
    chalk.red(
      'appliance-vm binary not found. Build it with `cargo build && ./scripts/sign-dev.sh` in packages/vm, or set APPLIANCE_VM.'
    )
  );
  process.exit(1);
}

export function vmDir(name: string): string {
  return path.join(os.homedir(), '.appliance', 'vm', name);
}

/** Run an `appliance-vm` subcommand, inheriting stdio. Returns its code. */
export function runVm(args: string[]): number {
  const r = spawnSync(vmBinary(), args, { stdio: 'inherit' });
  return r.status ?? 1;
}

/** Run an `appliance-vm` subcommand and capture stdout (stderr passes
 *  through). Returns the exit code + trimmed stdout. */
export function runVmCapture(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(vmBinary(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim() };
}

/** Run a command inside the VM via `appliance-vm shell <vm> -- <cmd...>`,
 *  inheriting stdio (build/run output streams straight through). */
export function vmShell(vm: string, command: string[]): number {
  return runVm(['shell', vm, '--', ...command]);
}

/** Run a command in the guest and capture its stdout — the quiet probe
 *  behind readiness checks and `status`. */
export function vmShellCapture(vm: string, command: string[]): { status: number; stdout: string } {
  return runVmCapture(['shell', vm, '--', ...command]);
}

/** Run a single in-guest shell SCRIPT as the appliance user over the
 *  vsock one-shot path, capturing stdout. Passing the script as ONE
 *  element makes the engine's space-join a no-op, so the guest login
 *  shell parses it verbatim (multi-element commands lose their quoting).
 *  The agent runner (utils/agent.ts) uses this to install-on-first-use +
 *  spawn the detached `agent-<id>` tmux session in one invocation. */
export function vmRunScript(vm: string, script: string): { status: number; stdout: string } {
  return vmShellCapture(vm, [script]);
}

// ---- VM spec / state ---------------------------------------------------

interface VmSpecOnDisk {
  devMount?: string;
  docker?: boolean;
}

/** The persisted spec of a VM (`vm.json`), or null when undefined. */
function readVmSpec(name: string): VmSpecOnDisk | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(vmDir(name), 'vm.json'), 'utf8')) as VmSpecOnDisk;
  } catch {
    return null;
  }
}

/** The slice of the engine's status JSON the sandbox flows read. The
 *  full shape is `EngineVmStatus` in microvm-up.ts — derive from it so
 *  the two can never model the same engine output differently. */
export type VmStatusJson = Pick<EngineVmStatus, 'exists' | 'running'> & Partial<Pick<EngineVmStatus, 'clusterReady'>>;

/** Parse `appliance-vm status <vm>` JSON, or null when unreadable. */
export function vmStatus(name: string): VmStatusJson | null {
  const r = runVmCapture(['status', name]);
  try {
    return JSON.parse(r.stdout) as VmStatusJson;
  } catch {
    return null;
  }
}

/** The guest's IP, persisted by the engine at boot
 *  (`~/.appliance/vm/<vm>/guest-ip`). Null when the VM hasn't booted far
 *  enough to discover its lease. Surfaced as the host-reachable URL host
 *  for published ports (docs/up.md §4 — the v1 guest-IP URL). */
export function guestIp(name: string): string | null {
  try {
    const ip = fs.readFileSync(path.join(vmDir(name), 'guest-ip'), 'utf8').trim();
    return ip || null;
  } catch {
    return null;
  }
}

// ---- project detection -------------------------------------------------

export type ProjectType = 'dockerfile' | 'compose' | 'devcontainer' | 'none';

/** Compose file names in compose's own discovery order (docs/up.md §1). */
export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
export const DEVCONTAINER_FILES = ['.devcontainer/devcontainer.json', '.devcontainer.json'];

/** The first compose file present in `dir` (by COMPOSE_FILES precedence),
 *  as a bare file name relative to `dir`, or null when none exists. */
export function findComposeFile(dir: string): string | null {
  return COMPOSE_FILES.find((f) => fs.existsSync(path.join(dir, f))) ?? null;
}

/** Resolve the project type in cwd by docs/up.md §1 precedence
 *  (compose → devcontainer → dockerfile). Compose/devcontainer are
 *  detected but not run by this version. */
export function detectProjectType(dir: string): ProjectType {
  if (COMPOSE_FILES.some((f) => fs.existsSync(path.join(dir, f)))) return 'compose';
  if (DEVCONTAINER_FILES.some((f) => fs.existsSync(path.join(dir, f)))) return 'devcontainer';
  if (fs.existsSync(path.join(dir, 'Dockerfile'))) return 'dockerfile';
  return 'none';
}

/** Parse the first `EXPOSE <port>` from a Dockerfile, or null when none.
 *  EXPOSE may carry `<port>/<proto>` and multiple ports — we take the
 *  first numeric token of the first EXPOSE line. */
export function parseExposedPort(dockerfilePath: string): number | null {
  let text: string;
  try {
    text = fs.readFileSync(dockerfilePath, 'utf8');
  } catch {
    return null;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!/^EXPOSE\s/i.test(line)) continue;
    const token = line
      .replace(/^EXPOSE\s+/i, '')
      .trim()
      .split(/\s+/)[0];
    const port = Number.parseInt((token ?? '').split('/')[0], 10);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return null;
}

// ---- compose introspection ---------------------------------------------

/** A published-port mapping for one compose service, from `compose ps`. */
export interface ComposePort {
  /** Host port published on the guest's 0.0.0.0. */
  hostPort: number;
  /** Container port the host port maps to. */
  containerPort: number;
}

/** One service's runtime state, as surfaced by `docker compose ps`. */
export interface ComposePsService {
  /** Compose service name (the key under `services:`). */
  service: string;
  /** Container state, e.g. `running`, `exited`, or null when unknown. */
  state: string | null;
  /** Published host:container port mappings (TCP), in declaration order. */
  ports: ComposePort[];
}

/**
 * Parse `docker compose ps --format json` output. Recent compose emits
 * one JSON object per line (newline-delimited); older builds emit a
 * single JSON array. Both are handled. Returns one entry per service
 * row, with its published TCP ports extracted from the `Publishers`
 * array (preferred) or the `Ports` string (fallback).
 */
export function parseComposePsJson(stdout: string): ComposePsService[] {
  const objects: Record<string, unknown>[] = [];
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // Try a single JSON value first (array or object), then fall back to
  // newline-delimited objects — the shape varies across compose versions.
  let parsedWhole: unknown;
  try {
    parsedWhole = JSON.parse(trimmed);
  } catch {
    parsedWhole = undefined;
  }
  if (Array.isArray(parsedWhole)) {
    for (const v of parsedWhole) if (v && typeof v === 'object') objects.push(v as Record<string, unknown>);
  } else if (parsedWhole && typeof parsedWhole === 'object') {
    objects.push(parsedWhole as Record<string, unknown>);
  } else {
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        const obj = JSON.parse(l);
        if (obj && typeof obj === 'object') objects.push(obj as Record<string, unknown>);
      } catch {
        // Skip non-JSON noise rather than failing the whole parse.
      }
    }
  }

  return objects.map((o) => {
    const service = String(o.Service ?? o.service ?? o.Name ?? '');
    const stateRaw = o.State ?? o.state ?? null;
    const state = stateRaw == null ? null : String(stateRaw);
    return { service, state, ports: composePortsFrom(o) };
  });
}

/** Extract published TCP ports from a `compose ps` JSON row, preferring
 *  the structured `Publishers` array and falling back to the `Ports`
 *  display string. Only ports with a non-zero published host port count. */
function composePortsFrom(o: Record<string, unknown>): ComposePort[] {
  const out: ComposePort[] = [];
  const seen = new Set<string>();
  const add = (hostPort: number, containerPort: number) => {
    if (!Number.isInteger(hostPort) || hostPort <= 0) return;
    if (!Number.isInteger(containerPort) || containerPort <= 0) return;
    const key = `${hostPort}:${containerPort}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ hostPort, containerPort });
  };

  const publishers = o.Publishers ?? o.publishers;
  if (Array.isArray(publishers)) {
    for (const p of publishers) {
      if (!p || typeof p !== 'object') continue;
      const pub = p as Record<string, unknown>;
      const proto = String(pub.Protocol ?? pub.protocol ?? 'tcp').toLowerCase();
      if (proto !== 'tcp') continue;
      add(Number(pub.PublishedPort ?? pub.published ?? 0), Number(pub.TargetPort ?? pub.target ?? 0));
    }
  }

  if (out.length === 0 && typeof o.Ports === 'string') {
    for (const m of o.Ports.matchAll(/(?:\d+\.\d+\.\d+\.\d+:)?(\d+)->(\d+)\/tcp/g)) {
      add(Number.parseInt(m[1], 10), Number.parseInt(m[2], 10));
    }
  }
  return out;
}

/**
 * Best-effort parse of each compose service's `depends_on` (docs/up.md
 * item 7) without a YAML dependency. Handles the two common forms:
 *
 *   depends_on: [a, b]            # inline list
 *   depends_on:                   # block list
 *     - a
 *     - b
 *   depends_on:                   # mapping form (long syntax)
 *     a:
 *       condition: service_started
 *
 * Returns a map of service name → dependency names. Indentation-driven
 * and intentionally conservative: anything it can't confidently read is
 * simply omitted (the field is optional in link.json).
 */
export function parseComposeDependsOn(composePath: string): Record<string, string[]> {
  let text: string;
  try {
    text = fs.readFileSync(composePath, 'utf8');
  } catch {
    return {};
  }
  const lines = text.split('\n');
  const result: Record<string, string[]> = {};

  const indentOf = (l: string) => l.length - l.replace(/^\s+/, '').length;

  // Locate the top-level `services:` block and its child indent.
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^services:\s*$/.test(lines[i])) break;
  }
  if (i >= lines.length) return {};
  i++;

  // Determine the service-key indent from the first non-blank child.
  let serviceIndent = -1;
  for (let j = i; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    if (indentOf(l) === 0) return result; // dedented out of `services:`
    serviceIndent = indentOf(l);
    break;
  }
  if (serviceIndent < 0) return result;

  let currentService: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = indentOf(line);
    if (indent === 0) break; // left the services block

    const serviceMatch = indent === serviceIndent ? line.trim().match(/^([A-Za-z0-9._-]+):\s*$/) : null;
    if (serviceMatch) {
      currentService = serviceMatch[1];
      continue;
    }
    if (!currentService) continue;

    const depMatch = line.trim().match(/^depends_on:\s*(.*)$/);
    if (!depMatch) continue;

    const inline = depMatch[1].trim();
    const deps: string[] = [];
    if (inline.startsWith('[')) {
      // Inline flow list: depends_on: [a, b]
      for (const tok of inline.replace(/^\[|\]$/g, '').split(',')) {
        const name = tok.trim().replace(/['"]/g, '');
        if (name) deps.push(name);
      }
    } else {
      // Block form: list items (`- name`) or mapping keys (`name:`),
      // indented deeper than `depends_on`.
      const depIndent = indent;
      for (let k = i + 1; k < lines.length; k++) {
        const dl = lines[k];
        if (!dl.trim() || dl.trim().startsWith('#')) continue;
        if (indentOf(dl) <= depIndent) break;
        const listItem = dl.trim().match(/^-\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/);
        const mapKey = dl.trim().match(/^['"]?([A-Za-z0-9._-]+)['"]?:\s*$/);
        if (listItem) deps.push(listItem[1]);
        else if (mapKey) deps.push(mapKey[1]);
      }
    }
    if (deps.length) result[currentService] = deps;
  }
  return result;
}

// ---- devcontainer introspection ----------------------------------------

/** The machine-readable result of `devcontainer up`. The CLI emits one
 *  JSON object on stdout once bring-up finishes. */
export interface DevcontainerUpResult {
  outcome: string;
  containerId?: string;
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
  message?: string;
}

/**
 * Parse the `devcontainer up` result. The CLI streams progress on
 * stderr and prints a single JSON object on stdout (e.g.
 * `{"outcome":"success","containerId":"<id>",...}`). We scan every line
 * and return the LAST parseable JSON object that carries an `outcome`
 * — robust to any leading non-JSON noise sharing the stdout stream.
 * Returns null when no result object is present.
 */
export function parseDevcontainerUp(stdout: string): DevcontainerUpResult | null {
  let result: DevcontainerUpResult | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj && typeof obj === 'object' && 'outcome' in obj) {
        result = {
          outcome: String(obj.outcome),
          containerId: obj.containerId == null ? undefined : String(obj.containerId),
          remoteUser: obj.remoteUser == null ? undefined : String(obj.remoteUser),
          remoteWorkspaceFolder: obj.remoteWorkspaceFolder == null ? undefined : String(obj.remoteWorkspaceFolder),
          message: obj.message == null ? undefined : String(obj.message),
        };
      }
    } catch {
      // Not a JSON line — skip (progress is on stderr, but be defensive).
    }
  }
  return result;
}

/** One published port of a devcontainer's container, from `docker port`. */
export interface PublishedPort {
  hostPort: number;
  containerPort: number;
}

/**
 * Parse `docker port <container>` output into published TCP mappings.
 * Each line looks like `3000/tcp -> 0.0.0.0:8201` (a container may emit
 * an IPv4 and IPv6 line for the same mapping — dedupe). UDP lines are
 * ignored. Returns the mappings in the order docker reports them.
 */
export function parseDockerPort(stdout: string): PublishedPort[] {
  const out: PublishedPort[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // `<containerPort>/<proto> -> <host>:<hostPort>`
    const m = line.match(/^(\d+)\/(tcp|udp)\s*->\s*.*:(\d+)$/i);
    if (!m) continue;
    if (m[2].toLowerCase() !== 'tcp') continue;
    const containerPort = Number.parseInt(m[1], 10);
    const hostPort = Number.parseInt(m[3], 10);
    if (!Number.isInteger(containerPort) || !Number.isInteger(hostPort)) continue;
    const key = `${hostPort}:${containerPort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hostPort, containerPort });
  }
  return out;
}

/** Capture the published ports of a container in the guest, best-effort.
 *  Empty on any failure (container gone / VM down). */
export function devcontainerPublishedPorts(vm: string, containerId: string): PublishedPort[] {
  const r = vmShellCapture(vm, ['docker', 'port', containerId]);
  if (r.status !== 0) return [];
  return parseDockerPort(r.stdout);
}

// ---- identity + ports --------------------------------------------------

/** Normalize a string to a DNS-1123 label (lowercase alphanumeric + `-`,
 *  edges trimmed). The deterministic project id used for the container
 *  name + link.json project (docs/up.md §5). */
export function dnsLabel(input: string): string {
  const label = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return label || 'app';
}

/** A deterministic host port in the 8100–8999 range, derived from the
 *  project name so a project's URL is stable across `up`s without
 *  colliding with the reserved 8081/6443/5052/5053 ports. `--host-port`
 *  overrides it. */
export function deterministicHostPort(project: string): number {
  let h = 0;
  for (const ch of project) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 8100 + (h % 900);
}

/**
 * Whether two resolved mount paths point at the same folder. The engine
 * persists devMount canonicalized, which on Windows means the extended-length
 * `\\?\C:\…` form — path.resolve keeps that prefix, so a naive equality
 * against the plain `C:\…` projectDir NEVER matches and every `agent start`
 * forces a pointless VM restart. Strip the prefix and case-fold (Windows
 * paths are case-insensitive) before comparing.
 */
export function sameMountPath(
  a: string | null,
  b: string | null,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (a === null || b === null) return a === b;
  const norm = (p: string) => {
    const stripped = p.replace(/^\\\\\?\\/, '');
    return platform === 'win32' ? stripped.toLowerCase() : stripped;
  };
  return norm(a) === norm(b);
}

// ---- VM bring-up + docker readiness ------------------------------------

/** Options for {@link ensureSandboxVm}. */
export interface EnsureSandboxOpts {
  /** Provision the in-guest Docker engine (and wait on it). `appliance
   *  up` always needs it to build/run the project container; `appliance
   *  agent start` only with `--docker`. Default: no docker — the fastest,
   *  smallest agent sandbox (docs/fast-spin-up.md §1.5). */
  docker?: boolean;
  /** Readiness timeout (ms). */
  timeoutMs?: number;
}

/**
 * Ensure the ONE managed VM is up as a dev environment with the project
 * workspace mounted, then wait for the in-guest agent runtime (shell +
 * Node). The same VM carries the deploy runtime (k3s + guest api-server),
 * so `up`/`agent` and `dev` share a single machine and lifecycle.
 *
 * The mount (and docker provisioning) apply on the next boot, so if the
 * VM is already running with a different mount — or `--docker` is newly
 * requested — we stop it and re-up (one reboot, like a mount change).
 *
 * Returns once the agent runtime answers (plus dockerd when `docker`).
 */
export async function ensureSandboxVm(vm: string, projectDir: string, opts: EnsureSandboxOpts = {}): Promise<void> {
  const { docker = false, timeoutMs = 300_000 } = opts;
  const desiredMount = path.resolve(projectDir);
  const status = vmStatus(vm);
  const spec = readVmSpec(vm);
  const running = status?.running ?? false;
  const currentMount = spec?.devMount ? path.resolve(spec.devMount) : null;
  const currentDocker = spec?.docker ?? false;

  hintRetiredSandboxVm();

  // Stage the api-server guest artifacts BEFORE any boot: the merged VM
  // carries the control plane, and provisioning only reads the staged
  // assets at boot — a VM booted without them would make a later
  // `appliance dev` wait on an api-server that never comes up.
  const { ensureApiServerArtifacts } = await import('./api-server-artifact.js');
  await ensureApiServerArtifacts();

  // A running VM only picks up a new mount — or newly-requested docker —
  // on its next boot. Restart it when the share points elsewhere, or when
  // --docker is newly requested (the lazy re-up), so the change takes
  // effect this run.
  const needsRemount = running && !sameMountPath(currentMount, desiredMount);
  const needsDocker = running && docker && !currentDocker;
  if (needsRemount || needsDocker) {
    const why = needsRemount ? `mounted elsewhere (${currentMount ?? 'none'})` : 'docker newly requested (--docker)';
    console.log(chalk.yellow(`» VM '${vm}' ${why}; restarting to apply`));
    const stop = runVm(['stop', vm]);
    if (stop !== 0) throw new Error(`failed to stop VM '${vm}' to apply the change`);
  }

  // `--dev` provisions the dev toolchain + workspace on the SAME VM the
  // deploy runtime lives in (persisted one-way by the engine).
  const upArgs = ['up', vm, '--dev', '--mount', desiredMount];
  if (docker) upArgs.push('--docker');
  console.log(
    chalk.cyan(`» bringing up VM '${vm}' (${desiredMount} → ${GUEST_WORKSPACE}${docker ? ' + docker' : ''})`)
  );
  const code = runVm(upArgs);
  if (code !== 0) throw new Error(`appliance-vm up '${vm}' failed (exit ${code})`);

  // Readiness is the agent runtime: the dev toolchain installs in the
  // background, so poll until node answers. Only a --docker sandbox
  // additionally waits on the backgrounded dockerd.
  await waitForAgentRuntime(vm, timeoutMs);
  if (docker) await waitForDocker(vm, timeoutMs);
}

/** One-time nudge: the dedicated sandbox VM was merged into the main
 *  `appliance` VM — surface how to reclaim the old one's disk. */
function hintRetiredSandboxVm(): void {
  if (fs.existsSync(vmDir(RETIRED_SANDBOX_VM))) {
    console.log(
      chalk.dim(
        `note: the separate '${RETIRED_SANDBOX_VM}' sandbox VM was merged into '${DEFAULT_SANDBOX_VM}' — ` +
          `reclaim its disk with \`appliance vm delete ${RETIRED_SANDBOX_VM}\`.`
      )
    );
  }
}

/** Poll until the in-guest agent runtime is ready: the vsock shell
 *  answers and `node` is on PATH (the Node toolchain the agent rides).
 *  `up`'s agent-only gate already waits on `.dev-ready`, so this is a
 *  belt-and-suspenders probe that returns near-instantly. The agent CLI
 *  itself is installed on first use by the runner, so we probe only the
 *  runtime, not the agent binary. */
export async function waitForAgentRuntime(vm: string, timeoutMs: number): Promise<void> {
  console.log(chalk.cyan('» waiting for the in-guest agent runtime (node + shell)'));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = vmShellCapture(vm, ['command', '-v', 'node']);
    if (probe.status === 0 && probe.stdout.trim()) {
      console.log(`${chalk.green('✓')} agent runtime ready`);
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the in-guest agent runtime never became ready in '${vm}' (waited ${Math.round(timeoutMs / 1000)}s).\n` +
          'The Node toolchain installs in the background on first boot and pulls from the network — ' +
          `inspect it with \`appliance vm console ${vm}\` or retry once the cache is warm.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** Poll until the in-guest dockerd is provisioned (`.docker-ready`
 *  marker present and `docker version` answers). Provisioning is
 *  backgrounded so it can lag the cluster by up to ~1 min on a cold
 *  cache. */
export async function waitForDocker(vm: string, timeoutMs: number): Promise<void> {
  console.log(chalk.cyan('» waiting for the in-guest docker engine'));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const marker = vmShellCapture(vm, ['test', '-f', DOCKER_READY_MARKER]);
    if (marker.status === 0) {
      const ver = vmShellCapture(vm, ['docker', 'version']);
      if (ver.status === 0) {
        console.log(`${chalk.green('✓')} docker engine ready`);
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the in-guest docker engine never became ready in '${vm}' (waited ${Math.round(timeoutMs / 1000)}s).\n` +
          'Provisioning runs in the background on first boot and pulls packages from the network — ' +
          'inspect it with `appliance vm console --name ' +
          vm +
          '` or retry once the cache is warm.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

export { GUEST_WORKSPACE };

// ---- status ------------------------------------------------------------

/**
 * Print the sandbox state for the cwd project: the VM state, each
 * service's runtime state, and its host-reachable URL (docs/up.md
 * §2/§4). Returns the process exit code. Called by `appliance status`
 * when a sandbox link is present in cwd. Both the single-container
 * Dockerfile path and the multi-service compose path are handled.
 */
export async function runSandboxStatus(opts: { json?: boolean } = {}): Promise<number> {
  // Lazy import to avoid a cycle with link.ts importing nothing here.
  const { readSandboxLink } = await import('./link.js');
  const sandbox = readSandboxLink();
  if (!sandbox) {
    console.error(chalk.red('no sandbox link in this folder — run `appliance up` first.'));
    return 1;
  }
  if (sandbox.type === 'compose') return runComposeStatus(sandbox, opts);
  if (sandbox.type === 'devcontainer') return runDevcontainerStatus(sandbox, opts);

  const vm = sandbox.vm;
  const status = vmStatus(vm);
  const ip = guestIp(vm);
  const service = sandbox.services[0];
  const url = ip && service?.hostPort ? `http://${ip}:${service.hostPort}` : null;

  // `docker ps` filtered to this project's container, formatted as a
  // single tab-separated line for parsing + display.
  const ps = vmShellCapture(vm, [
    'docker',
    'ps',
    '-a',
    '--filter',
    `name=^${sandbox.project}$`,
    '--format',
    '{{.Names}}\t{{.Status}}\t{{.Ports}}',
  ]);
  const psLine = ps.status === 0 ? ps.stdout : '';
  const [, state, ports] = psLine ? psLine.split('\t') : [];

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          project: sandbox.project,
          type: sandbox.type,
          vm,
          vmRunning: status?.running ?? false,
          container: sandbox.project,
          state: state ?? null,
          ports: ports ?? null,
          url,
          services: sandbox.services,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(chalk.bold(`Sandbox — ${sandbox.project} (${sandbox.type})`));
  console.log(`  VM:         ${vm} (${status?.running ? chalk.green('running') : chalk.dim('stopped')})`);
  if (!psLine) {
    console.log(`  Container:  ${chalk.yellow('not found')} — run \`appliance up\` to start it`);
    return 0;
  }
  console.log(`  Container:  ${sandbox.project} (${state ?? 'unknown'})`);
  if (ports) console.log(`  Ports:      ${ports}`);
  if (url) console.log(`  URL:        ${chalk.bold(url)}`);
  else console.log(chalk.dim('  URL:        guest IP not known yet — is the VM finished booting?'));
  return 0;
}

/**
 * Status for a compose project: iterate every service in the link,
 * overlaying live state from `docker compose ps` where the VM is
 * reachable, and print each service's state + URL (or `internal` for an
 * unpublished service). Mirrors the Dockerfile path's block style.
 */
async function runComposeStatus(sandbox: import('./link.js').SandboxLink, opts: { json?: boolean }): Promise<number> {
  const vm = sandbox.vm;
  const status = vmStatus(vm);
  const ip = guestIp(vm);

  // Overlay live state from the guest (best-effort — the VM may be down).
  const live = composePsLive(vm, sandbox.project);
  const stateOf = (name: string): string | null => live.get(name)?.state ?? null;

  const services = sandbox.services.map((svc) => {
    const url = ip && svc.exposed && svc.hostPort ? `http://${ip}:${svc.hostPort}` : null;
    return { ...svc, state: stateOf(svc.name), url };
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          project: sandbox.project,
          type: sandbox.type,
          vm,
          vmRunning: status?.running ?? false,
          composeFile: sandbox.composeFile ?? null,
          services,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(chalk.bold(`Sandbox — ${sandbox.project} (${sandbox.type})`));
  console.log(`  VM:         ${vm} (${status?.running ? chalk.green('running') : chalk.dim('stopped')})`);
  const nameWidth = Math.max(4, ...services.map((s) => s.name.length));
  for (const svc of services) {
    const name = svc.name.padEnd(nameWidth);
    const stateLabel = svc.state
      ? svc.state === 'running'
        ? chalk.green(svc.state)
        : chalk.yellow(svc.state)
      : chalk.dim('not running');
    if (svc.url) {
      console.log(`  ${name}  ${chalk.bold(svc.url)}   (:${svc.port}) — ${stateLabel}`);
    } else if (svc.exposed && svc.hostPort) {
      console.log(`  ${name}  host port ${svc.hostPort} (:${svc.port}) — guest IP unknown — ${stateLabel}`);
    } else {
      console.log(`  ${name}  ${chalk.dim('internal')} — ${stateLabel}`);
    }
  }
  return 0;
}

/**
 * Status for a devcontainer project: show the container (by id) state
 * and any host-reachable URL for its published ports. The container is
 * looked up by the id the `@devcontainers/cli` reported at `up` time.
 */
async function runDevcontainerStatus(
  sandbox: import('./link.js').SandboxLink,
  opts: { json?: boolean }
): Promise<number> {
  const vm = sandbox.vm;
  const status = vmStatus(vm);
  const ip = guestIp(vm);
  const containerId = sandbox.containerId ?? '';

  // `docker ps` filtered to this container id, formatted as a single
  // tab-separated line for parsing + display.
  const ps = containerId
    ? vmShellCapture(vm, [
        'docker',
        'ps',
        '-a',
        '--filter',
        `id=${containerId}`,
        '--format',
        '{{.ID}}\t{{.Status}}\t{{.Ports}}',
      ])
    : { status: 1, stdout: '' };
  const psLine = ps.status === 0 ? ps.stdout : '';
  const [, state, ports] = psLine ? psLine.split('\t') : [];

  const published = containerId && psLine ? devcontainerPublishedPorts(vm, containerId) : [];
  const urls = ip ? published.map((p) => ({ ...p, url: `http://${ip}:${p.hostPort}` })) : [];

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          project: sandbox.project,
          type: sandbox.type,
          vm,
          vmRunning: status?.running ?? false,
          containerId: containerId || null,
          state: state ?? null,
          ports: ports ?? null,
          workspace: sandbox.workspace ?? null,
          urls,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(chalk.bold(`Sandbox — ${sandbox.project} (${sandbox.type})`));
  console.log(`  VM:         ${vm} (${status?.running ? chalk.green('running') : chalk.dim('stopped')})`);
  if (!psLine) {
    console.log(`  Container:  ${chalk.yellow('not found')} — run \`appliance up\` to start it`);
    return 0;
  }
  console.log(`  Container:  ${containerId.slice(0, 12)} (${state ?? 'unknown'})`);
  if (urls.length) {
    for (const u of urls) console.log(`  URL:        ${chalk.bold(u.url)}   (container :${u.containerPort})`);
  } else if (published.length && !ip) {
    console.log(chalk.dim('  URL:        guest IP not known yet — is the VM finished booting?'));
  } else {
    console.log(chalk.dim('  Ports:      none published — enter it with `appliance shell`'));
  }
  return 0;
}

/** Capture `docker compose ps` in the guest and index it by service
 *  name. Empty on any failure (VM down / project not up) so callers can
 *  fall back to the persisted link without special-casing. */
function composePsLive(vm: string, project: string): Map<string, ComposePsService> {
  const map = new Map<string, ComposePsService>();
  const r = vmShellCapture(vm, ['docker', 'compose', '-p', project, 'ps', '--format', 'json', '--all']);
  if (r.status !== 0) return map;
  for (const svc of parseComposePsJson(r.stdout)) {
    if (svc.service) map.set(svc.service, svc);
  }
  return map;
}
