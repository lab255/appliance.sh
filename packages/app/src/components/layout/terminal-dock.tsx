import { useTerminalSessions } from '@/providers/terminal-sessions-provider';
import { TerminalTabBar } from './terminal-tab-bar';

// Bottom terminal dock (E3.3, spec §4.2). Mounted in `app-shell.tsx` as a
// grid row OUTSIDE the route `<Outlet/>`, so it persists across navigation
// and is the always-on control surface for the live terminal set.
//
// It renders nothing until at least one session exists, so the chrome stays
// clean when no shells are open; the grid's `auto` row then collapses to 0.
// When sessions exist it sits at `z-[45]` — above the `TerminalLayer` modal
// (`z-40`) so the user can switch/close/rename tabs even while a terminal
// view is up, but below the confirm dialog (`z-50`) so the "End shell?"
// overlay always renders ABOVE the dock, never behind it.
export function TerminalDock() {
  const { sessions } = useTerminalSessions();
  if (sessions.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Terminal dock"
      className="relative z-[45] col-start-2 row-start-3 border-t border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-1.5"
    >
      <TerminalTabBar />
    </div>
  );
}
