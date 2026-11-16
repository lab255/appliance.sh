// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostProvider } from '@/providers/host-provider';
import type { ConsoleHost, BootstrapEvent } from '@/lib/host';
import { afterPendingPaint } from '@/lib/paint-pending';
import { BootstrapProgressPage } from './progress';

vi.mock('@/lib/paint-pending', () => ({ afterPendingPaint: vi.fn() }));

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
});
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  'starts an AWS retry only if still mounted after acknowledgment (unmount=%s)',
  async (unmount) => {
    let painted!: () => void;
    vi.mocked(afterPendingPaint).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          painted = resolve;
        })
    );
    const run = vi.fn((_input, _options, onEvent: (event: BootstrapEvent) => void) => {
      onEvent({ type: 'phase-failed', phase: 'phase1', error: 'test failure' });
      return Promise.reject(new Error('test failure'));
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    let mounted = true;
    const queryClient = new QueryClient();
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter
              initialEntries={[
                {
                  pathname: '/cloud/bootstrap/run',
                  state: {
                    mode: 'aws',
                    name: 'test',
                    region: 'ap-southeast-1',
                    domain: 'example.test',
                    createZone: true,
                    deployApiServer: false,
                    promoteState: false,
                  },
                },
              ]}
            >
              <HostProvider host={{ bootstrap: { run } } as unknown as ConsoleHost}>
                <BootstrapProgressPage />
              </HostProvider>
            </MemoryRouter>
          </QueryClientProvider>
        )
      );
      expect(run).toHaveBeenCalledOnce();
      const retry = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.startsWith('Retry ')
      )!;
      expect(retry).toBeDefined();
      await act(async () => retry.click());
      expect(run).toHaveBeenCalledOnce();
      if (unmount) {
        await act(async () => root.unmount());
        mounted = false;
      }
      await act(async () => painted());
      expect(run).toHaveBeenCalledTimes(unmount ? 1 : 2);
    } finally {
      if (mounted) await act(async () => root.unmount());
      queryClient.clear();
    }
  }
);
