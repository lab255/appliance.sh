import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { ObjectStore, ReleaseEnvelope, ReleaseSignatureEnvelope, VersionedObject } from '@appliance.sh/sdk';
import { StorageService } from './storage.service';
import { SelfUpdateService, type ReleaseVerifier, type SelfUpdateDispatcher } from './self-update.service';
import {
  buildImageOnlyUpdate,
  craneCommand,
  createAwsSelfUpdateDependencies,
  runCraneCopy,
  SelfUpdateExecutor,
  type AssumedCredentials,
  type SelfUpdateExecutorDependencies,
  type SelfUpdateStack,
  type SelfUpdateStackRequest,
} from './self-update-executor.service';

class MemoryStore implements ObjectStore {
  private readonly values = new Map<string, { value: string; version: number }>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key)?.value ?? null;
  }
  async getWithVersion(key: string): Promise<VersionedObject | null> {
    const entry = this.values.get(key);
    return entry ? { value: entry.value, version: String(entry.version) } : null;
  }
  async set(key: string, value: string): Promise<void> {
    const old = this.values.get(key);
    this.values.set(key, { value, version: (old?.version ?? 0) + 1 });
  }
  async setIfAbsent(key: string, value: string): Promise<boolean> {
    if (this.values.has(key)) return false;
    this.values.set(key, { value, version: 1 });
    return true;
  }
  async setIfVersion(key: string, value: string, version: string): Promise<boolean> {
    const old = this.values.get(key);
    if (!old || String(old.version) !== version) return false;
    this.values.set(key, { value, version: old.version + 1 });
    return true;
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async list(prefix?: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => !prefix || key.startsWith(prefix));
  }
}

const digest = `sha256:${'a'.repeat(64)}`;
const oldDigest = `sha256:${'b'.repeat(64)}`;
const release: ReleaseEnvelope = {
  kind: 'control-plane-release',
  version: '1.58.0',
  generation: 5,
  notBefore: '2026-08-29T00:00:00.000Z',
  expires: '2026-09-30T00:00:00.000Z',
  artifacts: [
    { name: 'appliance-api-server-linux-x64', arch: 'x64', sha256: '1'.repeat(64), size: 1 },
    { name: 'appliance-api-server-linux-arm64', arch: 'arm64', sha256: '2'.repeat(64), size: 1 },
    { name: 'appliance-console.tar.gz', arch: 'any', sha256: '3'.repeat(64), size: 1 },
  ],
  image: { repository: 'ghcr.io/lab255/appliance-api-server', manifestDigest: digest },
};
const oldImage = `111111111111.dkr.ecr.us-east-1.amazonaws.com/appliance@${oldDigest}`;
const targetImage = `111111111111.dkr.ecr.us-east-1.amazonaws.com/appliance@${digest}`;
const taggedTargetImage = '111111111111.dkr.ecr.us-east-1.amazonaws.com/appliance:system-1.58.0';
const credentials: AssumedCredentials = {
  accessKeyId: 'access',
  secretAccessKey: 'secret',
  sessionToken: 'session',
};

type AwsMode =
  | 'success'
  | 'wrong-version'
  | 'target-rollback'
  | 'recovery-exhausted'
  | 'recovery-stack-failed'
  | 'recovery-stuck'
  | 'rollback-failed'
  | 'stuck';

function fakeAws(now: { value: number }, mode: AwsMode = 'success') {
  const updateRequests: SelfUpdateStackRequest[] = [];
  let pendingImage: string | undefined;
  const stack: SelfUpdateStack = {
    stackId: 'arn:aws:cloudformation:us-east-1:111111111111:stack/appliance-prod/uuid',
    stackName: 'appliance-prod',
    status: 'UPDATE_COMPLETE',
    parameters: [
      { key: 'InstallationName', value: 'prod' },
      { key: 'ImageUri', value: oldImage },
      { key: 'ImageArchitecture', value: 'x86_64' },
      { key: 'SystemRoleMode', value: 'scoped' },
    ],
    outputs: {
      ImageRepositoryUrl: '111111111111.dkr.ecr.us-east-1.amazonaws.com/appliance',
      SelfUpdateCloudFormationRoleArn:
        'arn:aws:iam::111111111111:role/appliance-system/prod-self-update-cloudformation',
      ApiServerFunctionUrl: 'https://api.lambda-url.us-east-1.on.aws/',
    },
    lastUpdatedAt: '2026-08-29T00:00:00.000Z',
  };
  const deps: SelfUpdateExecutorDependencies = {
    assumeRole: vi.fn().mockResolvedValue(credentials),
    describeStack: vi.fn(async () => structuredClone(stack)),
    describeStackEvents: vi
      .fn()
      .mockResolvedValue(['ApiServerFunction UPDATE_FAILED arn:aws:iam::111111111111:role/private']),
    getEcrAuthorization: vi.fn().mockResolvedValue('QVdTOnNlY3JldA=='),
    resolveImageDigest: vi.fn().mockResolvedValue(digest),
    craneCopy: vi.fn().mockResolvedValue(undefined),
    updateStack: vi.fn(async (_credentials, request) => {
      updateRequests.push(request);
      const image = request.Parameters.find((parameter) => parameter.ParameterKey === 'ImageUri')?.ParameterValue;
      if (mode === 'recovery-exhausted' && image === oldImage) throw new Error('recovery submission rejected');
      pendingImage = image;
      stack.status = 'UPDATE_IN_PROGRESS';
    }),
    health: vi.fn(async () => {
      const current = stack.parameters.find((parameter) => parameter.key === 'ImageUri')?.value;
      if (current === targetImage) {
        return {
          initialized: true,
          serverVersion: ['wrong-version', 'recovery-stuck'].includes(mode) ? '9.9.9' : release.version,
        };
      }
      return { initialized: true, serverVersion: '1.57.0' };
    }),
    sleep: vi.fn(async (ms) => {
      now.value += ms;
      if (
        stack.status === 'UPDATE_IN_PROGRESS' &&
        mode !== 'stuck' &&
        !(mode === 'recovery-stuck' && pendingImage === oldImage)
      ) {
        if (pendingImage === targetImage && mode === 'target-rollback') {
          stack.status = 'UPDATE_ROLLBACK_COMPLETE';
          stack.parameters.find((parameter) => parameter.key === 'ImageUri')!.value = oldImage;
        } else if (pendingImage === targetImage && mode === 'rollback-failed') {
          stack.status = 'UPDATE_ROLLBACK_FAILED';
        } else if (pendingImage === oldImage && mode === 'recovery-stack-failed') {
          stack.status = 'UPDATE_FAILED';
          stack.parameters.find((parameter) => parameter.key === 'ImageUri')!.value = targetImage;
        } else {
          stack.status = 'UPDATE_COMPLETE';
          stack.parameters.find((parameter) => parameter.key === 'ImageUri')!.value = pendingImage;
        }
        pendingImage = undefined;
      }
    }),
    now: () => new Date(now.value),
  };
  return { deps, stack, updateRequests };
}

describe('SelfUpdateExecutor', () => {
  let now: { value: number };
  let jobs: SelfUpdateService;
  let verifier: ReleaseVerifier;
  let dispatcher: SelfUpdateDispatcher;

  beforeEach(() => {
    now = { value: Date.parse('2026-08-30T00:00:00.000Z') };
    dispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    verifier = vi.fn(async (payload, envelope) => ({
      payload: payload as ReleaseEnvelope,
      envelope: envelope as ReleaseSignatureEnvelope,
      verifiedAt: new Date(now.value).toISOString(),
    }));
    jobs = new SelfUpdateService({
      storage: new StorageService(new MemoryStore()),
      dispatcher,
      verifier,
      now: () => new Date(now.value),
    });
    process.env.APPLIANCE_STACK_ID = 'arn:aws:cloudformation:us-east-1:111111111111:stack/appliance-prod/uuid';
    process.env.SELF_UPDATE_ROLE_ARN = 'arn:aws:iam::111111111111:role/appliance-system/prod-self-update';
  });

  async function queuedJob() {
    return (
      await jobs.create(
        { targetDigest: digest, release: { payload: release, envelope: { fixture: true } } },
        { keyId: 'admin', tenantId: 'default', secret: 'secret' },
        'executor'
      )
    ).job;
  }

  it('copies the verified digest and submits the exact previous-template ImageUri-only update', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now);
    const updateStack = aws.deps.updateStack;
    aws.deps.updateStack = vi.fn(async (assumed, request) => {
      expect(await jobs.get(job.id)).toMatchObject({ phase: 'submitting-update', targetImage });
      await updateStack(assumed, request);
    });
    await expect(new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id)).resolves.toBe('complete');

    expect(aws.deps.assumeRole).toHaveBeenCalledWith(process.env.SELF_UPDATE_ROLE_ARN, `self-update-${job.id}`);
    expect(aws.deps.craneCopy).toHaveBeenCalledWith(
      `${release.image.repository}@${digest}`,
      taggedTargetImage,
      '111111111111.dkr.ecr.us-east-1.amazonaws.com',
      'QVdTOnNlY3JldA=='
    );
    expect(aws.deps.resolveImageDigest).toHaveBeenCalledWith(
      credentials,
      '111111111111.dkr.ecr.us-east-1.amazonaws.com/appliance',
      'system-1.58.0'
    );
    expect(aws.updateRequests).toEqual([
      {
        StackName: aws.stack.stackId,
        UsePreviousTemplate: true,
        Parameters: [
          { ParameterKey: 'InstallationName', UsePreviousValue: true },
          { ParameterKey: 'ImageUri', ParameterValue: targetImage },
          { ParameterKey: 'ImageArchitecture', UsePreviousValue: true },
          { ParameterKey: 'SystemRoleMode', UsePreviousValue: true },
        ],
        RoleARN: aws.stack.outputs.SelfUpdateCloudFormationRoleArn,
        Capabilities: ['CAPABILITY_NAMED_IAM'],
      },
    ]);
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'succeeded',
      recovered: false,
      previousImage: oldImage,
      targetImage,
      stackId: aws.stack.stackId,
      stackName: aws.stack.stackName,
      templateIdentity: `${aws.stack.stackId}#2026-08-29T00:00:00.000Z`,
      healthUrl: 'https://api.lambda-url.us-east-1.on.aws/bootstrap/status',
    });
  });

  it('rejects a blank prior ImageUri before crane or CloudFormation mutation', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now);
    aws.stack.parameters.find((parameter) => parameter.key === 'ImageUri')!.value = '';
    await new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id);
    expect(aws.deps.craneCopy).not.toHaveBeenCalled();
    expect(aws.deps.updateStack).not.toHaveBeenCalled();
    expect(await jobs.get(job.id)).toMatchObject({ status: 'failed', recovered: true, phase: 'complete' });
  });

  it('finishes cleanly when the installation uses admin system roles', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now);
    process.env.SELF_UPDATE_ROLE_ARN = '';
    await expect(new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id)).resolves.toBe('complete');
    expect(aws.deps.assumeRole).not.toHaveBeenCalled();
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'failed',
      recovered: true,
      recoveryState: 'recovered',
      error: expect.stringContaining('baseline-update --system-role-mode scoped'),
    });
  });

  it('independently re-verifies persisted evidence before AWS mutation', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now);
    const rejecting = vi.fn().mockRejectedValue(Object.assign(new Error('blacklisted'), { code: 'blacklisted-key' }));
    await new SelfUpdateExecutor({ jobs, verifier: rejecting, aws: aws.deps }).execute(job.id);
    expect(aws.deps.assumeRole).not.toHaveBeenCalled();
    expect(aws.deps.craneCopy).not.toHaveBeenCalled();
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'failed',
      recovered: true,
      error: 'release evidence rejected by worker: blacklisted-key',
    });
  });

  it('re-pins the previous image when health is initialized at the wrong version', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now, 'wrong-version');
    await new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id);
    expect(aws.updateRequests.map((request) => request.Parameters[1]?.ParameterValue)).toEqual([targetImage, oldImage]);
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'failed',
      recovered: true,
      recoveryState: 'recovered',
      phase: 'complete',
    });
  });

  it('re-issues the prior image after CloudFormation rollback', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now, 'target-rollback');
    await new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id);
    expect(aws.updateRequests.map((request) => request.Parameters[1]?.ParameterValue)).toEqual([targetImage, oldImage]);
    expect(await jobs.get(job.id)).toMatchObject({ status: 'failed', recovered: true });
  });

  it('persists exhausted recovery as terminal and clears the lease for a later signed request', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now, 'recovery-exhausted');
    aws.deps.health = vi.fn().mockResolvedValue({ initialized: true, serverVersion: 'wrong' });
    await new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id);
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'failed',
      recovered: false,
      recoveryState: 'exhausted',
      phase: 'complete',
    });
    const retry = await jobs.create(
      { targetDigest: digest, release: { payload: release, envelope: { fixture: true } } },
      { keyId: 'admin', tenantId: 'default', secret: 'secret' },
      'after-exhaustion'
    );
    expect(retry.job.id).not.toBe(job.id);
  });

  it('leaves a submitted but unobserved re-pin resumable instead of marking it exhausted', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now, 'recovery-stuck');
    await new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id);
    expect(aws.updateRequests.map((request) => request.Parameters[1]?.ParameterValue)).toEqual([targetImage, oldImage]);
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'running',
      phase: 'waiting-for-recovery',
      recoveryState: 'in-progress',
      recovered: false,
    });
  });

  it('preserves the original failure when persisted recovery resumes', async () => {
    const job = await queuedJob();
    await new SelfUpdateExecutor({ jobs, verifier, aws: fakeAws(now, 'recovery-stuck').deps }).execute(job.id);
    expect(await jobs.get(job.id)).toMatchObject({
      phase: 'waiting-for-recovery',
      error: 'target health/version probe failed',
    });

    now.value += 61_000;
    await jobs.getAndResume(job.id, { keyId: 'admin', secret: 'secret' });
    await new SelfUpdateExecutor({ jobs, verifier, aws: fakeAws(now).deps }).execute(job.id);
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'failed',
      recovered: true,
      error: 'target health/version probe failed',
    });
  });

  it('records redacted CloudFormation events when recovery reaches a failed stable state', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now, 'recovery-stack-failed');
    aws.deps.health = vi.fn().mockResolvedValue({ initialized: true, serverVersion: 'wrong' });
    await new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id);
    expect(aws.deps.describeStackEvents).toHaveBeenCalled();
    const failed = await jobs.get(job.id);
    expect(failed).toMatchObject({ recoveryState: 'exhausted', recovered: false });
    expect(failed?.error).toContain('[REDACTED_ARN]');
    expect(failed?.error).not.toContain('111111111111');
  });

  it('resumes stack wait from persisted N-1-compatible job state without re-mirroring or re-submitting', async () => {
    const job = await queuedJob();
    const claimed = await jobs.claim(job.id);
    await jobs.heartbeat(job.id, claimed.lease.holder!, 'waiting-for-stack', {
      previousImage: oldImage,
      targetImage,
      stackId: process.env.APPLIANCE_STACK_ID,
    });
    now.value += 61_000;
    await jobs.getAndResume(job.id, { keyId: 'admin', secret: 'secret' });
    const aws = fakeAws(now);
    aws.stack.parameters.find((parameter) => parameter.key === 'ImageUri')!.value = targetImage;
    await new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id);
    expect(aws.deps.craneCopy).not.toHaveBeenCalled();
    expect(aws.deps.updateStack).not.toHaveBeenCalled();
    expect(await jobs.get(job.id)).toMatchObject({ status: 'succeeded' });
  });

  it('reserves the final three minutes for recovery before the 900-second Lambda deadline', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now, 'stuck');
    await new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id);
    expect(now.value - Date.parse('2026-08-30T00:00:00.000Z')).toBeLessThanOrEqual(840_000);
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'running',
      recoveryState: 'in-progress',
      phase: 'submitting-recovery',
    });
  });

  it('builds crane cp as an argv array with shell disabled and auth isolated to the supplied /tmp config', () => {
    process.env.BOOTSTRAP_TOKEN = 'must-not-reach-crane';
    const command = craneCommand('source@sha256:a', 'target@sha256:a', '/tmp/private-docker-config');
    expect(command.file).toBe('crane');
    expect(command.args).toEqual(['cp', 'source@sha256:a', 'target@sha256:a']);
    expect(command.options).toMatchObject({
      shell: false,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: '/tmp/private-docker-config' },
    });
    expect(command.options.env).not.toHaveProperty('BOOTSTRAP_TOKEN');
  });

  it('writes the exact ECR token only to the per-run DOCKER_CONFIG', async () => {
    let config: unknown;
    await runCraneCopy(
      'source@sha256:a',
      'target:system-1.0.0',
      '111111111111.dkr.ecr.us-east-1.amazonaws.com',
      'exact-token',
      async (command) => {
        const dockerConfig = command.options.env?.DOCKER_CONFIG;
        expect(typeof dockerConfig).toBe('string');
        config = JSON.parse(await readFile(join(String(dockerConfig), 'config.json'), 'utf8'));
      }
    );
    expect(config).toEqual({
      auths: { '111111111111.dkr.ecr.us-east-1.amazonaws.com': { auth: 'exact-token' } },
    });
  });

  it('requests the exact fenced one-hour AssumeRole session', async () => {
    let command: AssumeRoleCommand | undefined;
    const send = vi.spyOn(STSClient.prototype, 'send').mockImplementation(async (candidate: unknown) => {
      command = candidate as AssumeRoleCommand;
      return {
        Credentials: { AccessKeyId: 'access', SecretAccessKey: 'secret', SessionToken: 'session' },
      } as never;
    });
    try {
      await createAwsSelfUpdateDependencies().assumeRole(
        'arn:aws:iam::111111111111:role/self-update',
        'self-update-job'
      );
    } finally {
      send.mockRestore();
    }
    expect(command?.input).toEqual({
      RoleArn: 'arn:aws:iam::111111111111:role/self-update',
      RoleSessionName: 'self-update-job',
      SourceIdentity: 'self-update-job',
      DurationSeconds: 3600,
    });
  });

  it('persists a redacted recovered failure when mirroring fails before stack mutation', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now);
    const token = 'bare-secret-token-value';
    aws.deps.getEcrAuthorization = vi.fn().mockResolvedValue(token);
    aws.deps.craneCopy = vi.fn().mockRejectedValue(new Error(`crane exposed ${token}`));
    await new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id);
    expect(aws.deps.updateStack).not.toHaveBeenCalled();
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'failed',
      recovered: true,
      recoveryState: 'recovered',
      error: 'crane exposed [REDACTED_ECR_TOKEN]',
    });
  });

  it('rejects a post-mirror digest mismatch before UpdateStack', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now);
    aws.deps.resolveImageDigest = vi.fn().mockResolvedValue(`sha256:${'c'.repeat(64)}`);
    await new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id);
    expect(aws.deps.updateStack).not.toHaveBeenCalled();
    expect(await jobs.get(job.id)).toMatchObject({ status: 'failed', recovered: true });
  });

  it('aborts without mutation when a heartbeat reports a stolen lease', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now);
    vi.spyOn(jobs, 'heartbeat').mockRejectedValueOnce(
      Object.assign(new Error('stolen by resumed worker'), { code: 'lease-stolen' })
    );
    await expect(new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id)).resolves.toBe('complete');
    expect(aws.deps.craneCopy).not.toHaveBeenCalled();
    expect(aws.deps.updateStack).not.toHaveBeenCalled();
  });

  it('absorbs a stolen lease from the persisted-recovery early-return path', async () => {
    const job = await queuedJob();
    const claimed = await jobs.claim(job.id);
    await jobs.heartbeat(job.id, claimed.lease.holder!, 'submitting-recovery', {
      previousImage: oldImage,
      error: 'original target failure',
    });
    now.value += 61_000;
    await jobs.getAndResume(job.id, { keyId: 'admin', secret: 'secret' });

    const originalHeartbeat = jobs.heartbeat.bind(jobs);
    let recoveryHeartbeats = 0;
    const heartbeat = vi.spyOn(jobs, 'heartbeat').mockImplementation(async (...args) => {
      if (args[2] === 'submitting-recovery' && ++recoveryHeartbeats === 2) {
        throw Object.assign(new Error('stolen during resumed recovery'), { code: 'lease-stolen' });
      }
      return originalHeartbeat(...args);
    });
    try {
      await expect(new SelfUpdateExecutor({ jobs, verifier, aws: fakeAws(now).deps }).execute(job.id)).resolves.toBe(
        'complete'
      );
    } finally {
      heartbeat.mockRestore();
    }
  });

  it('absorbs a stolen lease while the outer failure path enters recovery', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now);
    aws.deps.updateStack = vi.fn().mockRejectedValue(new Error('target submission became uncertain'));
    const originalHeartbeat = jobs.heartbeat.bind(jobs);
    const heartbeat = vi.spyOn(jobs, 'heartbeat').mockImplementation(async (...args) => {
      if (args[2] === 'submitting-recovery') {
        throw Object.assign(new Error('stolen before recovery submission'), { code: 'lease-stolen' });
      }
      return originalHeartbeat(...args);
    });
    try {
      await expect(new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id)).resolves.toBe('complete');
    } finally {
      heartbeat.mockRestore();
    }
  });

  it('does not hammer UpdateStack after a terminal rollback failure', async () => {
    const job = await queuedJob();
    const aws = fakeAws(now, 'rollback-failed');
    await new SelfUpdateExecutor({ jobs, verifier, aws: aws.deps }).execute(job.id);
    expect(aws.updateRequests).toHaveLength(1);
    expect(aws.deps.describeStackEvents).toHaveBeenCalled();
    expect(await jobs.get(job.id)).toMatchObject({ status: 'failed', recoveryState: 'exhausted' });
  });

  it('refuses to build an update when ImageUri is absent', () => {
    const aws = fakeAws(now);
    aws.stack.parameters = [{ key: 'InstallationName', value: 'prod' }];
    expect(() => buildImageOnlyUpdate(aws.stack, targetImage, 'role')).toThrow('does not declare ImageUri');
  });
});
