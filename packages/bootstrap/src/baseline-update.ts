import * as os from 'node:os';
import * as path from 'node:path';
import { runPhase1 } from './phases/phase1';
import { verifyLegacyCluster, verifyStateBackendUrl, type ClusterRef } from './cluster-verify';
import type { BootstrapEvent, BootstrapInput, CloudFormationInstallationRef } from './types';
import { emitLegacyDeprecation } from './deprecation';

export interface BaselineUpdateInput {
  /**
   * The original wizard input the cluster was bootstrapped with —
   * critically including `base.config.dns.createZone` /
   * `attachZone` so re-running phase 1 doesn't switch the
   * Route53 zone between managed and unmanaged. The desktop
   * persists this on the Cluster record at handoff time.
   */
  bootstrap?: BootstrapInput;
  /**
   * The cluster's S3 state backend URL. After phase 3 has run,
   * the installer stack lives in S3 — baseline updates have to
   * point at the same backend so the existing stack is what
   * gets updated rather than a fresh local one. Omit only when
   * the installer state is still local (rare, pre-phase-3).
   */
  stateBackendUrl?: string;
  /**
   * AWS profile for the Pulumi run. Same shape as `BootstrapInput.aws.profile`;
   * if both are supplied, this one wins (more recent operator intent).
   */
  awsProfile?: string;
  /**
   * Cluster ref. When provided, `stateBackendUrl` is verified
   * against `/api/v1/cluster-info` before any Pulumi op runs —
   * stops a malicious or stale URL from rewriting state in the
   * wrong bucket. Skipped silently if cluster-info is unreachable.
   */
  cluster?: ClusterRef;
  /** Desktop generation dispatcher; legacy engine rejects this marker. */
  installation?: CloudFormationInstallationRef;
}

export interface BaselineUpdateOptions {
  /**
   * Cache directory for the Pulumi workspace files (Pulumi.yaml, etc.).
   * Defaults to `~/.appliance`. The actual *state* lives in the URL
   * supplied via `stateBackendUrl` — `cacheDir` is just scratch.
   */
  cacheDir?: string;
  onEvent?: (event: BootstrapEvent) => void;
}

/**
 * Re-run phase 1 against an already-bootstrapped cluster's installer
 * stack to apply infra changes that have shipped with this version
 * of `@appliance.sh/infra`. Reuses the original wizard input so DNS
 * mode (createZone vs attachZone) doesn't flip between deploys.
 *
 * On success the cluster's `baselineVersion` is stamped to the
 * current SDK VERSION, visible via `/api/v1/cluster-info`. Note that
 * the running api-server / api-worker Lambdas still hold the OLD
 * `APPLIANCE_BASE_CONFIG` in their env vars until the next system
 * deploy — call `runApiServerUpdate` afterwards to propagate the
 * new baseline values into the cluster's data plane.
 */
export async function runBaselineUpdate(
  input: BaselineUpdateInput,
  options: BaselineUpdateOptions = {}
): Promise<void> {
  const cacheDir = options.cacheDir ?? path.join(os.homedir(), '.appliance');
  const emit = options.onEvent ?? (() => {});
  emitLegacyDeprecation(emit);
  await verifyLegacyCluster(input.cluster);
  if (!input.bootstrap) throw new Error('Legacy baseline update requires the original BootstrapInput');

  if (input.stateBackendUrl) {
    await verifyStateBackendUrl(input.stateBackendUrl, input.cluster, (level, message) =>
      emit({ type: 'log', level, message })
    );
  }

  emit({ type: 'log', level: 'info', message: 'updating installer stack…' });

  // Merge the supplied awsProfile into the BootstrapInput (operator
  // supplies it fresh per update; we don't want to require it to be
  // present in the persisted bootstrap input).
  const mergedInput: BootstrapInput = {
    ...input.bootstrap,
    aws: input.awsProfile ? { profile: input.awsProfile } : input.bootstrap.aws,
  };

  const result = await runPhase1(mergedInput, {
    cacheDir,
    stateBackendUrl: input.stateBackendUrl,
    emit,
  });

  emit({
    type: 'log',
    level: 'info',
    message: `baseline updated — version ${result.baseConfig.baselineVersion ?? 'unknown'} live in ${input.stateBackendUrl ?? 'local state'}`,
  });
}
