import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterCompat } from '@/hooks/use-cluster-compat';
import type { ConsoleHost, MicroVmInstanceHost } from '@/lib/host';
import { HostProvider } from '@/providers/host-provider';
import { ClusterCompatBanner } from './cluster-compat-banner';

const useClusterCompat = vi.hoisted(() => vi.fn<() => ClusterCompat>());
vi.mock('@/hooks/use-cluster-compat', () => ({ useClusterCompat }));

function compat(capable: boolean): ClusterCompat {
  return {
    loading: false,
    clientVersion: '1.58.0',
    serverVersion: '1.57.0',
    minClientVersion: '1.0.0',
    isMicroVm: true,
    vmName: 'appliance',
    controlPlaneUpdateCapable: capable,
    clientBelowMinimum: false,
    controlPlanePredatesReporting: false,
    versionDrift: true,
    warnings: [],
  };
}

function renderBanner(update = vi.fn().mockResolvedValue('updated')): string {
  const instance = { update } as unknown as MicroVmInstanceHost;
  const host = {
    vm: { instance: () => instance },
  } as unknown as ConsoleHost;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <HostProvider host={host}>
          <ClusterCompatBanner />
        </HostProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('ClusterCompatBanner microVM update remediation', () => {
  beforeEach(() => useClusterCompat.mockReset());

  it('offers the in-place update action for an MV1 launcher', () => {
    useClusterCompat.mockReturnValue(compat(true));
    const html = renderBanner();
    expect(html).toContain('<button');
    expect(html).toContain('Update now');
    expect(html).not.toContain('Machine page');
  });

  it('keeps restage-and-reboot navigation for a legacy launcher', () => {
    useClusterCompat.mockReturnValue(compat(false));
    const html = renderBanner();
    expect(html).toContain('Machine page');
    expect(html).not.toContain('<button');
  });
});
