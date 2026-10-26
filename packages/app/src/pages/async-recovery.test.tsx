// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { HostProvider } from '@/providers/host-provider';
import type { ConsoleHost } from '@/lib/host';
import { ProjectDetailPage } from './projects/detail';
import { AccountSection } from './settings-account';
import { DeploymentsPage } from './deployments/list';

const state = vi.hoisted(() => ({ enabled: true }));
const client = vi.hoisted(() => ({ listDeployments: vi.fn() }));
vi.mock('@/hooks/use-appliance-client', () => ({ useApplianceClient: () => (state.enabled ? client : null) }));
vi.mock('@/hooks/use-selected-cluster', () => ({ useSelectedCluster: () => ({ cluster: { id: 'test' } }) }));
vi.mock('@/hooks/use-lookups', () => ({ useEnvironmentsMap: () => new Map(), useProjectsMap: () => new Map() }));

vi.mock('@/components/ui/confirm-dialog', () => ({ useConfirm: () => vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('async read recovery', () => {
  it('keeps pending detail reads skeletal before the API client is ready', async () => {
    state.enabled = false;
    const queryClient = new QueryClient();
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter initialEntries={['/projects/p1']}>
            <QueryClientProvider client={queryClient}>
              <Routes>
                <Route path="/projects/:id" element={<ProjectDetailPage />} />
              </Routes>
            </QueryClientProvider>
          </MemoryRouter>
        )
      );
      expect(container.querySelector('[aria-label="Loading app"]')).not.toBeNull();
      expect(container.textContent).not.toContain('Not found');
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
      state.enabled = true;
    }
  });

  it('retries a failed deployment read without discarding cached rows or remounting their links', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const deployment = {
      id: 'd1',
      projectId: 'p1',
      environmentId: 'e1',
      action: 'deploy',
      status: 'succeeded',
      startedAt: '2026-10-26T12:00:00Z',
    };
    queryClient.setQueryData(['deployments', 'all'], [deployment]);
    client.listDeployments.mockResolvedValue({ success: false, error: new Error('Read unavailable') });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <DeploymentsPage />
            </QueryClientProvider>
          </MemoryRouter>
        )
      );
      await flush();
      const link = container.querySelector('a[href="/deployments/d1"]');
      expect(link).not.toBeNull();
      expect(container.textContent).toContain("Couldn't load deployments");
      let resolveRead!: (value: unknown) => void;
      client.listDeployments.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          })
      );
      const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!;
      await act(async () => retry.click());
      await flush();
      expect(retry.disabled).toBe(true);
      expect(container.querySelector('a[href="/deployments/d1"]')).toBe(link);
      await act(async () => resolveRead({ success: true, data: [deployment] }));
      await flush();
      expect(container.textContent).not.toContain("Couldn't load deployments");
      expect(container.querySelector('a[href="/deployments/d1"]')).toBe(link);
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
    }
  });

  it('does not claim signed out while unknown, and recovers account reads in place', async () => {
    let resolveStatus!: (value: unknown) => void;
    const status = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveStatus = resolve;
          })
      );
    const host = { account: { status } } as unknown as ConsoleHost;
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <HostProvider host={host}>
            <AccountSection />
          </HostProvider>
        )
      );
      expect(container.textContent).not.toContain('Signed out');
      const retry = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry account status'
      )!;
      expect(retry).toBeDefined();
      await act(async () => retry.click());
      expect(container.textContent).toContain('Could not read your account');
      await act(async () => resolveStatus({ signedIn: true, email: 'avery@example.com' }));
      expect(container.textContent).toContain('Signed in with able as avery@example.com');
      expect(container.textContent).not.toContain('Could not read your account');
    } finally {
      await act(async () => root.unmount());
    }
  });
});
