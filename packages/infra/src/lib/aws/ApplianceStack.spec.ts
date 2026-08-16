import { describe, expect, it } from 'vitest';
import { ApplianceBaseType, applianceBaseConfig } from '@appliance.sh/sdk';
import { assertAwsEdgeProvisioned } from './ApplianceStack';

describe('assertAwsEdgeProvisioned', () => {
  it('refuses an ordinary workload during the substrate-only epoch', () => {
    const substrateConfig = applianceBaseConfig.parse({
      name: 'prod',
      type: ApplianceBaseType.ApplianceAwsPublic,
      provisioner: 'cloudformation-v1',
      stateBackendUrl: 's3://prod-state',
      aws: { region: 'us-east-1', dataBucketName: 'prod-data' },
    });

    expect(() => assertAwsEdgeProvisioned(substrateConfig)).toThrow(/provision the edge base first/i);
  });
});
