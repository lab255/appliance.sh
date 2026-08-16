import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentAction, DeploymentStatus, EnvironmentStatus, type Deployment } from '@appliance.sh/sdk';

const mocks = vi.hoisted(() => ({
  records: new Map<string, Deployment>(),
  convergeEdge: vi.fn(),
  destroyEdge: vi.fn(),
  deploy: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  environmentUpdate: vi.fn(),
}));

vi.mock('@appliance.sh/infra', () => ({
  createApplianceDeploymentService: vi.fn(() => ({
    convergeEdge: mocks.convergeEdge,
    destroyEdge: mocks.destroyEdge,
    deploy: mocks.deploy,
  })),
}));
vi.mock('./storage.service', () => ({
  getStorageService: () => ({
    get: vi.fn(async (_collection: string, id: string) => mocks.records.get(id) ?? null),
    set: vi.fn(async (_collection: string, id: string, value: Deployment) => {
      mocks.records.set(id, structuredClone(value));
    }),
  }),
}));
vi.mock('./environment.service', () => ({ environmentService: { updateStatus: mocks.environmentUpdate } }));
vi.mock('./build.service', () => ({ buildService: { resolve: vi.fn() } }));
vi.mock('./tenant-context', () => ({
  DEFAULT_TENANT: 'default',
  getCurrentTenant: () => null,
  runWithTenant: (_tenant: string, fn: () => unknown) => fn(),
}));
vi.mock('./base-config.service', () => ({
  resolveBaseConfig: vi.fn(async () => BASE_CONFIG),
  runWithBaseConfig: (_config: unknown, fn: () => unknown) => fn(),
}));
vi.mock('./base-config-writer.service', () => ({
  attachEdgeBaseConfig: mocks.attach,
  detachEdgeBaseConfig: mocks.detach,
}));
vi.mock('./deployment-backend', () => ({
  readBaseConfig: () => BASE_CONFIG,
  resolveContainerBackend: () => null,
}));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { executeDeployment, type WorkerEvent } from './deployment-executor.service';

const BASE_CONFIG = {
  name: 'prod',
  type: 'appliance-base-aws-public',
  provisioner: 'cloudformation-v1',
  stateBackendUrl: 's3://state',
  aws: { region: 'us-east-1', dataBucketName: 'data' },
};
const EDGE_CONFIG = {
  ...BASE_CONFIG,
  domainName: 'example.com',
  aws: {
    ...BASE_CONFIG.aws,
    zoneId: 'Z1',
    certificateArn: 'arn:cert',
    cloudfrontDistributionId: 'DIST',
    cloudfrontDistributionDomainName: 'dist.cloudfront.net',
    edgeRouterRoleArn: 'arn:edge',
    apiServerPublicUrl: 'https://api.example.com',
  },
};

const edgeEvent = (attempt: number): WorkerEvent => ({
  deploymentId: 'dep-edge',
  input: {
    environmentId: 'env-edge',
    action: DeploymentAction.Deploy,
    target: { type: 'edge', domainName: 'example.com', zone: { mode: 'create' } },
  },
  metadata: {
    projectId: 'project-edge',
    projectName: 'appliance-system',
    environmentId: 'env-edge',
    environmentName: 'edge',
    deploymentId: 'dep-edge',
    stackName: 'edge-stack',
  },
  edgeAttempt: attempt,
});

function edgeDeployment(): Deployment {
  return {
    id: 'dep-edge',
    environmentId: 'env-edge',
    projectId: 'project-edge',
    action: DeploymentAction.Deploy,
    target: { type: 'edge', domainName: 'example.com', zone: { mode: 'create' } },
    status: DeploymentStatus.Pending,
    startedAt: new Date().toISOString(),
    edgeConvergence: { state: 'running', attempt: 1 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.records.clear();
  mocks.attach.mockResolvedValue(EDGE_CONFIG);
  mocks.detach.mockResolvedValue(BASE_CONFIG);
  mocks.environmentUpdate.mockResolvedValue(undefined);
});

describe('edge worker convergence', () => {
  it('converges across N invocations and publishes epoch 2 only after no changes', async () => {
    mocks.records.set('dep-edge', edgeDeployment());
    mocks.convergeEdge
      .mockResolvedValueOnce({
        converged: false,
        message: 'resources changed',
        idempotentNoop: false,
        baseConfig: EDGE_CONFIG,
      })
      .mockResolvedValueOnce({
        converged: false,
        message: 'soft deadline',
        idempotentNoop: false,
      })
      .mockResolvedValueOnce({
        converged: true,
        message: 'verified no changes',
        idempotentNoop: true,
        url: 'https://api.example.com',
        baseConfig: EDGE_CONFIG,
      });

    expect(await executeDeployment(edgeEvent(1))).toBe('continue');
    expect(mocks.records.get('dep-edge')?.status).toBe(DeploymentStatus.InProgress);
    expect(mocks.records.get('dep-edge')?.edgeConvergence).toEqual({ state: 'ready', attempt: 1 });
    expect(mocks.attach).not.toHaveBeenCalled();

    mocks.records.get('dep-edge')!.edgeConvergence = { state: 'running', attempt: 2 };
    expect(await executeDeployment(edgeEvent(2))).toBe('continue');
    expect(mocks.attach).not.toHaveBeenCalled();

    mocks.records.get('dep-edge')!.edgeConvergence = { state: 'running', attempt: 3 };
    expect(await executeDeployment(edgeEvent(3))).toBe('complete');
    expect(mocks.attach).toHaveBeenCalledTimes(1);
    expect(mocks.records.get('dep-edge')).toMatchObject({
      status: DeploymentStatus.Succeeded,
      edgeConvergence: { state: 'converged', attempt: 3 },
    });
    expect(mocks.environmentUpdate).toHaveBeenLastCalledWith('env-edge', EnvironmentStatus.Deployed, {
      url: 'https://api.example.com',
    });
  });

  it('preserves cancel polling during an active edge pass', async () => {
    vi.useFakeTimers();
    try {
      mocks.records.set('dep-edge', edgeDeployment());
      const stack = { cancel: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) };
      let rejectPass!: (error: Error) => void;
      mocks.convergeEdge.mockImplementationOnce(
        async (_stackName: string, _target: unknown, opts: { onStack(stack: typeof stack): void }) => {
          opts.onStack(stack);
          await new Promise<never>((_resolve, reject) => {
            rejectPass = reject;
            stack.cancel.mockImplementation(async () => rejectPass(new Error('cancelled')));
          });
        }
      );
      const running = executeDeployment(edgeEvent(1));
      await vi.waitFor(() => expect(mocks.convergeEdge).toHaveBeenCalled());
      mocks.records.get('dep-edge')!.status = DeploymentStatus.Cancelling;
      await vi.advanceTimersByTimeAsync(3000);
      expect(await running).toBe('complete');
      expect(stack.cancel).toHaveBeenCalledTimes(1);
      expect(stack.refresh).toHaveBeenCalledTimes(1);
      expect(mocks.records.get('dep-edge')?.status).toBe(DeploymentStatus.Cancelled);
      expect(mocks.attach).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('converges an edge destroy across N bounded worker invocations before restoring epoch 1', async () => {
    const deployment = edgeDeployment();
    deployment.action = DeploymentAction.Destroy;
    mocks.records.set('dep-edge', deployment);
    mocks.destroyEdge
      .mockResolvedValueOnce({ converged: false, message: 'delete pass 1', idempotentNoop: false })
      .mockResolvedValueOnce({ converged: false, message: 'delete pass 2', idempotentNoop: false })
      .mockResolvedValueOnce({ converged: true, message: 'no resources remain', idempotentNoop: true });

    const event = (attempt: number): WorkerEvent => ({
      ...edgeEvent(attempt),
      input: { ...edgeEvent(attempt).input, action: DeploymentAction.Destroy },
    });

    expect(await executeDeployment(event(1))).toBe('continue');
    expect(mocks.detach).not.toHaveBeenCalled();
    mocks.records.get('dep-edge')!.edgeConvergence = { state: 'running', attempt: 2 };
    expect(await executeDeployment(event(2))).toBe('continue');
    expect(mocks.detach).not.toHaveBeenCalled();
    mocks.records.get('dep-edge')!.edgeConvergence = { state: 'running', attempt: 3 };
    expect(await executeDeployment(event(3))).toBe('complete');

    expect(mocks.destroyEdge).toHaveBeenCalledTimes(3);
    expect(mocks.detach).toHaveBeenCalledOnce();
    expect(mocks.records.get('dep-edge')).toMatchObject({
      status: DeploymentStatus.Succeeded,
      edgeConvergence: { state: 'converged', attempt: 3 },
    });
    expect(mocks.environmentUpdate).toHaveBeenLastCalledWith('env-edge', EnvironmentStatus.Destroyed, { url: null });
  });

  it('does not clobber a cancellation written while a bounded pass is yielding', async () => {
    mocks.records.set('dep-edge', edgeDeployment());
    mocks.convergeEdge.mockImplementationOnce(async () => {
      mocks.records.get('dep-edge')!.status = DeploymentStatus.Cancelling;
      return { converged: false, message: 'yielded', idempotentNoop: false };
    });

    expect(await executeDeployment(edgeEvent(1))).toBe('complete');
    expect(mocks.records.get('dep-edge')?.status).toBe(DeploymentStatus.Cancelled);
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it('leaves ordinary workloads on the single-invocation path', async () => {
    const deployment: Deployment = {
      id: 'dep-app',
      environmentId: 'env-app',
      projectId: 'project-app',
      action: DeploymentAction.Deploy,
      status: DeploymentStatus.Pending,
      startedAt: new Date().toISOString(),
    };
    mocks.records.set(deployment.id, deployment);
    mocks.deploy.mockResolvedValue({ message: 'deployed', idempotentNoop: false, url: 'https://app.example.com' });
    const event: WorkerEvent = {
      deploymentId: deployment.id,
      input: { environmentId: 'env-app', action: DeploymentAction.Deploy },
      metadata: {
        projectId: 'project-app',
        projectName: 'app',
        environmentId: 'env-app',
        environmentName: 'prod',
        deploymentId: deployment.id,
        stackName: 'app-prod',
      },
    };
    expect(await executeDeployment(event)).toBe('complete');
    expect(mocks.deploy).toHaveBeenCalledTimes(1);
    expect(mocks.convergeEdge).not.toHaveBeenCalled();
    expect(mocks.records.get(deployment.id)?.status).toBe(DeploymentStatus.Succeeded);
  });
});
