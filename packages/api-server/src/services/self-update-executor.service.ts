import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';
import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  type Parameter,
} from '@aws-sdk/client-cloudformation';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { PINNED_RELEASE_TRUST, verifyReleaseEnvelope } from '@appliance.sh/sdk';
import {
  getSelfUpdateService,
  type ReleaseVerifier,
  type SelfUpdateJob,
  type SelfUpdateService,
} from './self-update.service';
import { redactSelfUpdateError } from '../routes/self-update';
import { logger } from '../logger';

const POLL_MS = 5_000;
const HEALTH_WINDOW_MS = 120_000;
const TARGET_STACK_WORK_MS = 540_000;
const TARGET_HEALTH_END_MS = 660_000;
const HARD_WORK_MS = 840_000;

export interface AssumedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface SelfUpdateStack {
  stackId: string;
  stackName: string;
  status: string;
  parameters: Array<{ key: string; value?: string }>;
  outputs: Record<string, string>;
  lastUpdatedAt?: string;
}

export interface SelfUpdateStackRequest {
  StackName: string;
  UsePreviousTemplate: true;
  Parameters: Parameter[];
  RoleARN: string;
  Capabilities: ['CAPABILITY_IAM'];
}

export interface SelfUpdateExecutorDependencies {
  assumeRole(roleArn: string, sourceIdentity: string): Promise<AssumedCredentials>;
  describeStack(credentials: AssumedCredentials, stackId: string): Promise<SelfUpdateStack>;
  describeStackEvents(credentials: AssumedCredentials, stackId: string): Promise<string[]>;
  getEcrAuthorization(credentials: AssumedCredentials): Promise<string>;
  craneCopy(source: string, target: string, registry: string, authorizationToken: string): Promise<void>;
  updateStack(credentials: AssumedCredentials, request: SelfUpdateStackRequest): Promise<void>;
  health(url: string): Promise<{ initialized: boolean; serverVersion?: string }>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export function buildImageOnlyUpdate(
  stack: SelfUpdateStack,
  imageUri: string,
  cloudFormationRoleArn: string
): SelfUpdateStackRequest {
  if (!stack.parameters.some((parameter) => parameter.key === 'ImageUri')) {
    throw new Error('CloudFormation stack does not declare ImageUri');
  }
  return {
    StackName: stack.stackId,
    UsePreviousTemplate: true,
    Parameters: stack.parameters.map((parameter) =>
      parameter.key === 'ImageUri'
        ? { ParameterKey: parameter.key, ParameterValue: imageUri }
        : { ParameterKey: parameter.key, UsePreviousValue: true }
    ),
    RoleARN: cloudFormationRoleArn,
    Capabilities: ['CAPABILITY_IAM'],
  };
}

export function craneCommand(
  source: string,
  target: string,
  dockerConfig: string
): {
  file: 'crane';
  args: ['cp', string, string];
  options: SpawnOptions;
} {
  return {
    file: 'crane',
    args: ['cp', source, target],
    options: {
      shell: false,
      env: { ...process.env, DOCKER_CONFIG: dockerConfig },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  };
}

export async function runCraneCopy(
  source: string,
  target: string,
  registry: string,
  authorizationToken: string
): Promise<void> {
  const authDir = await mkdtemp(join(tmpdir(), 'appliance-self-update-'));
  try {
    await writeFile(
      join(authDir, 'config.json'),
      JSON.stringify({ auths: { [registry]: { auth: authorizationToken } } }),
      { mode: 0o600 }
    );
    const command = craneCommand(source, target, authDir);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.file, command.args, command.options);
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < 8_192) stderr += String(chunk);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`crane cp exited ${code}: ${stderr.slice(0, 8_192)}`));
      });
    });
  } finally {
    await rm(authDir, { recursive: true, force: true });
  }
}

export function createAwsSelfUpdateDependencies(): SelfUpdateExecutorDependencies {
  return {
    async assumeRole(roleArn, sourceIdentity) {
      const result = await new STSClient({}).send(
        new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: sourceIdentity,
          SourceIdentity: sourceIdentity,
          DurationSeconds: 900,
        })
      );
      const credentials = result.Credentials;
      if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
        throw new Error('STS did not return complete self-update credentials');
      }
      return {
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
      };
    },
    async describeStack(credentials, stackId) {
      const result = await new CloudFormationClient({ credentials }).send(
        new DescribeStacksCommand({ StackName: stackId })
      );
      const stack = result.Stacks?.[0];
      if (!stack?.StackId || !stack.StackName || !stack.StackStatus)
        throw new Error('CloudFormation stack was not found');
      return {
        stackId: stack.StackId,
        stackName: stack.StackName,
        status: stack.StackStatus,
        parameters: (stack.Parameters ?? [])
          .filter((parameter): parameter is Parameter & { ParameterKey: string } => Boolean(parameter.ParameterKey))
          .map((parameter) => ({ key: parameter.ParameterKey, value: parameter.ParameterValue })),
        outputs: Object.fromEntries(
          (stack.Outputs ?? [])
            .filter((output): output is { OutputKey: string; OutputValue: string } =>
              Boolean(output.OutputKey && output.OutputValue)
            )
            .map((output) => [output.OutputKey, output.OutputValue])
        ),
        ...(stack.LastUpdatedTime ? { lastUpdatedAt: stack.LastUpdatedTime.toISOString() } : {}),
      };
    },
    async describeStackEvents(credentials, stackId) {
      const result = await new CloudFormationClient({ credentials }).send(
        new DescribeStackEventsCommand({ StackName: stackId })
      );
      return (result.StackEvents ?? [])
        .slice(0, 10)
        .map(
          (event) =>
            `${event.LogicalResourceId ?? 'stack'} ${event.ResourceStatus ?? ''} ${event.ResourceStatusReason ?? ''}`
        );
    },
    async getEcrAuthorization(credentials) {
      const result = await new ECRClient({ credentials }).send(new GetAuthorizationTokenCommand({}));
      const token = result.authorizationData?.[0]?.authorizationToken;
      if (!token) throw new Error('ECR did not return an authorization token');
      return token;
    },
    craneCopy: runCraneCopy,
    async updateStack(credentials, request) {
      await new CloudFormationClient({ credentials }).send(new UpdateStackCommand(request));
    },
    async health(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`health probe returned HTTP ${response.status}`);
      return (await response.json()) as { initialized: boolean; serverVersion?: string };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
  };
}

export interface SelfUpdateExecutorOptions {
  jobs?: SelfUpdateService;
  verifier?: ReleaseVerifier;
  aws?: SelfUpdateExecutorDependencies;
}

export class SelfUpdateExecutor {
  private readonly jobs: SelfUpdateService;
  private readonly verifier: ReleaseVerifier;
  private readonly aws: SelfUpdateExecutorDependencies;

  constructor(options: SelfUpdateExecutorOptions = {}) {
    this.jobs = options.jobs ?? getSelfUpdateService();
    this.verifier = options.verifier ?? verifyReleaseEnvelope;
    this.aws = options.aws ?? createAwsSelfUpdateDependencies();
  }

  async execute(jobId: string): Promise<'complete' | 'continue'> {
    const startedAt = this.aws.now().getTime();
    const targetStackDeadline = startedAt + TARGET_STACK_WORK_MS;
    const targetHealthDeadline = startedAt + TARGET_HEALTH_END_MS;
    const hardDeadline = startedAt + HARD_WORK_MS;
    let job = await this.jobs.claim(jobId);
    if (isTerminal(job)) return 'complete';

    try {
      const verified = await this.verifier(job.release.payload, job.release.envelope, PINNED_RELEASE_TRUST, {
        now: this.aws.now(),
        highestGeneration: job.generation,
      });
      if (
        verified.payload.image.manifestDigest !== job.targetDigest ||
        `${verified.payload.image.repository}@${job.targetDigest}` !== job.sourceImage ||
        verified.payload.version !== job.targetVersion
      ) {
        throw Object.assign(new Error('persisted release evidence does not bind the requested target'), {
          code: 'digest-mismatch',
        });
      }
    } catch (error) {
      await this.jobs.finish(jobId, {
        status: 'failed',
        recovered: true,
        recoveryState: 'recovered',
        error: `release evidence rejected by worker: ${trustCode(error)}`,
      });
      return 'complete';
    }

    const stackId = requireInstallValue('APPLIANCE_STACK_ID');
    const roleArn = requireInstallValue('SELF_UPDATE_ROLE_ARN');
    const sourceIdentity = `self-update-${jobId}`;
    const credentials = await this.aws.assumeRole(roleArn, sourceIdentity);
    let stack = await this.aws.describeStack(credentials, stackId);
    job = await this.captureStack(job, stack);
    if (isTerminal(job)) return 'complete';

    if (job.phase === 'submitting-recovery' || job.phase === 'waiting-for-recovery') {
      return this.recover(job, credentials, stack, 'resuming persisted recovery', hardDeadline);
    }

    const cloudFormationRoleArn = requireOutput(stack, 'SelfUpdateCloudFormationRoleArn');
    const repository = requireOutput(stack, 'ImageRepositoryUrl');
    const targetImage = `${repository}@${job.targetDigest}`;
    const registry = repository.split('/')[0];
    if (!registry) throw new Error('installation ECR repository is malformed');

    try {
      if (job.phase !== 'waiting-for-stack' && job.phase !== 'probing-health') {
        if (parameterValue(stack, 'ImageUri') === targetImage) {
          job = await this.jobs.heartbeat(jobId, 'waiting-for-stack', { targetImage });
        } else if (
          (isUpdateInProgress(stack.status) && job.previousImage) ||
          (job.phase === 'submitting-update' && parameterValue(stack, 'ImageUri') === targetImage)
        ) {
          job = await this.jobs.heartbeat(jobId, 'waiting-for-stack', { targetImage });
        } else {
          job = await this.jobs.heartbeat(jobId, 'mirroring', { targetImage });
          const token = await this.aws.getEcrAuthorization(credentials);
          await this.withHeartbeat(jobId, 'mirroring', () =>
            this.aws.craneCopy(job.sourceImage, targetImage, registry, token)
          );
          job = await this.jobs.heartbeat(jobId, 'submitting-update', { targetImage });
          await this.aws.updateStack(credentials, buildImageOnlyUpdate(stack, targetImage, cloudFormationRoleArn));
          job = await this.jobs.heartbeat(jobId, 'waiting-for-stack', { targetImage });
        }
      }

      stack = await this.waitForTarget(jobId, credentials, stackId, targetStackDeadline);
      if (stack.status !== 'UPDATE_COMPLETE') {
        return this.recover(job, credentials, stack, `CloudFormation reached ${stack.status}`, hardDeadline);
      }
      await this.jobs.heartbeat(jobId, 'probing-health');
      const healthUrl = bootstrapStatusUrl(requireOutput(stack, 'ApiServerFunctionUrl'));
      const healthy = await this.pollHealth(
        jobId,
        'probing-health',
        healthUrl,
        job.targetVersion,
        Math.min(targetHealthDeadline, this.aws.now().getTime() + HEALTH_WINDOW_MS)
      );
      if (!healthy) return this.recover(job, credentials, stack, 'target health/version probe failed', hardDeadline);
      await this.jobs.finish(jobId, { status: 'succeeded', recovered: false, healthUrl });
      logger.info('self-update completed', {
        jobId,
        digestPrefix: job.targetDigest.slice(0, 19),
        phase: 'complete',
        result: 'succeeded',
      });
      return 'complete';
    } catch (error) {
      if (job.phase === 'mirroring') throw error;
      stack = await this.aws.describeStack(credentials, stackId);
      return this.recover(job, credentials, stack, safeError(error), hardDeadline);
    }
  }

  private async captureStack(job: SelfUpdateJob, stack: SelfUpdateStack): Promise<SelfUpdateJob> {
    const currentImage = parameterValue(stack, 'ImageUri');
    if (!currentImage) {
      return this.jobs.finish(job.id, {
        status: 'failed',
        recovered: true,
        recoveryState: 'recovered',
        error: 'CloudFormation ImageUri is blank; self-update refused before mutation',
      });
    }
    const previousImage = job.previousImage ?? currentImage;
    if (job.stackId && job.stackId !== stack.stackId) throw new Error('persisted self-update stack identity changed');
    const phase = ['queued', 'verifying', 'describing-stack'].includes(job.phase) ? 'describing-stack' : job.phase;
    return this.jobs.heartbeat(job.id, phase, {
      previousImage,
      stackId: stack.stackId,
      stackName: stack.stackName,
      templateIdentity: job.templateIdentity ?? `${stack.stackId}#${stack.lastUpdatedAt ?? 'unknown'}`,
      healthUrl: bootstrapStatusUrl(requireOutput(stack, 'ApiServerFunctionUrl')),
    });
  }

  private async waitForTarget(
    jobId: string,
    credentials: AssumedCredentials,
    stackId: string,
    deadline: number
  ): Promise<SelfUpdateStack> {
    let stack = await this.aws.describeStack(credentials, stackId);
    while (isUpdateInProgress(stack.status) && this.aws.now().getTime() < deadline) {
      await this.jobs.heartbeat(jobId, 'waiting-for-stack');
      await this.aws.sleep(POLL_MS);
      stack = await this.aws.describeStack(credentials, stackId);
    }
    return stack;
  }

  private async recover(
    job: SelfUpdateJob,
    credentials: AssumedCredentials,
    initialStack: SelfUpdateStack,
    reason: string,
    hardDeadline: number
  ): Promise<'complete'> {
    if (!job.previousImage) {
      await this.exhaust(job.id, reason);
      return 'complete';
    }
    await this.jobs.heartbeat(job.id, 'submitting-recovery', {
      recovered: false,
      recoveryState: 'in-progress',
      error: safeError(reason),
    });
    let stack = initialStack;
    while (isUpdateInProgress(stack.status) && this.aws.now().getTime() < hardDeadline) {
      await this.aws.sleep(POLL_MS);
      await this.jobs.heartbeat(job.id, 'submitting-recovery');
      stack = await this.aws.describeStack(credentials, stack.stackId);
    }
    const roleArn = requireOutput(stack, 'SelfUpdateCloudFormationRoleArn');
    let submitted = false;
    let alreadyPinned = false;
    while (!submitted && this.aws.now().getTime() < hardDeadline) {
      try {
        await this.aws.updateStack(credentials, buildImageOnlyUpdate(stack, job.previousImage, roleArn));
        submitted = true;
      } catch (error) {
        if (isNoUpdates(error)) {
          submitted = true;
          alreadyPinned = true;
          break;
        }
        await this.aws.sleep(POLL_MS);
        stack = await this.aws.describeStack(credentials, stack.stackId);
      }
    }
    if (!submitted) {
      await this.exhaust(job.id, reason);
      return 'complete';
    }
    await this.jobs.heartbeat(job.id, 'waiting-for-recovery');
    stack = await this.waitForRecovery(job.id, credentials, stack.stackId, hardDeadline);
    const healthUrl = bootstrapStatusUrl(requireOutput(stack, 'ApiServerFunctionUrl'));
    const healthy = await this.pollHealth(job.id, 'waiting-for-recovery', healthUrl, undefined, hardDeadline);
    if ((stack.status === 'UPDATE_COMPLETE' || alreadyPinned) && healthy) {
      await this.jobs.finish(job.id, {
        status: 'failed',
        recovered: true,
        recoveryState: 'recovered',
        error: safeError(reason),
        healthUrl,
      });
      return 'complete';
    }
    const events = await this.aws.describeStackEvents(credentials, stack.stackId).catch(() => []);
    await this.exhaust(job.id, `${reason}; ${events.slice(0, 3).join('; ')}`);
    return 'complete';
  }

  private async waitForRecovery(
    jobId: string,
    credentials: AssumedCredentials,
    stackId: string,
    deadline: number
  ): Promise<SelfUpdateStack> {
    let stack = await this.aws.describeStack(credentials, stackId);
    while (isUpdateInProgress(stack.status) && this.aws.now().getTime() < deadline) {
      await this.aws.sleep(POLL_MS);
      await this.jobs.heartbeat(jobId, 'waiting-for-recovery');
      stack = await this.aws.describeStack(credentials, stackId);
    }
    return stack;
  }

  private async pollHealth(
    jobId: string,
    phase: 'probing-health' | 'waiting-for-recovery',
    url: string,
    targetVersion: string | undefined,
    deadline: number
  ): Promise<boolean> {
    while (this.aws.now().getTime() < deadline) {
      await this.jobs.heartbeat(jobId, phase);
      try {
        const result = await this.aws.health(url);
        if (result.initialized && (!targetVersion || result.serverVersion === targetVersion)) return true;
      } catch {
        // Poll through transient function URL/code-swap failures.
      }
      await this.aws.sleep(POLL_MS);
    }
    return false;
  }

  private async exhaust(jobId: string, error: string): Promise<void> {
    await this.jobs.finish(jobId, {
      status: 'failed',
      recovered: false,
      recoveryState: 'exhausted',
      error: safeError(error),
    });
    logger.error('self-update recovery exhausted', new Error(safeError(error)), {
      jobId,
      phase: 'complete',
      result: 'failed',
    });
  }

  private async withHeartbeat<T>(jobId: string, phase: 'mirroring', operation: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      this.jobs.heartbeat(jobId, phase).catch(() => undefined);
    }, 20_000);
    timer.unref();
    try {
      return await operation();
    } finally {
      clearInterval(timer);
    }
  }
}

function parameterValue(stack: SelfUpdateStack, key: string): string | undefined {
  return stack.parameters.find((parameter) => parameter.key === key)?.value;
}

function requireOutput(stack: SelfUpdateStack, key: string): string {
  const value = stack.outputs[key];
  if (!value) throw new Error(`CloudFormation stack output ${key} is missing`);
  return value;
}

function requireInstallValue(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required for cloud self-update`);
  return value;
}

function bootstrapStatusUrl(functionUrl: string): string {
  return new URL('/bootstrap/status', functionUrl).toString();
}

function isUpdateInProgress(status: string): boolean {
  return status.endsWith('_IN_PROGRESS') || status === 'REVIEW_IN_PROGRESS';
}

function isNoUpdates(error: unknown): boolean {
  return error instanceof Error && /No updates are to be performed/i.test(error.message);
}

function trustCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'invalid-release';
}

function safeError(error: unknown): string {
  return redactSelfUpdateError(error).message.slice(0, 2_000);
}

function isTerminal(job: SelfUpdateJob): boolean {
  return job.status === 'failed' || job.status === 'succeeded';
}

let executor: SelfUpdateExecutor | undefined;

export function getSelfUpdateExecutor(): SelfUpdateExecutor {
  executor ??= new SelfUpdateExecutor();
  return executor;
}

export function resetSelfUpdateExecutorForTests(): void {
  executor = undefined;
}

export function setSelfUpdateExecutorForTests(value: SelfUpdateExecutor): void {
  executor = value;
}
