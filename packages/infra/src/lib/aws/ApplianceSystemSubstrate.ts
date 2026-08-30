import { ApplianceBaseType, applianceBaseConfig, type ApplianceBaseConfig } from '@appliance.sh/sdk';

export interface ApplianceSystemFunctionInput {
  name: string;
  arn: string;
  url: string;
}

/**
 * Plain inputs describing the resources owned by the CloudFormation
 * installer. This class intentionally does not extend ComponentResource
 * and imports no Pulumi package: constructing it can never register an AWS
 * resource. ApplianceEdgeBase consumes this immutable value only as config.
 */
export interface ApplianceSystemSubstrateConfig {
  installationName: string;
  region: string;
  stateBackendUrl: string;
  stateBucketName: string;
  stateBucketArn: string;
  dataBucketName: string;
  kmsKeyArn: string;
  kmsAliasName: string;
  ecrRepositoryUrl: string;
  userAppliancePermissionsBoundaryArn: string;
  systemRoleArns: {
    apiServer: string;
    worker: string;
  };
  systemFunctions: {
    apiServer: ApplianceSystemFunctionInput;
    worker: ApplianceSystemFunctionInput;
  };
}

export class ApplianceSystemSubstrate implements ApplianceSystemSubstrateConfig {
  readonly installationName: string;
  readonly region: string;
  readonly stateBackendUrl: string;
  readonly stateBucketName: string;
  readonly stateBucketArn: string;
  readonly dataBucketName: string;
  readonly kmsKeyArn: string;
  readonly kmsAliasName: string;
  readonly ecrRepositoryUrl: string;
  readonly userAppliancePermissionsBoundaryArn: string;
  readonly systemRoleArns: Readonly<{ apiServer: string; worker: string }>;
  readonly systemFunctions: Readonly<{
    apiServer: Readonly<ApplianceSystemFunctionInput>;
    worker: Readonly<ApplianceSystemFunctionInput>;
  }>;

  constructor(config: ApplianceSystemSubstrateConfig) {
    this.installationName = required(config.installationName, 'installationName');
    this.region = required(config.region, 'region');
    this.stateBackendUrl = required(config.stateBackendUrl, 'stateBackendUrl');
    this.stateBucketName = required(config.stateBucketName, 'stateBucketName');
    this.stateBucketArn = required(config.stateBucketArn, 'stateBucketArn');
    this.dataBucketName = required(config.dataBucketName, 'dataBucketName');
    this.kmsKeyArn = required(config.kmsKeyArn, 'kmsKeyArn');
    this.kmsAliasName = required(config.kmsAliasName, 'kmsAliasName');
    this.ecrRepositoryUrl = required(config.ecrRepositoryUrl, 'ecrRepositoryUrl');
    this.userAppliancePermissionsBoundaryArn = required(
      config.userAppliancePermissionsBoundaryArn,
      'userAppliancePermissionsBoundaryArn'
    );
    this.systemRoleArns = Object.freeze({
      apiServer: required(config.systemRoleArns.apiServer, 'systemRoleArns.apiServer'),
      worker: required(config.systemRoleArns.worker, 'systemRoleArns.worker'),
    });
    this.systemFunctions = Object.freeze({
      apiServer: freezeFunction(config.systemFunctions.apiServer, 'systemFunctions.apiServer'),
      worker: freezeFunction(config.systemFunctions.worker, 'systemFunctions.worker'),
    });
    Object.freeze(this);
  }

  static fromBaseConfig(config: ApplianceBaseConfig): ApplianceSystemSubstrate {
    if (config.provisioner !== 'cloudformation-v1') {
      throw new Error('Edge provisioning requires a cloudformation-v1 base config');
    }
    if (config.type !== ApplianceBaseType.ApplianceAwsPublic || !config.aws) {
      throw new Error(`Edge provisioning requires an AWS public base; got ${config.type}`);
    }
    const aws = config.aws;
    if (!config.stateBackendUrl) throw new Error('CFN base config is missing stateBackendUrl');
    if (!aws.stateBucketName) throw new Error('CFN base config is missing aws.stateBucketName');
    if (!aws.stateBucketArn) throw new Error('CFN base config is missing aws.stateBucketArn');
    if (!aws.dataBucketName) throw new Error('CFN base config is missing aws.dataBucketName');
    if (!aws.kmsKeyArn) throw new Error('CFN base config is missing aws.kmsKeyArn');
    if (!aws.kmsAliasName) throw new Error('CFN base config is missing aws.kmsAliasName');
    if (!aws.ecrRepositoryUrl) throw new Error('CFN base config is missing aws.ecrRepositoryUrl');
    if (!aws.userAppliancePermissionsBoundaryArn)
      throw new Error('CFN base config is missing aws.userAppliancePermissionsBoundaryArn');
    if (!aws.systemRoleArns) throw new Error('CFN base config is missing aws.systemRoleArns');
    if (!aws.systemFunctions) throw new Error('CFN base config is missing aws.systemFunctions');

    return new ApplianceSystemSubstrate({
      installationName: config.name,
      region: aws.region,
      stateBackendUrl: config.stateBackendUrl,
      stateBucketName: aws.stateBucketName,
      stateBucketArn: aws.stateBucketArn,
      dataBucketName: aws.dataBucketName,
      kmsKeyArn: aws.kmsKeyArn,
      // The alias is deliberately carried as a plain CFN output even
      // though Pulumi currently needs only the key ARN.
      kmsAliasName: aws.kmsAliasName,
      ecrRepositoryUrl: aws.ecrRepositoryUrl,
      userAppliancePermissionsBoundaryArn: aws.userAppliancePermissionsBoundaryArn,
      systemRoleArns: aws.systemRoleArns,
      systemFunctions: aws.systemFunctions,
    });
  }

  toBaseConfig(): ApplianceBaseConfig {
    return applianceBaseConfig.parse({
      name: this.installationName,
      type: ApplianceBaseType.ApplianceAwsPublic,
      provisioner: 'cloudformation-v1',
      stateBackendUrl: this.stateBackendUrl,
      aws: {
        region: this.region,
        stateBucketName: this.stateBucketName,
        stateBucketArn: this.stateBucketArn,
        dataBucketName: this.dataBucketName,
        kmsKeyArn: this.kmsKeyArn,
        kmsAliasName: this.kmsAliasName,
        ecrRepositoryUrl: this.ecrRepositoryUrl,
        userAppliancePermissionsBoundaryArn: this.userAppliancePermissionsBoundaryArn,
        systemRoleArns: this.systemRoleArns,
        systemFunctions: this.systemFunctions,
      },
    });
  }
}

function required(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`ApplianceSystemSubstrate requires ${field}`);
  }
  return value;
}

function freezeFunction(value: ApplianceSystemFunctionInput, field: string): Readonly<ApplianceSystemFunctionInput> {
  return Object.freeze({
    name: required(value.name, `${field}.name`),
    arn: required(value.arn, `${field}.arn`),
    url: required(value.url, `${field}.url`),
  });
}
