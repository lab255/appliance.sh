import { describe, expect, it } from 'vitest';
import type { SelfUpdatePublicJob } from '@appliance.sh/sdk';
import {
  cloudUpdateExitCode,
  cloudUpdateJson,
  createPhaseLineFormatter,
  phaseMessage,
  terminalFailureMessage,
} from './cloud-update-output.js';

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
    expect(terminalFailureMessage(failed)).toContain('may still be running the failed image');
  });

  it('prints cyan-ready phase lines with completed duration and live elapsed time', () => {
    const format = createPhaseLineFormatter(() => Date.parse('2026-08-30T00:00:40Z'));
    expect(
      format(
        job({
          phase: 'mirroring',
          timestamps: timestamps('2026-08-30T00:00:00Z'),
        })
      )
    ).toEqual(['» mirror: copying the signed image digest into private ECR (40s elapsed)']);
    expect(
      format(
        job({
          phase: 'waiting-for-stack',
          phaseDurationsMs: { mirroring: 28_000 },
          timestamps: timestamps('2026-08-30T00:00:00Z'),
        })
      )
    ).toEqual([
      '» mirror: copying the signed image digest into private ECR (28s)',
      '» updating: waiting for CloudFormation (40s elapsed)',
    ]);
  });

  it('pins the terminal JSON acceptance artifact top-level shape and explicit totalMs', () => {
    const terminal = job({
      status: 'succeeded',
      phase: 'complete',
      totalMs: 123_000,
      resumeCount: 0,
      phaseDurationsMs: { mirroring: 28_000, 'waiting-for-stack': 70_000, 'probing-health': 15_000 },
    });
    const parsed = JSON.parse(
      cloudUpdateJson({
        outcome: 'terminal',
        job: terminal,
        previousServerVersion: '1.57.0',
        currentServerVersion: '1.58.0',
      })
    ) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['outcome', 'job', 'previousServerVersion', 'currentServerVersion']);
    expect(parsed.job).toMatchObject({ totalMs: 123_000, resumeCount: 0 });
  });

  it('uses exit 3 for conflicts and exit 1 only for terminal failures', () => {
    expect(
      cloudUpdateExitCode({
        outcome: 'conflict',
        jobId: 'existing',
        statusUrl: '/api/v1/self-update/existing',
        start: { httpStatus: 409, jobId: 'existing', statusUrl: '/api/v1/self-update/existing' },
      })
    ).toBe(3);
    expect(cloudUpdateExitCode({ outcome: 'terminal', job: job({ status: 'failed', phase: 'complete' }) })).toBe(1);
    expect(
      cloudUpdateExitCode({ outcome: 'terminal', job: job({ status: 'succeeded', phase: 'complete' }) })
    ).toBeUndefined();
  });

  it('pins the conflict JSON acceptance artifact top-level shape', () => {
    const parsed = JSON.parse(
      cloudUpdateJson({
        outcome: 'conflict',
        jobId: 'existing',
        statusUrl: '/api/v1/self-update/existing',
        start: { httpStatus: 409, jobId: 'existing', statusUrl: '/api/v1/self-update/existing' },
        previousServerVersion: '1.57.0',
      })
    ) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['outcome', 'jobId', 'statusUrl', 'start', 'previousServerVersion']);
  });
});

function timestamps(startedAt: string): SelfUpdatePublicJob['timestamps'] {
  return {
    createdAt: startedAt,
    startedAt,
    updatedAt: startedAt,
    heartbeatAt: startedAt,
    leaseExpiresAt: startedAt,
  };
}

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
