import { microVmGone } from './utils/cluster-gc.js';
import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { PROFILES_FILE, readProfiles, removeProfile, setActiveProfile } from './utils/profile-store.js';
import { findCluster, listClusters, localVmStates, planRemoval } from './utils/cluster-registry.js';
import { DEFAULT_VM_NAME, deleteVmAndProfile } from './utils/microvm-up.js';

// `appliance cluster` — the user-facing view of the credential registry
// in ~/.appliance/profiles.json, framed as clusters to match the desktop
// (control-plane.md §5). It's the discoverable home for switching
// between clusters and, crucially, for FORGETTING one: dropping a
// cluster from this device without destroying anything.
//
// Removal here is deliberately NOT `appliance teardown`. Teardown runs
// `pulumi destroy` and tears down cloud infrastructure; `cluster rm`
// only forgets the saved URL + key (the inverse of registering the
// cluster, not of bootstrapping it) — handy for the throwaway local
// clusters you churn through during development. For a local microVM
// cluster, `--delete-vm` additionally removes the backing VM + its state.
//
// `appliance profile` remains as the lower-level alias over the same
// store; the two never diverge because both call the profile-store
// primitives here.

const program = new Command();

program.description('list, switch, and forget clusters (credential profiles shared with the desktop app)');

program
  .command('list')
  .alias('ls')
  .description('list every registered cluster')
  .action(() => {
    const clusters = listClusters();
    if (clusters.length === 0) {
      console.log(chalk.dim('No clusters. Run `appliance init` (local) or `appliance login` (remote) to add one.'));
      return;
    }
    // Running-state is only meaningful for local microVM clusters, and
    // only when the engine is installed; skip the probe entirely when
    // there's nothing to report so the table stays honest.
    const states = clusters.some((c) => c.kind === 'local') ? localVmStates() : new Map<string, boolean>();
    const width = Math.max(...clusters.map((c) => c.name.length), 4);
    console.log(`${'  '}${'NAME'.padEnd(width)}  ${'KIND'.padEnd(6)}  ${'STATE'.padEnd(8)}  URL`);
    for (const c of clusters) {
      const marker = c.active ? chalk.green(' *') : '  ';
      // Pad the PLAIN cell text, THEN colorize the padded string —
      // padding a colorized cell miscounts chalk's ANSI bytes (the same
      // idiom `appliance vm list` uses).
      const kind = (c.kind === 'local' ? chalk.cyan : chalk.magenta)(c.kind.padEnd(6));
      const stateText = microVmGone(c.name) ? 'unreachable' : stateLabel(c.kind, c.vmName, states);
      const state = (stateText === 'running' ? chalk.green : chalk.dim)(stateText.padEnd(8));
      console.log(`${marker}${c.name.padEnd(width)}  ${kind}  ${state}  ${chalk.dim(c.apiUrl)}`);
      if (stateText === 'unreachable') console.log(`    Remove stale credentials: appliance cluster rm ${c.name}`);
    }
  });

/** The STATE cell for a cluster row. Only local microVM clusters have a
 *  running-state; remote clusters render a dash. A local cluster whose VM
 *  the engine doesn't know about reads "absent" (its VM was deleted out
 *  from under the profile — exactly the orphan `cluster rm` cleans up). */
function stateLabel(kind: 'local' | 'remote', vmName: string | null, states: Map<string, boolean>): string {
  if (kind !== 'local' || vmName === null) return '-';
  if (!states.has(vmName)) return 'absent';
  return states.get(vmName) ? 'running' : 'stopped';
}

program
  .command('current')
  .description('print the active cluster name')
  .action(() => {
    const file = readProfiles();
    if (!file.activeProfile || !file.profiles[file.activeProfile]) {
      console.error(chalk.red('No active cluster.'));
      process.exit(1);
    }
    console.log(file.activeProfile);
  });

program
  .command('use <name>')
  .description('switch the active cluster')
  .action((name: string) => {
    if (!setActiveProfile(name)) {
      console.error(chalk.red(`Cluster not found: ${name}`));
      console.error(chalk.dim('Run `appliance cluster list` to see registered clusters.'));
      process.exit(1);
    }
    console.log(chalk.green(`Active cluster: ${name}`));
  });

program
  .command('show [name]')
  .description('show cluster details (secret is redacted)')
  .action((name?: string) => {
    const file = readProfiles();
    const target = name ?? file.activeProfile ?? undefined;
    if (!target) {
      console.error(chalk.red('No cluster name given and no active cluster.'));
      process.exit(1);
    }
    const entry = findCluster(target);
    const profile = file.profiles[target];
    if (!entry || !profile) {
      console.error(chalk.red(`Cluster not found: ${target}`));
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          name: entry.name,
          active: entry.active,
          kind: entry.kind,
          vmName: entry.vmName,
          apiUrl: entry.apiUrl,
          keyId: profile.keyId,
          bootstrapped: entry.bootstrapped,
          managed: entry.managed,
          // Truncate so a pasted terminal log doesn't leak the full key
          // while still identifying it. A desktop-managed cluster keeps
          // its secret in the macOS Keychain, not the file — say so
          // rather than render a misleading null.
          secret: profile.secret
            ? `${profile.secret.slice(0, 6)}…(redacted)`
            : profile.managed === 'desktop' && process.platform === 'darwin'
              ? '(stored in macOS Keychain)'
              : null,
        },
        null,
        2
      )
    );
  });

program
  .command('rm <name>')
  .aliases(['remove', 'delete'])
  .description('forget a cluster from this device (does NOT destroy infrastructure — that is `appliance teardown`)')
  .option('--delete-vm', 'also delete the backing local microVM and its state (local clusters only)', false)
  .option('-y, --yes', 'skip the confirmation prompt', false)
  .action(async (name: string, opts: { deleteVm: boolean; yes: boolean }) => {
    const entry = findCluster(name);
    if (!entry) {
      console.error(chalk.red(`Cluster not found: ${name}`));
      const others = listClusters();
      if (others.length > 0) {
        console.error(chalk.dim(`Registered clusters: ${others.map((c) => c.name).join(', ')}`));
      }
      process.exit(1);
    }

    const plan = planRemoval(entry, { deleteVm: opts.deleteVm });
    if (plan.kind === 'error') {
      console.error(chalk.red(plan.message));
      process.exit(1);
    }

    if (!opts.yes) {
      const message =
        plan.kind === 'delete-vm'
          ? `Delete microVM '${plan.vmName}' (its state + data) and forget cluster '${name}'? This cannot be undone.`
          : `Forget cluster '${name}' from this device? Infrastructure is left untouched.`;
      const ok = await confirm({ message, default: false });
      if (!ok) {
        console.log(chalk.dim('aborted'));
        return;
      }
    }

    if (plan.kind === 'delete-vm') {
      const code = deleteVmAndProfile(plan.vmName);
      if (code !== 0) {
        console.error(chalk.red(`Failed to delete microVM '${plan.vmName}'.`));
        process.exit(code);
      }
      console.log(chalk.green(`Deleted microVM '${plan.vmName}' and forgot cluster '${name}'.`));
      return;
    }

    if (!removeProfile(name)) {
      // planRemoval already confirmed the entry exists, so a false here
      // is a lost race with a concurrent writer — report it plainly.
      console.error(chalk.red(`Cluster not found: ${name}`));
      process.exit(1);
    }
    console.log(chalk.green(`Forgot cluster '${name}'.`));
    if (entry.kind === 'local' && entry.vmName !== null) {
      const nameFlag = entry.vmName === DEFAULT_VM_NAME ? '' : ` --name ${entry.vmName}`;
      console.log(
        chalk.dim(
          `  Its microVM '${entry.vmName}' is still on disk — remove it with \`appliance vm delete${nameFlag}\` (or re-run with --delete-vm).`
        )
      );
    } else if (entry.bootstrapped) {
      console.log(
        chalk.dim(
          "  Cloud infrastructure is untouched. Destroy it with `appliance teardown` on the device holding this cluster's Pulumi state."
        )
      );
    }
  });

program
  .command('path')
  .description('print the absolute path of the cluster/credential store')
  .action(() => {
    console.log(PROFILES_FILE);
  });

program.parse(process.argv);
