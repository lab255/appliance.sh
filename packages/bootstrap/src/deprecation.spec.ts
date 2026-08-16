import { describe, expect, it } from 'vitest';
import { applianceBaseConfig } from '@appliance.sh/sdk';
import { assertLegacyInstallation, LEGACY_BOOTSTRAP_DEPRECATION } from './deprecation';

describe('legacy bootstrap generation guard', () => {
  it('carries the two-release deprecation notice', () => {
    expect(LEGACY_BOOTSTRAP_DEPRECATION).toContain('Supported for 2 releases');
    expect(LEGACY_BOOTSTRAP_DEPRECATION).toContain('appliance cloud install');
  });

  it('rejects the server-side cloudformation-v1 marker', () => {
    const config = applianceBaseConfig.parse({
      name: 'prod',
      type: 'appliance-base-aws-public',
      provisioner: 'cloudformation-v1',
      aws: { region: 'us-east-1' },
    });
    expect(() => assertLegacyInstallation(config, 'test')).toThrow(/Refusing to mix/);
  });
});
