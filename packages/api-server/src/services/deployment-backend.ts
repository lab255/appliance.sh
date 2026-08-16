import { isDockerBase, isKubernetesBase } from '@appliance.sh/sdk';
import type { ApplianceBaseConfig } from '@appliance.sh/sdk';
import { LocalContainerDeploymentService, type ContainerDeploymentBackend } from '@appliance.sh/infra';
import { readBaseConfigSnapshot } from './base-config.service';

// THE base-type fork. Every service that used to branch on
// isKubernetesBase/isDockerBase/else resolves its runtime through
// here, so "which backend does this base use" has exactly one answer:
//
//   - Kubernetes bases (the microVM local runtime + BYO clusters) →
//     a ContainerDeploymentBackend driving the cluster.
//   - Cloud (AWS/Lambda) bases → null; callers take the Pulumi path
//     (deploys) or degrade/refuse (health, workloads).
//   - Docker bases → RemovedDockerBaseError. The host-daemon runtime
//     that produced them was removed; the error names the migration.

export class RemovedDockerBaseError extends Error {
  constructor() {
    super(
      'This environment targets the removed local Docker runtime. Deploy to the microVM runtime instead ' +
        '(`appliance dev`), or re-create the environment against a supported base.'
    );
    this.name = 'RemovedDockerBaseError';
  }
}

/** Read the immutable request/job snapshot (legacy env fallback included). */
export function readBaseConfig(): ApplianceBaseConfig | undefined {
  return readBaseConfigSnapshot();
}

/**
 * Resolve the container-runtime backend for a base config, or null for
 * cloud bases (whose deploys run Pulumi, and whose health/workloads
 * have no container state to read). Throws RemovedDockerBaseError for
 * the deprecated docker base.
 */
export function resolveContainerBackend(
  baseConfig: ApplianceBaseConfig | undefined
): ContainerDeploymentBackend | null {
  if (!baseConfig) return null;
  assertSupportedBase(baseConfig);
  if (isKubernetesBase(baseConfig)) return new LocalContainerDeploymentService(baseConfig);
  return null;
}

/**
 * Enforce the removed-docker-base error without constructing a
 * cluster client — for the build services, which pick their pipeline
 * by base semantics (upload vs image) rather than needing a backend.
 */
export function assertSupportedBase(baseConfig: ApplianceBaseConfig): void {
  if (isDockerBase(baseConfig)) throw new RemovedDockerBaseError();
}
