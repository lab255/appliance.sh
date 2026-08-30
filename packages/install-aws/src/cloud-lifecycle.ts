import { CloudFormationClient, DeleteStackCommand, waitUntilStackDeleteComplete } from '@aws-sdk/client-cloudformation';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import {
  createApplianceClient,
  DeploymentStatus,
  type ApplianceClient,
  type SelfUpdatePublicJob,
  type SelfUpdateReleaseEvidence,
  type SelfUpdateStartResponse,
} from '@appliance.sh/sdk';
import {
  createAwsCloudInstallDependencies,
  BASE_CONFIG_KEY,
  defaultSourceImage,
  resolveCloudOutputs,
  type CloudInstallDependencies,
  type StackSnapshot,
} from './cloud-install.js';
import type { CloudInstallProfileMetadata, ImageArchitecture, SystemRoleMode } from './types.js';

export interface CloudLifecycleProfile extends CloudInstallProfileMetadata {
  apiUrl: string;
  keyId: string;
  secret: string;
}

export interface CloudUpdateOptions {
  profile: CloudLifecycleProfile;
  installationName?: string;
  sourceImage?: string;
  architecture?: ImageArchitecture;
  awsProfile?: string;
  healthTimeoutMs?: number;
  healthPollMs?: number;
}

export interface CloudBaselineUpdateOptions {
  profile: CloudLifecycleProfile;
  installationName?: string;
  systemRoleMode?: SystemRoleMode;
  healthTimeoutMs?: number;
  healthPollMs?: number;
}

export interface CloudTeardownResult {
  retained: Array<{ kind: 'state bucket' | 'data bucket' | 'KMS key' | 'ECR repository'; value: string }>;
}

export interface CloudRouteUpdateOptions {
  targetDigest?: string;
  release?: SelfUpdateReleaseEvidence;
  idempotencyKey?: string;
  followJobId?: string;
  intervalMs?: number;
  onPhase?: (job: SelfUpdatePublicJob) => void;
}

export type CloudRouteUpdateResult =
  | {
      outcome: 'conflict';
      start: Extract<SelfUpdateStartResponse, { httpStatus: 409 }>;
      previousServerVersion?: string;
    }
  | {
      outcome: 'terminal';
      job: SelfUpdatePublicJob;
      previousServerVersion?: string;
      currentServerVersion?: string;
    };

export interface CloudLifecycleDependencies extends CloudInstallDependencies {
  destroyEdge(profile: CloudLifecycleProfile): Promise<void>;
  deleteStack(stackName: string): Promise<void>;
}

function assertCloudProfile(profile: CloudLifecycleProfile): void {
  if (profile.installGeneration !== 'cloudformation-v1') {
    throw new Error('Refusing CloudFormation lifecycle operation for a legacy Pulumi bootstrap profile');
  }
}

async function healthPoll(
  deps: CloudInstallDependencies,
  apiUrl: string,
  timeoutMs = 15 * 60_000,
  pollMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'timeout';
  while (Date.now() < deadline) {
    try {
      await deps.getBootstrapStatus(apiUrl);
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await deps.sleep(pollMs);
  }
  throw new Error(`api-server health check failed: ${last}`);
}

async function syncPermissionsBoundary(deps: CloudInstallDependencies, stack: StackSnapshot): Promise<void> {
  const outputs = resolveCloudOutputs(stack);
  if (!outputs.userAppliancePermissionsBoundaryArn) {
    throw new Error('Updated CloudFormation stack is missing required output UserAppliancePermissionsBoundaryArn');
  }
  await deps.updateBaseConfigBoundary(
    outputs.dataBucketName,
    BASE_CONFIG_KEY,
    outputs.userAppliancePermissionsBoundaryArn
  );
}

export async function runCloudSystemUpdate(
  options: CloudUpdateOptions,
  deps: CloudInstallDependencies
): Promise<StackSnapshot> {
  assertCloudProfile(options.profile);
  const accountId = await deps.getAccountId();
  if (accountId !== options.profile.awsAccountId)
    throw new Error(`Profile belongs to AWS account ${options.profile.awsAccountId}, not active account ${accountId}`);
  const stack = await deps.getStack(options.profile.cloudFormationStackName);
  if (!stack.exists) throw new Error(`CloudFormation stack ${options.profile.cloudFormationStackName} does not exist`);
  if (stack.region && stack.region !== options.profile.awsRegion)
    throw new Error(`CloudFormation stack is in ${stack.region}, not profile region ${options.profile.awsRegion}`);
  const outputs = resolveCloudOutputs(stack);
  const architecture = options.architecture ?? (stack.parameters.ImageArchitecture === 'arm64' ? 'arm64' : 'x86_64');
  const sourceImage = options.sourceImage ?? defaultSourceImage();
  deps.log(`Mirroring ${sourceImage} to ${outputs.imageRepositoryUrl}…`);
  const credentials = await deps.getRegistryCredentials();
  const mirrored = await deps.mirror({
    sourceImage,
    targetRepositoryUrl: outputs.imageRepositoryUrl,
    architecture,
    targetCredentials: credentials,
    onProgress: deps.log,
  });
  const previousImage = stack.parameters.ImageUri;
  const updated = await deps.deployStack({
    stackName: options.profile.cloudFormationStackName,
    installationName:
      stack.parameters.InstallationName ?? options.installationName ?? profileInstallName(options.profile),
    imageUri: mirrored.imageUri,
    architecture,
    systemRoleMode: stack.parameters.SystemRoleMode === 'admin' ? 'admin' : 'scoped',
  });
  await syncPermissionsBoundary(deps, updated);
  try {
    await healthPoll(deps, options.profile.apiUrl, options.healthTimeoutMs, options.healthPollMs);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Roll back by updating ImageUri to ${previousImage || '<previous known-good digest>'}.`
    );
  }
  return updated;
}

/** Drive CU2 through the signed in-server route; no operator AWS credentials are used. */
export async function runCloudRouteUpdate(
  options: CloudRouteUpdateOptions,
  client: ApplianceClient
): Promise<CloudRouteUpdateResult> {
  const before = await client.getClusterInfo();
  const previousServerVersion = before.success ? before.data.serverVersion : undefined;
  let jobId = options.followJobId;
  if (!jobId) {
    if (!options.targetDigest || !options.release || !options.idempotencyKey) {
      throw new Error('targetDigest, signed release evidence, and idempotencyKey are required to start self-update');
    }
    const started = await client.selfUpdate.start({
      targetDigest: options.targetDigest,
      release: options.release,
      idempotencyKey: options.idempotencyKey,
    });
    if (!started.success) throw started.error;
    if (started.data.httpStatus === 409) {
      return { outcome: 'conflict', start: started.data, previousServerVersion };
    }
    jobId = started.data.jobId;
  }
  const watched = await client.selfUpdate.watch(jobId, {
    intervalMs: options.intervalMs,
    onPhase: options.onPhase,
  });
  if (!watched.success) throw watched.error;
  const after = await client.getClusterInfo();
  return {
    outcome: 'terminal',
    job: watched.data,
    previousServerVersion,
    currentServerVersion: after.success ? after.data.serverVersion : undefined,
  };
}

export async function runCloudBaselineUpdate(
  options: CloudBaselineUpdateOptions,
  deps: CloudInstallDependencies
): Promise<StackSnapshot> {
  assertCloudProfile(options.profile);
  const accountId = await deps.getAccountId();
  if (accountId !== options.profile.awsAccountId)
    throw new Error(`Profile belongs to AWS account ${options.profile.awsAccountId}, not active account ${accountId}`);
  const stack = await deps.getStack(options.profile.cloudFormationStackName);
  if (!stack.exists) throw new Error(`CloudFormation stack ${options.profile.cloudFormationStackName} does not exist`);
  if (!stack.parameters.ImageUri) throw new Error('CloudFormation stack has no ImageUri to preserve');
  const updated = await deps.deployStack({
    stackName: options.profile.cloudFormationStackName,
    installationName:
      stack.parameters.InstallationName ?? options.installationName ?? profileInstallName(options.profile),
    imageUri: stack.parameters.ImageUri,
    architecture: stack.parameters.ImageArchitecture === 'arm64' ? 'arm64' : 'x86_64',
    systemRoleMode: options.systemRoleMode ?? (stack.parameters.SystemRoleMode === 'admin' ? 'admin' : 'scoped'),
  });
  await syncPermissionsBoundary(deps, updated);
  try {
    await healthPoll(deps, options.profile.apiUrl, options.healthTimeoutMs, options.healthPollMs);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. If scoped IAM caused the outage, rerun with \`appliance cloud baseline-update --system-role-mode admin --yes\`.`
    );
  }
  return updated;
}

function profileInstallName(profile: CloudLifecycleProfile): string {
  return profile.cloudFormationStackName.replace(/^appliance-/, '');
}

export async function runCloudTeardown(
  profile: CloudLifecycleProfile,
  deps: CloudLifecycleDependencies
): Promise<CloudTeardownResult> {
  assertCloudProfile(profile);
  const accountId = await deps.getAccountId();
  if (accountId !== profile.awsAccountId)
    throw new Error(`Profile belongs to AWS account ${profile.awsAccountId}, not active account ${accountId}`);
  const stack = await deps.getStack(profile.cloudFormationStackName);
  if (!stack.exists) return { retained: [] };
  if (stack.region && stack.region !== profile.awsRegion)
    throw new Error(`CloudFormation stack is in ${stack.region}, not profile region ${profile.awsRegion}`);
  const outputs = resolveCloudOutputs(stack);
  deps.log('Destroying the Pulumi-owned edge through the running endpoint…');
  await deps.destroyEdge(profile);
  deps.log(`Deleting CloudFormation stack ${profile.cloudFormationStackName}…`);
  await deps.deleteStack(profile.cloudFormationStackName);
  return {
    retained: [
      { kind: 'state bucket', value: outputs.stateBucketName },
      { kind: 'data bucket', value: outputs.dataBucketName },
      { kind: 'KMS key', value: outputs.kmsKeyArn },
      { kind: 'ECR repository', value: outputs.imageRepositoryUrl },
    ],
  };
}

export function createAwsCloudLifecycleDependencies(options: {
  region: string;
  awsProfile?: string;
  log?: (message: string) => void;
}): CloudLifecycleDependencies {
  const base = createAwsCloudInstallDependencies({
    ...options,
    writeProfile: () => undefined,
  });
  const credentials = options.awsProfile ? fromNodeProviderChain({ profile: options.awsProfile }) : undefined;
  const cloudFormation = new CloudFormationClient({ region: options.region, credentials });
  const log = options.log ?? (() => undefined);
  return {
    ...base,
    async destroyEdge(profile) {
      const client = createApplianceClient({
        baseUrl: profile.apiUrl,
        credentials: { keyId: profile.keyId, secret: profile.secret },
        product: 'installer',
      });
      const info = await client.getClusterInfo();
      if (!info.success) throw new Error(`Cannot read edge state before teardown: ${info.error.message}`);
      if (info.data.baseConfig.provisioner !== 'cloudformation-v1')
        throw new Error('Server-side base config is not cloudformation-v1; refusing CFN teardown');
      const domain = info.data.baseConfig.domainName;
      const zoneId = info.data.baseConfig.aws?.zoneId;
      if (!domain || !zoneId) {
        log('No edge epoch is attached; skipping endpoint edge destroy.');
        return;
      }
      const projects = await client.listProjects();
      if (!projects.success) throw projects.error;
      const project = projects.data.find((candidate) => candidate.name === 'appliance-system');
      if (!project) throw new Error('Edge epoch exists but reserved appliance-system project is missing');
      const environments = await client.listEnvironments(project.id);
      if (!environments.success) throw environments.error;
      const environment = environments.data.find((candidate) => candidate.name === 'edge');
      if (!environment) throw new Error('Edge epoch exists but reserved appliance-system/edge environment is missing');
      const started = await client.destroyEdge(environment.id, domain, zoneId);
      if (!started.success) throw started.error;
      const deadline = Date.now() + 30 * 60_000;
      while (Date.now() < deadline) {
        const current = await client.getDeployment(started.data.id);
        if (!current.success) throw current.error;
        if (current.data.status === DeploymentStatus.Succeeded) return;
        if (current.data.status === DeploymentStatus.Failed || current.data.status === DeploymentStatus.Cancelled)
          throw new Error(`Edge destroy ${current.data.status}: ${current.data.message ?? 'no detail'}`);
        if (current.data.status === DeploymentStatus.InProgress && current.data.edgeConvergence?.state === 'ready') {
          const continued = await client.continueDeployment(current.data.id);
          if (!continued.success) throw new Error(`Failed to continue edge destroy: ${continued.error.message}`);
        }
        await base.sleep(3_000);
      }
      throw new Error('Timed out waiting for edge destroy; CloudFormation stack was not deleted');
    },
    async deleteStack(stackName) {
      await cloudFormation.send(new DeleteStackCommand({ StackName: stackName }));
      const waited = await waitUntilStackDeleteComplete(
        { client: cloudFormation, maxWaitTime: 1800 },
        { StackName: stackName }
      );
      if (waited.state !== 'SUCCESS') throw new Error(`CloudFormation delete did not converge: ${waited.reason}`);
    },
  };
}
