// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';

vi.mock('@/providers/host-provider', () => ({ useHost: () => ({ vm: {}, platform: 'macos' }) }));
const readiness = vi.hoisted(() => ({ mode: false, cluster: false, role: false }));
vi.mock('@/hooks/use-selected-cluster', () => ({
  useSelectedCluster: () => ({ cluster: null, isLoading: readiness.cluster }),
}));
vi.mock('@/hooks/use-key-role', () => ({ useKeyRole: () => ({ role: 'admin', isLoading: readiness.role }) }));
vi.mock('@/hooks/use-app-mode', () => ({
  useAppMode: () => ({ mode: readiness.mode ? undefined : 'developer', isLoading: readiness.mode }),
}));
vi.mock('./cluster-switcher', () => ({ ClusterSwitcher: () => null }));
vi.mock('./terminal-dock', () => ({ TerminalDock: () => null }));
vi.mock('@/pages/local-runtime/terminal-drawer', () => ({ TerminalLayer: () => null }));
vi.mock('@/components/cluster-compat-banner', () => ({ ClusterCompatBanner: () => null }));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

describe('Setup navigation styling', () => {
  it.each(['/machine', '/setup'])('has only focus rings and preserves active/press/glide styling at %s', (route) => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <MemoryRouter initialEntries={[route]}>
        <AppShell />
      </MemoryRouter>
    );
    const setup = container.querySelector('a[href="/setup"]')!;
    expect([...setup.classList].filter((name) => name.startsWith('ring-'))).toEqual([]);
    expect(setup.classList.contains('focus-visible:ring-2')).toBe(true);
    expect(setup.classList.contains('active:bg-[var(--color-active)]')).toBe(true);
    expect(setup.classList.contains('bg-[var(--color-accent)]')).toBe(route === '/setup');
    expect(setup.hasAttribute('data-hover-glide-item')).toBe(true);
    expect(setup.getAttribute('aria-current')).toBe(route === '/setup' ? 'page' : null);
  });
});

// Cold reservation is independent of the existing admin-while-resolving role policy.
describe('cold navigation reservation', () => {
  it.each(['mode', 'cluster'] as const)('waits for %s before exposing links', (pending) => {
    readiness[pending] = true;
    try {
      const container = document.createElement('div');
      container.innerHTML = renderToStaticMarkup(
        <MemoryRouter>
          <AppShell />
        </MemoryRouter>
      );
      const nav = container.querySelector('nav')!;
      expect(nav.getAttribute('aria-busy')).toBe('true');
      expect(nav.classList.contains('invisible')).toBe(true);
      expect(nav.classList.contains('flex-1')).toBe(true);
    } finally {
      readiness[pending] = false;
    }
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>
    );
    expect(container.querySelector('nav')!.classList.contains('invisible')).toBe(false);
    expect(container.querySelector('a[href="/settings"]')).not.toBeNull();
  });
});

describe('navigation reveal lifetime', () => {
  it('keeps navigation visible when role or cluster starts loading after first settle', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    readiness.cluster = true;
    try {
      await act(() =>
        root.render(
          <MemoryRouter>
            <AppShell />
          </MemoryRouter>
        )
      );
      expect(container.querySelector('nav')!.classList.contains('invisible')).toBe(true);
      readiness.cluster = false;
      await act(() =>
        root.render(
          <MemoryRouter>
            <AppShell />
          </MemoryRouter>
        )
      );
      readiness.role = true;
      await act(() =>
        root.render(
          <MemoryRouter>
            <AppShell />
          </MemoryRouter>
        )
      );
      expect(container.querySelector('nav')!.classList.contains('invisible')).toBe(false);
      readiness.cluster = true;
      readiness.mode = true;
      await act(() =>
        root.render(
          <MemoryRouter>
            <AppShell />
          </MemoryRouter>
        )
      );
      expect(container.querySelector('nav')!.classList.contains('invisible')).toBe(false);
    } finally {
      await act(() => root.unmount());
      readiness.role = readiness.cluster = readiness.mode = false;
    }
  });

  it('preserves the admin default while the initial role lookup is pending', () => {
    readiness.role = true;
    try {
      const container = document.createElement('div');
      container.innerHTML = renderToStaticMarkup(
        <MemoryRouter>
          <AppShell />
        </MemoryRouter>
      );
      expect(container.querySelector('nav')!.classList.contains('invisible')).toBe(false);
      expect(container.querySelector('a[href="/cloud"]')).not.toBeNull();
    } finally {
      readiness.role = false;
    }
  });

  it('reveals after one second even if cold host data never settles', async () => {
    vi.useFakeTimers();
    readiness.mode = readiness.cluster = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <MemoryRouter>
            <AppShell />
          </MemoryRouter>
        )
      );
      expect(container.querySelector('nav')!.classList.contains('invisible')).toBe(true);
      await act(() => vi.advanceTimersByTime(999));
      expect(container.querySelector('nav')!.classList.contains('invisible')).toBe(true);
      await act(() => vi.advanceTimersByTime(1));
      expect(container.querySelector('nav')!.classList.contains('invisible')).toBe(false);
    } finally {
      await act(() => root.unmount());
      vi.useRealTimers();
      readiness.mode = readiness.cluster = false;
    }
  });
});
