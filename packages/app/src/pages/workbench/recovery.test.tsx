// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { HostProvider } from '@/providers/host-provider';
import type { ConsoleHost } from '@/lib/host';
import { WorkbenchPage } from './index';
import { WorkbenchDetailPage } from './detail';
import { workbenchErrorMessage } from './errors';
vi.mock('@/hooks/use-selected-cluster', () => ({ useSelectedCluster: () => ({ config: { clusters: [] } }) }));
vi.mock('@/hooks/use-dev-machine-targets', () => ({ useDevMachineTargets: () => ({ visibleClusters: [] }) }));
const failure = {
  kind: 'unreadable-file',
  path: '/project/.appliance/workbench.json',
  reason: 'EOF while parsing an object at line 1 column 1',
};
const message =
  "/project/.appliance/workbench.json is unreadable (EOF while parsing an object at line 1 column 1). Fix or delete it to reset this workspace's view settings. Your project and deploy link are not affected.";
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

describe('Workbench file recovery', () => {
  it('formats the same actionable error for read, open and save surfaces', () => {
    expect(workbenchErrorMessage(failure)).toBe(message);
    expect(workbenchErrorMessage({ kind: 'operation', message: 'Folder is not writable' })).toBe(
      'Folder is not writable'
    );
  });
  it.each(['list', 'detail'])('shows %s errors immediately without inheriting global retries', async (surface) => {
    const error = surface === 'list' ? { ...failure, path: '/app-data/workbench-directories.json' } : failure;
    const read = vi.fn().mockRejectedValue(error);
    const host = { platform: 'macos', workbench: { list: read, open: read } } as unknown as ConsoleHost;
    const client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 1 } } });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <HostProvider host={host}>
            <QueryClientProvider client={client}>
              <MemoryRouter initialEntries={[surface === 'list' ? '/workbench' : '/workbench/project']}>
                <Routes>
                  <Route path="/workbench" element={<WorkbenchPage />} />
                  <Route path="/workbench/:workspaceId" element={<WorkbenchDetailPage />} />
                </Routes>
              </MemoryRouter>
            </QueryClientProvider>
          </HostProvider>
        )
      );
      await flush();
      await flush();
      expect(container.textContent).toContain(workbenchErrorMessage(error));
      expect(container.textContent).not.toContain('Retry');
      expect(container.textContent).not.toContain('Opening workspace…');
      expect(read).toHaveBeenCalledTimes(1);
      expect(client.getDefaultOptions().queries?.retry).toBe(3);
    } finally {
      await act(async () => root.unmount());
      client.clear();
    }
  });
  it('removes a failed row through the reference-only host capability', async () => {
    const row = { directory: '/project', binding: { version: 1 }, sessions: [], error: failure };
    const list = vi.fn().mockResolvedValueOnce([row]).mockResolvedValue([]);
    const forget = vi.fn().mockResolvedValue(undefined);
    const host = { platform: 'macos', workbench: { list, forget } } as unknown as ConsoleHost;
    const client = new QueryClient();
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <HostProvider host={host}>
            <QueryClientProvider client={client}>
              <MemoryRouter>
                <WorkbenchPage />
              </MemoryRouter>
            </QueryClientProvider>
          </HostProvider>
        )
      );
      await flush();
      expect(container.textContent).toContain(message);
      const remove = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove from Workbench')!;
      expect(remove.closest('a')).toBeNull();
      await act(async () => remove.click());
      await flush();
      expect(forget).toHaveBeenCalledWith('/project');
      expect(container.textContent).toContain('No workspaces yet.');
    } finally {
      await act(async () => root.unmount());
      client.clear();
    }
  });
});
