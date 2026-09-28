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

vi.mock('@appliance.sh/ui/motion-provider', () => ({ useMotionReady: () => true }));
let reduced = false;
let listeners: Set<() => void>;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  reduced = false;
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
    await act(() => exiting.dispatchEvent(new Event('animationend', { bubbles: true })));
    expect(container.querySelector('[inert]')).toBeNull();
    expect(container.textContent).toBe('Two');
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
