import { describe, expect, it, vi } from 'vitest';
import {
  runCloudBaselineUpdate,
  runCloudSystemUpdate,
  runCloudTeardown,
  type CloudLifecycleDependencies,
} from './cloud-lifecycle.js';

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
    ApiServerFunctionName: 'api',
    ApiServerFunctionArn: 'arn:api',
    ApiServerFunctionUrl: profile.apiUrl,
    WorkerFunctionName: 'worker',
    WorkerFunctionArn: 'arn:worker',
    WorkerFunctionUrl: 'https://worker.example',
  },
};

function dependencies(): CloudLifecycleDependencies {
  return {
    getAccountId: vi.fn(async () => profile.awsAccountId),
    getStack: vi.fn(async () => stack),
    deployStack: vi.fn(async () => ({ ...stack, parameters: { ...stack.parameters, ImageUri: 'repo@sha256:new' } })),
    getRegistryCredentials: vi.fn(async () => ({ username: 'AWS', password: 'token' })),
    mirror: vi.fn(async () => ({
      imageUri: 'repo@sha256:new',
      digest: 'sha256:new',
      uploadedBlobs: 1,
      reusedBlobs: 0,
    })),
    writeBaseConfigIfAbsent: vi.fn(),
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
  it('mirrors, updates the one shared ImageUri, then health-checks', async () => {
    const deps = dependencies();
    await runCloudSystemUpdate({ profile, installationName: 'prod', sourceImage: 'ghcr.io/appliance/api:v2' }, deps);
    expect(deps.mirror).toHaveBeenCalledOnce();
    expect(deps.deployStack).toHaveBeenCalledWith(
      expect.objectContaining({ imageUri: 'repo@sha256:new', architecture: 'x86_64' })
    );
    expect(deps.getBootstrapStatus).toHaveBeenCalledWith(profile.apiUrl);
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

  it('baseline update preserves ImageUri and passes the selected role mode', async () => {
    const deps = dependencies();
    await runCloudBaselineUpdate({ profile, installationName: 'prod', systemRoleMode: 'admin' }, deps);
    expect(deps.deployStack).toHaveBeenCalledWith({
      stackName: profile.cloudFormationStackName,
      installationName: 'prod',
      imageUri: 'repo@sha256:old',
      architecture: 'x86_64',
      systemRoleMode: 'admin',
    });
    expect(deps.getBootstrapStatus).toHaveBeenCalledWith(profile.apiUrl);
  });

  it('baseline update preserves the stack role mode when the flag is omitted', async () => {
    const deps = dependencies();
    vi.mocked(deps.getStack).mockResolvedValue({
      ...stack,
      parameters: { ...stack.parameters, SystemRoleMode: 'admin' },
    });
    await runCloudBaselineUpdate({ profile, installationName: 'prod' }, deps);
    expect(deps.deployStack).toHaveBeenCalledWith(expect.objectContaining({ systemRoleMode: 'admin' }));
  });

  it('baseline update defaults legacy stacks without the parameter to scoped', async () => {
    const deps = dependencies();
    await runCloudBaselineUpdate({ profile, installationName: 'prod' }, deps);
    expect(deps.deployStack).toHaveBeenCalledWith(expect.objectContaining({ systemRoleMode: 'scoped' }));
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
