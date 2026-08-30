import { describe, expect, it, vi } from 'vitest';
import {
  runCloudBaselineUpdate,
  runCloudRouteUpdate,
  runCloudSystemUpdate,
  runCloudTeardown,
  type CloudLifecycleDependencies,
} from './cloud-lifecycle.js';
import type { SelfUpdatePublicJob } from '@appliance.sh/sdk';

const profile = {
  installGeneration: 'cloudformation-v1' as const,
  cloudFormationStackName: 'appliance-prod',
  awsAccountId: '111111111111',
  awsRegion: 'us-east-1',
  apiUrl: 'https://raw.lambda-url.us-east-1.on.aws',
  keyId: 'ak',
  secret: 'sk',
};

const stack = {
  exists: true,
  accountId: '111111111111',
  region: 'us-east-1',
  status: 'UPDATE_COMPLETE',
  parameters: { ImageUri: 'repo@sha256:old', ImageArchitecture: 'x86_64' },
  outputs: {
    StateBucketName: 'state',
    StateBucketArn: 'arn:state',
    DataBucketName: 'data',
    DataBucketArn: 'arn:data',
    StateKmsKeyArn: 'arn:kms',
    StateKmsAliasName: 'alias/state',
    ImageRepositoryUrl: '111.dkr.ecr.us-east-1.amazonaws.com/appliance',
    SystemApiServerRoleArn: 'arn:api-role',
    SystemWorkerRoleArn: 'arn:worker-role',
    BootstrapTokenSecretArn: 'arn:secret',
    UserAppliancePermissionsBoundaryArn:
      'arn:aws:iam::111111111111:policy/appliance-system/prod-user-appliance-boundary',
    ApiServerFunctionName: 'api',
    ApiServerFunctionArn: 'arn:api',
    ApiServerFunctionUrl: profile.apiUrl,
    WorkerFunctionName: 'worker',
    WorkerFunctionArn: 'arn:worker',
    WorkerFunctionUrl: 'https://worker.example',
  },
};

function preCu0Stack() {
  const { UserAppliancePermissionsBoundaryArn: _boundaryOutput, ...outputs } = stack.outputs;
  return { ...stack, outputs };
}

function dependencies(stackOverride = stack): CloudLifecycleDependencies {
  return {
    getAccountId: vi.fn(async () => profile.awsAccountId),
    getStack: vi.fn(async () => stackOverride),
    deployStack: vi.fn(async () => ({
      ...stackOverride,
      parameters: { ...stackOverride.parameters, ImageUri: 'repo@sha256:new' },
    })),
    getRegistryCredentials: vi.fn(async () => ({ username: 'AWS', password: 'token' })),
    mirror: vi.fn(async () => ({
      imageUri: 'repo@sha256:new',
      digest: 'sha256:new',
      uploadedBlobs: 1,
      reusedBlobs: 0,
    })),
    writeBaseConfigIfAbsent: vi.fn(),
    updateBaseConfigBoundary: vi.fn(),
    getSecret: vi.fn(),
    getBootstrapStatus: vi.fn(async () => ({ initialized: true })),
    mintApiKey: vi.fn(),
    writeProfile: vi.fn(),
    sleep: vi.fn(),
    log: vi.fn(),
    destroyEdge: vi.fn(),
    deleteStack: vi.fn(),
  };
}

describe('CloudFormation lifecycle', () => {
  it('starts and watches the in-server route while reporting before/after server versions', async () => {
    const terminal = selfUpdateJob('succeeded');
    const client = {
      getClusterInfo: vi
        .fn()
        .mockResolvedValueOnce({ success: true, data: { serverVersion: '1.57.0' } })
        .mockResolvedValueOnce({ success: true, data: { serverVersion: '1.58.0' } }),
      selfUpdate: {
        start: vi.fn(async () => ({
          success: true as const,
          data: { httpStatus: 202 as const, jobId: terminal.jobId, status: 'queued' as const, statusUrl: '/job' },
        })),
        watch: vi.fn(async (_jobId: string, options: { onPhase?: (job: SelfUpdatePublicJob) => void }) => {
          options.onPhase?.(terminal);
          return { success: true as const, data: terminal };
        }),
      },
    };
    const onPhase = vi.fn();
    await expect(
      runCloudRouteUpdate(
        {
          targetDigest: terminal.target.digest,
          release: { payload: {} as never, envelope: {} as never },
          idempotencyKey: 'once',
          onPhase,
        },
        client as never
      )
    ).resolves.toMatchObject({
      outcome: 'terminal',
      previousServerVersion: '1.57.0',
      currentServerVersion: '1.58.0',
      job: terminal,
    });
    expect(client.selfUpdate.start).toHaveBeenCalledOnce();
    expect(onPhase).toHaveBeenCalledWith(terminal);
  });

  it('returns a live-lease conflict without polling', async () => {
    const client = {
      getClusterInfo: vi.fn(async () => ({ success: true, data: { serverVersion: '1.57.0' } })),
      selfUpdate: {
        start: vi.fn(async () => ({
          success: true as const,
          data: { httpStatus: 409 as const, jobId: 'existing', statusUrl: '/api/v1/self-update/existing' },
        })),
        watch: vi.fn(),
      },
    };
    const result = await runCloudRouteUpdate(
      { targetDigest: `sha256:${'a'.repeat(64)}`, release: {} as never, idempotencyKey: 'once' },
      client as never
    );
    expect(result).toMatchObject({
      outcome: 'conflict',
      jobId: 'existing',
      statusUrl: '/api/v1/self-update/existing',
      start: { jobId: 'existing' },
    });
    expect(client.selfUpdate.watch).not.toHaveBeenCalled();
  });

  it('follows an existing job without starting another one', async () => {
    const terminal = selfUpdateJob('failed');
    const client = {
      getClusterInfo: vi.fn(async () => ({ success: true, data: { serverVersion: '1.57.0' } })),
      selfUpdate: {
        start: vi.fn(),
        watch: vi.fn(async () => ({ success: true as const, data: terminal })),
      },
    };
    await runCloudRouteUpdate({ followJobId: terminal.jobId }, client as never);
    expect(client.selfUpdate.start).not.toHaveBeenCalled();
    expect(client.selfUpdate.watch).toHaveBeenCalledWith(terminal.jobId, expect.any(Object));
  });

  it('mirrors, updates the one shared ImageUri, then health-checks', async () => {
    const deps = dependencies();
    await runCloudSystemUpdate({ profile, installationName: 'prod', sourceImage: 'ghcr.io/appliance/api:v2' }, deps);
    expect(deps.mirror).toHaveBeenCalledOnce();
    expect(deps.deployStack).toHaveBeenCalledWith(
      expect.objectContaining({ imageUri: 'repo@sha256:new', architecture: 'x86_64' })
    );
    expect(deps.updateBaseConfigBoundary).toHaveBeenCalledWith(
      'data',
      'system/base-config.json',
      'arn:aws:iam::111111111111:policy/appliance-system/prod-user-appliance-boundary'
    );
    expect(vi.mocked(deps.updateBaseConfigBoundary).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.getBootstrapStatus).mock.invocationCallOrder[0]!
    );
    expect(deps.getBootstrapStatus).toHaveBeenCalledWith(profile.apiUrl);
    expect(deps.updateBaseConfigBoundary).toHaveBeenCalledWith(
      'data',
      'system/base-config.json',
      'arn:aws:iam::111111111111:policy/appliance-system/prod-user-appliance-boundary'
    );
  });

  it('documents the previous digest when post-update health fails', async () => {
    const deps = dependencies();
    vi.mocked(deps.getBootstrapStatus).mockRejectedValue(new Error('offline'));
    await expect(
      runCloudSystemUpdate({ profile, installationName: 'prod', healthTimeoutMs: 1, healthPollMs: 0 }, deps)
    ).rejects.toThrow(/repo@sha256:old/);
  });

  it('system image updates preserve an explicit admin escape hatch', async () => {
    const deps = dependencies();
    vi.mocked(deps.getStack).mockResolvedValue({
      ...stack,
      parameters: { ...stack.parameters, SystemRoleMode: 'admin' },
    });
    await runCloudSystemUpdate({ profile, installationName: 'prod' }, deps);
    expect(deps.deployStack).toHaveBeenCalledWith(expect.objectContaining({ systemRoleMode: 'admin' }));
  });

  it('updates a pre-CU0 stack before requiring the new boundary output', async () => {
    const deps = dependencies();
    vi.mocked(deps.getStack).mockResolvedValue(preCu0Stack());

    await runCloudSystemUpdate({ profile, installationName: 'prod' }, deps);

    expect(deps.deployStack).toHaveBeenCalledOnce();
    expect(deps.updateBaseConfigBoundary).toHaveBeenCalledWith(
      'data',
      'system/base-config.json',
      'arn:aws:iam::111111111111:policy/appliance-system/prod-user-appliance-boundary'
    );
  });

  it('baseline update preserves ImageUri and passes the selected role mode', async () => {
    const deps = dependencies();
    await runCloudBaselineUpdate({ profile, installationName: 'prod', systemRoleMode: 'admin' }, deps);
    expect(deps.deployStack).toHaveBeenCalledWith({
      stackName: profile.cloudFormationStackName,
      installationName: 'prod',
      imageUri: 'repo@sha256:old',
      architecture: 'x86_64',
      systemRoleMode: 'admin',
      preserveParameters: true,
    });
    expect(deps.getBootstrapStatus).toHaveBeenCalledWith(profile.apiUrl);
  });

  it('baseline update preserves the stack role mode with UsePreviousValue when the flag is omitted', async () => {
    const deps = dependencies();
    vi.mocked(deps.getStack).mockResolvedValue({
      ...stack,
      parameters: { ...stack.parameters, SystemRoleMode: 'admin' },
    });
    await runCloudBaselineUpdate({ profile, installationName: 'prod' }, deps);
    expect(deps.deployStack).toHaveBeenCalledWith(expect.objectContaining({ preserveParameters: true }));
    expect(deps.deployStack).toHaveBeenCalledWith(expect.not.objectContaining({ systemRoleMode: expect.anything() }));
  });

  it('lets the baseline parameter builder default legacy stacks without SystemRoleMode to scoped', async () => {
    const deps = dependencies();
    await runCloudBaselineUpdate({ profile, installationName: 'prod' }, deps);
    expect(deps.deployStack).toHaveBeenCalledWith(expect.objectContaining({ preserveParameters: true }));
    expect(deps.deployStack).toHaveBeenCalledWith(expect.not.objectContaining({ systemRoleMode: expect.anything() }));
  });

  it('passes a scheduled self-update policy through the operator baseline path', async () => {
    const deps = dependencies();
    await runCloudBaselineUpdate({ profile, installationName: 'prod', selfUpdatePolicy: 'notify' }, deps);
    expect(deps.deployStack).toHaveBeenCalledWith(
      expect.objectContaining({ selfUpdatePolicy: 'notify', preserveParameters: true, imageUri: 'repo@sha256:old' })
    );
  });

  it.each(['notify', 'auto'] as const)('refuses policy %s while system roles are admin', async (selfUpdatePolicy) => {
    const deps = dependencies({
      ...stack,
      parameters: { ...stack.parameters, SystemRoleMode: 'admin' },
    });
    await expect(runCloudBaselineUpdate({ profile, selfUpdatePolicy }, deps)).rejects.toThrow(
      'appliance cloud baseline-update --system-role-mode scoped'
    );
    expect(deps.deployStack).not.toHaveBeenCalled();
  });

  it('baseline update reports the admin recovery command when post-update health fails', async () => {
    const deps = dependencies();
    vi.mocked(deps.getBootstrapStatus).mockRejectedValue(new Error('AccessDenied'));
    await expect(
      runCloudBaselineUpdate({ profile, installationName: 'prod', healthTimeoutMs: 1, healthPollMs: 0 }, deps)
    ).rejects.toThrow('baseline-update --system-role-mode admin --yes');
    expect(deps.deployStack).toHaveBeenCalledOnce();
  });

  it('destroys edge before CFN and reports retained resources', async () => {
    const deps = dependencies();
    const order: string[] = [];
    vi.mocked(deps.destroyEdge).mockImplementation(async () => void order.push('edge'));
    vi.mocked(deps.deleteStack).mockImplementation(async () => void order.push('cfn'));
    const result = await runCloudTeardown(profile, deps);
    expect(order).toEqual(['edge', 'cfn']);
    expect(result.retained).toEqual([
      { kind: 'state bucket', value: 'state' },
      { kind: 'data bucket', value: 'data' },
      { kind: 'KMS key', value: 'arn:kms' },
      { kind: 'ECR repository', value: stack.outputs.ImageRepositoryUrl },
    ]);
  });

  it('tears down a pre-CU0 stack without requiring the boundary output', async () => {
    const deps = dependencies();
    vi.mocked(deps.getStack).mockResolvedValue(preCu0Stack());

    await expect(runCloudTeardown(profile, deps)).resolves.toMatchObject({ retained: expect.any(Array) });
    expect(deps.deleteStack).toHaveBeenCalledOnce();
  });

  it('never starts CFN deletion until resumable edge destruction has converged', async () => {
    const deps = dependencies();
    let finishEdge!: () => void;
    vi.mocked(deps.destroyEdge).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishEdge = resolve;
        })
    );

    const teardown = runCloudTeardown(profile, deps);
    await vi.waitFor(() => expect(deps.destroyEdge).toHaveBeenCalledOnce());
    expect(deps.deleteStack).not.toHaveBeenCalled();
    finishEdge();
    await teardown;
    expect(deps.deleteStack).toHaveBeenCalledOnce();
  });

  it('refuses a legacy profile before mutating AWS', async () => {
    const deps = dependencies();
    await expect(runCloudTeardown({ ...profile, installGeneration: undefined } as never, deps)).rejects.toThrow(
      /legacy Pulumi/
    );
    expect(deps.destroyEdge).not.toHaveBeenCalled();
  });
});

function selfUpdateJob(status: 'succeeded' | 'failed'): SelfUpdatePublicJob {
  return {
    jobId: 'selfupdate_1',
    status,
    phase: 'complete',
    target: {
      digest: `sha256:${'a'.repeat(64)}`,
      version: '1.58.0',
      generation: 2,
      source: `ghcr.io/lab255/appliance-api-server@sha256:${'a'.repeat(64)}`,
    },
    timestamps: {
      createdAt: '2026-08-30T00:00:00Z',
      updatedAt: '2026-08-30T00:01:00Z',
      heartbeatAt: '2026-08-30T00:01:00Z',
      leaseExpiresAt: '2026-08-30T00:02:00Z',
    },
  };
}
