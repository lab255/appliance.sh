import { describe, expect, it, vi } from 'vitest';
import { runtimePsRows, type RuntimeStatusBackend } from './runtime-reconcile.js';
import type { RuntimeRecord } from './runtime-registry.js';

function record(appId: string, state: RuntimeRecord['state']): RuntimeRecord {
  return {
    appId,
    version: '1.0.0',
    state,
    principalIp: '192.168.127.10',
    hostPorts: [],
    startedAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    poolVm: 'appliance-runtime',
    poolRestartPending: false,
    bundlePath: `/apps/${appId}.appliance.zip`,
    installDir: `/runtime/${appId}`,
    shareTag: `ap-${appId}`,
    uid: 20000,
  };
}

describe('runtime ps reconciliation', () => {
  it('prunes missing rows and retains exited service and exit-code detail', () => {
    const backend: RuntimeStatusBackend = {
      poolRunning: vi.fn(() => true),
      appStatus: vi.fn((_pool, appId) =>
        appId === 'gone'
          ? { state: 'missing' }
          : { state: 'exited', exitCode: 17, services: [{ name: 'worker', state: 'exited' }] }
      ),
    };
    const rows = runtimePsRows(
      [record('gone', 'running'), record('finished', 'exited')],
      backend,
      '2026-08-29T01:00:00.000Z'
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.record).toMatchObject({ appId: 'finished', state: 'exited', exitCode: 17 });
    expect(rows[0]?.status?.services).toEqual([{ name: 'worker', state: 'exited' }]);
    expect(backend.appStatus).toHaveBeenCalledWith('appliance-runtime', 'finished');
  });
});
