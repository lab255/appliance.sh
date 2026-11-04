import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { WorkloadsPanel } from './workloads-panel';

vi.mock('@/providers/host-provider', () => ({ useHost: () => ({ getConfig: vi.fn() }) }));
vi.mock('@/providers/terminal-sessions-provider', () => ({ useTerminalSessions: () => ({}) }));
vi.mock('@/hooks/use-appliance-client', () => ({ useApplianceClient: () => ({ listWorkloads: vi.fn() }) }));

function markup(data?: object) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['host', 'config'], { selectedClusterId: 'microvm' });
  if (data) client.setQueryData(['local-runtime', 'workloads', 'microvm'], data);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <WorkloadsPanel clusterId="microvm" />
      </QueryClientProvider>
    );
  } finally {
    client.clear();
  }
}

describe('Workloads tables', () => {
  it('reserves the same bounded viewport while loading and when empty', () => {
    const loading = markup();
    const empty = markup({ deployments: [], pods: [], services: [] });
    expect(loading).toContain('Loading workloads…');
    expect(loading).toContain('role="status"');
    expect(empty).toContain('No workloads yet');
    for (const html of [loading, empty]) expect(html).toContain('h-[32rem] overflow-auto');
  });

  it('adopts all three accessible tables and preserves refresh, log and service controls', () => {
    const html = markup({
      deployments: [{ name: 'journal', image: 'journal:v1', ready: 1, desired: 1 }],
      pods: [{ name: 'journal-pod', phase: 'Running', ready: true, restartCount: 0 }],
      services: [{ name: 'journal', nodePort: 30080, serviceType: 'NodePort', clusterIp: '10.0.0.1' }],
    });
    expect(html.match(/table-fixed/g)).toHaveLength(3);
    for (const title of ['Deployments', 'Pods', 'Services'])
      expect(html).toContain(`${title} hosted on this Dev Machine`);
    expect(html).toContain('aria-label="Refresh workloads"');
    expect(html).toContain('Logs');
    expect(html).toContain('href="http://localhost:30080"');
    expect(html).toContain('Technical details');
    expect(html).not.toContain('role="button"');
  });
});
