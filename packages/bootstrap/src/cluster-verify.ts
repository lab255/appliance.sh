import { createApplianceClient } from '@appliance.sh/sdk';
import { assertLegacyInstallation } from './deprecation';

export interface ClusterRef {
  apiServerUrl: string;
  apiKey: { id: string; secret: string };
}

export async function verifyLegacyCluster(cluster: ClusterRef | undefined): Promise<void> {
  if (!cluster) return;
  const client = createApplianceClient({
    baseUrl: cluster.apiServerUrl,
    credentials: { keyId: cluster.apiKey.id, secret: cluster.apiKey.secret },
  });
  const result = await client.getClusterInfo();
  if (!result.success)
    throw new Error(`cluster-info unavailable; cannot verify legacy ownership: ${result.error.message}`);
  assertLegacyInstallation(result.data.baseConfig, 'legacy bootstrap');
}

/**
 * Verify a caller-supplied stateBackendUrl matches what the cluster's
 * /api/v1/cluster-info reports as the canonical state backend. Used
 * by state promote/demote to defend against a malicious or mistaken
 * URL pointing at a bucket the operator doesn't actually control —
 * importing into the wrong bucket would cross-pollute installer
 * state, exporting from one would expose state to a third party.
 *
 * No-op when the cluster ref isn't supplied (e.g. caller is operating
 * standalone without an authenticated api-server). When cluster-info
 * 404s — the same case the api-server self-update flow handles —
 * we can't verify and have to trust the supplied URL; we surface a
 * warning so the operator knows verification was skipped.
 */
export async function verifyStateBackendUrl(
  stateBackendUrl: string,
  cluster: ClusterRef | undefined,
  onLog?: (level: 'info' | 'warn', message: string) => void
): Promise<void> {
  if (!cluster) return;

  const client = createApplianceClient({
    baseUrl: cluster.apiServerUrl,
    credentials: { keyId: cluster.apiKey.id, secret: cluster.apiKey.secret },
  });
  const r = await client.getClusterInfo();
  if (!r.success) {
    onLog?.(
      'warn',
      `cluster-info unavailable (${r.error.message}); skipping state-backend-URL verification — proceed at your own risk.`
    );
    return;
  }
  const expected = r.data.baseConfig.stateBackendUrl;
  assertLegacyInstallation(r.data.baseConfig, 'legacy installer-state operation');
  if (expected !== stateBackendUrl) {
    throw new Error(
      `stateBackendUrl mismatch: cluster /cluster-info reports ${expected || '<empty>'}, ` +
        `but caller supplied ${stateBackendUrl}. Refusing to operate on a bucket the cluster doesn't claim.`
    );
  }
}
