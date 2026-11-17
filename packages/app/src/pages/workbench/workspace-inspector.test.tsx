// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostProvider } from '@/providers/host-provider';
import type { ConsoleHost } from '@/lib/host';
import type { Inspection } from '@/lib/inspection';
import { WorkspaceInspector } from './workspace-inspector';
import { WorkbenchDetailPage } from './detail';
vi.mock('@/hooks/use-selected-cluster', () => ({ useSelectedCluster: () => ({ config: { clusters: [] } }) }));
vi.mock('@/hooks/use-dev-machine-targets', () => ({ useDevMachineTargets: () => ({ visibleClusters: [] }) }));
// Only session transport is excluded; the real detail -> inspector composition stays mounted.
vi.mock('./sessions-observation', () => ({ SessionsObservation: () => null }));
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
const proposal = {
  source: 'fixture' as const,
  directory: '/project',
  proposalId: 'ready-1',
  sessionId: 'agent-fixture',
  sessionStatus: 'done' as const,
  revision: 'snapshot-1',
  baselineId: 'baseline-1',
  summary: 'Fixture result',
};
const path = '.appliance/agent-results/agent-example.json';
const snapshot = (generated: boolean): Inspection => ({
  snapshotId: 'snapshot-1',
  baselineId: 'baseline-1',
  directory: '/project',
  capturedAt: '2026-11-17T01:00:00Z',
  refreshedAt: '2026-11-17T02:00:00Z',
  comparisonError: null,
  initialGitStatus: '',
  entries: generated ? [{ path, size: 9, state: 'added', generated: true, issue: null }] : [],
});
async function mount(generated: boolean, route: boolean, readiness = false) {
  const refresh = vi.fn().mockResolvedValue(snapshot(generated));
  const workspace = {
    directory: '/project',
    binding: { version: 1 },
    sessions: readiness ? [{ sessionId: 'agent-fixture', status: 'done' }] : [],
  };
  const host = {
    platform: 'macos',
    inspectionRefresh: refresh,
    workbench: { open: vi.fn().mockResolvedValue(workspace) },
  } as unknown as ConsoleHost;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <HostProvider host={host}>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/workbench/%2Fproject']}>
            {route ? (
              <Routes>
                <Route
                  path="/workbench/:workspaceId"
                  element={
                    <WorkbenchDetailPage
                      readinessSource={
                        readiness
                          ? {
                              subscribe: () => () => {},
                              getSnapshot: () => proposal,
                            }
                          : undefined
                      }
                    />
                  }
                />
              </Routes>
            ) : (
              <WorkspaceInspector directory="/project" />
            )}
          </MemoryRouter>
        </QueryClientProvider>
      </HostProvider>
    )
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return {
    container,
    refresh,
    client,
    workspace,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      client.clear();
    },
  };
}
it.each([false, true])('discloses generated-only changes and reveals rows (real detail route=%s)', async (route) => {
  const { container, refresh, cleanup } = await mount(true, route);
  try {
    expect(refresh).toHaveBeenCalledWith('/project');
    expect(container.textContent).toContain('0 files · 1 generated changes hidden');
    expect(container.textContent).toContain('1 generated path changed and is not shown');
    for (const pattern of ['.appliance/agents.json', '.appliance/agent-results/*', '.appliance/.agents.*'])
      expect(container.textContent).toContain(pattern);
    expect(container.textContent).not.toContain('No changes since workspace baseline');
    expect(container.querySelector('[role=treeitem]')).toBeNull();
    const toggle = container.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(toggle.parentElement?.textContent).toContain('Include generated');
    await act(async () => toggle.click());
    expect(container.querySelector('[role=treeitem]')?.textContent).toContain(path);
    expect(container.textContent).toContain('1 files');
  } finally {
    await cleanup();
  }
});
it.each([false, true])('negative control: genuinely unchanged shows No changes (route=%s)', async (route) => {
  const { container, cleanup } = await mount(false, route);
  try {
    expect(container.textContent).toContain('No changes since workspace baseline');
    expect(container.textContent).not.toContain('generated changes hidden');
  } finally {
    await cleanup();
  }
});
it.each([false, true])(
  'failed refresh retains a stale snapshot without a clean comparison (route=%s)',
  async (route) => {
    const { container, refresh, cleanup } = await mount(false, route);
    try {
      expect(container.textContent).toContain('No changes since workspace baseline'); // negative control before failure
      refresh.mockRejectedValue(new Error('host unavailable'));
      await act(async () => {
        [...container.querySelectorAll('button')].find((b) => b.textContent === 'Refresh inspection')!.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(container.textContent).toContain(
        'Previous snapshot is stale — captured 2026-11-17T02:00:00Z; refresh failed'
      );
      expect(container.textContent).toContain('Comparison unavailable');
      expect(container.textContent).not.toContain('No changes since workspace baseline');
    } finally {
      await cleanup();
    }
  }
);

it('real detail reconciles host session and inspection refresh evidence before presenting a proposal', async () => {
  const { container, refresh, client, workspace, cleanup } = await mount(false, true, true);
  const text = () => container.textContent;
  const refreshButton = () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Refresh inspection')!;
  const refreshTo = async (value: Inspection) => {
    refresh.mockResolvedValue(value);
    await act(async () => {
      refreshButton().click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };
  try {
    expect(text()).toContain('Agent-proposed · not approved');
    for (const sessions of [[], [{ sessionId: 'agent-fixture', status: 'running' }]]) {
      await act(async () => {
        client.setQueryData(['workbench', '/project'], { ...workspace, sessions });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(text()).toContain('Stale proposal — Session unknown');
    }
    await act(async () => {
      client.setQueryData(['workbench', '/project'], workspace);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(text()).toContain('Agent-proposed · not approved');
    for (const value of [
      { ...snapshot(false), snapshotId: 'snapshot-2' },
      { ...snapshot(false), baselineId: 'baseline-2' },
    ]) {
      await refreshTo(value);
      expect(text()).toContain('Stale proposal — The workspace baseline or snapshot');
    }
    await refreshTo(snapshot(false));
    expect(text()).toContain('Agent-proposed · not approved');
    await refreshTo({ ...snapshot(false), comparisonError: 'Baseline authentication failed' });
    expect(text()).toContain('Stale proposal — Freshness unknown');
  } finally {
    await cleanup();
  }
});

it('real detail invalidates readiness after a rejected refresh following success', async () => {
  const { container, refresh, cleanup } = await mount(false, true, true);
  try {
    expect(container.textContent).toContain('Agent-proposed · not approved');
    refresh.mockRejectedValue(new Error('host unavailable after successful inspection'));
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Refresh inspection')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(container.textContent).toContain('host unavailable after successful inspection');
    expect(container.textContent).toContain('Comparison unavailable');
    expect(container.textContent).toContain('Stale proposal — Freshness unknown');
    expect(container.textContent).not.toContain('Agent-proposed · not approved');
  } finally {
    await cleanup();
  }
});
