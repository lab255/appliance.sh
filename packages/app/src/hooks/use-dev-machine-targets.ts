import { useQuery } from '@tanstack/react-query';
import { resolveDevMachineTargets } from '@/lib/dev-machine-targets';
import { useHost } from '@/providers/host-provider';
import type { Cluster } from '@/lib/host';

/** Shared VM-inventory probe for every surface that needs to distinguish
 *  no machine, a core-only machine, and a registered deploy target.
 *  A missing engine or failed inventory probe deliberately degrades to an
 *  empty inventory: those cases are unconfigured, not error pages. */
export function useDevMachineTargets(clusters: Cluster[]) {
  const host = useHost();
  const vmListQuery = useQuery({
    queryKey: ['microvm', 'list'],
    enabled: Boolean(host.vm),
    queryFn: () => host.vm!.list(),
  });
  // Even if React Query retains older data during a failed refetch, a
  // failed probe is not evidence that a machine currently exists.
  const targets = resolveDevMachineTargets(clusters, vmListQuery.isError ? [] : (vmListQuery.data ?? []));
  return {
    ...targets,
    isLoading: Boolean(host.vm) && vmListQuery.isPending && !vmListQuery.isError,
  };
}
