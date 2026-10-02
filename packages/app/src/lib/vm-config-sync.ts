import type { QueryClient } from '@tanstack/react-query';
import { microVmNameFromClusterId, type ConsoleHost, type HostConfig, type MicroVmStatus } from './host';

const CONFIG_KEY = ['host', 'config'] as const;

/** Existing status polls trigger native registry GC before a stale key can
 * stay bound to a port another VM now owns. No connectivity-based deletion:
 * getConfig checks the persisted VM registry and preserves stopped VMs. */
export function subscribeToVmConfigChanges(client: QueryClient, host: ConsoleHost): () => void {
  let refreshing = false;
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const [kind, name, action] = event.query.queryKey;
    if (kind !== 'microvm' || typeof name !== 'string' || action !== 'status') return;
    const status = event.query.state.data as MicroVmStatus | undefined;
    if (status?.exists !== false || refreshing) return;
    const config = client.getQueryData<HostConfig>(CONFIG_KEY);
    const affectedIds = new Set(
      config?.clusters
        .filter((cluster) => microVmNameFromClusterId(cluster.id, cluster.apiServerUrl) === name)
        .map((cluster) => cluster.id)
    );
    if (!config || !affectedIds.size) return;
    refreshing = true;
    // Cancel a previous config fetch and immediately detach the affected key;
    // invalidation alone would leave it usable while the native GC is pending.
    void client.cancelQueries({ queryKey: CONFIG_KEY });
    if (config.selectedClusterId && affectedIds.has(config.selectedClusterId)) {
      client.setQueryData<HostConfig>(CONFIG_KEY, { ...config, apiKey: null });
    }
    void client
      .fetchQuery({ queryKey: CONFIG_KEY, queryFn: () => host.getConfig(), staleTime: 0 })
      .catch(() => {
        /* Keep the key withheld on a failed refresh. */
      })
      .finally(() => {
        refreshing = false;
      });
  });
}
