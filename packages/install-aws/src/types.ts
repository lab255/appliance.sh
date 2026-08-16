export type ImageArchitecture = 'x86_64' | 'arm64';
export type RegistryArchitecture = 'amd64' | 'arm64';

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
  apiServer?: SystemFunctionOutput;
  worker?: SystemFunctionOutput;
}

export interface CloudInstallProfileMetadata {
  installGeneration: 'cloudformation-v1';
  cloudFormationStackName: string;
  awsAccountId: string;
  awsRegion: string;
}
