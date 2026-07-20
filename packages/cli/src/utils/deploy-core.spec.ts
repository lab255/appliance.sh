import { afterEach, describe, expect, it, vi } from 'vitest';
import { warnIfNotHealthy } from './deploy-core.js';

// warnIfNotHealthy is the "Deployed must not be a lie" check: after a
// successful deploy it probes environment health and warns (with the
// exact logs command) when the app crashloops right away. These tests
// pin the three contract points: loud on unhealthy, quiet on healthy,
// and never failing the deploy on probe errors.

type HealthResult = { success: true; data: Record<string, unknown> } | { success: false; error: Error };

function clientReturning(...results: HealthResult[]) {
  let call = 0;
  return {
    getEnvironmentHealth: async () => results[Math.min(call++, results.length - 1)],
  } as never;
}

function health(status: string, extra: Record<string, unknown> = {}) {
  return {
    success: true as const,
    data: {
      environmentId: 'env-1',
      status,
      desiredReplicas: 1,
      readyReplicas: 0,
      restarts: 5,
      pods: [{ name: 'p', phase: 'Running', ready: false, restarts: 5, reason: 'CrashLoopBackOff' }],
      ...extra,
    },
  };
}

describe('warnIfNotHealthy', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns with the exact logs command when the workload crashloops', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await warnIfNotHealthy(clientReturning(health('unhealthy')), 'proj', 'env', 'demo', 'dev', {
      probes: 1,
      delayMs: 0,
    });
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('not staying up');
    expect(output).toContain('CrashLoopBackOff');
    expect(output).toContain('appliance logs demo dev');
  });

  it('stays silent when the workload is healthy', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await warnIfNotHealthy(
      clientReturning(health('healthy', { readyReplicas: 1, restarts: 0 })),
      'p',
      'e',
      'demo',
      'dev',
      {
        probes: 3,
        delayMs: 0,
      }
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('stays silent on non-Kubernetes bases (status unknown) and on probe errors', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await warnIfNotHealthy(clientReturning(health('unknown')), 'p', 'e', 'demo', 'dev', { probes: 1, delayMs: 0 });
    await warnIfNotHealthy(clientReturning({ success: false, error: new Error('409') }), 'p', 'e', 'demo', 'dev', {
      probes: 1,
      delayMs: 0,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('notes a still-rolling-out (degraded) workload without alarming', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await warnIfNotHealthy(
      clientReturning(health('degraded', { pods: [{ name: 'p', phase: 'Running', ready: false, restarts: 0 }] })),
      'p',
      'e',
      'demo',
      'dev',
      { probes: 2, delayMs: 0 }
    );
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Still starting');
    expect(output).toContain('appliance status');
  });
});
