import {
  Deployment,
  DeploymentInput,
  DeploymentStatus,
  DeploymentAction,
  EnvironmentStatus,
  generateId,
  signRequest,
  type SigningCredentials,
} from '@appliance.sh/sdk';
import { getStorageService } from './storage.service';
import { environmentService } from './environment.service';
import { envVarService } from './env-var.service';
import { projectService } from './project.service';
import { executeDeployment, type WorkerEvent } from './deployment-executor.service';
import { getCurrentTenant } from './tenant-context';
import { logger } from '../logger';

const COLLECTION = 'deployments';

// Client-side timeout for dispatching to the worker. We only need enough
// time for the request to reach the worker and start processing — we do
// NOT wait for the deployment to finish. The worker continues running
// even if we abort the connection.
const DISPATCH_TIMEOUT_MS = 5000;

export class EnvironmentBusyError extends Error {
  constructor(environmentId: string, status: EnvironmentStatus) {
    super(`Environment ${environmentId} is ${status}`);
    this.name = 'EnvironmentBusyError';
  }
}

export class DeploymentService {
  async execute(input: DeploymentInput, caller: SigningCredentials): Promise<Deployment> {
    const storage = getStorageService();

    const environment = await environmentService.get(input.environmentId);
    if (!environment) {
      throw new Error(`Environment not found: ${input.environmentId}`);
    }

    // Refuse to start a new deployment while a transition is in flight
    // for this environment — overlapping Pulumi runs on the same stack
    // would race on state. `Deploying`, `Destroying`, and `Refreshing`
    // are rejected: `Pending` is the initial state (must allow the
    // first deploy), and terminal states (`Deployed`, `Destroyed`,
    // `Failed`) are all safe to start a new deployment from.
    if (
      environment.status === EnvironmentStatus.Deploying ||
      environment.status === EnvironmentStatus.Destroying ||
      environment.status === EnvironmentStatus.Refreshing
    ) {
      throw new EnvironmentBusyError(environment.id, environment.status);
    }

    const project = await projectService.get(environment.projectId);
    if (!project) {
      throw new Error(`Project not found: ${environment.projectId}`);
    }

    // Inject the environment's stored variables (set via `appliance env
    // set`) so they reach every deploy without the client resending
    // them. Only on Deploy — Destroy/Refresh don't run the workload.
    // Per-deploy values (input.environment, populated from the
    // manifest / --env-file) win over stored ones: the stored set is
    // the persistent baseline, the per-deploy map is the local override.
    let effectiveInput = input;
    if (input.action === DeploymentAction.Deploy) {
      const stored = await envVarService.get(environment.id);
      if (Object.keys(stored).length > 0) {
        effectiveInput = { ...input, environment: { ...stored, ...(input.environment ?? {}) } };
      }
    }

    const now = new Date().toISOString();
    const { environment: _env, ...inputWithoutEnv } = effectiveInput;
    const deployment: Deployment = {
      ...inputWithoutEnv,
      id: generateId('deployment'),
      projectId: environment.projectId,
      status: DeploymentStatus.Pending,
      startedAt: now,
      ...(effectiveInput.target?.type === 'edge' ? { edgeConvergence: { state: 'running' as const, attempt: 1 } } : {}),
    };

    await storage.set(COLLECTION, deployment.id, deployment);

    // Capture the prior env status BEFORE flipping it. Refresh
    // restores this on success; Deploy/Destroy ignore it (they
    // compute their own terminal status — Deployed/Destroyed/Failed).
    const priorEnvStatus = environment.status;

    const envStatus =
      input.action === DeploymentAction.Deploy
        ? EnvironmentStatus.Deploying
        : input.action === DeploymentAction.Destroy
          ? EnvironmentStatus.Destroying
          : EnvironmentStatus.Refreshing;
    await environmentService.updateStatus(environment.id, envStatus);

    const workerEvent: WorkerEvent = {
      deploymentId: deployment.id,
      input: effectiveInput,
      metadata: {
        projectId: project.id,
        projectName: project.name,
        environmentId: environment.id,
        environmentName: environment.name,
        deploymentId: deployment.id,
        stackName: environment.stackName,
      },
      priorEnvStatus,
      // Capture the caller's tenant (server-derived, from the ambient
      // request context) so the inline/background executor re-establishes
      // the same scope. Undefined in single-tenant mode.
      tenantId: getCurrentTenant(),
      ...(effectiveInput.target?.type === 'edge' ? { edgeAttempt: 1 } : {}),
    };

    try {
      await this.dispatch(workerEvent, caller);
    } catch (error) {
      logger.error('failed to dispatch worker', error, { deploymentId: deployment.id });
      deployment.status = DeploymentStatus.Failed;
      deployment.completedAt = new Date().toISOString();
      deployment.message = `Failed to dispatch worker: ${error instanceof Error ? error.message : String(error)}`;
      await storage.set(COLLECTION, deployment.id, deployment);
      await environmentService.updateStatus(environment.id, EnvironmentStatus.Failed);
    }

    return deployment;
  }

  /**
   * Dispatches a job to a worker. If WORKER_URL is set, the job is sent
   * via HTTP to a separate worker container. Otherwise it runs inline
   * (useful for local dev and single-container deployments).
   *
   * The dispatch is re-signed with the ORIGINAL caller's API key. This
   * means the worker's /api/internal routes authenticate against the same
   * shared api-key store as the data plane — no separate worker secret
   * to leak, and the worker can attribute the job back to the real
   * caller for audit purposes.
   */
  private async dispatch(event: WorkerEvent, caller: SigningCredentials): Promise<void> {
    const workerUrl = process.env.WORKER_URL;
    if (!workerUrl) {
      // Inline execution — run in background, don't await.
      executeDeployment(event).catch((err) => {
        logger.error('inline deployment execution failed', err, { deploymentId: event.deploymentId });
      });
      return;
    }

    const url = `${workerUrl.replace(/\/$/, '')}/api/internal/jobs/deployment`;
    const body = JSON.stringify(event);
    const baseHeaders: Record<string, string> = { 'content-type': 'application/json' };

    const sigHeaders = await signRequest(caller, { method: 'POST', url, headers: baseHeaders, body });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...baseHeaders, ...sigHeaders },
        body,
        signal: controller.signal,
      });

      // If we got a response within the timeout window, surface any errors.
      if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(`Worker returned ${response.status}: ${responseBody}`);
      }
    } catch (error) {
      // AbortError is expected — we only wait long enough for the request
      // to reach the worker. The worker continues running even if we
      // abort the client side of the connection.
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('worker dispatch aborted (expected, worker continues)', {
          deploymentId: event.deploymentId,
        });
        return;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Advance one persisted edge continuation lease and dispatch its next bounded worker pass. */
  async continueEdge(id: string, caller: SigningCredentials): Promise<Deployment | null> {
    const storage = getStorageService();
    const versioned = await storage.getVersioned<Deployment>(COLLECTION, id);
    if (!versioned) return null;
    const deployment = versioned.value;
    if (deployment.target?.type !== 'edge') throw new Error('Only edge deployments can be continued');
    if (deployment.status !== DeploymentStatus.InProgress || deployment.edgeConvergence?.state !== 'ready') {
      return deployment;
    }
    const environment = await environmentService.get(deployment.environmentId);
    if (!environment) throw new Error(`Environment not found: ${deployment.environmentId}`);
    const project = await projectService.get(environment.projectId);
    if (!project) throw new Error(`Project not found: ${environment.projectId}`);

    const attempt = deployment.edgeConvergence.attempt + 1;
    const leased: Deployment = {
      ...deployment,
      edgeConvergence: { state: 'running', attempt },
      message: `Edge convergence pass ${attempt} dispatched…`,
    };
    const wonLease = await storage.setIfVersion(COLLECTION, leased.id, leased, versioned.version);
    if (!wonLease) return storage.get<Deployment>(COLLECTION, id);
    const event: WorkerEvent = {
      deploymentId: leased.id,
      input: {
        environmentId: leased.environmentId,
        action: leased.action,
        target: leased.target,
      },
      metadata: {
        projectId: project.id,
        projectName: project.name,
        environmentId: environment.id,
        environmentName: environment.name,
        deploymentId: leased.id,
        stackName: environment.stackName,
      },
      tenantId: getCurrentTenant(),
      edgeAttempt: attempt,
    };
    try {
      await this.dispatch(event, caller);
    } catch (error) {
      const latest = await storage.getVersioned<Deployment>(COLLECTION, leased.id);
      if (
        latest?.value.status === DeploymentStatus.InProgress &&
        latest.value.edgeConvergence?.state === 'running' &&
        latest.value.edgeConvergence.attempt === attempt
      ) {
        await storage.setIfVersion(
          COLLECTION,
          leased.id,
          {
            ...latest.value,
            edgeConvergence: { state: 'ready', attempt },
            message: `Edge continuation dispatch failed and is safe to retry: ${error instanceof Error ? error.message : String(error)}`,
          },
          latest.version
        );
      }
      throw error;
    }
    return leased;
  }

  async get(id: string): Promise<Deployment | null> {
    const storage = getStorageService();
    return storage.get<Deployment>(COLLECTION, id);
  }

  /**
   * Request cancellation of a deployment.
   *
   * Cooperative ({ force: false } — default): sets status to
   * Cancelling on Pending/InProgress records; the worker observes
   * the flag on its next status poll, calls stack.cancel() on the
   * running Pulumi op, then runs stack.refresh to reconcile state
   * and writes the final Cancelled status. Terminal-state and
   * already-cancelling deployments are returned unchanged.
   *
   * Force ({ force: true }): bypasses worker cooperation. Writes a
   * terminal Cancelled status directly and flips the environment
   * to Failed. Used to unstick a deployment whose worker is dead
   * (Lambda timeout, container crashed). Pulumi state is NOT
   * refreshed — operators run `pulumi refresh` after reaping the
   * stale worker. Already-terminal deployments are returned
   * unchanged.
   */
  async cancel(id: string, options: { force?: boolean } = {}): Promise<Deployment | null> {
    const storage = getStorageService();
    const deployment = await storage.get<Deployment>(COLLECTION, id);
    if (!deployment) return null;

    // Already terminal — nothing to do regardless of force.
    if (
      deployment.status === DeploymentStatus.Cancelled ||
      deployment.status === DeploymentStatus.Succeeded ||
      deployment.status === DeploymentStatus.Failed
    ) {
      return deployment;
    }

    if (options.force) {
      deployment.status = DeploymentStatus.Cancelled;
      deployment.completedAt = new Date().toISOString();
      deployment.message =
        'Force-cancelled. Worker cooperation was bypassed; Pulumi state may not match reality. ' +
        'Run `pulumi refresh` after the worker is reaped if you suspect drift.';
      await storage.set(COLLECTION, deployment.id, deployment);
      await environmentService.updateStatus(deployment.environmentId, EnvironmentStatus.Failed);
      logger.warn('deployment force-cancelled', { deploymentId: deployment.id });
      return deployment;
    }

    // No worker is active between bounded edge passes, so cooperative
    // cancellation can settle immediately instead of waiting for a poller
    // that does not currently exist.
    if (deployment.target?.type === 'edge' && deployment.edgeConvergence?.state === 'ready') {
      deployment.status = DeploymentStatus.Cancelled;
      deployment.completedAt = new Date().toISOString();
      deployment.message = 'Edge convergence cancelled between worker invocations.';
      await storage.set(COLLECTION, deployment.id, deployment);
      await environmentService.updateStatus(deployment.environmentId, EnvironmentStatus.Failed);
      return deployment;
    }

    // Cooperative cancel — already cancelling means a previous
    // request is in flight. Don't churn the record.
    if (deployment.status === DeploymentStatus.Cancelling) {
      return deployment;
    }

    deployment.status = DeploymentStatus.Cancelling;
    await storage.set(COLLECTION, deployment.id, deployment);
    logger.info('deployment cancellation requested', { deploymentId: deployment.id });
    return deployment;
  }

  async listByEnvironment(environmentId: string): Promise<Deployment[]> {
    const storage = getStorageService();
    return storage.filter<Deployment>(COLLECTION, (d) => d.environmentId === environmentId);
  }

  /**
   * List deployments sorted by `startedAt` descending (most recent
   * first). Optional filters narrow by environment or project.
   * `limit` is clamped to [1, 200] to keep any single S3 page
   * materialization bounded.
   */
  async list(options?: {
    limit?: number;
    offset?: number;
    environmentId?: string;
    projectId?: string;
  }): Promise<Deployment[]> {
    const storage = getStorageService();
    const all = await storage.getAll<Deployment>(COLLECTION);

    const filtered = all.filter((d) => {
      if (options?.environmentId && d.environmentId !== options.environmentId) return false;
      if (options?.projectId && d.projectId !== options.projectId) return false;
      return true;
    });

    filtered.sort((a, b) => {
      const at = new Date(a.startedAt).getTime();
      const bt = new Date(b.startedAt).getTime();
      return bt - at;
    });

    const offset = Math.max(0, options?.offset ?? 0);
    const limit = Math.min(Math.max(1, options?.limit ?? 50), 200);
    return filtered.slice(offset, offset + limit);
  }
}

export const deploymentService = new DeploymentService();
