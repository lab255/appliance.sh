// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterCompat } from '@/hooks/use-cluster-compat';
import type { ConsoleHost, MicroVmInstanceHost } from '@/lib/host';
import { HostProvider } from '@/providers/host-provider';
import { ClusterCompatBanner } from './cluster-compat-banner';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const useClusterCompat = vi.hoisted(() => vi.fn<() => ClusterCompat>());
vi.mock('@/hooks/use-cluster-compat', () => ({ useClusterCompat }));

function compat(capable: boolean, selfUpdateEnabled = true): ClusterCompat {
  return {
    loading: false,
    clientVersion: '1.58.0',
    serverVersion: '1.57.0',
    minClientVersion: '1.0.0',
    isMicroVm: true,
    vmName: 'appliance',
    controlPlaneUpdateCapable: capable,
    selfUpdateEnabled,
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

async function mountBanner(update: MicroVmInstanceHost['update']): Promise<{
  container: HTMLDivElement;
  root: Root;
}> {
  const instance = { update } as unknown as MicroVmInstanceHost;
  const host = { vm: { instance: () => instance } } as unknown as ConsoleHost;
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <HostProvider host={host}>
            <ClusterCompatBanner />
          </HostProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  return { container, root };
}

describe('ClusterCompatBanner microVM update remediation', () => {
  beforeEach(() => useClusterCompat.mockReset());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  it('does not offer a dead-end update when signed release trust is not enabled', () => {
    useClusterCompat.mockReturnValue(compat(true, false));
    const html = renderBanner();
    expect(html).toContain('in-place updates are not enabled in this build');
    expect(html).toContain('Machine page');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('AP-226');
  });

  it('uses only phase-prefixed events as the update button accessible name', async () => {
    useClusterCompat.mockReturnValue(compat(true));
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const update = vi.fn(async (_version, onEvent) => {
      onEvent?.({ message: 'WARNING: development release trust is active' });
      return completed.then(() => 'updated');
    });
    const { container, root } = await mountBanner(update);
    try {
      await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
      expect(container.querySelector('button')?.textContent).toBe('Checking VM capability…');

      const onEvent = update.mock.calls[0]?.[1];
      await act(async () => onEvent?.({ message: '» shipping artifacts' }));
      expect(container.querySelector('button')?.textContent).toBe('shipping artifacts');

      await act(async () => finish());
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('dismisses success so server warnings render again', async () => {
    useClusterCompat.mockReturnValue({ ...compat(true), warnings: ['watchdog warning'] });
    const { container, root } = await mountBanner(vi.fn().mockResolvedValue('updated'));
    try {
      await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
      expect(container.textContent).toContain('Control plane updated: v1.57.0 → v1.58.0');
      expect(container.textContent).not.toContain('watchdog warning');

      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click());
      expect(container.textContent).toContain('watchdog warning');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('auto-clears success after ten seconds so server warnings render again', async () => {
    vi.useFakeTimers();
    useClusterCompat.mockReturnValue({ ...compat(true), warnings: ['watchdog warning'] });
    const { container, root } = await mountBanner(vi.fn().mockResolvedValue('updated'));
    try {
      await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
      expect(container.textContent).toContain('Control plane updated');

      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(container.textContent).toContain('watchdog warning');
      expect(container.textContent).not.toContain('Control plane updated');
    } finally {
      await act(async () => root.unmount());
    }
  });
});
