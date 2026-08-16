import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplianceDeploymentService } from './ApplianceDeploymentService';

const baseConfig = {
  type: 'appliance-base-v1' as const,
  provisioner: 'cloudformation-v1' as const,
  name: 'test',
  stateBackendUrl: 's3://state',
  dataBucket: 'data',
  aws: {
    region: 'us-east-1',
    accountId: '123456789012',
    stateBucketName: 'state',
    stateBucketArn: 'arn:aws:s3:::state',
    dataBucketName: 'data',
    dataBucketArn: 'arn:aws:s3:::data',
    kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/test',
    kmsAlias: 'alias/test',
    ecrRepositoryUrl: '123456789012.dkr.ecr.us-east-1.amazonaws.com/test',
    systemFunctions: {
      apiServerArn: 'arn:aws:lambda:us-east-1:123456789012:function:api',
      apiServerUrl: 'https://api.lambda-url.us-east-1.on.aws/',
      workerArn: 'arn:aws:lambda:us-east-1:123456789012:function:worker',
      workerUrl: 'https://worker.lambda-url.us-east-1.on.aws/',
    },
    apiServerPublicUrl: 'https://api.lambda-url.us-east-1.on.aws/',
  },
};

const target = {
  type: 'edge' as const,
  domainName: 'example.com',
  zone: { id: 'Z123', name: 'example.com' },
};

describe('ApplianceDeploymentService edge convergence', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('requires a following no-change pass after applying changes', async () => {
    const service = new ApplianceDeploymentService({ baseConfig });
    const stack = {
      up: vi
        .fn()
        .mockResolvedValueOnce({
          summary: { resourceChanges: { update: 1, same: 3 } },
          outputs: { baseConfig: { value: baseConfig }, apiServerPublicUrl: { value: 'https://api.example.com' } },
        })
        .mockResolvedValueOnce({
          summary: { resourceChanges: { same: 4 } },
          outputs: { baseConfig: { value: baseConfig }, apiServerPublicUrl: { value: 'https://api.example.com' } },
        }),
    };
    vi.spyOn(service as never, 'getOrCreateEdgeStack' as never).mockResolvedValue(stack as never);

    await expect(service.convergeEdge('appliance-system/edge', target)).resolves.toMatchObject({ converged: false });
    await expect(service.convergeEdge('appliance-system/edge', target)).resolves.toMatchObject({ converged: true });
  });

  it('cancels before the Lambda deadline and refreshes persisted state', async () => {
    vi.useFakeTimers();
    const service = new ApplianceDeploymentService({ baseConfig });
    let rejectUp: (error: Error) => void = () => undefined;
    const stack = {
      up: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectUp = reject;
          })
      ),
      cancel: vi.fn(async () => rejectUp(new Error('cancelled by soft deadline'))),
      refresh: vi.fn(async () => ({ summary: { resourceChanges: {} } })),
    };
    vi.spyOn(service as never, 'getOrCreateEdgeStack' as never).mockResolvedValue(stack as never);

    const pass = service.convergeEdge('appliance-system/edge', target, { softDeadlineMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(pass).resolves.toMatchObject({ converged: false, ok: true });
    expect(stack.cancel).toHaveBeenCalledOnce();
    expect(stack.refresh).toHaveBeenCalledOnce();
  });

  it('requires a following no-resource pass after deleting edge resources', async () => {
    const service = new ApplianceDeploymentService({ baseConfig });
    const stack = {
      destroy: vi
        .fn()
        .mockResolvedValueOnce({ summary: { resourceChanges: { delete: 8 } } })
        .mockResolvedValueOnce({ summary: { resourceChanges: {} } }),
    };
    vi.spyOn(service as never, 'selectExistingStack' as never).mockResolvedValue(stack as never);

    await expect(service.destroyEdge('appliance-system/edge')).resolves.toMatchObject({ converged: false });
    await expect(service.destroyEdge('appliance-system/edge')).resolves.toMatchObject({ converged: true });
  });
});
