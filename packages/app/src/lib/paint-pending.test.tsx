// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { paintPending, afterPendingPaint } from './paint-pending';
import { HostProvider } from '@/providers/host-provider';
import { ToastProvider } from '@/components/ui/toast';
import { InstalledAppsPage } from '@/pages/installed-apps';
import type { ConsoleHost } from '@/lib/host';

vi.mock('@/components/layout/workspace-switcher', () => ({
  useCurrentWorkspace: () => ({ cluster: null, kind: 'local', isLoading: false }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function frames() {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => queue.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  return async () => {
    const current = queue;
    queue = [];
    await act(async () => {
      for (const callback of current) callback(performance.now());
    });
  };
}

it('commits acknowledgment before bridge setup and leaves a frame between them', async () => {
  const frame = frames();
  const container = document.createElement('div');
  const root = createRoot(container);
  const bridge = vi.fn(() => expect(container.textContent).toBe('Working…'));
  function Action() {
    const [busy, setBusy] = React.useState(false);
    return (
      <button
        onClick={async () => {
          await paintPending(() => setBusy(true));
          bridge();
        }}
      >
        {busy ? 'Working…' : 'Start'}
      </button>
    );
  }
  try {
    await act(async () => root.render(<Action />));
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toBe('Working…');
    expect(bridge).not.toHaveBeenCalled();
    await frame();
    expect(bridge).not.toHaveBeenCalled();
    await frame();
    expect(bridge).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it('yields mutation pending notifications before invoking mutationFn', async () => {
  const frame = frames();
  const container = document.createElement('div');
  const root = createRoot(container);
  const work = vi.fn(() => {
    expect(container.textContent).toBe('Working…');
    return new Promise<void>(() => {});
  });
  function Action() {
    const mutation = useMutation({ onMutate: afterPendingPaint, mutationFn: work });
    return <button onClick={() => mutation.mutate()}>{mutation.isPending ? 'Working…' : 'Start'}</button>;
  }
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <Action />
        </QueryClientProvider>
      )
    );
    await act(async () => {
      container.querySelector('button')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe('Working…');
    expect(work).not.toHaveBeenCalled();
    await frame();
    expect(work).not.toHaveBeenCalled();
    await frame();
    expect(work).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each(['cancel', 'reject', 'install'] as const)(
  'acknowledges both install buttons before picker and restores them after %s',
  async (outcome) => {
    const frame = frames();
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.append(container);
    const picker = vi.fn(() => {
      expect(container.querySelectorAll('button[aria-busy="true"]')).toHaveLength(2);
      if (outcome === 'reject') return Promise.reject('picker unavailable');
      return Promise.resolve(outcome === 'cancel' ? null : '/tmp/app.appliance.zip');
    });
    const install = vi.fn(() => {
      expect(container.textContent).toContain('Installing…');
      return Promise.reject('bundle unavailable');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = {
      platform: 'macos',
      installedApps: { list: async () => [], pickBundle: picker, installBundle: install },
    } as unknown as ConsoleHost;
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <HostProvider host={host}>
              <ToastProvider>
                <InstalledAppsPage />
              </ToastProvider>
            </HostProvider>
          </MemoryRouter>
        )
      );
      await act(async () =>
        container.querySelector<HTMLButtonElement>('button[aria-label="Install from file"]')!.click()
      );
      const focused = container.querySelector<HTMLButtonElement>('button[aria-busy="true"]')!;
      focused.focus();
      await act(async () => focused.click());
      expect(document.activeElement).toBe(focused);
      expect(focused.getAttribute('aria-disabled')).toBe('true');
      expect(container.textContent).toContain('Choose bundle…');
      expect(picker).not.toHaveBeenCalled();
      await frame();
      expect(picker).not.toHaveBeenCalled();
      await frame();
      expect(picker).toHaveBeenCalledOnce();
      if (outcome === 'install') {
        expect(install).not.toHaveBeenCalled();
        await frame();
        expect(install).not.toHaveBeenCalled();
        await frame();
        expect(install).toHaveBeenCalledOnce();
      }
      expect(container.querySelectorAll('button[aria-label="Install from file"]')).toHaveLength(2);
      expect(container.querySelector('button[aria-busy="true"]')).toBeNull();
      container.remove();
    } finally {
      await act(async () => root.unmount());
    }
  }
);

it('does not strand pending work if the document becomes hidden between frames', async () => {
  frames();
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const done = vi.fn();
  const promise = paintPending(() => {}).then(done);
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  await promise;
  expect(done).toHaveBeenCalledOnce();
  expect(cancelAnimationFrame).toHaveBeenCalled();
});
