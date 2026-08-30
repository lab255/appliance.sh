import { describe, expect, it } from 'vitest';
import type { SelfUpdatePublicJob } from '@appliance.sh/sdk';
import { selfUpdatePhaseMessage, selfUpdateTerminalError } from './self-update-ui';

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
