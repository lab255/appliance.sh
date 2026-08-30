import { describe, expect, it, vi } from 'vitest';
import type { SelfUpdatePublicJob } from '@appliance.sh/sdk';
import { runDesktopCloudSelfUpdate, selfUpdatePhaseMessage, selfUpdateTerminalError } from './self-update-ui';

describe('desktop self-update panel states', () => {
  it.each([
    ['mirroring', 'Mirroring'],
    ['waiting-for-stack', 'Updating'],
    ['probing-health', 'Checking'],
  ] as const)('renders the running %s state', (phase, label) => {
    expect(selfUpdatePhaseMessage(job({ phase, status: 'running' }))).toContain(label);
  });

  it('renders recovered and exhausted failures distinctly', () => {
    const recovered = job({ status: 'failed', phase: 'complete', recovered: true, recoveryState: 'recovered' });
    expect(selfUpdatePhaseMessage(recovered)).toContain('re-pinned and is healthy');
    expect(selfUpdateTerminalError(recovered)).toContain('passed health checks');
    expect(
      selfUpdateTerminalError(
        job({ status: 'failed', phase: 'complete', recovered: false, recoveryState: 'exhausted' })
      )
    ).toContain('appliance cloud update --local');
  });

  it('renders the successful terminal result', () => {
    expect(selfUpdatePhaseMessage(job({ status: 'succeeded', phase: 'complete' }))).toBe(
      'Updated successfully to 1.58.0'
    );
  });

  it.each([202, 409] as const)(
    'starts through the SDK and watches the %s job without a sidecar',
    async (httpStatus) => {
      const terminal = job({ status: 'succeeded', phase: 'complete' });
      const client = {
        selfUpdate: {
          start: vi.fn(async () => ({
            success: true as const,
            data:
              httpStatus === 202
                ? { httpStatus, jobId: terminal.jobId, status: 'queued' as const, statusUrl: '/job' }
                : { httpStatus, jobId: terminal.jobId, statusUrl: '/job' },
          })),
          watch: vi.fn(async () => ({ success: true as const, data: terminal })),
        },
      };
      const resolveEvidence = vi.fn(async () => ({
        version: '1.58.0',
        targetDigest: terminal.target.digest,
        release: { payload: {} as never, envelope: {} as never },
      }));

      const result = await runDesktopCloudSelfUpdate(client as never, '1.58.0', {
        idempotencyKey: 'desktop-once',
        resolveEvidence,
      });

      expect(client.selfUpdate.start).toHaveBeenCalledWith(
        expect.objectContaining({ targetDigest: terminal.target.digest, idempotencyKey: 'desktop-once' })
      );
      expect(client.selfUpdate.watch).toHaveBeenCalledWith(terminal.jobId, expect.any(Object));
      expect(result).toMatchObject({ job: terminal });
      expect(result.existingStatusUrl).toBe(httpStatus === 409 ? '/job' : undefined);
    }
  );
});

function job(overrides: Partial<SelfUpdatePublicJob>): SelfUpdatePublicJob {
  return {
    jobId: 'selfupdate_1',
    status: 'running',
    phase: 'queued',
    target: { digest: `sha256:${'a'.repeat(64)}`, version: '1.58.0', generation: 2, source: 'ghcr.io/x@y' },
    timestamps: { createdAt: '', updatedAt: '', heartbeatAt: '', leaseExpiresAt: '' },
    error: 'target health check failed.',
    ...overrides,
  };
}
