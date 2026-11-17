// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { RefetchButton } from './refetch-button';
import { AccountSection } from '@/pages/settings-account';
import { HostProvider } from '@/providers/host-provider';
import type { ConsoleHost } from '@/lib/host';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
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
async function render(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  await act(async () => root.render(node));
  return container;
}

it('paints before queryFn, suppresses rapid duplicate activation and retains focus through settlement', async () => {
  const frame = frames();
  let finish!: () => void;
  const work = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const client = new QueryClient();
  cleanups.push(async () => client.clear());
  function Action() {
    const query = useQuery({ queryKey: ['click'], queryFn: work, enabled: false });
    return (
      <RefetchButton disabled={query.isFetching} onRefetch={() => query.refetch()}>
        Retry
      </RefetchButton>
    );
  }
  const container = await render(
    <QueryClientProvider client={client}>
      <Action />
    </QueryClientProvider>
  );
  const button = container.querySelector('button')!;
  button.focus();
  await act(async () => {
    button.click();
    button.click();
  });
  expect(button.getAttribute('aria-busy')).toBe('true');
  expect(button.getAttribute('aria-label')).toBe('Retrying…');
  expect(button.disabled).toBe(false);
  expect(document.activeElement).toBe(button);
  expect(work).not.toHaveBeenCalled();
  await frame();
  expect(work).not.toHaveBeenCalled();
  await frame();
  expect(work).toHaveBeenCalledOnce();
  await act(async () => button.click());
  expect(work).toHaveBeenCalledOnce();
  await act(async () => {
    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(button.getAttribute('aria-busy')).toBe('false');
  expect(document.activeElement).toBe(button);
});

it('leaves the default 1s/2s/4s React Query retry signature intact', async () => {
  vi.useFakeTimers();
  const frame = frames();
  const starts: number[] = [];
  const client = new QueryClient();
  cleanups.push(async () => client.clear());
  function Action() {
    const query = useQuery({
      queryKey: ['fail'],
      enabled: false,
      queryFn: () => {
        starts.push(Date.now());
        throw new Error('offline');
      },
    });
    return <RefetchButton onRefetch={() => query.refetch()}>Retry</RefetchButton>;
  }
  const container = await render(
    <QueryClientProvider client={client}>
      <Action />
    </QueryClientProvider>
  );
  await act(async () => container.querySelector('button')!.click());
  expect(starts).toHaveLength(0);
  await frame();
  await frame();
  expect(starts).toHaveLength(1);
  for (const delay of [1000, 2000, 4000]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(delay);
    });
  }
  expect(starts.slice(1).map((time, index) => time - starts[index])).toEqual([1000, 2000, 4000]);
  expect(container.querySelector('button')!.getAttribute('aria-busy')).toBe('false');
});

it('does not start a queued refetch after unmount', async () => {
  const frame = frames();
  const work = vi.fn(async () => {});
  const container = await render(<RefetchButton onRefetch={work}>Retry</RefetchButton>);
  await act(async () => container.querySelector('button')!.click());
  await cleanups.pop()!();
  await frame();
  await frame();
  expect(work).not.toHaveBeenCalled();
});

it('keeps initial account read and 2s polling immediate while yielding only the retry click', async () => {
  vi.useFakeTimers();
  const frame = frames();
  const status = vi.fn(async () => {
    throw new Error('offline');
  });
  const host = { account: { status } } as unknown as ConsoleHost;
  const container = await render(
    <HostProvider host={host}>
      <AccountSection />
    </HostProvider>
  );
  expect(status).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(status).toHaveBeenCalledTimes(2);
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Retry account'))!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(button.getAttribute('aria-busy')).toBe('true');
  expect(status).toHaveBeenCalledTimes(2);
  await frame();
  expect(status).toHaveBeenCalledTimes(2);
  await frame();
  expect(status).toHaveBeenCalledTimes(3);
  expect(button.getAttribute('aria-busy')).toBe('false');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(status).toHaveBeenCalledTimes(4);
});

it('keeps unavailable controls idle and focusable without starting work', async () => {
  const work = vi.fn(async () => {});
  const container = await render(
    <RefetchButton disabled onRefetch={work}>
      Refresh
    </RefetchButton>
  );
  const button = container.querySelector('button')!;
  button.focus();
  await act(async () => button.click());
  expect(work).not.toHaveBeenCalled();
  expect(button.getAttribute('aria-busy')).toBe('false');
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.disabled).toBe(false);
  expect(document.activeElement).toBe(button);
});
