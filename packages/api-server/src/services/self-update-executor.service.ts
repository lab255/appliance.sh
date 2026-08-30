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
import { DescribeImagesCommand, ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { PINNED_RELEASE_TRUST, verifyReleaseEnvelope } from '@appliance.sh/sdk';
import {
  getSelfUpdateService,
  type ReleaseVerifier,
  type SelfUpdateJob,
  type SelfUpdateService,
} from './self-update.service';
import { redactSelfUpdateError } from './self-update-redaction';
import { logger } from '../logger';

const POLL_MS = 5_000;
const HEALTH_WINDOW_MS = 120_000;
const TARGET_STACK_WORK_MS = 540_000;
const TARGET_HEALTH_END_MS = 660_000;
const HARD_WORK_MS = 840_000;
const RECOVERY_WAIT_FLOOR_MS = 60_000;
const RECOVERY_HEALTH_FLOOR_MS = 60_000;

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
  Capabilities: ['CAPABILITY_NAMED_IAM'];
}

export interface SelfUpdateExecutorDependencies {
  assumeRole(roleArn: string, sourceIdentity: string): Promise<AssumedCredentials>;
  describeStack(credentials: AssumedCredentials, stackId: string): Promise<SelfUpdateStack>;
  describeStackEvents(credentials: AssumedCredentials, stackId: string): Promise<string[]>;
  getEcrAuthorization(credentials: AssumedCredentials): Promise<string>;
  resolveImageDigest(credentials: AssumedCredentials, repositoryUrl: string, imageTag: string): Promise<string>;
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
    Capabilities: ['CAPABILITY_NAMED_IAM'],
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
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DOCKER_CONFIG: dockerConfig,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  };
}

export type CraneRunner = (command: ReturnType<typeof craneCommand>) => Promise<void>;

const spawnCrane: CraneRunner = async (command) => {
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
};

export async function runCraneCopy(
  source: string,
  target: string,
  registry: string,
  authorizationToken: string,
  runner: CraneRunner = spawnCrane
): Promise<void> {
  const authDir = await mkdtemp(join(tmpdir(), 'appliance-self-update-'));
  try {
    await writeFile(
      join(authDir, 'config.json'),
      JSON.stringify({ auths: { [registry]: { auth: authorizationToken } } }),
      { mode: 0o600 }
    );
    const command = craneCommand(source, target, authDir);
    await runner(command);
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
          DurationSeconds: 3600,
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
    async resolveImageDigest(credentials, repositoryUrl, imageTag) {
      const [registry, ...repositoryParts] = repositoryUrl.split('/');
      const repositoryName = repositoryParts.join('/');
      const registryId = registry?.split('.')[0];
      if (!registryId || !/^\d{12}$/.test(registryId) || !repositoryName) {
        throw new Error('installation ECR repository URL is malformed');
      }
      const result = await new ECRClient({ credentials }).send(
        new DescribeImagesCommand({
          registryId,
          repositoryName,
          imageIds: [{ imageTag }],
        })
      );
      const resolved = result.imageDetails?.[0]?.imageDigest;
      if (!resolved || !/^sha256:[0-9a-f]{64}$/.test(resolved)) {
        throw new Error('ECR did not resolve the mirrored system image digest');
      }
      return resolved;
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
  clearAvailable?: (targetDigest: string) => Promise<boolean>;
}

export class SelfUpdateExecutor {
  private readonly jobs: SelfUpdateService;
  private readonly verifier: ReleaseVerifier;
  private readonly aws: SelfUpdateExecutorDependencies;
  private readonly clearAvailable: (targetDigest: string) => Promise<boolean>;

  constructor(options: SelfUpdateExecutorOptions = {}) {
    this.jobs = options.jobs ?? getSelfUpdateService();
    this.verifier = options.verifier ?? verifyReleaseEnvelope;
    this.aws = options.aws ?? createAwsSelfUpdateDependencies();
    this.clearAvailable =
      options.clearAvailable ??
      (async (targetDigest) => {
        const { getSelfUpdateSchedulerService } = await import('./self-update-scheduler.service.js');
        return getSelfUpdateSchedulerService().clearAvailableIfDigest(targetDigest);
      });
  }

  async execute(jobId: string): Promise<'complete'> {
    try {
      return await this.executeWithLease(jobId);
    } catch (error) {
      if (isLeaseStolen(error)) return 'complete';
      throw error;
    }
  }

  private async executeWithLease(jobId: string): Promise<'complete'> {
    const startedAt = this.aws.now().getTime();
    const targetStackDeadline = startedAt + TARGET_STACK_WORK_MS;
    const targetHealthDeadline = startedAt + TARGET_HEALTH_END_MS;
    const hardDeadline = startedAt + HARD_WORK_MS;
    let job = await this.jobs.claim(jobId);
    if (isTerminal(job)) return 'complete';
    const holder = requireLeaseHolder(job);

    const roleArn = process.env.SELF_UPDATE_ROLE_ARN;
    if (!roleArn) {
      await this.jobs.finish(
        jobId,
        {
          status: 'failed',
          recovered: true,
          recoveryState: 'recovered',
          error:
            'self-update requires scoped system roles; run appliance cloud baseline-update --system-role-mode scoped',
        },
        holder
      );
      return 'complete';
    }

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
      await this.jobs.finish(
        jobId,
        {
          status: 'failed',
          recovered: true,
          recoveryState: 'recovered',
          error: `release evidence rejected by worker: ${trustCode(error)}`,
        },
        holder
      );
      return 'complete';
    }

    const stackId = requireInstallValue('APPLIANCE_STACK_ID');
    const sourceIdentity = `self-update-${jobId}`;
    let credentials: AssumedCredentials;
    let stack: SelfUpdateStack;
    try {
      credentials = await this.aws.assumeRole(roleArn, sourceIdentity);
      stack = await this.aws.describeStack(credentials, stackId);
      job = await this.captureStack(job, stack, holder);
    } catch (error) {
      if (isLeaseStolen(error)) return 'complete';
      await this.failBeforeMutation(jobId, holder, error);
      return 'complete';
    }
    if (isTerminal(job)) return 'complete';

    if (job.phase === 'submitting-recovery' || job.phase === 'waiting-for-recovery') {
      return await this.recover(
        job,
        holder,
        credentials,
        stack,
        job.error ?? 'resuming persisted recovery',
        hardDeadline
      );
    }

    let cloudFormationRoleArn: string;
    let repository: string;
    let registry: string;
    try {
      cloudFormationRoleArn = requireOutput(stack, 'SelfUpdateCloudFormationRoleArn');
      repository = requireOutput(stack, 'ImageRepositoryUrl');
      registry = repository.split('/')[0] ?? '';
      if (!registry) throw new Error('installation ECR repository is malformed');
    } catch (error) {
      await this.failBeforeMutation(jobId, holder, error);
      return 'complete';
    }
    const targetImage = `${repository}@${job.targetDigest}`;
    if (job.targetImage && job.targetImage !== targetImage) {
      await this.failBeforeMutation(jobId, holder, 'persisted target image does not match signed release digest');
      return 'complete';
    }
    const imageTag = systemImageTag(job.targetVersion);
    const mirrorTarget = `${repository}:${imageTag}`;
    let authorizationToken: string | undefined;
    let mutationMayHaveStarted = !['queued', 'verifying', 'describing-stack', 'mirroring'].includes(job.phase);

    try {
      if (job.phase !== 'waiting-for-stack' && job.phase !== 'probing-health') {
        if (parameterValue(stack, 'ImageUri') === targetImage) {
          job = await this.jobs.heartbeat(jobId, holder, 'waiting-for-stack', { targetImage });
          mutationMayHaveStarted = true;
        } else if (isUpdateInProgress(stack.status) && job.previousImage) {
          job = await this.jobs.heartbeat(jobId, holder, 'waiting-for-stack', { targetImage });
          mutationMayHaveStarted = true;
        } else if (job.phase === 'submitting-update' && job.targetImage === targetImage) {
          mutationMayHaveStarted = true;
          await this.aws.updateStack(credentials, buildImageOnlyUpdate(stack, targetImage, cloudFormationRoleArn));
          job = await this.jobs.heartbeat(jobId, holder, 'waiting-for-stack', { targetImage });
        } else {
          job = await this.jobs.heartbeat(jobId, holder, 'mirroring');
          authorizationToken = await this.aws.getEcrAuthorization(credentials);
          await this.withHeartbeat(jobId, holder, 'mirroring', () =>
            this.aws.craneCopy(job.sourceImage, mirrorTarget, registry, authorizationToken!)
          );
          const resolvedDigest = await this.aws.resolveImageDigest(credentials, repository, imageTag);
          if (resolvedDigest !== job.targetDigest) {
            throw new Error('mirrored ECR digest does not match the signed release digest');
          }
          job = await this.jobs.heartbeat(jobId, holder, 'submitting-update', { targetImage });
          mutationMayHaveStarted = true;
          await this.aws.updateStack(credentials, buildImageOnlyUpdate(stack, targetImage, cloudFormationRoleArn));
          job = await this.jobs.heartbeat(jobId, holder, 'waiting-for-stack', { targetImage });
        }
      }

      stack = await this.waitForTarget(jobId, holder, credentials, stackId, targetStackDeadline);
      if (stack.status !== 'UPDATE_COMPLETE') {
        return await this.recover(
          job,
          holder,
          credentials,
          stack,
          `CloudFormation reached ${stack.status}`,
          hardDeadline
        );
      }
      await this.jobs.heartbeat(jobId, holder, 'probing-health');
      const healthUrl = bootstrapStatusUrl(requireOutput(stack, 'ApiServerFunctionUrl'));
      const healthy = await this.pollHealth(
        jobId,
        holder,
        'probing-health',
        healthUrl,
        job.targetVersion,
        Math.min(targetHealthDeadline, this.aws.now().getTime() + HEALTH_WINDOW_MS)
      );
      if (!healthy)
        return await this.recover(job, holder, credentials, stack, 'target health/version probe failed', hardDeadline);
      await this.jobs.finish(jobId, { status: 'succeeded', recovered: false, healthUrl }, holder);
      try {
        await this.clearAvailable(job.targetDigest);
      } catch (error) {
        logger.warn('self-update completed but availability marker cleanup failed', {
          jobId,
          error: redactSelfUpdateError(error).message,
        });
      }
      logger.info('self-update completed', {
        jobId,
        digestPrefix: job.targetDigest.slice(0, 19),
        phase: 'complete',
        result: 'succeeded',
      });
      return 'complete';
    } catch (error) {
      if (isLeaseStolen(error)) return 'complete';
      const safe = safeError(error, authorizationToken ? [authorizationToken] : []);
      if (!mutationMayHaveStarted) {
        await this.failBeforeMutation(jobId, holder, safe);
        return 'complete';
      }
      stack = await this.aws.describeStack(credentials, stackId);
      return await this.recover(job, holder, credentials, stack, safe, hardDeadline);
    }
  }

  private async failBeforeMutation(jobId: string, holder: string, error: unknown): Promise<void> {
    await this.jobs.finish(
      jobId,
      {
        status: 'failed',
        recovered: true,
        recoveryState: 'recovered',
        error: safeError(error),
      },
      holder
    );
  }

  private async captureStack(job: SelfUpdateJob, stack: SelfUpdateStack, holder: string): Promise<SelfUpdateJob> {
    const currentImage = parameterValue(stack, 'ImageUri');
    if (!currentImage) {
      return this.jobs.finish(
        job.id,
        {
          status: 'failed',
          recovered: true,
          recoveryState: 'recovered',
          error: 'CloudFormation ImageUri is blank; self-update refused before mutation',
        },
        holder
      );
    }
    const previousImage = job.previousImage ?? currentImage;
    if (job.stackId && job.stackId !== stack.stackId) throw new Error('persisted self-update stack identity changed');
    const phase = ['queued', 'verifying', 'describing-stack'].includes(job.phase) ? 'describing-stack' : job.phase;
    return this.jobs.heartbeat(job.id, holder, phase, {
      previousImage,
      stackId: stack.stackId,
      stackName: stack.stackName,
      templateIdentity: job.templateIdentity ?? `${stack.stackId}#${stack.lastUpdatedAt ?? 'unknown'}`,
      healthUrl: bootstrapStatusUrl(requireOutput(stack, 'ApiServerFunctionUrl')),
    });
  }

  private async waitForTarget(
    jobId: string,
    holder: string,
    credentials: AssumedCredentials,
    stackId: string,
    deadline: number
  ): Promise<SelfUpdateStack> {
    let stack = await this.aws.describeStack(credentials, stackId);
    while (isUpdateInProgress(stack.status) && this.aws.now().getTime() < deadline) {
      await this.jobs.heartbeat(jobId, holder, 'waiting-for-stack');
      await this.aws.sleep(POLL_MS);
      stack = await this.aws.describeStack(credentials, stackId);
    }
    return stack;
  }

  private async recover(
    job: SelfUpdateJob,
    holder: string,
    credentials: AssumedCredentials,
    initialStack: SelfUpdateStack,
    reason: string,
    hardDeadline: number
  ): Promise<'complete'> {
    if (!job.previousImage) {
      await this.exhaust(job.id, holder, reason);
      return 'complete';
    }
    await this.jobs.heartbeat(job.id, holder, 'submitting-recovery', {
      recovered: false,
      recoveryState: 'in-progress',
      error: safeError(reason),
    });
    let stack = initialStack;
    const submissionDeadline = hardDeadline - RECOVERY_WAIT_FLOOR_MS - RECOVERY_HEALTH_FLOOR_MS;
    while (isUpdateInProgress(stack.status) && this.aws.now().getTime() < submissionDeadline) {
      await this.aws.sleep(POLL_MS);
      await this.jobs.heartbeat(job.id, holder, 'submitting-recovery');
      stack = await this.aws.describeStack(credentials, stack.stackId);
    }
    if (isTerminalUnrecoverableStack(stack.status)) {
      const events = await this.aws.describeStackEvents(credentials, stack.stackId).catch(() => []);
      await this.exhaust(job.id, holder, `${reason}; ${events.slice(0, 3).join('; ')}`);
      return 'complete';
    }
    if (isUpdateInProgress(stack.status)) return 'complete';

    const roleArn = requireOutput(stack, 'SelfUpdateCloudFormationRoleArn');
    let submitted = false;
    let alreadyPinned = false;
    let lastSubmissionError: string | undefined;
    while (!submitted && this.aws.now().getTime() < submissionDeadline) {
      if (isUpdateInProgress(stack.status)) {
        await this.aws.sleep(POLL_MS);
        await this.jobs.heartbeat(job.id, holder, 'submitting-recovery');
        stack = await this.aws.describeStack(credentials, stack.stackId);
        continue;
      }
      if (isTerminalUnrecoverableStack(stack.status)) break;
      try {
        await this.aws.updateStack(credentials, buildImageOnlyUpdate(stack, job.previousImage, roleArn));
        submitted = true;
      } catch (error) {
        if (isNoUpdates(error)) {
          submitted = true;
          alreadyPinned = true;
          break;
        }
        lastSubmissionError = safeError(error);
        stack = await this.aws.describeStack(credentials, stack.stackId);
        if (!isTerminalUnrecoverableStack(stack.status)) await this.aws.sleep(POLL_MS);
      }
    }
    if (!submitted) {
      if (isTerminalUnrecoverableStack(stack.status)) {
        const events = await this.aws.describeStackEvents(credentials, stack.stackId).catch(() => []);
        await this.exhaust(job.id, holder, `${reason}; ${events.slice(0, 3).join('; ')}`);
      } else if (lastSubmissionError) {
        await this.exhaust(job.id, holder, `${reason}; recovery submission failed: ${lastSubmissionError}`);
      }
      return 'complete';
    }
    await this.jobs.heartbeat(job.id, holder, 'waiting-for-recovery');
    stack = await this.waitForRecovery(job.id, holder, credentials, stack.stackId, hardDeadline);
    if (isUpdateInProgress(stack.status)) return 'complete';
    if (isTerminalUnrecoverableStack(stack.status)) {
      const events = await this.aws.describeStackEvents(credentials, stack.stackId).catch(() => []);
      await this.exhaust(job.id, holder, `${reason}; ${events.slice(0, 3).join('; ')}`);
      return 'complete';
    }
    const healthUrl = bootstrapStatusUrl(requireOutput(stack, 'ApiServerFunctionUrl'));
    const recoveryHealthDeadline = Math.min(hardDeadline, this.aws.now().getTime() + RECOVERY_HEALTH_FLOOR_MS);
    const healthy = await this.pollHealth(
      job.id,
      holder,
      'waiting-for-recovery',
      healthUrl,
      undefined,
      recoveryHealthDeadline
    );
    if ((stack.status === 'UPDATE_COMPLETE' || alreadyPinned) && healthy) {
      await this.jobs.finish(
        job.id,
        {
          status: 'failed',
          recovered: true,
          recoveryState: 'recovered',
          error: safeError(reason),
          healthUrl,
        },
        holder
      );
      return 'complete';
    }
    if (this.aws.now().getTime() >= hardDeadline) return 'complete';
    const events = await this.aws.describeStackEvents(credentials, stack.stackId).catch(() => []);
    await this.exhaust(job.id, holder, `${reason}; ${events.slice(0, 3).join('; ')}`);
    return 'complete';
  }

  private async waitForRecovery(
    jobId: string,
    holder: string,
    credentials: AssumedCredentials,
    stackId: string,
    deadline: number
  ): Promise<SelfUpdateStack> {
    let stack = await this.aws.describeStack(credentials, stackId);
    while (isUpdateInProgress(stack.status) && this.aws.now().getTime() < deadline) {
      await this.aws.sleep(POLL_MS);
      await this.jobs.heartbeat(jobId, holder, 'waiting-for-recovery');
      stack = await this.aws.describeStack(credentials, stackId);
    }
    return stack;
  }

  private async pollHealth(
    jobId: string,
    holder: string,
    phase: 'probing-health' | 'waiting-for-recovery',
    url: string,
    targetVersion: string | undefined,
    deadline: number
  ): Promise<boolean> {
    while (this.aws.now().getTime() < deadline) {
      await this.jobs.heartbeat(jobId, holder, phase);
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

  private async exhaust(jobId: string, holder: string, error: string): Promise<void> {
    await this.jobs.finish(
      jobId,
      {
        status: 'failed',
        recovered: false,
        recoveryState: 'exhausted',
        error: safeError(error),
      },
      holder
    );
    logger.error('self-update recovery exhausted', new Error(safeError(error)), {
      jobId,
      phase: 'complete',
      result: 'failed',
    });
  }

  private async withHeartbeat<T>(
    jobId: string,
    holder: string,
    phase: 'mirroring',
    operation: () => Promise<T>
  ): Promise<T> {
    const timer = setInterval(() => {
      this.jobs.heartbeat(jobId, holder, phase).catch(() => undefined);
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
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? code : 'invalid-release';
}

function safeError(error: unknown, exactSecrets: readonly string[] = []): string {
  return redactSelfUpdateError(error, exactSecrets).message.slice(0, 2_000);
}

function isTerminal(job: SelfUpdateJob): boolean {
  return job.status === 'failed' || job.status === 'succeeded';
}

function requireLeaseHolder(job: SelfUpdateJob): string {
  if (!job.lease.holder) throw new Error(`Self-update job ${job.id} has no lease holder`);
  return job.lease.holder;
}

function isLeaseStolen(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'lease-stolen');
}

function isTerminalUnrecoverableStack(status: string): boolean {
  return status.endsWith('_FAILED');
}

function systemImageTag(version: string): string {
  return `system-${version.replace(/\+/g, '_')}`;
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
