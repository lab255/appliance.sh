import { describe, expect, it, vi } from 'vitest';
import type { ApplianceV2 } from '@appliance.sh/sdk';
import {
  reconcileAndStartRuntimeOpen,
  routeRuntimeOpen,
  runtimeOpenJson,
  runtimeOpenUrl,
  runtimeUiPortName,
  type RuntimeOpenBackend,
  type RuntimeOpenDependencies,
  type RuntimeOpenDescriptor,
} from './appliance-runtime-open';
import type { RuntimeRecord } from './utils/runtime-registry';

const descriptor: RuntimeOpenDescriptor = {
  appId: 'journal',
  target: 'local',
  name: 'Journal',
  version: '1.2.0',
  license: 'MIT',
  ui: { type: 'web', port: 'web', path: '/' },
  state: 'running',
  url: 'http://127.0.0.1:20421/',
  hostPort: 20421,
  egressHostCount: 2,
};

describe('runtime open routing', () => {
  it('uses desktop IPC when the desktop accepts the request', async () => {
    const sendDesktop = vi.fn().mockResolvedValue(true);
    const openBrowser = vi.fn();
    await expect(routeRuntimeOpen(descriptor, { sendDesktop, openBrowser })).resolves.toBe('desktop');
    expect(sendDesktop).toHaveBeenCalledWith(descriptor);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('falls back to the default browser when desktop is not running', async () => {
    const openBrowser = vi.fn();
    await expect(
      routeRuntimeOpen(descriptor, { sendDesktop: vi.fn().mockResolvedValue(false), openBrowser })
    ).resolves.toBe('browser');
    expect(openBrowser).toHaveBeenCalledWith(descriptor.url);
  });

  it('does not route apps without a web URL', async () => {
    await expect(
      routeRuntimeOpen(
        { ...descriptor, ui: { type: 'none' }, url: undefined },
        {
          sendDesktop: vi.fn(),
          openBrowser: vi.fn(),
        }
      )
    ).rejects.toThrow('has no web UI');
  });

  it('carries a machine-readable open metric context through desktop routing', async () => {
    const measured = { ...descriptor, openMetric: { kind: 'warm' as const, startedAtMs: 1_000 } };
    const sendDesktop = vi.fn().mockResolvedValue(true);
    await expect(routeRuntimeOpen(measured, { sendDesktop, openBrowser: vi.fn() })).resolves.toBe('desktop');
    expect(sendDesktop).toHaveBeenCalledWith(measured);
    expect(runtimeOpenJson(measured, 'desktop')).toMatchObject({
      route: 'desktop',
      metrics: { appOpenTtv: { kind: 'warm', startedAtMs: 1_000 } },
    });
  });
});

describe('runtime open reconciliation', () => {
  function record(state: RuntimeRecord['state'] = 'running'): RuntimeRecord {
    return {
      appId: 'journal',
      version: '1.2.0',
      state,
      principalIp: '192.168.127.10',
      hostPorts: [{ name: 'web', host: 20421, guest: 3000, protocol: 'tcp' }],
      startedAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
      poolVm: 'appliance-runtime',
      poolRestartPending: false,
      bundlePath: '/apps/journal.appliance.zip',
      installDir: '/runtime/journal',
      shareTag: 'ap-journal',
      uid: 20000,
    };
  }

  function fakeRuntime(
    poolRunning: boolean,
    appState: string | null
  ): {
    backend: RuntimeOpenBackend;
    dependencies: RuntimeOpenDependencies;
    updates: Array<Partial<RuntimeRecord>>;
    starts: Array<{ selector: string; target: string }>;
  } {
    let current = record();
    let currentDescriptor = { ...descriptor };
    const updates: Array<Partial<RuntimeRecord>> = [];
    const starts: Array<{ selector: string; target: string }> = [];
    const backend: RuntimeOpenBackend = {
      poolRunning: vi.fn(() => poolRunning),
      appStatus: vi.fn(() => (appState ? { state: appState } : null)),
      runDetached: vi.fn(async (selector, target) => {
        starts.push({ selector, target });
        current = { ...current, state: 'running' };
        currentDescriptor = { ...currentDescriptor, state: 'running', hostPort: current.hostPorts[0]?.host };
      }),
    };
    const dependencies: RuntimeOpenDependencies = {
      backend,
      readRecords: () => [current],
      updateRecord: (_appId, update) => {
        updates.push(update);
        current = { ...current, ...update };
        currentDescriptor = { ...currentDescriptor, state: current.state, exitCode: current.exitCode };
        return current;
      },
      describe: () => currentDescriptor,
    };
    return { backend, dependencies, updates, starts };
  }

  it('turns a stale running registry row into stopped and takes the detached cold-start path', async () => {
    const fake = fakeRuntime(false, null);
    const result = await reconcileAndStartRuntimeOpen('journal', 'local', descriptor, false, fake.dependencies);
    expect(fake.updates[0]).toMatchObject({ state: 'stopped' });
    expect(fake.starts).toEqual([{ selector: 'journal', target: 'local' }]);
    expect(result.kind).toBe('cold');
    expect(result.descriptor.state).toBe('running');
  });

  it('checks supervisor state after confirming the pool is resident', async () => {
    const fake = fakeRuntime(true, 'missing');
    await reconcileAndStartRuntimeOpen('journal', 'local', descriptor, false, fake.dependencies);
    expect(fake.backend.poolRunning).toHaveBeenCalledWith('appliance-runtime');
    expect(fake.backend.appStatus).toHaveBeenCalledWith('appliance-runtime', 'journal');
    expect(fake.starts).toHaveLength(1);
  });

  it('keeps the persisted host port when a post-restart open rebinds the app', async () => {
    const fake = fakeRuntime(false, null);
    const result = await reconcileAndStartRuntimeOpen('journal', 'local', descriptor, false, fake.dependencies);
    expect(result.descriptor.hostPort).toBe(20421);
    expect(result.descriptor.url).toBe('http://127.0.0.1:20421/');
    expect(fake.starts).toHaveLength(1);
  });

  it('treats a live pool and supervisor row as warm', async () => {
    const fake = fakeRuntime(true, 'running');
    const result = await reconcileAndStartRuntimeOpen('journal', 'local', descriptor, false, fake.dependencies);
    expect(result.kind).toBe('warm');
    expect(fake.starts).toHaveLength(0);
  });
});

describe('runtime open URL selection', () => {
  it('selects a compound service.port through the same published-port key path', () => {
    const manifest = {
      ui: { type: 'web', service: 'dashboard', port: 'http', path: '/ui' },
    } as ApplianceV2;
    expect(runtimeUiPortName(manifest)).toBe('dashboard.http');
  });

  it('always derives web URLs on host loopback', () => {
    expect(runtimeOpenUrl(20421, '/notes')).toBe('http://127.0.0.1:20421/notes');
  });
});
