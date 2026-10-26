// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostingStatus, JourneySwap } from './journey-motion';
import { BootstrapWizardPage } from '@/pages/bootstrap/wizard';
import { HostProvider } from '@/providers/host-provider';
import type { ConsoleHost } from '@/lib/host';

const removeFrame = vi.hoisted(() => vi.fn());
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return {
    ...actual,
    usePresence: () => {
      const [present, remove] = actual.usePresence();
      const trackedRemove = React.useCallback(() => {
        removeFrame();
        remove?.();
      }, [remove]);
      return [present, trackedRemove];
    },
  };
});

vi.mock('@appliance.sh/ui/motion-provider', () => ({ useMotionReady: () => true }));
let reduced = false;
let listeners: Set<() => void>;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  reduced = false;
  removeFrame.mockClear();
  listeners = new Set();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: reduced,
    addEventListener: (_: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(children: React.ReactNode) {
  await act(() => root.render(children));
}

describe('journey motion', () => {
  it('acknowledges only an actual transition to On, never a poll or initial On', async () => {
    await render(<HostingStatus on>On</HostingStatus>);
    expect(container.querySelector('.journey-hosting')).toBeNull();
    await render(<HostingStatus on={false}>Setting up…</HostingStatus>);
    await render(<HostingStatus on>On</HostingStatus>);
    const first = container.querySelector('.journey-hosting');
    expect(first).not.toBeNull();
    await render(<HostingStatus on>On</HostingStatus>);
    expect(container.querySelector('.journey-hosting')).toBe(first);
    await render(<HostingStatus on={false}>Off</HostingStatus>);
    await render(<HostingStatus on>On</HostingStatus>);
    expect(container.querySelector('.journey-hosting')).not.toBe(first);
  });

  it('does not replay a completed or reduced acknowledgement when preferences change', async () => {
    await render(<HostingStatus on={false}>Off</HostingStatus>);
    await render(<HostingStatus on>On</HostingStatus>);
    await act(() =>
      container.querySelector('.journey-hosting')!.dispatchEvent(new Event('animationend', { bubbles: true }))
    );
    expect(container.querySelector('.journey-hosting')).toBeNull();
    reduced = true;
    await act(() => {
      for (const listener of listeners) listener();
    });
    await render(<HostingStatus on={false}>Off</HostingStatus>);
    await render(<HostingStatus on>On</HostingStatus>);
    expect(container.querySelector('.journey-hosting')).toBeNull();
    reduced = false;
    await act(() => {
      for (const listener of listeners) listener();
    });
    expect(container.querySelector('.journey-hosting')).toBeNull();
    expect(container.textContent).toBe('On');
  });

  it('removes exiting surfaces immediately under reduced motion, including preference changes', async () => {
    await render(
      <JourneySwap step="one">
        <h1>One</h1>
      </JourneySwap>
    );
    await render(
      <JourneySwap step="two">
        <h1>Two</h1>
      </JourneySwap>
    );
    expect(container.querySelector('[inert]')).not.toBeNull();
    reduced = true;
    await act(() => {
      for (const listener of listeners) listener();
    });
    expect(container.querySelector('[inert]')).toBeNull();
    expect(container.querySelector('[data-immediate="true"]')).not.toBeNull();
  });

  it('retires only the outgoing frame when its visual transition ends', async () => {
    await render(
      <JourneySwap step="one">
        <h1>One</h1>
      </JourneySwap>
    );
    await render(
      <JourneySwap step="two">
        <h1>Two</h1>
      </JourneySwap>
    );
    const exiting = container.querySelector('[inert]')!;
    const childEnd = new Event('transitionend', { bubbles: true });
    Object.defineProperty(childEnd, 'propertyName', { value: 'opacity' });
    await act(() => exiting.querySelector('h1')!.dispatchEvent(childEnd));
    const transformEnd = new Event('transitionend', { bubbles: true });
    Object.defineProperty(transformEnd, 'propertyName', { value: 'transform' });
    await act(() => exiting.dispatchEvent(transformEnd));
    expect(container.querySelector('[inert]')).toBe(exiting);
    const end = new Event('transitionend', { bubbles: true });
    Object.defineProperty(end, 'propertyName', { value: 'opacity' });
    await act(() => exiting.dispatchEvent(end));
    expect(container.querySelector('[inert]')).toBeNull();
    expect(container.textContent).toBe('Two');
  });

  it('cancels exit cleanup when the retained frame revives mid-exit', async () => {
    vi.useFakeTimers();
    const page = (step: string) => (
      <JourneySwap step={step} direction={0}>
        <h1>{step}</h1>
      </JourneySwap>
    );
    await render(page('A'));
    const original = container.querySelector('.journey-frame');
    await render(page('B'));
    expect(original?.getAttribute('data-present')).toBe('false');
    await act(() => vi.advanceTimersByTime(80));
    await render(page('A'));
    expect(container.querySelector('[data-present="true"]')).toBe(original);
    expect(original?.hasAttribute('inert')).toBe(false);
    // A's original safety deadline passes, but B's later exit is still pending.
    await act(() => vi.advanceTimersByTime(280));
    expect(removeFrame).not.toHaveBeenCalled();
    expect(original?.getAttribute('data-present')).toBe('true');
    await act(() => vi.advanceTimersByTime(80));
    expect(removeFrame).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.journey-frame')).toBe(original);
    expect(container.textContent).toBe('A');
  });

  it('retires a transitionless exit after the safety deadline', async () => {
    vi.useFakeTimers();
    await render(
      <JourneySwap step="A" direction={0}>
        <h1>A</h1>
      </JourneySwap>
    );
    await render(
      <JourneySwap step="B" direction={0}>
        <h1>B</h1>
      </JourneySwap>
    );
    // No transitionend is dispatched: both opacity and transform may stay unchanged.
    await act(() => vi.advanceTimersByTime(359));
    expect(container.querySelector('[inert]')).not.toBeNull();
    expect(removeFrame).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(1));
    expect(removeFrame).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[inert]')).toBeNull();
    expect(container.textContent).toBe('B');
  });

  it.each([false, true])('focuses the current wizard heading forward and back (reduced=%s)', async (reduce) => {
    reduced = reduce;
    const host = { vm: {}, bootstrap: {} } as ConsoleHost;
    await render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <HostProvider host={host}>
            <BootstrapWizardPage />
          </HostProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
    expect(document.activeElement?.textContent).toBe('New installation');
    const local = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Dev Machine')
    )!;
    await act(() => local.click());
    expect(document.activeElement?.textContent).toBe('Dev Machine');
    const back = [...container.querySelectorAll('[data-present="true"] button')].find((button) =>
      button.textContent?.includes('Back')
    ) as HTMLButtonElement;
    await act(() => back.click());
    expect(document.activeElement?.textContent).toBe('New installation');
  });
});
