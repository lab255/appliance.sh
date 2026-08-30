export type ImageArchitecture = 'x86_64' | 'arm64';
export type RegistryArchitecture = 'amd64' | 'arm64';
export type SystemRoleMode = 'scoped' | 'admin';
export type SelfUpdatePolicy = 'off' | 'notify' | 'auto';

export interface SystemFunctionOutput {
  name: string;
  arn: string;
  url: string;
}

export interface ApplianceCloudOutputs {
  stateBucketName: string;
  stateBucketArn: string;
  dataBucketName: string;
  dataBucketArn: string;
  kmsKeyArn: string;
  kmsAliasName: string;
  imageRepositoryUrl: string;
  apiServerRoleArn: string;
  workerRoleArn: string;
  bootstrapTokenSecretArn: string;
  /** Added by the CU0 template; absent from pre-1.58 stack snapshots. */
  userAppliancePermissionsBoundaryArn?: string;
  /** Added by CU1; optional while resolving the pre-update stack snapshot. */
  selfUpdateRoleArn?: string;
  /** Added by CU1; optional while resolving the pre-update stack snapshot. */
  selfUpdateCloudFormationRoleArn?: string;
  apiServer?: SystemFunctionOutput;
  worker?: SystemFunctionOutput;
}

export interface CloudInstallProfileMetadata {
  installGeneration: 'cloudformation-v1';
  cloudFormationStackName: string;
  awsAccountId: string;
  awsRegion: string;
}
