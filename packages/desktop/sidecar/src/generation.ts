export type InstallGeneration = 'legacy-pulumi' | 'cloudformation-v1';

/** Single dispatcher for desktop lifecycle calls; unknown markers fail closed. */
export function resolveInstallGeneration(marker: string | undefined): InstallGeneration {
  if (marker === undefined) return 'legacy-pulumi';
  if (marker === 'cloudformation-v1') return marker;
  throw new Error(`Unsupported install generation ${marker}; refusing lifecycle operation`);
}
