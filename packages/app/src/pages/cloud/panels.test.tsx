import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HostProvider } from '@/providers/host-provider';
import type { Cluster, ConsoleHost } from '@/lib/host';
import { CloudFormationLifecycleHandoff } from './panels';

const cluster: Cluster = {
  id: 'cloud-1',
  name: 'Production',
  apiServerUrl: 'https://api.example.test',
  createdAt: '2026-08-30T00:00:00.000Z',
  installGeneration: 'cloudformation-v1',
};

function render(desktop: boolean): string {
  const host = {
    desktop,
    platform: 'macos',
    getConfig: async () => ({
      clusters: [cluster],
      selectedClusterId: cluster.id,
      apiKey: { id: 'key', secret: 'secret' },
    }),
  } as ConsoleHost;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <HostProvider host={host}>
        <CloudFormationLifecycleHandoff cluster={cluster} desktop={desktop} />
      </HostProvider>
    </QueryClientProvider>
  );
}

describe('CloudFormation update handoff', () => {
  it('renders the CLI command outside the desktop shell', () => {
    const html = render(false);
    expect(html).toContain('appliance cloud update');
    expect(html).not.toContain('Update Appliance service');
  });

  it('renders the in-app update panel in the desktop shell', () => {
    const html = render(true);
    expect(html).toContain('Update Appliance service');
    expect(html).not.toContain('appliance cloud update</');
    expect(html).not.toContain('AWS profile');
    expect(html).toContain('Target version');
  });
});
