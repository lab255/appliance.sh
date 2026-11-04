// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';

vi.mock('@/providers/host-provider', () => ({ useHost: () => ({ vm: {}, platform: 'macos' }) }));
vi.mock('@/hooks/use-selected-cluster', () => ({ useSelectedCluster: () => ({ cluster: null, isLoading: false }) }));
vi.mock('@/hooks/use-key-role', () => ({ useKeyRole: () => ({ role: 'admin' }) }));
vi.mock('@/hooks/use-app-mode', () => ({ useAppMode: () => ({ mode: 'developer', isLoading: false }) }));
vi.mock('./cluster-switcher', () => ({ ClusterSwitcher: () => null }));
vi.mock('./terminal-dock', () => ({ TerminalDock: () => null }));
vi.mock('@/pages/local-runtime/terminal-drawer', () => ({ TerminalLayer: () => null }));
vi.mock('@/components/cluster-compat-banner', () => ({ ClusterCompatBanner: () => null }));

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
