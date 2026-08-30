import { useQuery } from '@tanstack/react-query';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useHost } from '@/providers/host-provider';
import { isMicroVmClusterId, microVmNameFromClusterId } from '@/lib/host';

// Client/server version-compat preflight for the selected cluster.
// Reads GET /api/v1/cluster-info (same query key as the deploy wizard's
// capability probe, so the cache is shared) and compares the server's
// reported versions with this app build. Everything here is ADVISORY —
// the goal is a banner with the right remediation, never a hard block:
// missing data on old servers must not strand a working cluster.

export interface ClusterCompat {
  /** No selection/client yet, or cluster-info hasn't answered. Render nothing. */
  loading: boolean;
  /** This app build's version (every package moves in lockstep). */
  clientVersion: string;
  serverVersion?: string;
  minClientVersion?: string;
  isMicroVm: boolean;
  vmName?: string;
  /** Host probe of the boot-rendered MV1 launcher marker. */
  controlPlaneUpdateCapable: boolean;
  /** Signed release trust is provisioned in this CLI build. */
  selfUpdateEnabled: boolean;
  /** The server's advisory floor is above this app's version — update the app. */
  clientBelowMinimum: boolean;
  /** microVM control plane doesn't report a version at all: the guest
   *  binary predates capability reporting — restart the Dev Machine to
   *  update it. (Cloud clusters without a version stay un-flagged: a
   *  missing field there means an older but working server.) */
  controlPlanePredatesReporting: boolean;
  /** Versions differ. Benign for cloud (independent release cadence);
   *  on a microVM it means the guest binary lags the app — a Dev
   *  Machine restart updates it. */
  versionDrift: boolean;
  /** Operational warnings the server reports on cluster-info (e.g. the
   *  guest watchdog's "legacy deploy removed — update the CLI").
   *  Human-readable lines, deduplicated, passed through verbatim;
   *  empty when the server has none (or predates the field). */
  warnings: string[];
}

/** Dev/test builds carry unstamped placeholder versions; comparing
 *  those would flag drift on every dev run. */
function isComparable(version: string | undefined): version is string {
  return Boolean(version) && !version!.replace(/^v/, '').startsWith('0.0.0');
}

/** Numeric semver comparison on the dotted core. Tolerates a leading
 *  `v` (the SDK's stamped VERSION is v-prefixed, the app's vite-defined
 *  version is not) and ignores prerelease tags — release versions here
 *  are never prereleases. Returns <0 / 0 / >0 like a comparator. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function useClusterCompat(): ClusterCompat {
  const host = useHost();
  const client = useApplianceClient();
  const { cluster } = useSelectedCluster();
  const isMicroVm = Boolean(cluster && isMicroVmClusterId(cluster.id));
  const vmName = cluster ? (microVmNameFromClusterId(cluster.id) ?? undefined) : undefined;

  const vmStatusQuery = useQuery({
    queryKey: ['microvm', vmName, 'status'],
    enabled: Boolean(host.vm && vmName),
    queryFn: () => host.vm!.instance(vmName).status(),
    retry: false,
  });

  const clusterInfoQuery = useQuery({
    // Shared with the deploy wizard's capability probe.
    queryKey: ['cluster-info', cluster?.id],
    enabled: Boolean(client),
    queryFn: async () => {
      const r = await client!.getClusterInfo();
      if (!r.success) throw r.error;
      return r.data;
    },
    retry: false,
  });

  const clientVersion = __APPLIANCE_VERSION__;
  const info = clusterInfoQuery.data;
  // Normalized for display (the SDK stamps a v-prefixed VERSION; the
  // app's vite-defined version has no prefix — don't render "vv1.x").
  const serverVersion = info?.serverVersion?.replace(/^v/, '');
  const minClientVersion = info?.minClientVersion?.replace(/^v/, '');

  // R3: a microVM whose cluster-info answers WITHOUT a serverVersion —
  // or 404s the route entirely — is running a guest binary older than
  // capability reporting. Any other error (network, auth) proves
  // nothing about the version, so it stays un-flagged.
  const notFound = clusterInfoQuery.isError && /HTTP 404\b/.test(String((clusterInfoQuery.error as Error)?.message));
  const controlPlanePredatesReporting = isMicroVm && ((Boolean(info) && !serverVersion) || notFound);

  const clientBelowMinimum =
    isComparable(clientVersion) && isComparable(minClientVersion)
      ? compareVersions(clientVersion, minClientVersion) < 0
      : false;

  const versionDrift =
    isComparable(clientVersion) && isComparable(serverVersion)
      ? compareVersions(clientVersion, serverVersion) !== 0
      : false;

  // The server already dedupes its warnings file, but re-dedupe here so
  // a future server (or proxy) repeating lines can't stack the banner.
  const warnings = [...new Set(info?.warnings ?? [])];

  return {
    loading: !client || clusterInfoQuery.isPending || (Boolean(host.vm && vmName) && vmStatusQuery.isPending),
    clientVersion,
    serverVersion,
    minClientVersion,
    isMicroVm,
    vmName,
    controlPlaneUpdateCapable: vmStatusQuery.data?.controlPlaneUpdateCapable === true,
    selfUpdateEnabled: vmStatusQuery.data?.selfUpdateEnabled === true,
    clientBelowMinimum,
    controlPlanePredatesReporting,
    versionDrift,
    warnings,
  };
}
