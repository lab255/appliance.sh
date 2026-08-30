import { describe, expect, it } from 'vitest';
import type { SelfUpdatePublicJob } from '@appliance.sh/sdk';
import { phaseMessage, terminalFailureMessage } from './cloud-update-output.js';

describe('cloud update UX copy', () => {
  it('maps route phases to operator-facing mirror/update/health progress', () => {
    expect(phaseMessage(job({ phase: 'mirroring', status: 'running' }))).toContain('mirror:');
    expect(phaseMessage(job({ phase: 'waiting-for-stack', status: 'running' }))).toContain('updating:');
    expect(phaseMessage(job({ phase: 'probing-health', status: 'running' }))).toContain('health:');
  });

  it('reports a successful re-pin after a failed target', () => {
    const failed = job({ phase: 'complete', status: 'failed', recovered: true, recoveryState: 'recovered' });
    expect(phaseMessage(failed)).toContain('previous image was re-pinned');
    expect(terminalFailureMessage(failed)).toContain('passed health checks');
  });

  it('points exhausted recovery at the explicit local break-glass path', () => {
    const failed = job({ phase: 'complete', status: 'failed', recovered: false, recoveryState: 'exhausted' });
    expect(terminalFailureMessage(failed)).toContain('appliance cloud update --local');
  });
});

function job(overrides: Partial<SelfUpdatePublicJob>): SelfUpdatePublicJob {
  return {
    jobId: 'selfupdate_1',
    status: 'running',
    phase: 'queued',
    target: { digest: `sha256:${'a'.repeat(64)}`, version: '1.58.0', generation: 2, source: 'ghcr.io/x@y' },
    timestamps: { createdAt: '', updatedAt: '', heartbeatAt: '', leaseExpiresAt: '' },
    error: 'target health/version probe failed',
    ...overrides,
  };
}
