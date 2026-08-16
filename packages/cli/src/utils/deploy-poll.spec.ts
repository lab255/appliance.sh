import { describe, expect, it, vi } from 'vitest';
import { DeploymentAction, DeploymentStatus } from '@appliance.sh/sdk';
import { pollDeploymentUntilDone } from './deploy-poll';

function edgeDeployment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deployment-1',
    projectId: 'appliance-system',
    environmentId: 'edge',
    action: DeploymentAction.Deploy,
    target: { type: 'edge', domainName: 'example.com', zone: { id: 'Z123', name: 'example.com' } },
    status: DeploymentStatus.InProgress,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    edgeConvergence: { state: 'ready', attempt: 1 },
    ...overrides,
  };
}

describe('pollDeploymentUntilDone', () => {
  it('re-dispatches a ready edge pass and waits for terminal success', async () => {
    const client = {
      getDeployment: vi
        .fn()
        .mockResolvedValueOnce({ success: true, data: edgeDeployment() })
        .mockResolvedValueOnce({
          success: true,
          data: edgeDeployment({
            status: DeploymentStatus.Succeeded,
            edgeConvergence: { state: 'converged', attempt: 2 },
          }),
        }),
      continueDeployment: vi.fn().mockResolvedValue({ success: true, data: edgeDeployment() }),
    };

    const result = await pollDeploymentUntilDone(client as never, 'deployment-1', {
      intervalMs: 0,
      timeoutMs: 1000,
    });

    expect(client.continueDeployment).toHaveBeenCalledExactlyOnceWith('deployment-1');
    expect(result.terminal).toBe(DeploymentStatus.Succeeded);
  });

  it('does not re-dispatch ordinary workload deployments', async () => {
    const client = {
      getDeployment: vi.fn().mockResolvedValue({
        success: true,
        data: edgeDeployment({
          target: undefined,
          status: DeploymentStatus.Succeeded,
          edgeConvergence: undefined,
        }),
      }),
      continueDeployment: vi.fn(),
    };

    await pollDeploymentUntilDone(client as never, 'deployment-1', { intervalMs: 0, timeoutMs: 1000 });
    expect(client.continueDeployment).not.toHaveBeenCalled();
  });
});
