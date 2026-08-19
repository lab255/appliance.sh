import * as React from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { Wand, Server, Laptop, Cloud, Folder, Bot, Cog } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useKeyRole } from '@/hooks/use-key-role';
import { useAuthExpired, clearAuthFailure } from '@/lib/auth-signal';
import { ClusterCompatBanner } from '@/components/cluster-compat-banner';
import { TerminalLayer } from '@/pages/local-runtime/terminal-drawer';
import { ClusterSwitcher } from './cluster-switcher';
import { TerminalDock } from './terminal-dock';
import { Banner } from '@/components/ui/banner';

type NavItem = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  // Setup is highlighted while the shell is unconfigured (Q3); a ring
  // makes "start here" obvious without a second style of nav entry.
  prominent?: boolean;
};

export function AppShell() {
  // Adaptive Setup (docs/desktop-ia.md §8 Q3): ① is a prominent nav item
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

  // Nav: Setup (only while unconfigured) / Apps / Agents / Machine /
  // Cloud / Settings — canonical labels only. Members see Apps + Settings;
  // admin desktop sees everything; admin web (no host.vm) drops Agents +
  // Machine and keeps Cloud.
  const nav: NavItem[] = [
    ...(isOperator && !isLoading && !configured ? [{ to: '/setup', label: 'Setup', icon: Wand, prominent: true }] : []),
    { to: '/projects', label: 'Apps', icon: Folder },
    ...(isOperator && hasVm ? [{ to: '/agents', label: 'Agents', icon: Bot }] : []),
    ...(isOperator && hasVm ? [{ to: '/machine', label: 'Machine', icon: Laptop }] : []),
    ...(isOperator ? [{ to: '/cloud', label: 'Cloud', icon: Cloud }] : []),
    { to: '/settings', label: 'Settings', icon: Cog },
  ];

  return (
    // Below `sm` the sidebar collapses to an icon rail so narrow
    // windows (small desktop panes, phones) keep a usable content
    // column instead of a crushed two-column squeeze.
    // The third (auto) row holds the persistent terminal dock; it collapses
    // to zero height until a shell is open (TerminalDock renders null), so
    // the chrome is unchanged when no terminals exist.
    <div className="grid h-full grid-cols-[56px_1fr] grid-rows-[auto_1fr_auto] sm:grid-cols-[220px_1fr]">
      <aside className="row-span-3 flex flex-col border-r border-[var(--color-border)] bg-[var(--color-muted)]">
        {/* Brand — height + divider align with the content header so the
            top-left corner reads as one clean grid, not two strips. */}
        <div className="flex h-[57px] items-center gap-2.5 border-b border-[var(--color-border)] px-4">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-foreground)] text-[var(--color-background)]">
            <Server className="h-3.5 w-3.5" />
          </div>
          <span className="hidden text-sm font-semibold tracking-tight sm:block">Appliance</span>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 px-2 py-3">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              title={item.label}
              // Hover only brightens the text; the filled background is
              // reserved for the active route so the two states never
              // read the same while the pointer rests on the sidebar.
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium',
                  item.prominent
                    ? 'text-[var(--color-foreground)] ring-1 ring-inset ring-[var(--color-border-strong)]'
                    : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
                  isActive && 'bg-[var(--color-accent)] text-[var(--color-foreground)]'
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <header className="col-start-2 flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <ClusterSwitcher />
        <div className="flex items-center gap-2">{/* search / notifications slot */}</div>
      </header>

      <main className="col-start-2 min-h-0 overflow-auto p-6">
        <AuthExpiredBanner />
        <ClusterCompatBanner />
        <Outlet />
      </main>

      {/* Terminal dock — a tab strip for ALL live shells, in the grid row
          below `<main>` and OUTSIDE the `<Outlet/>`. Reachable from every
          route, so a running-but-hidden shell is never orphaned.
          Operator-only: members have no shell-opening affordances, so the
          dock (and layer) would be permanent dead chrome for them. */}
      {isOperator ? <TerminalDock /> : null}

      {/* Persistent terminal layer — OUTSIDE the `<Outlet/>` so navigating
          never unmounts the active shell. Its sessions live in
          `TerminalSessionsProvider`; this only shows/hides the view. */}
      {isOperator ? <TerminalLayer /> : null}
    </div>
  );
}

// Dismissible auth-expiry banner. The query cache's error handler raises
// the signal when any query fails with an auth-shaped error (401/403,
// invalid signature) — one banner at the top instead of scattered raw
// errors, with a Reconnect CTA into the connect page.
function AuthExpiredBanner() {
  const expired = useAuthExpired();
  if (!expired) return null;
  return (
    <Banner
      tone="warning"
      role="alert"
      className="mb-4"
      onDismiss={() => clearAuthFailure()}
      action={
        <Link
          to="/setup/connect"
          onClick={() => clearAuthFailure()}
          className="rounded-md border border-[var(--color-warning-border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-warning-background)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        >
          Reconnect
        </Link>
      }
    >
      Your connection to the server expired.
    </Banner>
  );
}
