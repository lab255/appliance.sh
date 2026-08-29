import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureHelperBinOnPath, DEFAULT_LOCAL_NAMESPACE } from '@appliance.sh/helper';
import {
  DEFAULT_VM_NAME,
  profileForVm,
  vmDir,
  vmBinary,
  runVm,
  runVmQuiet,
  runUp,
  deleteVmAndProfile,
  renderVmStatus,
  type EngineVmStatus,
} from './utils/microvm-up.js';
import { runVmCapture } from './utils/sandbox.js';
import { wslModeCommandArgs } from './utils/runtime-wsl-egress.js';

// `appliance vm` — the microVM runtime engine (appliance-vm), the sole
// local runtime now that bare k3d has been removed. Workloads run inside
// an isolated VM that Appliance itself boots:
// no docker provider required for the cluster, only for building and
// pushing application images.
//
// The heavy lifting lives in the `appliance-vm` Rust binary; this
// command drives it and layers the Appliance control plane on top
// (in-VM api-server bootstrap + credential registration), ending at
// the exact same DX as every other engine:
//
//   appliance vm up
//   appliance deploy <project> <env> --profile microvm
//   → http://<project>-<env>.appliance.localhost:8081

ensureHelperBinOnPath();

// The shared microVM bring-up core (boot → bootstrap api-server → adopt
// the credential profile) and the low-level VM primitives it leans on
// (binary resolution, per-VM ports + profile) live in utils/microvm-up
// so `appliance vm up` and `appliance init` drive one copy.

/** Whether a VM was provisioned as a development environment, read from
 *  its persisted spec (the engine sets `dev` on `vm dev up`). */
function isDevVm(name: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(vmDir(name), 'vm.json'), 'utf8');
    return (JSON.parse(raw) as { dev?: boolean }).dev === true;
  } catch {
    return false;
  }
}

const program = new Command();
program.description('manage the microVM runtime (isolated VM engine, no docker required)');

// ---- up ---------------------------------------------------------------

program
  .command('up')
  .description('boot the fast core sandbox (add --cluster to provision the lazy deployment layer)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option(
    '--image <ref>',
    '(deprecated, ignored) the api-server runs as a guest binary — set APPLIANCE_API_SERVER_BINARY to override it'
  )
  .option('--timeout <seconds>', 'seconds to wait for the platform to be ready', '900')
  .option('--cpus <n>', 'virtual CPUs for the VM (persisted; takes effect on next boot)', parsePositiveInt)
  .option('--memory <MiB>', 'guest memory in MiB (persisted; takes effect on next boot)', parsePositiveInt)
  .option('--cluster', 'provision k3s, BuildKit, registry, api-server, and the local profile', false)
  .action(
    async (opts: {
      name: string;
      image?: string;
      timeout: string;
      cpus?: number;
      memory?: number;
      cluster: boolean;
    }) => {
      try {
        await runUp(
          opts.name,
          opts.image,
          Number.parseInt(opts.timeout, 10),
          {
            cpus: opts.cpus,
            memory: opts.memory,
          },
          { cluster: opts.cluster }
        );
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    }
  );

/** Commander option parser: a positive integer, or a clear failure.
 *  Used for --cpus / --memory so a bad value is rejected host-side
 *  before the engine ever sees it. */
function parsePositiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`expected a positive integer, got '${value}'`);
  }
  return n;
}

// ---- passthrough lifecycle ---------------------------------------------

program
  .command('stop')
  .description('stop the microVM (state is preserved)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['stop', opts.name]));
  });

program
  .command('status')
  .description('show the microVM state and the next command (--json for the raw engine report)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--json', 'print the raw engine JSON instead of the human summary', false)
  .action((opts: { name: string; json: boolean }) => {
    // runVmCapture streams the engine's stderr through live, so a
    // broken engine explains itself; we only own stdout.
    const r = runVmCapture(['status', opts.name]);
    if (r.status !== 0 || !r.stdout) {
      if (r.stdout) console.log(r.stdout);
      process.exit(r.status || 1);
    }
    if (opts.json) {
      console.log(r.stdout);
      return;
    }
    let status: EngineVmStatus;
    try {
      status = JSON.parse(r.stdout) as EngineVmStatus;
    } catch {
      // A future engine changed the shape — fall back to its raw output
      // rather than hiding it.
      console.log(r.stdout);
      return;
    }
    for (const line of renderVmStatus(status)) console.log(line);
  });

program
  .command('reset')
  .description('start over: delete this VM (apps, images, state, credential profile) and boot a fresh one')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('-f, --force', 'skip the confirmation prompt', false)
  .action(async (opts: { name: string; force: boolean }) => {
    if (!opts.force) {
      const ok = await confirm({
        message:
          `Reset VM '${opts.name}'? This deletes its deployed apps, cached images, and credential profile, ` +
          'then boots a brand-new one.',
        default: false,
      });
      if (!ok) {
        console.log(chalk.yellow('aborted'));
        return;
      }
    }
    // Best-effort stop first so delete never trips over a running VM;
    // a delete failure after that means "nothing to delete" — still a
    // valid starting point for the fresh boot.
    runVmQuiet(['stop', opts.name]);
    deleteVmAndProfile(opts.name);
    try {
      await runUp(opts.name, undefined, 900, {});
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  });

// `delete`/`prune` are not plain passthroughs: the Rust engine removes
// the VM and its on-disk state, but the credential profile `vm up`
// minted lives in the CLI profile store, which the engine knows nothing
// about. `deleteVmAndProfile` (utils/microvm-up) removes both so a
// deleted VM never leaves an orphan cluster behind in the CLI or the
// desktop (both read ~/.appliance/profiles.json). `appliance cluster rm
// --delete-vm` shares the same helper.

program
  .command('delete')
  .description('delete the microVM, its state, and its credential profile')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(deleteVmAndProfile(opts.name));
  });

program
  .command('prune')
  .description('delete every stopped microVM and its credential profile')
  .option('-f, --force', 'skip the confirmation prompt', false)
  .action(async (opts: { force: boolean }) => {
    const bin = vmBinary();
    const r = spawnSync(bin, ['list'], { encoding: 'utf8' });
    if (r.status !== 0) {
      process.stderr.write(r.stderr ?? '');
      process.exit(r.status ?? 1);
    }
    const stopped = (JSON.parse(r.stdout) as { name: string; running: boolean }[]).filter((e) => !e.running);
    if (stopped.length === 0) {
      console.log(chalk.dim('no stopped microVMs to prune'));
      return;
    }
    if (!opts.force) {
      const names = stopped.map((e) => e.name).join(', ');
      const ok = await confirm({
        message: `Delete ${stopped.length} stopped microVM(s) (${names}) and their credential profiles?`,
        default: false,
      });
      if (!ok) {
        console.log(chalk.yellow('aborted'));
        return;
      }
    }
    let deleted = 0;
    for (const e of stopped) {
      if (deleteVmAndProfile(e.name) === 0) deleted++;
      else console.error(chalk.red(`failed to delete '${e.name}'`));
    }
    console.log(`pruned ${deleted}/${stopped.length} stopped microVM(s)`);
  });

program
  .command('console')
  .description("print the microVM's console log")
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('-f, --follow', 'follow the log as it grows', false)
  .action((opts: { name: string; follow: boolean }) => {
    const args = ['console', opts.name];
    if (opts.follow) args.push('-f');
    process.exit(runVm(args));
  });

program
  .command('kubeconfig')
  .description("print the microVM's kubeconfig path (use: export KUBECONFIG=$(appliance vm kubeconfig))")
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    console.log(kubeconfigOrExit(opts.name));
  });

// ---- exec / shell -------------------------------------------------------

function kubeconfigOrExit(name: string): string {
  const p = path.join(vmDir(name), 'kubeconfig.yaml');
  if (!fs.existsSync(p)) {
    console.error(chalk.red(`no kubeconfig at ${p} — is the VM up? (appliance vm up)`));
    process.exit(1);
  }
  return p;
}

/** kubectl exec's -t needs a real terminal on both ends; piped runs
 *  (CI, scripts) still work interactively on stdin alone. */
function ttyFlag(): string {
  return process.stdin.isTTY && process.stdout.isTTY ? '-it' : '-i';
}

program
  .command('exec')
  .description('run a command in a workload pod (interactive shell by default)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('-n, --namespace <ns>', 'kubernetes namespace', DEFAULT_LOCAL_NAMESPACE)
  .argument('<pod>', 'pod (any kubectl target works, e.g. deploy/my-app)')
  .argument('[command...]', 'command to run (default: /bin/sh)')
  .action((pod: string, command: string[], opts: { name: string; namespace: string }) => {
    const kubeconfig = kubeconfigOrExit(opts.name);
    const r = spawnSync(
      'kubectl',
      [
        '--kubeconfig',
        kubeconfig,
        '-n',
        opts.namespace,
        'exec',
        ttyFlag(),
        pod,
        '--',
        ...(command.length ? command : ['/bin/sh']),
      ],
      { stdio: 'inherit' }
    );
    process.exit(r.status ?? 1);
  });

/** Resolve the VM's single k3s node name from its kubeconfig, or '' if
 *  it can't be read (VM down / kubeconfig missing). The host shell and
 *  dev commands all target `node/<name>` via `kubectl debug`. */
function resolveNodeName(kubeconfig: string): string {
  const node = spawnSync(
    'kubectl',
    ['--kubeconfig', kubeconfig, 'get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}'],
    { encoding: 'utf8' }
  );
  return node.status === 0 ? node.stdout.trim() : '';
}

/** Open a shell into the VM host itself. `kubectl debug node/` attaches
 *  a pod with the VM's root fs at /host; chroot turns it into a real VM
 *  shell — no SSH or guest agent needed, it rides the same kubeconfig as
 *  everything else, and --profile=sysadmin grants privileged +
 *  hostPID/hostNetwork. `entry` is the argv run under the chroot.
 *  Returns the child's exit code (caller decides whether to exit). */
function runHostShell(name: string, entry: string[]): number {
  const kubeconfig = kubeconfigOrExit(name);
  const nodeName = resolveNodeName(kubeconfig);
  if (!nodeName) {
    console.error(chalk.red('could not resolve the VM node — is the VM up? (appliance vm up)'));
    return 1;
  }
  const r = spawnSync(
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      'debug',
      `node/${nodeName}`,
      ttyFlag(),
      '--image=busybox:1.36',
      '--profile=sysadmin',
      '--',
      'chroot',
      '/host',
      ...entry,
    ],
    { stdio: 'inherit' }
  );
  // kubectl debug leaves its debugger pod behind by design; sweep ours
  // so repeated shells don't accumulate Completed pods.
  cleanupNodeDebuggerPods(kubeconfig, nodeName);
  return r.status ?? 1;
}

/** The resident VM process serves this Unix socket while the VM runs
 *  (and was booted with a vsock-capable engine); `appliance-vm shell`
 *  rides it for a fast, k3s-independent shell. */
function shellSock(name: string): string {
  return path.join(vmDir(name), 'shell.sock');
}

/** Open an interactive shell, preferring the fast vsock channel
 *  (`appliance-vm shell`, no k3s, no debugger pod) when its relay socket
 *  is up, and falling back to the kubectl-debug host shell otherwise
 *  (older VMs, or while the guest agent is still starting). `fallback`
 *  is the chroot argv used on the kubectl path. `session`, when set,
 *  attaches to (or creates) a reattachable tmux session over the vsock
 *  path; it has no equivalent on the kubectl fallback, so it's dropped
 *  there. */
function runInteractiveShell(name: string, fallback: string[], root = false, session?: string): number {
  // The relay socket is a unix-only artifact (vsock backend). On Windows
  // the WSL backend's `appliance-vm shell` drives wsl.exe directly — no
  // socket ever exists — so always prefer the engine there (it reports
  // "is it running?" itself when the VM is down).
  if (process.platform === 'win32' || fs.existsSync(shellSock(name))) {
    // The vsock agent drops to the non-root `appliance` user by default;
    // `--root` lands a root shell via the agent's escape hatch.
    // `--session` rides the agent's tmux attach-or-create path.
    const args = ['shell', name];
    if (root) args.push('--root');
    if (session) args.push('--session', session);
    const r = spawnSync(vmBinary(), args, { stdio: 'inherit' });
    return r.status ?? 1;
  }
  // The kubectl-debug fallback already chroots in as root, so --root is
  // a no-op there.
  return runHostShell(name, fallback);
}

/** Run one command in the VM, preferring the engine's shell channel
 *  (vsock on macOS, wsl.exe on Windows — no k3s, no kubectl) with the
 *  kubectl-debug host shell as the fallback for older VMs. Mirrors
 *  runInteractiveShell's channel preference: on Windows the engine is
 *  always right (the WSL backend has no relay socket, and the kubectl
 *  path would demand a kubeconfig an agent-only VM never has). */
function runOneShot(name: string, script: string, root = false): number {
  if (process.platform === 'win32' || fs.existsSync(shellSock(name))) {
    const args = ['shell', name];
    if (root) args.push('--root');
    args.push('--', script);
    const r = spawnSync(vmBinary(), args, { stdio: 'inherit' });
    return r.status ?? 1;
  }
  return runHostShell(name, ['/bin/sh', '-c', script]);
}

/** Run one command in the VM host and capture its stdout (no TTY) — the
 *  quiet probe behind `vm dev status`. Debugger-session chatter goes to
 *  the inherited stderr's /dev/null, so the returned stdout is clean. */
function hostExec(name: string, command: string): { status: number; stdout: string } {
  const kubeconfig = kubeconfigOrExit(name);
  const nodeName = resolveNodeName(kubeconfig);
  if (!nodeName) return { status: 1, stdout: '' };
  const r = spawnSync(
    'kubectl',
    [
      '--kubeconfig',
      kubeconfig,
      'debug',
      `node/${nodeName}`,
      '-i',
      '--image=busybox:1.36',
      '--profile=sysadmin',
      '--',
      'chroot',
      '/host',
      '/bin/sh',
      '-c',
      command,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  cleanupNodeDebuggerPods(kubeconfig, nodeName);
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim() };
}

program
  .command('shell')
  .description(
    'open a shell inside the VM as the non-root appliance user (--root for root; --session <id> for a reattachable session; or run one command: appliance vm shell -- uname -a)'
  )
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--root', 'land a root shell instead of the non-root appliance user', false)
  .option(
    '-s, --session <id>',
    'attach to (or create) a reattachable named session that survives this client disconnecting'
  )
  .argument('[command...]', 'command to run instead of an interactive shell')
  .action((command: string[], opts: { name: string; root: boolean; session?: string }) => {
    // One-shot commands prefer the engine's shell channel (vsock, or
    // wsl.exe on Windows) — no k3s, no kubeconfig, no kubectl needed —
    // and fall back to kubectl-debug `sh -c` for older VMs without one.
    // Interactive shells share the same preference; only the engine
    // path carries a reattachable --session.
    if (command.length) {
      process.exit(runOneShot(opts.name, command.join(' '), opts.root));
    }
    process.exit(runInteractiveShell(opts.name, ['/bin/sh'], opts.root, opts.session));
  });

// ---- sessions (reattachable shell sessions) ----------------------------

const sessions = program.command('sessions').description('manage reattachable shell sessions (tmux) inside the VM');

sessions
  .command('list')
  .description("list the VM's reattachable shell sessions as JSON")
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--root', 'list root sessions (the separate root-owned socket) instead of the non-root ones', false)
  .action((opts: { name: string; root: boolean }) => {
    const args = ['sessions', 'list', opts.name];
    if (opts.root) args.push('--root');
    process.exit(runVm(args));
  });

sessions
  .command('kill <id>')
  .description('kill a reattachable shell session by id')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--root', 'kill a root session (the separate root-owned socket) instead of a non-root one', false)
  .action((id: string, opts: { name: string; root: boolean }) => {
    const args = ['sessions', 'kill', id, '--name', opts.name];
    if (opts.root) args.push('--root');
    process.exit(runVm(args));
  });

function cleanupNodeDebuggerPods(kubeconfig: string, nodeName: string): void {
  const list = spawnSync(
    'kubectl',
    ['--kubeconfig', kubeconfig, 'get', 'pods', '-o', 'jsonpath={.items[*].metadata.name}'],
    { encoding: 'utf8' }
  );
  if (list.status !== 0) return;
  const debuggers = list.stdout.split(/\s+/).filter((name) => name.startsWith(`node-debugger-${nodeName}-`));
  if (debuggers.length === 0) return;
  spawnSync('kubectl', ['--kubeconfig', kubeconfig, 'delete', 'pod', '--wait=false', ...debuggers], {
    stdio: 'ignore',
  });
}

// ---- dev (development environment) -------------------------------------

// Interactive login into the dev workspace: a stable HOME on the
// persistent disk, cd into the workspace, and bash when the toolchain
// has installed it (falling back to sh while it's still provisioning).
const DEV_SHELL_LOGIN =
  'export HOME=/persist/workspace; cd /persist/workspace 2>/dev/null || true; ' +
  'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi';

const dev = program
  .command('dev')
  .description(
    'manage the shared dev environment VM used by the desktop app and coding agents (for the local app dev loop, use `appliance dev`)'
  );

dev
  .command('up')
  .description('boot a microVM as a dev environment (toolchain + persistent /persist/workspace)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option(
    '--image <ref>',
    '(deprecated, ignored) the api-server runs as a guest binary — set APPLIANCE_API_SERVER_BINARY to override it'
  )
  .option('--timeout <seconds>', 'seconds to wait for the platform to be ready', '900')
  .option('--cpus <n>', 'virtual CPUs for the VM (persisted; takes effect on next boot)', parsePositiveInt)
  .option('--memory <MiB>', 'guest memory in MiB (persisted; takes effect on next boot)', parsePositiveInt)
  .option('--mount <path>', 'share a host folder into /persist/workspace (edit on host, run in VM)')
  .action(
    async (opts: { name: string; image?: string; timeout: string; cpus?: number; memory?: number; mount?: string }) => {
      try {
        await runUp(opts.name, opts.image, Number.parseInt(opts.timeout, 10), {
          cpus: opts.cpus,
          memory: opts.memory,
          dev: true,
          mount: opts.mount,
        });
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    }
  );

dev
  .command('shell')
  .description('open a shell in the dev workspace (or run one command: appliance vm dev shell -- npm test)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .argument('[command...]', 'command to run instead of an interactive shell')
  .action((command: string[], opts: { name: string }) => {
    if (!isDevVm(opts.name)) {
      console.error(
        chalk.red(
          `VM '${opts.name}' is not a dev environment — create one with \`appliance vm dev up${
            opts.name === DEFAULT_VM_NAME ? '' : ` --name ${opts.name}`
          }\`.`
        )
      );
      process.exit(1);
    }
    // One-shot commands prefer the engine's shell channel (see
    // runOneShot); an interactive dev shell prefers the same fast path,
    // which lands in /persist/workspace via the guest agent.
    if (command.length) {
      const script = `export HOME=/persist/workspace; cd /persist/workspace 2>/dev/null || true; ${command.join(' ')}`;
      process.exit(runOneShot(opts.name, script));
    }
    process.exit(runInteractiveShell(opts.name, ['/bin/sh', '-c', DEV_SHELL_LOGIN]));
  });

dev
  .command('status')
  .description('report whether the VM is a dev environment and if its workspace + toolchain are ready')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    const isDev = isDevVm(opts.name);
    const bin = vmBinary();
    const s = spawnSync(bin, ['status', opts.name], { encoding: 'utf8' });
    let exists = false;
    let running = false;
    try {
      const j = JSON.parse(s.stdout) as { exists?: boolean; running?: boolean };
      exists = !!j.exists;
      running = !!j.running;
    } catch {
      // status JSON unparseable — treat as not-defined below.
    }
    if (!exists) {
      console.log(chalk.dim(`no microVM named '${opts.name}' — create one with \`appliance vm dev up\``));
      process.exit(1);
    }
    const nameFlag = opts.name === DEFAULT_VM_NAME ? '' : ` --name ${opts.name}`;
    console.log(`VM:          ${opts.name}`);
    console.log(`Dev env:     ${isDev ? chalk.green('yes') : chalk.dim('no')}`);
    console.log(`State:       ${running ? chalk.green('running') : chalk.dim('stopped')}`);
    if (!isDev) {
      console.log(chalk.dim(`  promote it with: appliance vm dev up${nameFlag}`));
      return;
    }
    if (!running) {
      console.log(chalk.dim(`  start it with: appliance vm dev up${nameFlag}`));
      return;
    }
    // Quiet in-guest probe for the workspace + the toolchain marker the
    // background apk install drops on completion.
    const probe = hostExec(
      opts.name,
      'test -d /persist/workspace && echo workspace; test -f /persist/.dev-ready && echo ready'
    );
    const hasWorkspace = probe.stdout.includes('workspace');
    const toolchainReady = probe.stdout.includes('ready');
    console.log(`Workspace:   ${hasWorkspace ? chalk.green('/persist/workspace') : chalk.yellow('not created yet')}`);
    console.log(
      `Toolchain:   ${
        toolchainReady ? chalk.green('ready') : chalk.yellow('installing… (first boot pulls packages from the network)')
      }`
    );
  });

program
  .command('list')
  .alias('ls')
  .description('list all microVMs with their ports and running state')
  .option('--json', 'print raw JSON instead of a table', false)
  .action((opts: { json: boolean }) => {
    const bin = vmBinary();
    const r = spawnSync(bin, ['list'], { encoding: 'utf8' });
    if (r.status !== 0) {
      process.stderr.write(r.stderr ?? '');
      process.exit(r.status ?? 1);
    }
    if (opts.json) {
      process.stdout.write(r.stdout);
      return;
    }
    type Entry = {
      name: string;
      running: boolean;
      hostPort: number;
      apiPort: number;
      registryPort: number;
      egressPort: number;
    };
    const entries = JSON.parse(r.stdout) as Entry[];
    if (entries.length === 0) {
      console.log(chalk.dim('no microVMs defined — create one with `appliance vm up --name <name>`'));
      return;
    }
    console.log(
      `${'NAME'.padEnd(16)} ${'STATE'.padEnd(9)} ${'INGRESS'.padEnd(8)} ${'K8S'.padEnd(6)} ${'REGISTRY'.padEnd(9)} ${'EGRESS'.padEnd(7)} PROFILE`
    );
    for (const e of entries) {
      // padEnd before colorizing would miscount the ANSI codes, so pad
      // the plain text and color the already-padded cell.
      const statePad = (e.running ? 'running' : 'stopped').padEnd(9);
      const stateCell = e.running ? chalk.green(statePad) : chalk.dim(statePad);
      console.log(
        `${e.name.padEnd(16)} ${stateCell} ${String(e.hostPort).padEnd(8)} ${String(e.apiPort).padEnd(6)} ${String(e.registryPort).padEnd(9)} ${String(e.egressPort).padEnd(7)} ${profileForVm(e.name)}`
      );
    }
  });

program
  .command('doctor')
  .description('probe whether this machine can run microVMs')
  .action(() => {
    process.exit(runVm(['doctor']));
  });

// ---- egress (outbound-traffic control) ---------------------------------

const egress = program.command('egress').description("control the VM's outbound traffic (allow/deny by host)");

egress
  .command('proxy')
  .description('run the egress proxy in the foreground until killed')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--addr <host:port>', 'address to listen on')
  .option('--log', 'log every allow/deny decision', false)
  .action((opts: { name: string; addr?: string; log: boolean }) => {
    const args = ['egress', 'proxy', opts.name];
    if (opts.addr) args.push('--addr', opts.addr);
    if (opts.log) args.push('--log');
    process.exit(runVm(args));
  });

egress
  .command('policy')
  .description("print the VM's effective egress policy and enforced/cooperative boundary as JSON")
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['egress', 'policy', opts.name]));
  });

egress
  .command('list')
  .description('show the effective egress policy and its enforced/cooperative boundary')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['egress', 'list', opts.name]));
  });

egress
  .command('wsl-mode [mode]')
  .description('read or set WSL Runtime egress posture (strict | cooperative; default strict)')
  .option('--name <name>', 'VM name', 'appliance-runtime')
  .action((mode: string | undefined, opts: { name: string }) => {
    process.exit(runVm(wslModeCommandArgs(mode as 'strict' | 'cooperative' | undefined, opts.name)));
  });

egress
  .command('default <action>')
  .description('set the default action when no rule matches (allow | deny)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((action: string, opts: { name: string }) => {
    process.exit(runVm(['egress', 'default', action, '--name', opts.name]));
  });

egress
  .command('allow <host>')
  .description('allow outbound traffic to a host suffix (e.g. github.com)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((host: string, opts: { name: string }) => {
    process.exit(runVm(['egress', 'allow', host, '--name', opts.name]));
  });

egress
  .command('deny <host>')
  .description('deny outbound traffic to a host suffix (deny wins over allow)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((host: string, opts: { name: string }) => {
    process.exit(runVm(['egress', 'deny', host, '--name', opts.name]));
  });

egress
  .command('remove <host>')
  .description('remove a single operator allow/deny rule for an exact host (the per-rule counterpart of reset)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((host: string, opts: { name: string }) => {
    process.exit(runVm(['egress', 'remove', host, '--name', opts.name]));
  });

egress
  .command('reset')
  .description('clear all rules and reset to the permissive default')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['egress', 'reset', opts.name]));
  });

egress
  .command('mitm <state>')
  .description('enable or disable TLS interception (on | off)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((state: string, opts: { name: string }) => {
    process.exit(runVm(['egress', 'mitm', state, '--name', opts.name]));
  });

egress
  .command('ca')
  .description("print the path to the VM's egress CA cert (generates on first use)")
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['egress', 'ca', opts.name]));
  });

egress
  .command('gateway')
  .description('print the HTTPS_PROXY + CA values guest workloads should use')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['egress', 'gateway', opts.name]));
  });

egress
  .command('sync')
  .description('publish the policy into the cluster (the api-server injects it into workloads)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['egress', 'sync', opts.name]));
  });

egress
  .command('log')
  .description('print recorded egress traffic as JSON (the desktop traffic view feed)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--tail <n>', 'most-recent events to print', '200')
  .option('--clear', 'forget all recorded traffic instead of printing', false)
  .action((opts: { name: string; tail: string; clear: boolean }) => {
    const args = ['egress', 'log', opts.name, '--tail', opts.tail];
    if (opts.clear) args.push('--clear');
    process.exit(runVm(args));
  });

egress
  .command('denied')
  .description('show blocked egress attempts and the `allow` command to permit each (the blocked→allow loop)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--tail <n>', 'most-recent traffic events to scan for denials', '1000')
  .action((opts: { name: string; tail: string }) => {
    process.exit(runVm(['egress', 'denied', opts.name, '--tail', opts.tail]));
  });

// ---- creds (per-host credential capture / injection) -------------------

const creds = program.command('creds').description('manage per-host credential capture/injection (apiKeyHelper)');

creds
  .command('list')
  .description('print credential rules + stored secrets (masked) as JSON')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['creds', 'list', opts.name]));
  });

creds
  .command('add <host>')
  .description('add/update a per-host credential rule')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--capture', 'capture the credential header off requests into the store', false)
  .option('--inject', 'inject the credential header onto outbound requests', false)
  .option('--header <header>', 'header to capture/inject (default: authorization)')
  .option('--helper <cmd>', 'command whose stdout is the credential to inject (apiKeyHelper)')
  .action(
    (host: string, opts: { name: string; capture: boolean; inject: boolean; header?: string; helper?: string }) => {
      const args = ['creds', 'add', host, '--name', opts.name];
      if (opts.capture) args.push('--capture');
      if (opts.inject) args.push('--inject');
      if (opts.header) args.push('--header', opts.header);
      if (opts.helper) args.push('--helper', opts.helper);
      process.exit(runVm(args));
    }
  );

creds
  .command('rm <host>')
  .description("remove a host's credential rule")
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((host: string, opts: { name: string }) => {
    process.exit(runVm(['creds', 'rm', host, '--name', opts.name]));
  });

creds
  .command('set <host> <value>')
  .description('manually store a secret for a host (e.g. paste an API key)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .option('--header <header>', 'header the secret is for (default: authorization)')
  .action((host: string, value: string, opts: { name: string; header?: string }) => {
    const args = ['creds', 'set', host, value, '--name', opts.name];
    if (opts.header) args.push('--header', opts.header);
    process.exit(runVm(args));
  });

creds
  .command('forget')
  .description('forget all stored secrets (rules are kept)')
  .option('--name <name>', 'VM name', DEFAULT_VM_NAME)
  .action((opts: { name: string }) => {
    process.exit(runVm(['creds', 'forget', opts.name]));
  });

program.parse(process.argv);
