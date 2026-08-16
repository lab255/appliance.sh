import type { ApplianceBaseConfig } from '@appliance.sh/sdk';
import type { BootstrapEvent } from './types';

export const LEGACY_BOOTSTRAP_DEPRECATION =
  'deprecated: legacy 3-phase bootstrap; new installs use appliance cloud install (CloudFormation). Supported for 2 releases.';

export function emitLegacyDeprecation(emit: (event: BootstrapEvent) => void): void {
  emit({ type: 'log', level: 'warn', message: LEGACY_BOOTSTRAP_DEPRECATION });
}

export function assertLegacyInstallation(config: ApplianceBaseConfig, operation: string): void {
  if (config.provisioner === 'cloudformation-v1') {
    throw new Error(
      `${operation} is a legacy bootstrap operation, but the server-side base config is marked provisioner:'cloudformation-v1'. ` +
        'Refusing to mix Pulumi-owned bootstrap with CloudFormation-owned infrastructure.'
    );
  }
}
