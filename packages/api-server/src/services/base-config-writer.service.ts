import { applianceBaseConfig, type ApplianceBaseConfig } from '@appliance.sh/sdk';
import { updateBaseConfig } from './base-config.service';

const EDGE_AWS_FIELDS = [
  'zoneId',
  'certificateArn',
  'cloudfrontDistributionId',
  'cloudfrontDistributionDomainName',
  'edgeRouterRoleArn',
  'apiServerPublicUrl',
] as const;

/** Executor-only epoch-1 → epoch-2 transition after a no-change Pulumi convergence pass. */
export function attachEdgeBaseConfig(edge: ApplianceBaseConfig): Promise<ApplianceBaseConfig> {
  if (edge.provisioner !== 'cloudformation-v1' || !edge.aws) {
    throw new Error('Edge outputs are not a cloudformation-v1 AWS base config');
  }
  return updateBaseConfig((substrate) => {
    if (substrate.provisioner !== 'cloudformation-v1' || !substrate.aws) {
      throw new Error('Stored base config is not a cloudformation-v1 AWS substrate');
    }
    const aws = { ...substrate.aws } as Record<string, unknown>;
    for (const field of EDGE_AWS_FIELDS) {
      const value = edge.aws?.[field];
      if (value === undefined) throw new Error(`Edge output is missing aws.${field}`);
      aws[field] = value;
    }
    return applianceBaseConfig.parse({
      ...substrate,
      domainName: edge.domainName,
      baselineVersion: edge.baselineVersion,
      aws,
    });
  });
}

/** Reversible edge destroy: restore the retained substrate epoch instead of publishing stale routing. */
export function detachEdgeBaseConfig(): Promise<ApplianceBaseConfig> {
  return updateBaseConfig((current) => {
    if (current.provisioner !== 'cloudformation-v1' || !current.aws) {
      throw new Error('Stored base config is not a cloudformation-v1 AWS substrate');
    }
    const aws = { ...current.aws } as Record<string, unknown>;
    for (const field of EDGE_AWS_FIELDS) delete aws[field];
    const substrate = { ...current, aws } as Record<string, unknown>;
    delete substrate.domainName;
    delete substrate.baselineVersion;
    return applianceBaseConfig.parse(substrate);
  });
}
