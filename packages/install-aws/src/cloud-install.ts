import {
  Capability,
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
  type Output,
  type Parameter,
  type Stack,
} from '@aws-sdk/client-cloudformation';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { ApplianceBaseType, VERSION } from '@appliance.sh/sdk';
import { mirrorImageToEcr, type MirrorImageOptions, type MirrorImageResult } from './ecr-mirror.js';
import { APPLIANCE_CLOUDFORMATION_TEMPLATE } from './template.js';
import type { ApplianceCloudOutputs, CloudInstallProfileMetadata, ImageArchitecture, SystemRoleMode } from './types.js';

export const BASE_CONFIG_KEY = 'system/base-config.json';
const DEFAULT_HEALTH_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_HEALTH_POLL_MS = 5_000;

export interface CloudInstallProfile extends CloudInstallProfileMetadata {
  apiUrl: string;
  keyId: string;
  secret: string;
}

export interface CloudInstallOptions {
  installationName: string;
  stackName: string;
  region: string;
  architecture: ImageArchitecture;
  sourceImage?: string;
  awsProfile?: string;
  profileName: string;
  existingProfile?: CloudInstallProfile;
  /** Profile-aware shells set this to prevent cross-generation overlays. */
  existingLegacyProfile?: boolean;
  healthTimeoutMs?: number;
  healthPollMs?: number;
}

export interface StackSnapshot {
  exists: boolean;
  accountId?: string;
  region?: string;
  status?: string;
  parameters: Record<string, string>;
  outputs: Record<string, string>;
}

export interface CloudInstallDependencies {
  getAccountId(): Promise<string>;
  getStack(stackName: string): Promise<StackSnapshot>;
  deployStack(input: {
    stackName: string;
    installationName: string;
    imageUri: string;
    architecture: ImageArchitecture;
    systemRoleMode?: SystemRoleMode;
  }): Promise<StackSnapshot>;
  getRegistryCredentials(): Promise<{ username: string; password: string }>;
  mirror(options: MirrorImageOptions): Promise<MirrorImageResult>;
  /** Create epoch 1 only when no base-config object exists. Returns false when already initialized. */
  writeBaseConfigIfAbsent(bucket: string, key: string, value: unknown): Promise<boolean>;
  /** Preserve the current epoch while refreshing the CFN-owned boundary output. */
  updateBaseConfigBoundary(bucket: string, key: string, boundaryArn: string): Promise<void>;
  getSecret(secretArn: string): Promise<string>;
  getBootstrapStatus(apiUrl: string): Promise<{ initialized: boolean }>;
  mintApiKey(apiUrl: string, token: string, name: string): Promise<{ id: string; secret: string }>;
  validateExistingProfile?(profile: CloudInstallProfile): Promise<boolean>;
  writeProfile(name: string, profile: CloudInstallProfile): Promise<void> | void;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

function output(snapshot: StackSnapshot, key: string): string {
  const value = snapshot.outputs[key];
  if (!value) throw new Error(`CloudFormation stack is missing required output ${key}`);
  return value;
}

export function resolveCloudOutputs(snapshot: StackSnapshot): ApplianceCloudOutputs {
  const resolved: ApplianceCloudOutputs = {
    stateBucketName: output(snapshot, 'StateBucketName'),
    stateBucketArn: output(snapshot, 'StateBucketArn'),
    dataBucketName: output(snapshot, 'DataBucketName'),
    dataBucketArn: output(snapshot, 'DataBucketArn'),
    kmsKeyArn: output(snapshot, 'StateKmsKeyArn'),
    kmsAliasName: output(snapshot, 'StateKmsAliasName'),
    imageRepositoryUrl: output(snapshot, 'ImageRepositoryUrl'),
    apiServerRoleArn: output(snapshot, 'SystemApiServerRoleArn'),
    workerRoleArn: output(snapshot, 'SystemWorkerRoleArn'),
    bootstrapTokenSecretArn: output(snapshot, 'BootstrapTokenSecretArn'),
    userAppliancePermissionsBoundaryArn: output(snapshot, 'UserAppliancePermissionsBoundaryArn'),
  };
  if (snapshot.outputs.ApiServerFunctionUrl) {
    resolved.apiServer = {
      name: output(snapshot, 'ApiServerFunctionName'),
      arn: output(snapshot, 'ApiServerFunctionArn'),
      url: output(snapshot, 'ApiServerFunctionUrl'),
    };
    resolved.worker = {
      name: output(snapshot, 'WorkerFunctionName'),
      arn: output(snapshot, 'WorkerFunctionArn'),
      url: output(snapshot, 'WorkerFunctionUrl'),
    };
  }
  return resolved;
}

export function substrateBaseConfig(
  installationName: string,
  region: string,
  outputs: ApplianceCloudOutputs
): Record<string, unknown> {
  if (!outputs.apiServer || !outputs.worker)
    throw new Error('System function outputs are unavailable before image deployment');
  return {
    name: installationName,
    type: ApplianceBaseType.ApplianceAwsPublic,
    provisioner: 'cloudformation-v1',
    stateBackendUrl: `s3://${outputs.stateBucketName}`,
    aws: {
      region,
      stateBucketName: outputs.stateBucketName,
      stateBucketArn: outputs.stateBucketArn,
      dataBucketName: outputs.dataBucketName,
      kmsKeyArn: outputs.kmsKeyArn,
      kmsAliasName: outputs.kmsAliasName,
      ecrRepositoryUrl: outputs.imageRepositoryUrl,
      userAppliancePermissionsBoundaryArn: outputs.userAppliancePermissionsBoundaryArn,
      systemRoleArns: { apiServer: outputs.apiServerRoleArn, worker: outputs.workerRoleArn },
      systemFunctions: { apiServer: outputs.apiServer, worker: outputs.worker },
    },
  };
}

function normalizeApiUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

async function pollHealthy(
  deps: CloudInstallDependencies,
  apiUrl: string,
  timeoutMs: number,
  pollMs: number
): Promise<{ initialized: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timeout';
  while (Date.now() < deadline) {
    try {
      return await deps.getBootstrapStatus(apiUrl);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await deps.sleep(pollMs);
  }
  throw new Error(`api-server health check failed after ${Math.round(timeoutMs / 1000)}s: ${lastError}`);
}

/** Idempotent installer state machine. Each completed AWS operation is discoverable on the next run. */
export async function runCloudInstall(
  options: CloudInstallOptions,
  deps: CloudInstallDependencies
): Promise<CloudInstallProfile> {
  if (options.existingLegacyProfile) {
    throw new Error(
      'Refusing to install CloudFormation over a legacy Pulumi bootstrap profile; no auto-migration exists'
    );
  }
  const accountId = await deps.getAccountId();
  if (options.existingProfile?.cloudFormationStackName === options.stackName) {
    if (options.existingProfile.awsAccountId !== accountId) {
      throw new Error(
        `Profile ${options.profileName} records AWS account ${options.existingProfile.awsAccountId}, not active account ${accountId}`
      );
    }
    if (options.existingProfile.awsRegion !== options.region) {
      throw new Error(
        `Profile ${options.profileName} records region ${options.existingProfile.awsRegion}, not requested region ${options.region}`
      );
    }
  }
  let existing = await deps.getStack(options.stackName);
  if (existing.exists) {
    if (existing.accountId && existing.accountId !== accountId) {
      throw new Error(
        `Stack ${options.stackName} belongs to AWS account ${existing.accountId}, not active account ${accountId}`
      );
    }
    if (existing.region && existing.region !== options.region) {
      throw new Error(`Stack ${options.stackName} is in ${existing.region}, not requested region ${options.region}`);
    }
  }

  // Never blank ImageUri on a resume: that would delete healthy Lambdas.
  if (!existing.exists) {
    deps.log('Creating CloudFormation substrate…');
    existing = await deps.deployStack({ ...options, imageUri: '' });
  } else {
    deps.log(`Resuming CloudFormation stack ${options.stackName}…`);
  }
  const substrate = resolveCloudOutputs(existing);

  deps.log(`Mirroring ${options.sourceImage ?? defaultSourceImage()} to private ECR…`);
  const credentials = await deps.getRegistryCredentials();
  const mirrored = await deps.mirror({
    sourceImage: options.sourceImage ?? defaultSourceImage(),
    targetRepositoryUrl: substrate.imageRepositoryUrl,
    architecture: options.architecture,
    targetCredentials: credentials,
    onProgress: (message) => deps.log(message),
  });

  const previousImage = existing.parameters.ImageUri;
  deps.log(`Deploying system Lambdas from ${mirrored.digest}…`);
  const complete = await deps.deployStack({ ...options, imageUri: mirrored.imageUri });
  const outputs = resolveCloudOutputs(complete);
  const apiUrl = normalizeApiUrl(outputs.apiServer!.url);
  await deps.writeBaseConfigIfAbsent(
    outputs.dataBucketName,
    BASE_CONFIG_KEY,
    substrateBaseConfig(options.installationName, options.region, outputs)
  );

  let status: { initialized: boolean };
  try {
    status = await pollHealthy(
      deps,
      apiUrl,
      options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      options.healthPollMs ?? DEFAULT_HEALTH_POLL_MS
    );
  } catch (error) {
    const rollback = previousImage
      ? ` Re-run the stack update with the previous digest ${previousImage} to roll back.`
      : ' This was the first image deployment; re-run install with a previously known-good image digest.';
    throw new Error(`${error instanceof Error ? error.message : String(error)}.${rollback}`);
  }

  const expectedMetadata: CloudInstallProfileMetadata = {
    installGeneration: 'cloudformation-v1',
    cloudFormationStackName: options.stackName,
    awsAccountId: accountId,
    awsRegion: options.region,
  };
  if (
    status.initialized &&
    options.existingProfile &&
    options.existingProfile.apiUrl === apiUrl &&
    Object.entries(expectedMetadata).every(
      ([key, value]) => options.existingProfile?.[key as keyof CloudInstallProfile] === value
    ) &&
    (await deps.validateExistingProfile?.(options.existingProfile))
  ) {
    deps.log(`Existing profile ${options.profileName} is valid; keeping its API key.`);
    return options.existingProfile;
  }

  const secretJson = await deps.getSecret(outputs.bootstrapTokenSecretArn);
  const token = parseBootstrapToken(secretJson);
  const key = await deps.mintApiKey(apiUrl, token, `cloud-install:${options.profileName}`);
  const profile: CloudInstallProfile = {
    apiUrl,
    keyId: key.id,
    secret: key.secret,
    ...expectedMetadata,
  };
  await deps.writeProfile(options.profileName, profile);
  return profile;
}

export function parseBootstrapToken(secretString: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new Error('Bootstrap token secret is not valid JSON');
  }
  const token = (parsed as { token?: unknown })?.token;
  if (typeof token !== 'string' || token.length < 32)
    throw new Error('Bootstrap token secret is missing its token property');
  return token;
}

export function defaultSourceImage(): string {
  return `ghcr.io/appliance-sh/api-server:${VERSION.replace(/^v/, '')}`;
}

export function isNoCloudFormationUpdates(error: unknown): boolean {
  return error instanceof Error && /No updates are to be performed/i.test(error.message);
}

function stackSnapshot(stack: Stack | undefined): StackSnapshot {
  if (!stack) throw new Error('CloudFormation returned no stack record');
  const stackId = String(stack.StackId ?? '');
  const arn = stackId.split(':');
  return {
    exists: true,
    accountId: arn[4] || undefined,
    region: arn[3] || undefined,
    status: stack.StackStatus,
    parameters: Object.fromEntries(
      (stack.Parameters ?? []).map((p: Parameter) => [p.ParameterKey!, p.ParameterValue ?? ''])
    ),
    outputs: Object.fromEntries((stack.Outputs ?? []).map((o: Output) => [o.OutputKey!, o.OutputValue ?? ''])),
  };
}

export interface AwsCloudInstallAdapterOptions {
  region: string;
  awsProfile?: string;
  fetch?: typeof globalThis.fetch;
  log?: (message: string) => void;
  writeProfile(name: string, profile: CloudInstallProfile): Promise<void> | void;
  validateExistingProfile?(profile: CloudInstallProfile): Promise<boolean>;
}

/** Production AWS/fetch adapter; kept separate from the state machine so interruption paths are unit-testable. */
export function createAwsCloudInstallDependencies(options: AwsCloudInstallAdapterOptions): CloudInstallDependencies {
  const credentials = options.awsProfile ? fromNodeProviderChain({ profile: options.awsProfile }) : undefined;
  const common = { region: options.region, credentials };
  const cloudFormation = new CloudFormationClient(common);
  const ecr = new ECRClient(common);
  const secrets = new SecretsManagerClient(common);
  const s3 = new S3Client(common);
  const sts = new STSClient(common);
  const request = options.fetch ?? globalThis.fetch;

  const describeStack = async (stackName: string): Promise<StackSnapshot> => {
    try {
      const response = await cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }));
      return stackSnapshot(response.Stacks?.[0]);
    } catch (error) {
      if (error instanceof Error && error.name === 'ValidationError')
        return { exists: false, parameters: {}, outputs: {} };
      throw error;
    }
  };
  const getStack = async (stackName: string): Promise<StackSnapshot> => {
    let snapshot = await describeStack(stackName);
    if (snapshot.status === 'CREATE_IN_PROGRESS') {
      const waited = await waitUntilStackCreateComplete(
        { client: cloudFormation, maxWaitTime: 1800 },
        { StackName: stackName }
      );
      if (waited.state !== 'SUCCESS')
        throw new Error(`Interrupted CloudFormation create did not converge: ${waited.reason}`);
      snapshot = await describeStack(stackName);
    } else if (snapshot.status?.startsWith('UPDATE_') && snapshot.status.endsWith('_IN_PROGRESS')) {
      const waited = await waitUntilStackUpdateComplete(
        { client: cloudFormation, maxWaitTime: 1800 },
        { StackName: stackName }
      );
      if (waited.state !== 'SUCCESS')
        throw new Error(`Interrupted CloudFormation update did not converge: ${waited.reason}`);
      snapshot = await describeStack(stackName);
    }
    return snapshot;
  };

  return {
    async getAccountId() {
      const result = await sts.send(new GetCallerIdentityCommand({}));
      if (!result.Account) throw new Error('AWS did not return an account ID for the active credentials');
      return result.Account;
    },
    getStack,
    async deployStack(input) {
      const parameters = [
        { ParameterKey: 'InstallationName', ParameterValue: input.installationName },
        { ParameterKey: 'ImageUri', ParameterValue: input.imageUri },
        { ParameterKey: 'ImageArchitecture', ParameterValue: input.architecture },
        { ParameterKey: 'SystemRoleMode', ParameterValue: input.systemRoleMode ?? 'scoped' },
      ];
      const current = await getStack(input.stackName);
      if (!current.exists) {
        await cloudFormation.send(
          new CreateStackCommand({
            StackName: input.stackName,
            TemplateBody: APPLIANCE_CLOUDFORMATION_TEMPLATE,
            Parameters: parameters,
            Capabilities: [Capability.CAPABILITY_IAM],
          })
        );
        const waited = await waitUntilStackCreateComplete(
          { client: cloudFormation, maxWaitTime: 1800 },
          { StackName: input.stackName }
        );
        if (waited.state !== 'SUCCESS') throw new Error(`CloudFormation create did not converge: ${waited.reason}`);
      } else {
        try {
          await cloudFormation.send(
            new UpdateStackCommand({
              StackName: input.stackName,
              TemplateBody: APPLIANCE_CLOUDFORMATION_TEMPLATE,
              Parameters: parameters,
              Capabilities: [Capability.CAPABILITY_IAM],
            })
          );
        } catch (error) {
          if (!isNoCloudFormationUpdates(error)) throw error;
          return getStack(input.stackName);
        }
        const waited = await waitUntilStackUpdateComplete(
          { client: cloudFormation, maxWaitTime: 1800 },
          { StackName: input.stackName }
        );
        if (waited.state !== 'SUCCESS') throw new Error(`CloudFormation update did not converge: ${waited.reason}`);
      }
      return getStack(input.stackName);
    },
    async getRegistryCredentials() {
      const response = await ecr.send(new GetAuthorizationTokenCommand({}));
      const auth = response.authorizationData?.[0]?.authorizationToken;
      if (!auth) throw new Error('AWS ECR did not return a registry authorization token');
      const decoded = Buffer.from(auth, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator < 0) throw new Error('AWS ECR returned a malformed registry authorization token');
      return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
    },
    mirror: (input) => mirrorImageToEcr({ ...input, fetch: request }),
    async writeBaseConfigIfAbsent(bucket, key, value) {
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: JSON.stringify(value),
            ContentType: 'application/json',
            IfNoneMatch: '*',
          })
        );
        return true;
      } catch (error) {
        const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (candidate.name === 'PreconditionFailed' || candidate.$metadata?.httpStatusCode === 412) return false;
        throw error;
      }
    },
    async updateBaseConfigBoundary(bucket, key, boundaryArn) {
      const current = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!current.Body) throw new Error(`Base config s3://${bucket}/${key} has no body`);
      const parsed = JSON.parse(await current.Body.transformToString()) as Record<string, unknown>;
      const aws = parsed.aws;
      if (!aws || typeof aws !== 'object' || Array.isArray(aws)) {
        throw new Error(`Base config s3://${bucket}/${key} has no AWS configuration`);
      }
      parsed.aws = { ...aws, userAppliancePermissionsBoundaryArn: boundaryArn };
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(parsed),
          ContentType: 'application/json',
          IfMatch: current.ETag,
        })
      );
    },
    async getSecret(secretArn) {
      const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
      if (!response.SecretString) throw new Error('Bootstrap token secret has no string value');
      return response.SecretString;
    },
    async getBootstrapStatus(apiUrl) {
      const response = await request(`${apiUrl}/bootstrap/status`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { initialized?: unknown };
      if (typeof body.initialized !== 'boolean') throw new Error('Unexpected /bootstrap/status response');
      return { initialized: body.initialized };
    },
    async mintApiKey(apiUrl, token, name) {
      const response = await request(`${apiUrl}/bootstrap/create-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bootstrap-token': token },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(`/bootstrap/create-key returned HTTP ${response.status}`);
      const body = (await response.json()) as { id?: unknown; secret?: unknown };
      if (typeof body.id !== 'string' || typeof body.secret !== 'string') {
        throw new Error('/bootstrap/create-key response omitted id or secret');
      }
      return { id: body.id, secret: body.secret };
    },
    validateExistingProfile: options.validateExistingProfile,
    writeProfile: options.writeProfile,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: options.log ?? (() => undefined),
  };
}
