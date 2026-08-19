import { isMicroVmClusterId, microVmClusterId } from './host';
import type { Cluster, MicroVmSummary } from './host';

// One machine, two config entries: the CLI writes its own profiles (e.g.
// `local`) whose URL is a local VM's forwarded api-server endpoint
// (`http://api.appliance.localhost:<hostPort>`) — the same machine the VM
// deployment layer registers under a `microvm*` cluster id. A bare profile ingest
// surfaces both as separate clusters, so one machine reads as two targets
// with the duplicate mislabeled "cloud".
//
// This module is the ONE place that dedupe policy lives. Given the cluster
// list + the live VM inventory it decides which entries are ALIASES of a
// local VM and folds them into the VM's own row. Aliases don't just
// relabel — they REBIND: useSelectedCluster resolves a stored alias
// selection to the microvm cluster id, so readiness gating, credential
// sync, and the SDK client all follow the VM's identity. An alias row is
// therefore never rendered (its twin is) and never stays selected.
//
// Two deliberate boundaries:
//  - Only RUNNING VMs match. A stopped VM's hostPort is unbound, so a
//    genuinely distinct local api-server (the local-server feature) may be
//    listening on that port — matching it would hide a real target and
//    mislabel it as the Dev Machine.
//  - An alias with no `microvm*` twin in the cluster registry is left
//    alone: there's no cluster record to rebind to, and a relabel-only
//    dedupe is exactly the broken half-identity this module replaces. It
//    renders and behaves as the plain cluster it claims to be.

/** The fields alias matching needs from the VM inventory — kept narrow so
 *  tests / callers with partial summaries can use the helpers. */
export type VmPortInfo = Pick<MicroVmSummary, 'name' | 'hostPort' | 'running'>;

/** Hostname shapes that resolve to this computer — bare localhost /
 *  loopback IPs, plus any `*.localhost` name (the VM's forwarded
 *  api-server is reached at `api.appliance.localhost`, which resolves
 *  to 127.0.0.1). */
function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')
  );
}

function urlPort(apiServerUrl: string): number | null {
  let url: URL;
  try {
    url = new URL(apiServerUrl);
  } catch {
    return null;
  }
  if (!isLoopbackHostname(url.hostname)) return null;
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

/** Whether a cluster entry COULD be a Dev Machine alias — a non-microvm
 *  record whose URL points at this computer. This is the cheap, inventory-
 *  free pre-check useSelectedCluster gates on: a selection that can't be
 *  an alias must never gain a loading dependency on `vm.list()`. */
export function couldBeDevMachineAlias(cluster: Pick<Cluster, 'id' | 'apiServerUrl'>): boolean {
  return !isMicroVmClusterId(cluster.id) && urlPort(cluster.apiServerUrl) !== null;
}

/** The RUNNING local VM whose forwarded api-server endpoint
 *  `apiServerUrl` points at, or null. Stopped VMs never match — see the
 *  module comment for why. */
export function runningMicroVmBehindUrl(apiServerUrl: string, vms: readonly VmPortInfo[]): string | null {
  const port = urlPort(apiServerUrl);
  if (port === null) return null;
  return vms.find((vm) => vm.running && vm.hostPort === port)?.name ?? null;
}

export interface DevMachineTargets {
  /** The canonical target list: the input clusters with alias entries
   *  folded into their `microvm*` twin. What the switcher renders. */
  visibleClusters: Cluster[];
  /** Canonical NON-Dev-Machine targets: cloud installations, BYO
   *  clusters, and standalone local servers. What the deploy wizard's
   *  cloud rows + its auto-skip counting consume. */
  cloudClusters: Cluster[];
  /** alias cluster id → the `microvm*` cluster id it resolves to. What
   *  useSelectedCluster rebinds a stored alias selection through. */
  aliasToMicroVm: Map<string, string>;
  /** The VM inventory that establishes whether a local machine exists,
   *  independent of deployment-layer registration. */
  machines: readonly VmPortInfo[];
  /** Local VMs that exist but do not yet have a real deploy-target
   *  cluster record. The switcher renders these as navigation-only rows. */
  coreMachines: VmPortInfo[];
  /** Canonical local-machine lifecycle state. A cluster record wins over
   *  the VM inventory because it represents the deploy-capable identity. */
  state: 'none' | 'core-machine' | 'deploy-target';
}

/** Compute the canonical deploy-target view of the cluster registry.
 *  Pure + cheap; every dedupe consumer (switcher, deploy wizard, the
 *  selection hook) derives from this so the policy can't diverge. */
export function resolveDevMachineTargets(clusters: Cluster[], vms: readonly VmPortInfo[]): DevMachineTargets {
  const aliasToMicroVm = new Map<string, string>();
  for (const cluster of clusters) {
    if (isMicroVmClusterId(cluster.id)) continue;
    const vmName = runningMicroVmBehindUrl(cluster.apiServerUrl, vms);
    if (!vmName) continue;
    const twinId = microVmClusterId(vmName);
    // Fold only when the VM's own cluster record exists — that's the
    // identity the alias rebinds to. No twin ⇒ leave the entry alone.
    if (clusters.some((c) => c.id === twinId)) aliasToMicroVm.set(cluster.id, twinId);
  }
  const visibleClusters = clusters.filter((c) => !aliasToMicroVm.has(c.id));
  const cloudClusters = visibleClusters.filter((c) => !isMicroVmClusterId(c.id));
  const devMachineClusterIds = new Set(visibleClusters.filter((c) => isMicroVmClusterId(c.id)).map((c) => c.id));
  const coreMachines = vms.filter((vm) => !devMachineClusterIds.has(microVmClusterId(vm.name)));
  const state = devMachineClusterIds.size > 0 ? 'deploy-target' : coreMachines.length > 0 ? 'core-machine' : 'none';
  return { visibleClusters, cloudClusters, aliasToMicroVm, machines: vms, coreMachines, state };
}
