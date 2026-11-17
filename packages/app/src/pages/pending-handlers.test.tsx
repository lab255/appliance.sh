// @vitest-environment jsdom
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { TerminalSessionsProvider } from '@/providers/terminal-sessions-provider';
import { ToastProvider } from '@/components/ui/toast';
import { MotionProvider } from '@appliance.sh/ui/motion-provider';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { HostProvider } from '@/providers/host-provider';
import type { ConsoleHost } from '@/lib/host';
import { WorkloadsPanel } from './environments/workloads-panel';
import { CredentialHelperEditor } from './machine/credential-helper-editor';
import { RuntimeDetail } from './machine/runtime-detail';
import { AgentLoginPanel } from '@/components/agent-login';
import { SettingsPage } from './settings';

// PTY rendering is infrastructure; the real session provider remains mounted.
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }));
vi.mock('@/hooks/use-appliance-client', () => ({ useApplianceClient: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

const cases = [
  ['switch', 'Switch', 'Switching…'],
  ['program', 'Browse', 'Choose program…'],
  ['terminal', 'Start sign-in', 'Opening terminal…'],
  ['relaunch', 'Restart to update', 'Restarting…'],
  ['folder', 'Share a folder…', 'Choose folder…'],
  ['deploy', 'Deploy app', 'Opening deploy…'],
  ['provision', 'Deploy app', 'Provisioning cluster…'],
] as const;

it.each(cases)(
  '%s paints before host work, avoids native disabled, guards duplicates and recovers',
  async (kind, idle, pending) => {
    let frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (frames.push(cb), frames.length));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const frame = async () => {
      const current = frames;
      frames = [];
      await act(async () => current.forEach((cb) => cb(0)));
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    let settle!: (value?: unknown) => void;
    let reject!: (error: Error) => void;
    const work = vi.fn(
      () =>
        new Promise((resolve, fail) => {
          settle = resolve;
          reject = fail;
        })
    );
    const cfg = { clusters: [], selectedClusterId: null };
    const status = {
      available: true,
      exists: true,
      running: kind === 'deploy' || kind === 'provision',
      dev: kind === 'folder',
      clusterProvisioned: kind !== 'provision',
      kubeconfigReady: false,
    };
    client.setQueryData(['host', 'config'], cfg);
    client.setQueryData(['microvm', 'appliance', 'status'], status);
    client.setQueryData(['microvm', 'list'], []);
    client.setQueryData(['microvm', 'appliance', 'egress'], { rules: [] });
    const host = {
      platform: 'macos',
      getConfig:
        kind === 'deploy' ? work : async () => ({ ...cfg, selectedClusterId: kind === 'provision' ? 'target' : null }),
      selectCluster: work,
      local: { pickDirectory: work },
      agentAuth: {
        status: async () => ({ configured: false, kind: null }),
        hasHostClaude: async () => true,
        runSetupToken: work,
      },
      updater: { check: async () => ({ version: '9.0.0' }), downloadAndInstall: async () => {}, relaunch: work },
      vm: {
        instance: () => ({ status: async () => status, clusterUp: work, egress: { get: async () => ({ rules: [] }) } }),
        list: async () => [],
      },
    } as unknown as ConsoleHost;
    const changed = vi.fn();
    const view =
      kind === 'switch' ? (
        <WorkloadsPanel clusterId="target" />
      ) : kind === 'program' ? (
        <CredentialHelperEditor
          program=""
          args={[]}
          platform="macos"
          showErrors={false}
          onProgramChange={changed}
          onArgsChange={() => {}}
          onPickProgram={work as () => Promise<string | null>}
        />
      ) : kind === 'terminal' ? (
        <AgentLoginPanel />
      ) : kind === 'relaunch' ? (
        <SettingsPage />
      ) : (
        <RuntimeDetail name="appliance" clusterId="target" />
      );
    const button = (name: string) =>
      [...container.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name
      )!;
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <QueryClientProvider client={client}>
              <HostProvider host={host}>
                <MotionProvider>
                  <ToastProvider>
                    <ConfirmProvider>
                      <TerminalSessionsProvider>{view}</TerminalSessionsProvider>
                    </ConfirmProvider>
                  </ToastProvider>
                </MotionProvider>
              </HostProvider>
            </QueryClientProvider>
          </MemoryRouter>
        )
      );
      if (kind === 'relaunch') {
        await act(async () => button('Check for updates').click());
        await frame();
        await frame();
        await act(async () => button('Download & install 9.0.0').click());
        await frame();
        await frame();
      }
      const control = button(idle);
      expect(control, 'idle control').toBeTruthy();
      control.focus();
      for (const outcome of ['reject', 'cancel', 'success']) {
        work.mockClear();
        await act(async () => control.click());
        expect(control.getAttribute('aria-busy')).toBe('true');
        expect(control.hasAttribute('disabled')).toBe(false);
        expect(control.getAttribute('aria-label')).toBe(pending);
        expect(document.activeElement).toBe(control);
        expect(control.getAttribute('aria-disabled')).toBe('true');
        expect(work).not.toHaveBeenCalled();
        await act(async () => control.click());
        await frame();
        expect(work).not.toHaveBeenCalled();
        await frame();
        if (kind === 'provision') {
          await frame();
          expect(work).not.toHaveBeenCalled();
          await frame();
          expect(control.getAttribute('aria-label')).toBe('Provisioning cluster…');
        }
        expect(work).toHaveBeenCalledTimes(1);
        await act(async () => control.click());
        expect(work).toHaveBeenCalledTimes(1);
        await act(async () => {
          if (outcome === 'reject') reject(new Error('Host unavailable'));
          else
            settle(
              kind === 'deploy'
                ? { ...cfg, selectedClusterId: 'target' }
                : outcome === 'cancel'
                  ? null
                  : kind === 'terminal'
                    ? true
                    : '/chosen'
            );
        });
        if (kind === 'provision' && outcome !== 'reject') {
          expect(control.getAttribute('aria-label')).toBe('Opening deploy…');
          expect(control.hasAttribute('disabled')).toBe(false);
          await frame();
          await frame();
        }
        if (outcome === 'reject' && kind !== 'deploy' && kind !== 'provision') {
          expect(container.textContent).toContain(
            kind === 'relaunch' ? "The app couldn't restart itself" : 'Host unavailable'
          );
        }
        expect(control.getAttribute('aria-busy')).toBe('false');
        expect(control.getAttribute('aria-disabled')).toBe('false');
        if (kind === 'program' && outcome === 'cancel') expect(changed).not.toHaveBeenCalled();
      }
      if (kind === 'program') expect(changed).toHaveBeenCalledWith('/chosen');
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    }
  }
);
