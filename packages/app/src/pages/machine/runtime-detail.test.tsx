import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { HostProvider } from '@/providers/host-provider';
import type { ConsoleHost } from '@/lib/host';
import { RuntimeDetail } from './runtime-detail';

vi.mock('@/providers/terminal-sessions-provider', () => ({ useTerminalSessions: () => ({}) }));
vi.mock('@/components/ui/confirm-dialog', () => ({ useConfirm: () => vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const helper = 'Start the Sandbox to use Internet access, Credentials, and Facts. Set up hosting to use Workloads.';

describe('Sandbox helper', () => {
  it.each([
    { running: false, kubeconfigReady: false },
    { running: true, kubeconfigReady: false },
    { running: true, kubeconfigReady: true },
  ])('follows sandbox state: %j', ({ running, kubeconfigReady }) => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(['microvm', 'appliance', 'status'], {
      available: true,
      running,
      kubeconfigReady,
      clusterProvisioned: false,
    });
    client.setQueryData(['microvm', 'list'], []);
    const host = { vm: { instance: () => ({}) } } as unknown as ConsoleHost;
    try {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <HostProvider host={host}>
              <RuntimeDetail name="appliance" clusterId="microvm:appliance" />
            </HostProvider>
          </QueryClientProvider>
        </MemoryRouter>
      );
      expect(html.includes(helper)).toBe(!running);
      // Hosting remains unavailable in the running core-only regression case.
      expect(html).toMatch(/<button[^>]*disabled[^>]*>Workloads<\/button>/);
    } finally {
      client.clear();
    }
  });
});
