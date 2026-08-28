import * as React from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Wand, Server, Laptop, Cloud, Folder, Bot, Cog, Grid2X2, ShoppingBag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useKeyRole } from '@/hooks/use-key-role';
import { useAuthExpired } from '@/lib/auth-signal';
import { ClusterCompatBanner } from '@/components/cluster-compat-banner';
import { TerminalLayer } from '@/pages/local-runtime/terminal-drawer';
import { ClusterSwitcher } from './cluster-switcher';
import { WorkspaceSwitcher } from './workspace-switcher';
import { TerminalDock } from './terminal-dock';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { ModeChoicePage } from '@/pages/mode-choice';
import { useAppMode } from '@/hooks/use-app-mode';
import { getAppNavigation, type AppNavKey } from '@/lib/app-navigation';

const navIcons: Record<AppNavKey, React.ComponentType<{ className?: string }>> = {
  'installed-apps': Grid2X2,
  catalogue: ShoppingBag,
  setup: Wand,
  projects: Folder,
  agents: Bot,
  machine: Laptop,
  cloud: Cloud,
  settings: Cog,
};

export function AppShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const mainRef = React.useRef<HTMLElement>(null);
  const previousPath = React.useRef(pathname);
  React.useEffect(() => {
    if (previousPath.current !== pathname) {
      mainRef.current?.focus();
      previousPath.current = pathname;
    }
  }, [pathname]);
  // Adaptive Setup (docs/desktop-ia.md): Setup is a prominent nav item
  // while unconfigured and is demoted out of the primary nav once a
  // cluster is selected (its recurring children — add-cluster, doctor —
  // surface from ② Clusters). "Unconfigured" = no selected cluster, the
  // same predicate the `/` landing resolver uses.
  const { cluster, isLoading } = useSelectedCluster();
  const configured = Boolean(cluster);

  // Agents and Machine are desktop-only — both need the local VM engine
  // (host.vm). The web shell hides them; the routes themselves render a
  // "desktop app only" message for direct links.
  const host = useHost();
  const hasVm = Boolean(host.vm);

  // Member keys (invite-onboarded teammates) get the task surface only:
  // their apps and Settings. Machine / Cloud / Agents / Setup are operator
  // tools — the API 403s a member on them anyway, so showing the nav
  // items would only manufacture dead ends.
  const { role } = useKeyRole();
  const isOperator = role === 'admin';
  const { mode, isLoading: isModeLoading, savingMode, error: modeError, setMode } = useAppMode();

  React.useEffect(() => {
    if (mode !== 'user') return;
    const isUserRoute = ['/apps', '/catalogue', '/settings'].some(
      (route) => pathname === route || pathname.startsWith(`${route}/`)
    );
    if (!isUserRoute) navigate('/apps', { replace: true });
  }, [mode, navigate, pathname]);

  // User mode is the runner set. Developer mode appends the existing
  // build surfaces under a Develop label without weakening their role,
  // VM-capability, or configured-state gates.
  const nav = getAppNavigation({
    mode: mode ?? 'user',
    isOperator,
    hasVm,
    configured,
    isLoading,
  });
  const isChoosingMode = !isModeLoading && mode === null;

  return (
    // Below `sm` the sidebar collapses to an icon rail so narrow
    // windows (small desktop panes, phones) keep a usable content
    // column instead of a crushed two-column squeeze.
    // The third (auto) row holds the persistent terminal dock; it collapses
    // to zero height until a shell is open (TerminalDock renders null), so
    // the chrome is unchanged when no terminals exist.
    <div className="grid h-full overflow-hidden grid-cols-[56px_1fr] grid-rows-[auto_1fr_auto] sm:grid-cols-[220px_1fr]">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[60] -translate-y-20 rounded-md bg-[var(--color-surface-overlay)] px-3 py-2 text-sm font-medium focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
      >
        Skip to content
      </a>
      <aside className="row-span-3 flex flex-col border-r border-[var(--color-border)] bg-[var(--color-muted)]">
        {/* Brand — height + divider align with the content header so the
            top-left corner reads as one clean grid, not two strips. */}
        <div className="flex h-[57px] shrink-0 items-center gap-2.5 border-b border-[var(--color-border)] px-4">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-foreground)] text-[var(--color-background)]">
            <Server className="h-3.5 w-3.5" aria-hidden />
          </div>
          <span className="hidden text-sm font-semibold tracking-tight sm:block">Appliance</span>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 px-2 py-3">
          {nav.map((item) => {
            const Icon = navIcons[item.key];
            return (
              <React.Fragment key={item.to}>
                {item.group ? (
                  <div className="px-2.5 pb-1 pt-3 text-micro font-medium uppercase tracking-[0.08em] text-[var(--color-muted-foreground)]">
                    Develop
                  </div>
                ) : null}
                {isChoosingMode ? (
                  <span
                    role="link"
                    aria-disabled="true"
                    tabIndex={-1}
                    className="pointer-events-none flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-[var(--color-muted-foreground)] opacity-50"
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="hidden sm:inline">{item.label}</span>
                  </span>
                ) : (
                  <NavLink
                    to={item.to}
                    title={item.label}
                    // Hover only brightens the text; the filled background is
                    // reserved for the active route so the two states never
                    // read the same while the pointer rests on the sidebar.
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
                        item.prominent
                          ? 'text-[var(--color-foreground)] ring-1 ring-inset ring-[var(--color-border-strong)]'
                          : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
                        isActive && 'bg-[var(--color-accent)] text-[var(--color-foreground)]'
                      )
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="hidden sm:inline">{item.label}</span>
                  </NavLink>
                )}
              </React.Fragment>
            );
          })}
        </nav>
        {mode === 'developer' ? (
          <div className="hidden border-t border-[var(--color-border)] p-3 sm:block">
            <StatusPill tone="info" dot={false} label="Developer mode" />
          </div>
        ) : null}
      </aside>

      <header className="col-start-2 flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        {mode === 'user' ? (
          <WorkspaceSwitcher
            onSetup={() => {
              void setMode('developer')
                .then(() => navigate('/setup'))
                .catch(() => undefined);
            }}
          />
        ) : (
          <ClusterSwitcher />
        )}
        <div className="flex items-center gap-2">
          {mode === 'developer' ? <StatusPill tone="info" dot={false} label="Developer mode" /> : null}
        </div>
      </header>

      <main
        ref={mainRef}
        id="main-content"
        tabIndex={-1}
        className="col-start-2 min-h-0 overflow-auto p-6 focus:outline-none"
      >
        {isModeLoading ? null : mode === null ? (
          <ModeChoicePage
            platform={host.platform}
            savingMode={savingMode}
            error={modeError}
            onSelect={(nextMode) => {
              void setMode(nextMode)
                .then(() => navigate(nextMode === 'user' ? '/apps' : '/'))
                .catch(() => undefined);
            }}
          />
        ) : (
          <>
            <AuthExpiredBanner />
            <ClusterCompatBanner />
            <Outlet />
          </>
        )}
      </main>

      {/* Terminal dock — a tab strip for ALL live shells, in the grid row
          below `<main>` and OUTSIDE the `<Outlet/>`. Reachable from every
          route, so a running-but-hidden shell is never orphaned.
          Operator-only: members have no shell-opening affordances, so the
          dock (and layer) would be permanent dead chrome for them. */}
      {isOperator && mode === 'developer' ? <TerminalDock /> : null}

      {/* Persistent terminal layer — OUTSIDE the `<Outlet/>` so navigating
          never unmounts the active shell. Its sessions live in
          `TerminalSessionsProvider`; this only shows/hides the view. */}
      {isOperator && mode === 'developer' ? <TerminalLayer /> : null}
    </div>
  );
}

// Dismissible auth-expiry banner. The query cache's error handler raises
// the signal when any query fails with an auth-shaped error (401/403,
// invalid signature) — one banner at the top instead of scattered raw
// errors, with a Reconnect CTA into the connect page.
function AuthExpiredBanner() {
  const expired = useAuthExpired();
  const [hidden, setHidden] = React.useState(false);
  React.useEffect(() => {
    if (!expired) setHidden(false);
  }, [expired]);
  if (!expired || hidden) return null;
  return (
    <Banner
      tone="warning"
      role="alert"
      className="mb-4"
      action={
        <>
          <Link
            to="/setup/connect"
            className="rounded-md border border-[var(--color-warning-border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-warning-background)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          >
            Reconnect
          </Link>
          <Button variant="ghost" size="sm" onClick={() => setHidden(true)}>
            Hide for now
          </Button>
        </>
      }
    >
      Your connection to the server expired.
    </Banner>
  );
}
