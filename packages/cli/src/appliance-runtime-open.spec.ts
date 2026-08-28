import { describe, expect, it, vi } from 'vitest';
import { routeRuntimeOpen, runtimeOpenJson, type RuntimeOpenDescriptor } from './appliance-runtime-open';

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
