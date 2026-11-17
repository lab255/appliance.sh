// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { HostProvider } from '@/providers/host-provider';
import { TerminalSessionsProvider } from '@/providers/terminal-sessions-provider';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import type { ConsoleHost } from '@/lib/host';
import { useReadinessFixture, type ReadinessFixture, type ReadinessFixtureSource } from '@/lib/workbench-readiness';
import { WorkbenchDetailPage } from './detail';

it('rejects another directory at the source hook without relying on PackageSection', async () => {
  const snapshot: ReadinessFixture = {
    source: 'fixture',
    directory: '/workspace',
    sessionId: 'agent-fixture',
    proposalId: 'ready-1',
    revision: 'snapshot-1',
    baselineId: 'baseline-1',
    sessionStatus: 'done',
    summary: 'Fixture result',
  };
  const source: ReadinessFixtureSource = { getSnapshot: () => snapshot, subscribe: () => () => {} };
  function Probe({ directory }: { directory: string }) {
    const result = useReadinessFixture(directory, source);
    return <p>{result ? result.proposalId : 'No scoped proposal'}</p>;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe directory="/workspace" />));
    expect(container.textContent).toBe('ready-1');
    await act(async () => root.render(<Probe directory="/other-workspace" />));
    expect(container.textContent).toBe('No scoped proposal');
  } finally {
    await act(async () => root.unmount());
  }
});

vi.mock('@/hooks/use-selected-cluster', () => ({ useSelectedCluster: () => ({ config: { clusters: [] } }) }));
vi.mock('@/hooks/use-dev-machine-targets', () => ({ useDevMachineTargets: () => ({ visibleClusters: [] }) }));
vi.mock('./workspace-inspector', () => ({
  WorkspaceInspector: ({ onSnapshot }: { onSnapshot: (value: unknown) => void }) => {
    useEffect(() => {
      onSnapshot({
        directory: '/workspace',
        snapshotId: 'snapshot-1',
        baselineId: 'baseline-1',
        comparisonError: null,
      });
    }, [onSnapshot]);
    return <p>Inspection fixture</p>;
  },
}));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('bridges a scoped fixture session to detail; stale is not approval and only a human click packages', async () => {
  let snapshot: ReadinessFixture | null = null;
  const listeners = new Set<() => void>();
  const source: ReadinessFixtureSource = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const emit = async (value: ReadinessFixture | null) =>
    act(async () => {
      snapshot = value;
      listeners.forEach((fn) => fn());
    });
  const proposal: ReadinessFixture = {
    source: 'fixture',
    directory: '/workspace',
    sessionId: 'agent-fixture',
    proposalId: 'ready-1',
    revision: 'snapshot-1',
    baselineId: 'baseline-1',
    sessionStatus: 'done',
    summary: 'A simulated captured result; review the changes.',
  };
  const packageCall = vi.fn().mockRejectedValue(new Error('Fixture package failure'));
  const host = {
    platform: 'macos',
    workbench: {},
    workbenchPackage: { package: packageCall },
  } as unknown as ConsoleHost;
  const cache = new QueryClient();
  cache.setQueryData(['workbench', '/workspace'], {
    directory: '/workspace',
    binding: { version: 1 },
    sessions: [{ sessionId: 'agent-fixture', status: 'done' }],
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === name)!;
  try {
    await act(async () =>
      root.render(
        <HostProvider host={host}>
          <QueryClientProvider client={cache}>
            <TerminalSessionsProvider>
              <ConfirmProvider>
                <MemoryRouter initialEntries={['/workbench/%2Fworkspace']}>
                  <Routes>
                    <Route path="/workbench/:workspaceId" element={<WorkbenchDetailPage readinessSource={source} />} />
                  </Routes>
                </MemoryRouter>
              </ConfirmProvider>
            </TerminalSessionsProvider>
          </QueryClientProvider>
        </HostProvider>
      )
    );
    // Negative control: done alone, including result text, cannot invent readiness.
    expect(container.textContent).toContain('No structured readiness proposal.');
    expect(button('Package').disabled).toBe(false);
    await emit({ ...proposal, directory: '/other-workspace' });
    expect(container.textContent).not.toContain('Agent proposal: Ready to package.');
    await emit(proposal);
    expect(container.textContent).toContain('Agent-proposed · not approved');
    expect(container.textContent).toContain('Fixture session: agent-fixture · Finished');
    expect(container.textContent).toContain(proposal.summary);
    expect(container.querySelector('a[href="#workbench-inspection"]')).not.toBeNull();
    expect(container.querySelector('#workbench-inspection')).not.toBeNull();
    expect(packageCall).not.toHaveBeenCalled();
    button('Dismiss proposal').focus();
    await act(async () => button('Dismiss proposal').click());
    expect(container.textContent).toContain('Stale proposal — You dismissed this proposal.');
    expect(document.activeElement).toBe(button('Dismiss proposal'));
    expect(button('Dismiss proposal').getAttribute('aria-disabled')).toBe('true');
    await emit({ ...proposal });
    expect(container.textContent).toContain('Stale proposal — You dismissed this proposal.');
    expect(button('Package').disabled).toBe(false);
    for (const status of ['stopped', 'dismissed', 'error', 'exited'] as const) {
      await emit({ ...proposal, proposalId: status, sessionStatus: status });
      expect(container.textContent).toContain('Stale proposal —');
      expect(button('Package').disabled).toBe(false);
    }
    expect(packageCall).not.toHaveBeenCalled();
    await act(async () => {
      button('Package').click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(packageCall).toHaveBeenCalledOnce();
    expect(packageCall.mock.calls[0][0]).toBe('/workspace');
    await emit(null);
    expect(container.textContent).toContain('No structured readiness proposal.');
    expect(button('Retry Package').disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    expect(listeners.size).toBe(0);
    cache.clear();
    container.remove();
  }
});
