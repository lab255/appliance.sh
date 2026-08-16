import type { createApplianceClient, Deployment } from '@appliance.sh/sdk';
import { DeploymentStatus } from '@appliance.sh/sdk';

type Client = ReturnType<typeof createApplianceClient>;

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes; matches worst-case AWS deploys

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /**
   * Called every time the status changes. Receives the full Deployment
   * record so callers can format messages however they want.
   */
  onProgress?: (deployment: Deployment) => void;
}

export interface PollResult {
  deployment: Deployment;
  /** Terminal status the deployment landed in. */
  terminal: DeploymentStatus;
}

/**
 * Poll a deployment until it reaches a terminal status, then return it.
 * Calls `onProgress` whenever the (status, message) tuple changes so
 * callers can drive a live status line without seeing duplicate ticks.
 */
export async function pollDeploymentUntilDone(
  client: Client,
  deploymentId: string,
  opts: PollOptions = {}
): Promise<PollResult> {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let lastKey = '';

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const status = await client.getDeployment(deploymentId);
    if (!status.success) {
      throw new Error(`Failed to get deployment status: ${status.error.message}`);
    }

    const d = status.data;
    if (d.target?.type === 'edge' && d.status === DeploymentStatus.InProgress && d.edgeConvergence?.state === 'ready') {
      const continued = await client.continueDeployment(deploymentId);
      if (!continued.success) {
        throw new Error(`Failed to continue edge convergence: ${continued.error.message}`);
      }
    }
    const key = `${d.status}::${d.message ?? ''}`;
    if (key !== lastKey) {
      opts.onProgress?.(d);
      lastKey = key;
    }

    if (
      d.status === DeploymentStatus.Succeeded ||
      d.status === DeploymentStatus.Failed ||
      d.status === DeploymentStatus.Cancelled
    ) {
      return { deployment: d, terminal: d.status };
    }
  }

  throw new Error(
    'Timed out waiting for the deployment to settle — it may still be finishing server-side. ' +
      'Check it with `appliance status`, and `appliance logs` once it lands; re-running the same ' +
      'deploy later is safe (deploys are idempotent).'
  );
}

/**
 * Pull a URL out of a deployment's message field. Today only the local
 * runtime embeds URLs as `URL: http://localhost:30039`; cloud deploys
 * don't expose endpoints on the Deployment record yet. Returns null
 * when nothing matches so callers can degrade gracefully.
 */
export function extractDeploymentUrl(message: string | undefined | null): string | null {
  if (!message) return null;
  const match = message.match(/URL:\s*(\S+)/i);
  if (!match) return null;
  const candidate = match[1].trim();
  if (!/^https?:\/\//i.test(candidate)) return null;
  return candidate;
}

/**
 * Build a map of environmentId → URL by scanning a newest-first
 * deployment list for the most recent successful deploy per env.
 * Used by `appliance status` / `appliance list` to print a single
 * "Live URL" line under each environment with one round-trip per
 * project rather than per env.
 */
export function urlsByEnvironment(deployments: Deployment[] | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!deployments) return result;
  for (const d of deployments) {
    if (d.action !== 'deploy' || d.status !== DeploymentStatus.Succeeded) continue;
    if (result.has(d.environmentId)) continue;
    const url = extractDeploymentUrl(d.message);
    if (url) result.set(d.environmentId, url);
  }
  return result;
}
