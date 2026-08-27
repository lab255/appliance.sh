// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordAppStopStart, renderAppWindow, type RuntimeAppWindowDescriptor } from './app-window';

const running: RuntimeAppWindowDescriptor = {
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
};

afterEach(() => {
  vi.restoreAllMocks();
  document.head.replaceChildren();
  document.body.replaceChildren();
  window.localStorage.clear();
});

describe('app window document', () => {
  it('pins the iframe sandbox and exact wrapper CSP', () => {
    const root = document.createElement('div');
    document.body.append(root);
    renderAppWindow(root, running);

    expect(root.querySelector('iframe')?.getAttribute('sandbox')).toBe(
      'allow-downloads allow-forms allow-modals allow-popups allow-scripts allow-same-origin'
    );
    expect(document.head.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content).toBe(
      "default-src 'none'; frame-src http://127.0.0.1:20421; connect-src ipc: http://ipc.localhost; script-src 'self'; style-src 'unsafe-inline'; img-src data:"
    );
    expect(root.querySelector('footer')).toMatchObject({
      role: 'status',
      ariaLive: 'polite',
      ariaAtomic: 'true',
    });
    expect(root.querySelector('.appliance-app-status__dot')).not.toBeNull();
  });

  it('shows an inline error and restores Reopen after a rejected attempt', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    renderAppWindow(
      root,
      { ...running, state: 'exited', exitCode: 7 },
      { reopen: vi.fn().mockRejectedValue(new Error('restart failed')) }
    );

    const button = root.querySelector('button')!;
    button.click();
    expect(button.textContent).toBe('Reopening…');
    expect(button.getAttribute('aria-busy')).toBe('true');
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe('restart failed'));
    expect(button.textContent).toBe('Reopen');
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  it('distinguishes normal stops, nonzero exits, and failures', () => {
    const copies = [
      [{ ...running, state: 'exited' as const, exitCode: 0 }, 'Journal has stopped.'],
      [{ ...running, state: 'exited' as const, exitCode: 17 }, 'Journal stopped (exit code 17).'],
      [{ ...running, state: 'failed' as const, exitCode: 70 }, 'Journal failed (exit code 70).'],
    ] as const;
    for (const [descriptor, expected] of copies) {
      const root = document.createElement('div');
      document.body.replaceChildren(root);
      renderAppWindow(root, descriptor);
      expect(root.querySelector('.appliance-app-exited p')?.textContent).toBe(expected);
      document.head.replaceChildren();
    }
  });

  it('records iframe load as app_open_ttv with its launch kind', () => {
    const metric = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(1_250);
    const root = document.createElement('div');
    document.body.append(root);
    renderAppWindow(root, { ...running, openMetric: { kind: 'warm', startedAtMs: 1_000 } }, { metric });

    root.querySelector('iframe')!.dispatchEvent(new Event('load'));
    expect(metric).toHaveBeenCalledWith({
      name: 'app_open_ttv',
      appId: 'journal',
      durationMs: 250,
      kind: 'warm',
    });
  });

  it('records stop-to-exited after the exited page paints', () => {
    const metric = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(1_250);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    recordAppStopStart('journal', 1_000);
    const root = document.createElement('div');
    document.body.append(root);

    renderAppWindow(root, { ...running, state: 'exited', exitCode: 0 }, { metric });

    expect(metric).toHaveBeenCalledWith({
      name: 'app_stop_ttx',
      appId: 'journal',
      durationMs: 250,
    });
  });

  it('tags a successful Reopen and focuses the loaded app frame', async () => {
    const metric = vi.fn();
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const root = document.createElement('div');
    document.body.append(root);
    renderAppWindow(root, { ...running, state: 'exited', exitCode: 0 }, { reopen: async () => running, metric });

    root.querySelector('button')!.click();
    await vi.waitFor(() => expect(root.querySelector('iframe')).not.toBeNull());
    const frame = root.querySelector('iframe')!;
    expect(document.activeElement).toBe(frame);
    now = 1_200;
    frame.dispatchEvent(new Event('load'));
    expect(metric).toHaveBeenCalledWith({
      name: 'app_open_ttv',
      appId: 'journal',
      durationMs: 200,
      kind: 'reopen',
    });
  });
});
