import { describe, expect, it, vi } from 'vitest';
import {
  appWindowLabel,
  appWindowStatusText,
  appWindowTitle,
  closePolicyAction,
  reconcileRuntimeApps,
  waitForPublishedPort,
} from './app-window';

describe('app window contract', () => {
  it('derives the stable per-app label and approved title', () => {
    expect(appWindowLabel('journal')).toBe('app-journal');
    expect(appWindowLabel('Notes.Sync')).toBe('app-notes-sync');
    expect(appWindowTitle('Journal')).toBe('Journal — Appliance');
  });

  it('defaults close to keep-running and allows explicit stop-on-close', () => {
    expect(closePolicyAction()).toBe('keep');
    expect(closePolicyAction('keep-running')).toBe('keep');
    expect(closePolicyAction('stop-on-close')).toBe('stop');
  });

  it('re-attaches only installed apps using the runtime registry as lifecycle truth', () => {
    const registry = [
      { appId: 'journal', state: 'running' },
      { appId: 'removed', state: 'running' },
      { appId: 'reader', state: 'exited' },
    ];
    expect(reconcileRuntimeApps(['journal', 'reader'], registry)).toEqual([registry[0], registry[2]]);
  });

  it('renders the exact status-strip summary', () => {
    expect(
      appWindowStatusText({
        appId: 'journal',
        target: 'local',
        name: 'Journal',
        version: '1.2.0',
        license: 'MIT',
        ui: { type: 'web', port: 'web' },
        state: 'running',
        url: 'http://127.0.0.1:20421/',
        hostPort: 20421,
        egressHostCount: 2,
      })
    ).toBe('sandboxed · egress: 2 hosts allowed · port 20421');
  });
});

describe('published-port wait', () => {
  it('retries until the port accepts a connection', async () => {
    let now = 0;
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    await expect(
      waitForPublishedPort(probe, {
        timeoutMs: 500,
        intervalMs: 100,
        now: () => now,
        delay: async (milliseconds) => {
          now += milliseconds;
        },
      })
    ).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('is bounded by the configured timeout', async () => {
    let now = 0;
    const delays: number[] = [];
    await expect(
      waitForPublishedPort(async () => false, {
        timeoutMs: 250,
        intervalMs: 100,
        now: () => now,
        delay: async (milliseconds) => {
          delays.push(milliseconds);
          now += milliseconds;
        },
      })
    ).rejects.toThrow('within 250ms');
    expect(delays).toEqual([100, 100, 50]);
    expect(now).toBe(250);
  });
});
