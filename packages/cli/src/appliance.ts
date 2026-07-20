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
  build: {
    description: 'builds the appliance in the current working directory',
    load: () => import('./appliance-build.js'),
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
    description: 'deploy the linked (or named) project/environment',
    aliases: ['install'],
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
  bootstrap: 'bootstrap',
  teardown: 'teardown',
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

// Help groups the commands by audience instead of alphabetically: the
// everyday loop first, then configuration, then the advanced cloud &
// machine surface — so the common path is obvious before the long
// tail. Names must exist in SUBCOMMANDS (or SHORTCUTS, rendered as an
// alias line); anything unlisted lands in "Other" so a newly-registered
// command is never silently hidden.
const COMMAND_GROUPS: Array<{ title: string; names: string[] }> = [
  {
    title: 'Getting started & everyday',
    names: ['init', 'dev', 'deploy', 'logs', 'open', 'status', 'agent', 'up', 'shell', 'down'],
  },
  {
    title: 'Configuration (profiles, environments, project links)',
    names: ['configure', 'env', 'link', 'unlink', 'stack', 'app', 'cluster', 'login', 'whoami'],
  },
  {
    title: 'Advanced (cloud installs, machine & diagnostics)',
    names: [
      'bootstrap',
      'teardown',
      'vm',
      'deployment',
      'keys',
      'doctor',
      'test',
      'mcp',
      'manifest',
      'build',
      'destroy',
      'upgrade',
    ],
  },
];

function showHelp(): void {
  console.log('Usage: appliance <command> [options]');
  const allNames = Object.keys(SUBCOMMANDS).filter((n) => !SUBCOMMANDS[n].hidden);
  const width = Math.max(...allNames.map((n) => n.length));
  const grouped = new Set(COMMAND_GROUPS.flatMap((g) => g.names));
  const leftovers = allNames.filter((n) => !grouped.has(n)).sort();
  const groups = [...COMMAND_GROUPS, ...(leftovers.length > 0 ? [{ title: 'Other', names: leftovers }] : [])];
  for (const group of groups) {
    console.log();
    console.log(`${group.title}:`);
    for (const name of group.names) {
      const def = SUBCOMMANDS[name];
      if (!def) {
        // A shortcut listed in a group (e.g. `status`) renders as its
        // alias line here instead of in the Shortcuts section below.
        const sc = SHORTCUTS[name];
        if (sc) console.log(`  ${name.padEnd(width)}  alias for \`appliance ${sc.target} ${sc.prefix.join(' ')}\``);
        continue;
      }
      const aliasTail = def.aliases && def.aliases.length > 0 ? ` (alias: ${def.aliases.join(', ')})` : '';
      console.log(`  ${name.padEnd(width)}  ${def.description}${aliasTail}`);
    }
  }
  console.log();
  console.log('Shortcuts:');
  for (const [name, sc] of Object.entries(SHORTCUTS)) {
    if (grouped.has(name)) continue;
    console.log(`  ${name.padEnd(width)}  alias for \`appliance ${sc.target} ${sc.prefix.join(' ')}\``);
  }
  console.log(`  ${'cloud'.padEnd(width)}  umbrella: \`appliance cloud bootstrap|teardown\``);
  console.log();
  console.log('The three journeys:');
  console.log('  1. Build & run your app(s):   appliance dev            (deploy + logs + rebuild on save;');
  console.log('                                multi-service via appliance.stack.json — same command)');
  console.log('  2. Dev environment + agents:  appliance up  →  appliance agent login  →  appliance agent start');
  console.log('  3. Ship the same app to AWS:  appliance cloud bootstrap  →  appliance deploy --profile <cloud>');
  console.log();
  console.log('Environment variables:');
  console.log('  APPLIANCE_PROFILE               credential profile to use (overrides the active profile)');
  console.log('  APPLIANCE_API_URL               override the api-server URL from the profile');
  console.log('  APPLIANCE_TRUST_MANIFEST=1      skip the programmatic-manifest trust prompt (CI)');
  console.log();
  console.log('Run `appliance <command> --help` for command-specific options.');
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
      console.error('  bootstrap  provision a new Appliance installation on AWS');
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

// Ctrl-C inside an @inquirer prompt rejects with ExitPromptError.
// Subcommands that don't wrap their prompts in try/catch would
// otherwise crash with a stack trace on a plain abort — catch it
// centrally and exit with the conventional 130 instead.
process.on('unhandledRejection', (err) => {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.error('Cancelled.');
    process.exit(130);
  }
  throw err;
});

main().catch((err) => {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.error('Cancelled.');
    process.exit(130);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
