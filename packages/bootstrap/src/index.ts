export type { StatePromotionInput, StatePromotionOptions } from './state-promotion';
export type { StateDemotionInput, StateDemotionOptions } from './state-demotion';
export type { ApiServerUpdateInput, ApiServerUpdateOptions } from './api-server-update';
export type { BaselineUpdateInput, BaselineUpdateOptions } from './baseline-update';
export { latestGhcrTag, type LatestGhcrTagInput } from './ghcr-latest';
export {
  resolveReleaseEvidence,
  SELF_UPDATE_DISABLED_AP226,
  type ResolveReleaseEvidenceOptions,
  type ResolvedReleaseEvidence,
} from './release-evidence';
export type { TeardownOptions } from './teardown';
export { LEGACY_BOOTSTRAP_DEPRECATION, assertLegacyInstallation } from './deprecation';
export type {
  BootstrapInput,
  BootstrapOptions,
  BootstrapResult,
  BootstrapEvent,
  BootstrapPhase,
  BootstrapEngineKind,
  BootstrapPriorOutputs,
  CloudFormationInstallationRef,
} from './types';

// Keep the package root cheap to load. The CLI imports lightweight release
// evidence from here; Pulumi/bootstrap dependencies are loaded only when one
// of these operator-machine paths is actually invoked.
export async function runBootstrap(...args: Parameters<typeof import('./run').runBootstrap>) {
  const { runBootstrap: run } = await import('./run');
  return run(...args);
}

export async function runStatePromotion(...args: Parameters<typeof import('./state-promotion').runStatePromotion>) {
  const { runStatePromotion: run } = await import('./state-promotion');
  return run(...args);
}

export async function runStateDemotion(...args: Parameters<typeof import('./state-demotion').runStateDemotion>) {
  const { runStateDemotion: run } = await import('./state-demotion');
  return run(...args);
}

export async function runApiServerUpdate(...args: Parameters<typeof import('./api-server-update').runApiServerUpdate>) {
  const { runApiServerUpdate: run } = await import('./api-server-update');
  return run(...args);
}

export async function runBaselineUpdate(...args: Parameters<typeof import('./baseline-update').runBaselineUpdate>) {
  const { runBaselineUpdate: run } = await import('./baseline-update');
  return run(...args);
}

export async function runTeardown(...args: Parameters<typeof import('./teardown').runTeardown>) {
  const { runTeardown: run } = await import('./teardown');
  return run(...args);
}
