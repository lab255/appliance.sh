import { spawnSync } from 'node:child_process';
import { readProfiles, type Profile } from './profile-store.js';
import { vmNameForProfile } from './cluster-target.js';
import { resolveVmBinary } from './microvm-up.js';

// A "cluster" as the CLI presents it is one credential profile in
// ~/.appliance/profiles.json — the same store the desktop reads, where
// these are surfaced as clusters (control-plane.md §5). This module is
// the thin translation from that raw profile store into the cluster
// vocabulary `appliance cluster` speaks, plus the logic deciding what
// forgetting a cluster should do. The pure classification/planning
// functions carry the behavior worth testing; the command file
// (appliance-cluster.ts) stays a thin shell over them.

/** How a cluster is reached: a local microVM runtime this device boots,
 *  or a remote/cloud api-server it merely holds credentials for. */
export type ClusterKind = 'local' | 'remote';

/** One cluster row derived from a credentials profile. */
export interface ClusterEntry {
  /** Profile name — doubles as the cluster name the user types. */
  name: string;
  apiUrl: string;
  /** True when this is the active profile. */
  active: boolean;
  /** 'local' when the profile maps to a microVM (`microvm` /
   *  `microvm-<name>`), else 'remote'. */
  kind: ClusterKind;
  /** The microVM name behind a local cluster, else null. */
  vmName: string | null;
  /** True when this cluster was bootstrapped from this device and so has
   *  cloud infrastructure `appliance teardown` can destroy. */
  bootstrapped: boolean;
  /** Which surface created the profile, when recorded. */
  managed: 'desktop' | 'cli' | null;
}

/** Classify one named profile into a cluster row. Pure — the VM-name
 *  mapping is the sole "local vs remote" signal (mirrors the desktop's
 *  isMicroVmClusterId), and bootstrapped-ness is read straight off the
 *  profile's persisted state-backend / bootstrap-input fields. */
export function classifyCluster(name: string, profile: Profile, active: boolean): ClusterEntry {
  const vmName = vmNameForProfile(name);
  return {
    name,
    apiUrl: profile.apiUrl,
    active,
    kind: vmName ? 'local' : 'remote',
    vmName,
    bootstrapped: Boolean(profile.stateBackendUrl || profile.lastBootstrapInput),
    managed: profile.managed ?? null,
  };
}

/** Every registered cluster, sorted by name. Reads the shared profile
 *  store — the desktop sees the same set. */
export function listClusters(): ClusterEntry[] {
  const file = readProfiles();
  return Object.entries(file.profiles)
    .map(([name, profile]) => classifyCluster(name, profile, file.activeProfile === name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Look up one cluster by name, or null when it isn't registered. */
export function findCluster(name: string): ClusterEntry | null {
  const file = readProfiles();
  const profile = file.profiles[name];
  if (!profile) return null;
  return classifyCluster(name, profile, file.activeProfile === name);
}

export interface SelectDeployClusterOptions {
  command: 'deploy' | 'install';
  /** `install --cluster` uses the cluster vocabulary shown by
   *  `appliance cluster list`. */
  cluster?: string;
  /** Existing `--profile` spelling retained for compatibility. */
  profile?: string;
  envProfile?: string;
  activeProfile?: string | null;
}

/**
 * Choose the credential profile used by a deploy-like command.
 *
 * `deploy` preserves the existing override → environment → active-profile
 * cascade. `install` deliberately flips only the default to the local
 * cluster; an explicit --cluster (or legacy --profile) still wins.
 */
export function selectDeployCluster(opts: SelectDeployClusterOptions): string | undefined {
  if (opts.command === 'install') return opts.cluster ?? opts.profile ?? 'local';
  return opts.profile ?? opts.envProfile ?? opts.activeProfile ?? undefined;
}

/** Best-effort running-state of each defined microVM, keyed by VM name.
 *  Empty when the engine binary isn't installed (nothing to report) —
 *  so `cluster list` degrades to omitting the state column rather than
 *  failing. Not pure (shells out to the engine); kept out of the pure
 *  classification path above. */
export function localVmStates(): Map<string, boolean> {
  const states = new Map<string, boolean>();
  const bin = resolveVmBinary();
  if (!bin) return states;
  const r = spawnSync(bin, ['list'], { encoding: 'utf8' });
  if (r.status !== 0) return states;
  try {
    const entries = JSON.parse(r.stdout) as { name: string; running: boolean }[];
    for (const e of entries) states.set(e.name, e.running);
  } catch {
    // Unparseable engine output — report no states.
  }
  return states;
}

/** What removing a cluster should do:
 *   - `forget`: drop the profile from the local registry only. No
 *     infrastructure is touched — the inverse of registering it, never
 *     of bootstrapping it.
 *   - `delete-vm`: forget it AND delete the backing microVM + its state
 *     (only reachable for a local cluster, via --delete-vm).
 *   - `error`: the request is contradictory (e.g. --delete-vm on a
 *     remote cluster, which has no local VM to delete). */
export type RemovalPlan =
  | { kind: 'forget' }
  | { kind: 'delete-vm'; vmName: string }
  | { kind: 'error'; message: string };

/** Decide the removal plan for a cluster. `--delete-vm` is only
 *  meaningful for a local microVM cluster: a remote cluster has no VM on
 *  this device, and destroying the cloud infrastructure it points at is
 *  `appliance teardown`, deliberately not this command. */
export function planRemoval(entry: ClusterEntry, opts: { deleteVm: boolean }): RemovalPlan {
  if (opts.deleteVm) {
    if (entry.kind !== 'local' || !entry.vmName) {
      return {
        kind: 'error',
        message:
          `--delete-vm only applies to a local microVM cluster; "${entry.name}" is a remote cluster with no VM on this device.\n` +
          'Drop --delete-vm to just forget it, or run `appliance teardown` to destroy the cloud infrastructure it points at.',
      };
    }
    return { kind: 'delete-vm', vmName: entry.vmName };
  }
  return { kind: 'forget' };
}
