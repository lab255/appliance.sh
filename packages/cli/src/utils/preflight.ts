import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import { helperBinDir, runInstall, runStatus } from '@appliance.sh/helper';
import type { StatusEntry } from '@appliance.sh/helper';

// Reusable preflight checks shared by `appliance doctor` and any other
// surface that needs a structured "can this machine run Appliance?"
// verdict (the desktop sidecar, CI smoke tests, …). Every check returns
// the same {status, remediation} shape so callers render a uniform
// checklist without branching on the check's identity.
//
// Docker is deliberately NOT checked: nothing in the appliance flow
// needs it anymore. The control plane runs as a guest binary inside the
// microVM and images build server-side with the in-VM BuildKit.
//
// Checks never throw: a probe that can't run (tool missing, command
// errors) resolves to a `fail` (or `warn`) with an actionable
// remediation, never a rejected promise. That keeps the orchestrator a
// flat `Promise.all` and guarantees `doctor` always prints a full
// report instead of bailing on the first surprise.

/** Ports the microVM runtime forwards on the host. A conflicting
 *  listener here is the single most common cause of a silent first-run
 *  failure (the runtime can't bind the port, and startup times out with
 *  an opaque message). */
export const REQUIRED_PORTS: PortSpec[] = [
  { port: 8081, purpose: 'ingress (HTTP) — *.appliance.localhost', probe: 'http://127.0.0.1:8081/' },
  { port: 6443, purpose: 'kubernetes API server', tlsProbe: true },
  { port: 5052, purpose: 'in-VM image registry', probe: 'http://127.0.0.1:5052/v2/' },
];

interface PortSpec {
  port: number;
  purpose: string;
  /** When set, an HTTP URL that answering on this port means *our own*
   *  runtime already holds it — so an occupied port is "runtime up",
   *  not a conflict. */
  probe?: string;
  /** When true, a port that completes a TLS handshake is recognized as
   *  our own runtime (the kube-apiserver on 6443 speaks TLS, not HTTP,
   *  so it has no plain-HTTP signature). */
  tlsProbe?: boolean;
}

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface CheckResult {
  /** Stable identifier, e.g. `bin:kubectl`, `port:8081`. */
  id: string;
  /** Short human label rendered as the checklist row title. */
  label: string;
  status: CheckStatus;
  /** One-line detail (resolved version, what was found, why it failed). */
  detail?: string;
  /** Actionable fix, shown only for `fail`/`warn`. */
  remediation?: string;
}

function pass(id: string, label: string, detail?: string): CheckResult {
  return { id, label, status: 'pass', detail };
}
function fail(id: string, label: string, detail: string, remediation: string): CheckResult {
  return { id, label, status: 'fail', detail, remediation };
}
function warn(id: string, label: string, detail: string, remediation: string): CheckResult {
  return { id, label, status: 'warn', detail, remediation };
}

/** Run `<tool> <args>` and return its trimmed first stdout line, or
 *  null when the tool isn't on PATH / exits non-zero. Never throws. */
function probeVersion(tool: string, args: string[]): string | null {
  try {
    const r = spawnSync(tool, args, { encoding: 'utf8' });
    if (r.status !== 0 || r.error) return null;
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
    return '';
  } catch {
    return null;
  }
}

// ---- toolchain ----------------------------------------------------------

/** Rust toolchain (rustc + cargo). Only needed to build the
 *  `appliance-vm` binary from a repo checkout, so this is a `warn`, not
 *  a hard fail — published binaries ship without it. */
export function checkRust(): CheckResult {
  const rustc = probeVersion('rustc', ['--version']);
  const cargo = probeVersion('cargo', ['--version']);
  if (rustc && cargo) {
    return pass('rust', 'Rust toolchain (rustc, cargo)', rustc);
  }
  const missing = [!rustc && 'rustc', !cargo && 'cargo'].filter(Boolean).join(', ');
  const install =
    process.platform === 'win32'
      ? 'Install Rust via rustup: `winget install Rustlang.Rustup` (or the installer at https://rustup.rs).'
      : 'Install Rust via rustup: `curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh`.';
  return warn(
    'rust',
    'Rust toolchain (rustc, cargo)',
    `${missing} not found — only needed to build appliance-vm from source`,
    `${install} Skip if you use the published microVM binary.`
  );
}

/** bun — used to compile the CLI and the api-server guest binary from a
 *  repo checkout. A `warn` for the same reason as Rust: end users run
 *  prebuilt binaries. */
export function checkBun(): CheckResult {
  const version = probeVersion('bun', ['--version']);
  if (version) {
    return pass('bun', 'bun (build toolchain)', `v${version}`);
  }
  const install =
    process.platform === 'win32'
      ? 'Install bun: `powershell -c "irm bun.sh/install.ps1 | iex"`.'
      : 'Install bun: `curl -fsSL https://bun.sh/install | bash`.';
  return warn(
    'bun',
    'bun (build toolchain)',
    'bun not found — only needed to compile the CLI / api-server guest binary from source',
    `${install} Skip if you only run published binaries.`
  );
}

// ---- helper-managed binaries -------------------------------------------

/** kubectl (and any other helper-managed tools) from the provider
 *  registry. Probed via `runStatus` so the resolution order (managed
 *  bin dir → PATH) matches exactly what the rest of the CLI uses. */
export async function checkHelperBinaries(): Promise<CheckResult[]> {
  let entries: StatusEntry[];
  try {
    entries = await runStatus();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [
      fail(
        'helper-binaries',
        'Helper binaries (kubectl)',
        `could not probe helper providers: ${message}`,
        'Install the helper-managed binaries (kubectl), then re-run `appliance doctor`.'
      ),
    ];
  }
  return entries.map((e) => {
    const { provider, check } = e;
    const label = `${provider.name} (${provider.description.replace(/\.$/, '')})`;
    if (check.installed) {
      return pass(`bin:${provider.name}`, label, check.version);
    }
    const remediation = provider.autoInstallable
      ? `Install ${provider.name} under ${helperBinDir()} or via your package manager (\`appliance doctor --fix\` installs it for you); the microVM runtime also fetches it on \`appliance vm up\` when missing.`
      : provider.manualInstall({
          binDir: helperBinDir(),
          platform: process.platform as 'darwin' | 'linux' | 'win32',
          arch: process.arch as 'x64' | 'arm64',
        }).instructions;
    const detail = check.error ?? 'not installed';
    return provider.required
      ? fail(`bin:${provider.name}`, label, detail, remediation)
      : warn(`bin:${provider.name}`, label, detail, remediation);
  });
}

// ---- ports --------------------------------------------------------------

/** Whether a TCP port is free to bind on 127.0.0.1. Resolves true when
 *  the bind succeeds (port free), false on EADDRINUSE (occupied). */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/** Whether an HTTP probe answers (any status) within a short timeout —
 *  i.e. *something* is serving HTTP there, used to recognize our own
 *  runtime holding a port rather than a foreign conflict. */
async function httpResponds(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

/** Whether a TLS handshake completes on 127.0.0.1:port — used to
 *  recognize the kube-apiserver (TLS, self-signed) holding 6443. We
 *  don't validate the cert; reaching `secureConnect` is enough signal
 *  that *a* TLS server (not a foreign plain-TCP listener) is there. */
function tlsResponds(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, timeout: 2_000 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function checkPorts(): Promise<CheckResult[]> {
  return Promise.all(
    REQUIRED_PORTS.map(async ({ port, purpose, probe, tlsProbe }) => {
      const id = `port:${port}`;
      const label = `Port ${port} free`;
      if (await portFree(port)) {
        return pass(id, label, purpose);
      }
      // Occupied. If it answers our runtime's own signature (HTTP for
      // ingress/registry, TLS for the kube-apiserver), the runtime is
      // simply already up — not a first-run conflict.
      const ours = (probe && (await httpResponds(probe))) || (tlsProbe && (await tlsResponds(port)));
      if (ours) {
        return pass(id, label, `held by a running Appliance runtime (${purpose})`);
      }
      const finder =
        process.platform === 'win32'
          ? `netstat -ano | findstr :${port}\` then \`taskkill /PID <pid>`
          : `lsof -i :${port}`;
      return fail(
        id,
        label,
        `something is already listening on ${port} (${purpose})`,
        `Free port ${port} (find the listener with \`${finder}\`) or stop a previously-started runtime before starting a new one.`
      );
    })
  );
}

// ---- Windows: WSL2 ------------------------------------------------------

/**
 * Decode output captured from a Windows system tool. `wsl.exe` writes
 * UTF-16LE to its streams (most other console tools write UTF-8/ANSI),
 * so a plain utf8 decode turns its messages into NUL-riddled garbage.
 * Sniff for the UTF-16LE signature — ASCII text has a NUL in every
 * second byte — and decode accordingly.
 */
export function decodeWindowsToolOutput(buf: Buffer): string {
  if (buf.length >= 2) {
    // BOM, or the even-index-NUL pattern of UTF-16LE ASCII.
    const hasBom = buf[0] === 0xff && buf[1] === 0xfe;
    let nulEven = 0;
    const probe = Math.min(buf.length, 64);
    for (let i = 1; i < probe; i += 2) if (buf[i] === 0) nulEven++;
    if (hasBom || nulEven > probe / 4) {
      return buf.toString('utf16le').replace(/^\uFEFF/, '');
    }
  }
  return buf.toString('utf8');
}

/**
 * Map a `wsl.exe` failure to what actually went wrong + the fix. The
 * two big classes a fresh machine hits:
 *   - virtualization disabled (BIOS/UEFI, or the "Virtual Machine
 *     Platform" Windows feature off) — HCS error 0x80370102 et al.
 *   - the WSL2 kernel missing/outdated — fixed by `wsl --update`.
 * Exported for tests; keep the signature list in sync with
 * packages/vm/src/backend/wsl.rs's boot-time classification.
 */
export function classifyWslFailure(output: string): { detail: string; remediation: string } {
  const text = output.toLowerCase();
  if (
    text.includes('0x80370102') ||
    text.includes('0x80370114') ||
    text.includes('virtual machine platform') ||
    text.includes('hypervisor') ||
    (text.includes('virtualization') && (text.includes('enable') || text.includes('not'))) ||
    text.includes('hcs')
  ) {
    return {
      detail: 'virtualization is not available to WSL2',
      remediation:
        'Enable virtualization in your BIOS/UEFI (often called "Intel VT-x", "AMD-V", or "SVM"), then enable the ' +
        'Windows feature: open PowerShell as Administrator, run ' +
        '`Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform`, and reboot.',
    };
  }
  if (text.includes('wsl --update') || text.includes('kernel') || text.includes('0x800701bc')) {
    return {
      detail: 'the WSL2 kernel is missing or outdated',
      remediation: 'Update WSL: open PowerShell and run `wsl --update`, then retry.',
    };
  }
  if (text.includes('wsl --install') || text.includes('not installed') || text.includes('no installed distributions')) {
    return {
      detail: 'WSL is not set up on this machine',
      remediation: 'Open PowerShell as Administrator, run `wsl --install`, reboot, then re-run `appliance init`.',
    };
  }
  return {
    detail: `wsl.exe is not working: ${output.trim().split('\n')[0] || 'unknown error'}`,
    remediation: 'Run `wsl --status` in PowerShell to see the underlying error; `wsl --update` fixes most of them.',
  };
}

export const WSL_MIRRORED_REMEDIATION =
  'Set `networkingMode=NAT` under `[wsl2]` in `%USERPROFILE%\\.wslconfig` (or remove the setting), run `wsl --shutdown`, then retry.';

/** Parse the one WSL setting the managed VM cannot support. The last
 * networkingMode assignment under [wsl2] wins; comments and other
 * sections are ignored. Exported for fixture-driven tests on any OS. */
export function wslConfigUsesMirroredNetworking(text: string): boolean {
  let inWsl2 = false;
  let mode: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^\uFEFF/, '');
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      inWsl2 = section[1].trim().toLowerCase() === 'wsl2';
      continue;
    }
    if (!inWsl2) continue;
    const equals = line.indexOf('=');
    if (equals < 0 || line.slice(0, equals).trim().toLowerCase() !== 'networkingmode') continue;
    mode = line
      .slice(equals + 1)
      .split(/[;#]/, 1)[0]
      .trim();
  }
  return mode?.toLowerCase() === 'mirrored';
}

/** Decode a `.wslconfig` at the filesystem boundary. Windows PowerShell 5.1
 * and Notepad commonly write this file as BOM-marked UTF-16LE. */
export function decodeWslConfig(bytes: Buffer): string {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.toString('utf16le')
    : bytes.toString('utf8');
}

/**
 * WSL2 is THE gating prerequisite on Windows — the managed VM is a WSL2
 * distro. Probe `wsl --status` so a machine without it fails preflight
 * with the actual fix, instead of sailing all-green and then dying
 * minutes later at first boot. No-op (pass) off Windows.
 */
export function checkWsl(): CheckResult {
  const id = 'wsl';
  const label = 'WSL2 (runs the managed VM)';
  if (process.platform !== 'win32') {
    return pass(id, label, 'not applicable on this platform');
  }
  try {
    const configPath = path.join(os.homedir(), '.wslconfig');
    if (wslConfigUsesMirroredNetworking(decodeWslConfig(fs.readFileSync(configPath)))) {
      return fail(id, label, 'WSL mirrored networking is not supported by the managed VM', WSL_MIRRORED_REMEDIATION);
    }
  } catch {
    // Missing/unreadable config means WSL's default NAT mode.
  }
  let r;
  try {
    r = spawnSync('wsl.exe', ['--status'], { encoding: 'buffer', timeout: 15_000, windowsHide: true });
  } catch (err) {
    r = { error: err as Error, status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return fail(
      id,
      label,
      'wsl.exe not found — WSL is not installed',
      'Open PowerShell as Administrator, run `wsl --install`, reboot, then re-run `appliance init`.'
    );
  }
  const output = decodeWindowsToolOutput(Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)]));
  if (r.error || r.status !== 0) {
    const { detail, remediation } = classifyWslFailure(output);
    return fail(id, label, detail, remediation);
  }
  return pass(id, label, 'wsl.exe responds');
}

// ---- disk space ---------------------------------------------------------

/** Free-space floor for the VM's home. First boot imports a multi-GB
 *  distro image and pulls the k3s images into it; a nearly-full disk
 *  fails half-way with an opaque import/containerd error. */
const DISK_FAIL_GB = 3;
const DISK_WARN_GB = 12;

export function checkDiskSpace(dir: string = path.join(os.homedir(), '.appliance')): CheckResult {
  const id = 'disk';
  const label = 'Free disk space (VM images + build cache)';
  let probe = dir;
  // ~/.appliance may not exist yet on a fresh machine — stat the
  // nearest existing ancestor (worst case the home dir / drive root).
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let free: number;
  try {
    const stat = fs.statfsSync(probe);
    free = stat.bavail * stat.bsize;
  } catch {
    return pass(id, label, 'could not probe free space — skipping');
  }
  const freeGb = free / 1024 ** 3;
  const detail = `${freeGb.toFixed(1)} GB free at ${probe}`;
  if (freeGb < DISK_FAIL_GB) {
    return fail(
      id,
      label,
      detail,
      `Free up disk space: the managed VM needs at least ${DISK_FAIL_GB} GB to boot (first boot imports the VM ` +
        'image and pulls its runtime images). `appliance vm prune` removes stopped VMs you no longer use.'
    );
  }
  if (freeGb < DISK_WARN_GB) {
    return warn(
      id,
      label,
      detail,
      `Running low: builds and deploys cache images inside the VM; keep ~${DISK_WARN_GB} GB free to avoid ` +
        'mid-deploy failures. `appliance vm prune` removes stopped VMs you no longer use.'
    );
  }
  return pass(id, label, detail);
}

// ---- macOS signing / keychain ------------------------------------------

/**
 * On macOS, Virtualization.framework gates VM creation behind the
 * `com.apple.security.virtualization` entitlement, which requires a
 * code signature. A repo-built `appliance-vm` is unsigned until
 * `packages/vm/scripts/sign-dev.sh` runs. We can't know the user's
 * binary path generically, so this is an informational `warn` that
 * points at the signing step. No-op (pass) off macOS.
 */
export function checkMacSigning(): CheckResult {
  const id = 'mac-signing';
  const label = 'macOS code-signing (microVM entitlement)';
  if (process.platform !== 'darwin') {
    return pass(id, label, 'not applicable on this platform');
  }
  const codesign = probeVersion('codesign', ['--version']) !== null || spawnSync('codesign', []).error === undefined;
  if (!codesign) {
    return warn(
      id,
      label,
      'codesign not found — Xcode command line tools may be missing',
      'Install the Xcode command line tools: `xcode-select --install`.'
    );
  }
  return warn(
    id,
    label,
    'a repo-built appliance-vm must be signed to boot a microVM',
    'Booting microVMs needs the com.apple.security.virtualization entitlement. After building, run `packages/vm/scripts/sign-dev.sh` (the published binary is already signed).'
  );
}

// ---- orchestrator -------------------------------------------------------

export interface PreflightReport {
  results: CheckResult[];
  /** True when every check is `pass` or `warn` — no hard failures. */
  ok: boolean;
}

/** Run the full preflight suite and return a structured report. The
 *  caller decides how to render (checklist, JSON) and how to exit. */
export async function runPreflight(): Promise<PreflightReport> {
  const [helperBinaries, ports] = await Promise.all([checkHelperBinaries(), checkPorts()]);

  // WSL first: on Windows it gates everything else, so its verdict
  // should lead the checklist a stuck user reads top-to-bottom.
  const results: CheckResult[] = [
    checkWsl(),
    ...helperBinaries,
    checkRust(),
    checkBun(),
    ...ports,
    checkMacSigning(),
    checkDiskSpace(),
  ];

  return { results, ok: results.every((r) => r.status !== 'fail') };
}

/** Auto-resolve the checks doctor can safely fix without forking system
 *  trust decisions. Returns a per-fix log line for the caller to render. */
export interface FixOutcome {
  label: string;
  status: 'fixed' | 'skipped' | 'failed';
  detail: string;
}

/**
 * Run the safe, non-trust-forking auto-fixes for a preflight report:
 * install the missing helper-managed binaries (kubectl). Port conflicts
 * and toolchain gaps stay with the operator — remediations already name
 * the fix.
 *
 * The macOS dev-binary signing step is deliberately NOT here: it forks a
 * trust/identity decision and is therefore prompted by the caller
 * (`appliance init`), never run blind.
 */
export async function runFixes(report: PreflightReport): Promise<FixOutcome[]> {
  const outcomes: FixOutcome[] = [];

  const missingBins = report.results.filter((r) => r.id.startsWith('bin:') && r.status !== 'pass');
  if (missingBins.length > 0) {
    outcomes.push(...(await installHelperBinaries(missingBins)));
  }

  return outcomes;
}

/** Drive the helper auto-installer for the missing managed binaries.
 *  The check id is `bin:<provider>`, so the provider name is the
 *  suffix. Providers that can't auto-install return guidance rather
 *  than failing — surfaced as a `skipped` so the report still carries
 *  the manual remediation. */
async function installHelperBinaries(missing: CheckResult[]): Promise<FixOutcome[]> {
  const tools = missing.map((r) => r.id.slice('bin:'.length)).filter(Boolean);
  let outcomes;
  try {
    outcomes = await runInstall({ tools });
  } catch (err) {
    return [
      { label: 'install helper binaries', status: 'failed', detail: err instanceof Error ? err.message : String(err) },
    ];
  }
  return outcomes.map((o) => ({
    label: `install ${o.provider.name}`,
    status: o.status === 'installed' || o.status === 'already' ? 'fixed' : o.status === 'failed' ? 'failed' : 'skipped',
    detail: o.message,
  }));
}
