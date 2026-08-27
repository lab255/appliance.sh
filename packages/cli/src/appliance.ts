#!/usr/bin/env node

import { ensureHelperBinOnPath, ensureLocalhostFetch } from '@appliance.sh/helper';
import * as sdk from '@appliance.sh/sdk';
import { userArgs } from './utils/argv.js';

// Prepend ~/.appliance/bin to PATH so any downstream spawns (docker,
// kubectl, crane) resolve helper-installed binaries when the system
// PATH lacks them. Idempotent; safe to also call from a subcommand
// entry directly.
ensureHelperBinOnPath();

// Windows' resolver doesn't implement RFC 6761 `.localhost`, which the
// microVM runtime's URLs (`api.appliance.localhost`, per-deploy
// hostnames) depend on — teach this process' fetch to resolve them.
ensureLocalhostFetch();

// Dynamic-import dispatcher for the `appliance` umbrella command.
//
// We previously relied on commander's "executable subcommands" mode,
// which dispatches by spawning sibling `appliance-<name>.js` files.
// That breaks under `bun build --compile` (single-binary builds have
// no sibling files to spawn). The fix: enumerate subcommands here and
// route via dynamic `import()`, which Bun's bundler statically picks
// up and includes in the binary. The same code path also works under
// Node (each subcommand file still calls `program.parse(process.argv)`
// when imported, exactly as it did before).
//
// Adding a new subcommand:
//   1. Drop a new `appliance-<name>.ts` in this folder that self-
//      executes via `program.parse(process.argv)`.
//   2. Append an entry to `SUBCOMMANDS` below.

interface SubcommandDef {
  description: string;
  aliases?: string[];
  /** Dispatchable but omitted from `appliance --help` (deprecated shims
   *  and lower-level duplicates keep working without inviting new use). */
  hidden?: boolean;
  load: () => Promise<unknown>;
}

const SUBCOMMANDS: Record<string, SubcommandDef> = {
  agent: {
    description: 'run a coding agent (Claude Code, Copilot, Codex) inside the sandbox microVM',
    load: () => import('./appliance-agent.js'),
  },
  app: {
    description: 'manage applications (setup, status, list)',
    aliases: ['application'],
    load: () => import('./appliance-app.js'),
  },
  bootstrap: {
    description: 'provision a new Appliance installation on AWS (alias: `appliance cloud bootstrap`)',
    load: () => import('./appliance-bootstrap.js'),
  },
  'cloud-install': {
    description: 'install the Appliance control plane on AWS with CloudFormation',
    hidden: true,
    load: () => import('./appliance-cloud-install.js'),
  },
  'cloud-update': {
    description: 'update CloudFormation-owned system Lambdas',
    hidden: true,
    load: () => import('./appliance-cloud-update.js'),
  },
  build: {
    description: 'builds the appliance in the current working directory',
    load: () => import('./appliance-build.js'),
  },
  builder: {
    description: 'build and ship your own apps (`appliance builder <verb>`)',
    load: async () => {},
  },
  cluster: {
    description: 'list, switch, and forget clusters (shared with the desktop app)',
    load: () => import('./appliance-cluster.js'),
  },
  configure: {
    description: 'configures the appliance in the current working directory',
    load: () => import('./appliance-configure.js'),
  },
  deploy: {
    description: 'deploy the linked (or named) project to the active cluster (see `appliance cluster`; usually cloud)',
    load: () => import('./appliance-deploy.js'),
  },
  install: {
    description:
      'install the linked (or named) project to the local VM cluster (--cluster <name> to override) — or the whole stack in a stack folder',
    load: () => import('./appliance-deploy.js'),
  },
  deployment: {
    description: 'manage deployments',
    load: () => import('./appliance-deployment.js'),
  },
  destroy: {
    description: 'destroy the linked (or named) project/environment',
    aliases: ['remove'],
    load: () => import('./appliance-destroy.js'),
  },
  dev: {
    description: 'run your app locally with live rebuild + logs (Ctrl+C leaves apps running)',
    load: () => import('./appliance-dev.js'),
  },
  doctor: {
    description: 'run first-run preflight checks (use --fix to auto-resolve the safe ones)',
    load: () => import('./appliance-doctor.js'),
  },
  env: {
    description: 'manage per-environment variables (set/list/unset)',
    load: () => import('./appliance-env.js'),
  },
  init: {
    description: 'first-time setup: boot the managed VM and guide your first deploy (after that, `appliance dev`)',
    load: () => import('./appliance-init.js'),
  },
  keys: {
    description: 'manage the cluster API key lifecycle (rotate)',
    load: () => import('./appliance-keys.js'),
  },
  link: {
    description: 'link this folder to a project/environment',
    load: () => import('./appliance-link.js'),
  },
  logs: {
    description: "stream a deployment's container logs (local engines)",
    load: () => import('./appliance-logs.js'),
  },
  vm: {
    description: 'manage the microVM (the one `appliance` VM runs deploys, dev sessions, and agents)',
    load: () => import('./appliance-vm.js'),
  },
  login: {
    description: 'authenticate with the appliance API',
    load: () => import('./appliance-login.js'),
  },
  manifest: {
    description: 'evaluate a programmatic appliance manifest in a sandbox',
    load: () => import('./appliance-manifest.js'),
  },
  mcp: {
    description: 'serve Appliance over the Model Context Protocol (stdio) so AI agents can deploy and debug',
    load: () => import('./appliance-mcp.js'),
  },
  open: {
    description: 'open the latest deployment URL in a browser',
    load: () => import('./appliance-open.js'),
  },
  package: {
    description: 'package a manifest v2 project as a runnable bundle (alias: `appliance builder package`)',
    load: () => import('./appliance-build.js'),
  },
  run: {
    description: 'run a container-type packaged app in the pooled Runtime VM',
    load: async () => (await import('./appliance-runtime.js')).runRuntimeCommand('run', process.argv.slice(2)),
  },
  uninstall: {
    description: 'uninstall a packaged app from the current workspace target',
    load: async () => (await import('./appliance-runtime.js')).runRuntimeCommand('uninstall', process.argv.slice(2)),
  },
  ps: {
    description: 'list running packaged apps',
    load: async () => (await import('./appliance-runtime.js')).runRuntimeCommand('ps', process.argv.slice(2)),
  },
  stop: {
    description: 'stop a packaged app',
    load: async () => (await import('./appliance-runtime.js')).runRuntimeCommand('stop', process.argv.slice(2)),
  },
  search: {
    description: 'search the signed free-app catalogue',
    load: async () => (await import('./appliance-runtime-search.js')).runRuntimeSearch(process.argv.slice(2)),
  },
  entitlements: {
    description: 'manage packaged-app entitlements (coming in a later release)',
    load: async () => (await import('./appliance-runtime-stub.js')).runRuntimeStub('entitlements'),
  },
  runtime: {
    description: 'run packaged apps in microVMs (`appliance runtime <verb>`)',
    load: async () => {},
  },
  profile: {
    description: '(use `appliance cluster`) the lower-level credential-profile store',
    hidden: true,
    load: () => import('./appliance-profile.js'),
  },
  server: {
    description: '(deprecated) the control plane runs inside the microVM — use `appliance dev` / `appliance vm`',
    hidden: true,
    load: () => import('./appliance-server.js'),
  },
  stack: {
    description: 'scaffold/inspect/destroy a multi-app stack (`appliance deploy` in a stack folder deploys it)',
    load: () => import('./appliance-stack.js'),
  },
  teardown: {
    description: 'destroy a cloud installation (alias: `appliance cloud teardown`)',
    load: () => import('./appliance-teardown.js'),
  },
  test: {
    description: 'run connection and signing diagnostics',
    load: () => import('./appliance-test.js'),
  },
  unlink: {
    description: 'remove the local project/environment link',
    load: () => import('./appliance-unlink.js'),
  },
  upgrade: {
    description: 'show how to update this CLI (per install channel; prints, never executes)',
    load: () => import('./appliance-upgrade.js'),
  },
  up: {
    description: 'build + run this project (Dockerfile, compose, or devcontainer) in the managed microVM',
    load: () => import('./appliance-up.js'),
  },
  down: {
    description: "stop and remove this project's sandbox container",
    load: () => import('./appliance-down.js'),
  },
  shell: {
    description: "enter this project's sandbox (devcontainer exec, or the VM host shell)",
    load: () => import('./appliance-shell.js'),
  },
  whoami: {
    description: 'show active profile, server URL, and linked project',
    load: () => import('./appliance-whoami.js'),
  },
};

// Top-level shortcuts that expand to `<target> <prefix> [args]`. Keeps
// the muscle memory of `appliance status` / `appliance list` /
// `appliance setup` working without per-shortcut alias files.
const SHORTCUTS: Record<string, { target: string; prefix: string[] }> = {
  list: { target: 'app', prefix: ['list'] },
  setup: { target: 'app', prefix: ['setup'] },
  status: { target: 'app', prefix: ['status'] },
};

// `appliance cloud <verb>` — the umbrella for cloud-installation
// lifecycle. Routes to the existing command modules so `cloud
// bootstrap` and `bootstrap` can never drift.
const CLOUD_VERBS: Record<string, string> = {
  install: 'cloud-install',
  update: 'cloud-update',
  bootstrap: 'bootstrap',
  teardown: 'teardown',
};

// Namespaces only route to existing in-process command modules. This keeps the
// Bun single-binary contract intact and guarantees the top-level spelling and
// `builder <verb>` share exactly the same implementation.
const BUILDER_VERBS: Record<string, string> = {
  build: 'build',
  configure: 'configure',
  deploy: 'deploy',
  deployment: 'deployment',
  destroy: 'destroy',
  dev: 'dev',
  down: 'down',
  env: 'env',
  init: 'init',
  install: 'install',
  link: 'link',
  logs: 'logs',
  manifest: 'manifest',
  open: 'open',
  package: 'package',
  shell: 'shell',
  stack: 'stack',
  test: 'test',
  unlink: 'unlink',
  up: 'up',
};

const RUNTIME_VERBS: Record<string, string> = {
  run: 'run a .appliance.zip (path or URL) without installing',
  install: 'verify, register, and start a packaged app',
  uninstall: "stop, deregister, and delete an app's VM and volumes",
  list: 'list installed packaged apps',
  ps: 'list running packaged apps',
  stop: 'stop a running packaged app',
  logs: "stream a packaged app's logs",
  open: "open a packaged app's UI",
  search: 'search the signed app index',
  entitlements: 'show, grant, or revoke app entitlements',
};

// Resolve aliases (e.g. `application` -> `app`) to their canonical
// subcommand name. Filled once at module load.
const ALIAS_MAP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [name, def] of Object.entries(SUBCOMMANDS)) {
    m[name] = name;
    for (const alias of def.aliases ?? []) m[alias] = name;
  }
  return m;
})();

const HELP_ONLY: Record<string, string> = {
  cloud: 'umbrella: `appliance cloud install|update|bootstrap|teardown`',
};

// Help groups commands by product surface. Names must exist in
// SUBCOMMANDS, SHORTCUTS, or HELP_ONLY; anything unlisted lands in
// "Other" so a newly registered command is never silently hidden.
const COMMAND_GROUPS: Array<{ title: string; names: string[] }> = [
  {
    title: 'Builder',
    names: [
      'builder',
      'init',
      'dev',
      'build',
      'package',
      'install',
      'deploy',
      'destroy',
      'configure',
      'env',
      'link',
      'unlink',
      'stack',
      'deployment',
      'manifest',
      'test',
      'logs',
      'open',
    ],
  },
  {
    title: 'Cluster & machine',
    names: [
      'up',
      'down',
      'shell',
      'vm',
      'cluster',
      'status',
      'bootstrap',
      'teardown',
      'cloud',
      'keys',
      'doctor',
      'upgrade',
    ],
  },
  { title: 'Agents', names: ['agent', 'mcp'] },
  { title: 'Account', names: ['login', 'whoami', 'app', 'setup', 'list'] },
  {
    title: 'Runtime',
    names: ['runtime', 'run', 'uninstall', 'ps', 'stop', 'search', 'entitlements'],
  },
];

function showHelp(): void {
  console.log('Usage: appliance <command> [options]');
  const allNames = [
    ...Object.keys(SUBCOMMANDS).filter((n) => !SUBCOMMANDS[n].hidden),
    ...Object.keys(SHORTCUTS),
    ...Object.keys(HELP_ONLY),
  ];
  const width = Math.max(...allNames.map((n) => n.length));
  const grouped = new Set(COMMAND_GROUPS.flatMap((g) => g.names));
  const leftovers = [...new Set(allNames.filter((n) => !grouped.has(n)))].sort();
  const groups = [...COMMAND_GROUPS, ...(leftovers.length > 0 ? [{ title: 'Other', names: leftovers }] : [])];
  for (const group of groups) {
    console.log();
    console.log(`${group.title}:`);
    for (const name of group.names) {
      const def = SUBCOMMANDS[name];
      if (!def) {
        const sc = SHORTCUTS[name];
        const description = sc ? `alias for \`appliance ${sc.target} ${sc.prefix.join(' ')}\`` : HELP_ONLY[name];
        if (description) console.log(`  ${name.padEnd(width)}  ${description}`);
        continue;
      }
      const aliasTail = def.aliases && def.aliases.length > 0 ? ` (alias: ${def.aliases.join(', ')})` : '';
      console.log(`  ${name.padEnd(width)}  ${def.description}${aliasTail}`);
    }
  }
  console.log();
  console.log('The three journeys:');
  console.log('  1. Build & run your app(s):   appliance dev            (deploy + logs + rebuild on save;');
  console.log('                                multi-service via appliance.stack.json — same command)');
  console.log('  2. Dev environment + agents:  appliance up  →  appliance agent login  →  appliance agent start');
  console.log('  3. Ship the same app to AWS:  appliance cloud install  →  provision edge  →  appliance deploy');
  console.log();
  console.log('Environment variables:');
  console.log('  APPLIANCE_PROFILE               credential profile to use (overrides the active profile)');
  console.log('  APPLIANCE_API_URL               override the api-server URL from the profile');
  console.log('  APPLIANCE_TRUST_MANIFEST=1      skip the programmatic-manifest trust prompt (CI)');
  console.log();
  console.log('Run `appliance <command> --help` for command-specific options.');
}

function showNamespaceHelp(namespace: 'builder' | 'runtime'): void {
  console.log(`Usage: appliance ${namespace} <verb> [options]`);
  console.log();
  console.log(namespace === 'builder' ? 'Build and ship your own apps:' : 'Run packaged apps in microVMs:');
  const verbs = namespace === 'builder' ? BUILDER_VERBS : RUNTIME_VERBS;
  const width = Math.max(...Object.keys(verbs).map((verb) => verb.length));
  for (const [verb, targetOrDescription] of Object.entries(verbs)) {
    const description = namespace === 'builder' ? SUBCOMMANDS[targetOrDescription].description : targetOrDescription;
    console.log(`  ${verb.padEnd(width)}  ${description}`);
  }
  if (namespace === 'runtime') {
    console.log();
    console.log('Container run/ps/stop/logs are available; install/list/uninstall are available per workspace target.');
  }
  console.log();
  console.log(`Run \`appliance ${namespace} <verb> --help\` for command-specific options.`);
}

async function main(): Promise<void> {
  const args = userArgs();

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    showHelp();
    return;
  }

  if (args[0] === '--version' || args[0] === '-V') {
    // SDK.VERSION is a `v`-prefixed semver string emitted by the build
    // (e.g. `v1.41.0`); don't add another prefix.
    console.log(sdk.VERSION);
    return;
  }

  const sub = args[0];

  if (sub === 'builder' || sub === 'runtime') {
    const verb = args[1];
    if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
      showNamespaceHelp(sub);
      return;
    }
    if (sub === 'runtime') {
      if (!RUNTIME_VERBS[verb]) {
        console.error(`Unknown runtime command: ${verb}`);
        console.error();
        showNamespaceHelp('runtime');
        process.exit(1);
      }
      if (verb === 'search') {
        const { runRuntimeSearch } = await import('./appliance-runtime-search.js');
        await runRuntimeSearch(args.slice(2));
        return;
      }
      const { runRuntimeCommand } = await import('./appliance-runtime.js');
      await runRuntimeCommand(verb, args.slice(2));
      return;
    }
    const target = BUILDER_VERBS[verb];
    if (!target) {
      console.error(`Unknown builder command: ${verb}`);
      console.error();
      showNamespaceHelp('builder');
      process.exit(1);
    }
    process.argv = [process.argv[0], `appliance-${target}`, ...args.slice(2)];
    await SUBCOMMANDS[target].load();
    return;
  }

  // `appliance status` routes by link.json: a `sandbox` link (an
  // `appliance up` folder) shows the sandbox container + URL; otherwise
  // it falls through to the `app status` shortcut below (docs/up.md §2).
  if (sub === 'status') {
    const { readSandboxLink } = await import('./utils/link.js');
    if (readSandboxLink()) {
      const { runSandboxStatus } = await import('./utils/sandbox.js');
      const json = args.slice(1).includes('--json');
      process.exit(await runSandboxStatus({ json }));
    }
  }

  // Shortcut: rewrite argv so the target subcommand sees its own
  // sub-name as the first positional. Falls through to the regular
  // load below.
  const shortcut = SHORTCUTS[sub];
  if (shortcut) {
    process.argv = [process.argv[0], `appliance-${shortcut.target}`, ...shortcut.prefix, ...args.slice(1)];
    await SUBCOMMANDS[shortcut.target].load();
    return;
  }

  // `appliance cloud <verb>` — route to the underlying command module.
  if (sub === 'cloud') {
    const verb = args[1];
    const target = verb ? CLOUD_VERBS[verb] : undefined;
    if (!target) {
      console.error(`Usage: appliance cloud <${Object.keys(CLOUD_VERBS).join('|')}> [options]`);
      console.error('  install    provision a new Appliance installation on AWS with CloudFormation');
      console.error('  bootstrap  legacy three-phase installer (deprecated)');
      console.error('  teardown   destroy a cloud installation');
      process.exit(verb ? 1 : 0);
    }
    process.argv = [process.argv[0], `appliance-${target}`, ...args.slice(2)];
    await SUBCOMMANDS[target].load();
    return;
  }

  const canonical = ALIAS_MAP[sub];
  if (!canonical) {
    console.error(`Unknown command: ${sub}`);
    console.error();
    showHelp();
    process.exit(1);
  }

  // Normalize argv so the subcommand's `program.parse(process.argv)`
  // works. Commander's default `from: 'node'` slices argv[2..], so
  // we put a fake script name at argv[1] and real args from argv[2].
  process.argv = [process.argv[0], `appliance-${canonical}`, ...args.slice(1)];
  await SUBCOMMANDS[canonical].load();
}

// The last-resort net for async subcommand errors. Commander actions
// run after `program.parse` returns, so an error a subcommand doesn't
// catch itself surfaces here, not in main().catch below. Two shapes:
// Ctrl-C inside an @inquirer prompt (ExitPromptError — a plain abort,
// exit 130), and everything else — which must still come out as the
// CLI's standard red message + remediation hint, never a raw stack
// trace dumped at a non-developer.
process.on('unhandledRejection', (err) => {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.error('Cancelled.');
    process.exit(130);
  }
  void import('./utils/errors.js')
    .then(({ printCliError }) => {
      printCliError(err);
      process.exit(process.exitCode ?? 1);
    })
    .catch(() => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
});

main().catch((err) => {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.error('Cancelled.');
    process.exit(130);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
