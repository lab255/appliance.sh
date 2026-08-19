import * as React from 'react';
import { Check, CircleX, Loader2, Plus, Radio, X } from 'lucide-react';
import {
  useTerminalSessions,
  statusLabel,
  type AgentTabMeta,
  type TerminalSessionMeta,
} from '@/providers/terminal-sessions-provider';
import { StatusDot } from '@/components/ui/status-dot';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { agentAdapter, agentLabel } from '@/lib/agents';
import { cn } from '@/lib/utils';
import { terminalStatusTone } from '@/pages/local-runtime/terminal-drawer';

// Terminal tab strip (E3.3) — one tab per live session in the
// `TerminalSessionsProvider`. Because the strip is rendered in
// `app-shell.tsx` (outside the route `<Outlet/>`), it is reachable from
// EVERY route: a shell that is running-but-hidden (the modal dismissed,
// `activeId` null) always has a tab here, so navigating away can never
// orphan it — the user sees it and clicks back. Self-exited sessions are
// not auto-reaped; they are clearly flagged (dimmed, "Ended"/"Error" dot)
// and carry a close affordance so the user removes them deliberately.

// Compact projection of E3.2's `StatusPill`: same colour semantics
// (shared `statusDotClass`) shrunk to a single dot so it fits a tab. The
// status word is also folded into the tab button's accessible name (it is
// not colour-only) — this dot is decorative for assistive tech.
/** Plain-language label for an agent's *run* status (distinct from the PTY
 *  connection status). Folded into the tab's accessible name so the badge —
 *  which is colour/glyph-only and aria-hidden — isn't the only signal. An
 *  interactive agent reads as `attached` (a live TTY), not `running` (which
 *  would imply an autonomous task is churning). */
function agentStatusLabel(status: AgentTabMeta['status'], mode?: AgentTabMeta['mode']): string {
  if (status === 'done') return 'finished';
  if (status === 'error') return 'failed';
  return mode === 'interactive' ? 'attached' : 'running';
}

/** The agent's run status, rendered as a glyph badge DISTINCT from the PTY
 *  connection dot (`StatusDot`): a check when it finished, an x when it
 *  errored, and for a live run a STEADY "live" glyph for an interactive
 *  (attached TTY) agent vs a spinner for a genuinely-working autonomous run.
 *  An interactive agent isn't "working on a task", so a perpetual spinner
 *  would mislead it as stuck (Devon). */
function AgentStatusBadge({ status, mode }: { status: AgentTabMeta['status']; mode?: AgentTabMeta['mode'] }) {
  if (status === 'done') return <Check aria-hidden className="h-3 w-3 shrink-0 text-[var(--color-muted-foreground)]" />;
  if (status === 'error')
    return <CircleX aria-hidden className="h-3 w-3 shrink-0 text-[var(--color-destructive-foreground)]" />;
  if (mode === 'interactive')
    return <Radio aria-hidden className="h-3 w-3 shrink-0 text-[var(--color-info-foreground)]" />;
  return <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin text-[var(--color-info-foreground)]" />;
}

function TerminalTab({
  session,
  active,
  onSelect,
  onClose,
  onRename,
  tabStop,
}: {
  session: TerminalSessionMeta;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
  tabStop: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(session.title);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  // Set while cancelling so the blur that fires when the still-focused input
  // unmounts (`editing=false`) does NOT run the commit — otherwise Escape
  // would commit the discarded draft instead of dropping it.
  const skipBlurRef = React.useRef(false);
  // A self-exited / failed shell is dead weight — dim it so the live tabs
  // read first, but keep it present (and closable) per Devon's nit.
  const dead = session.status === 'closed' || session.status === 'error';
  // A coding agent (Phase 5, A5) reads distinctly from a plain shell: a
  // PER-TYPE glyph (Sparkles / Github / SquareTerminal from the registry, so
  // two differently-typed agents are distinguishable at a glance — not a
  // generic bot — Devon) + a cyan accent when active. Its tooltip + accessible
  // name carry BOTH the human agent label (agentLabel) and the task (via
  // session.title), so two same-tasked tabs of different types stay
  // distinguishable even when their visible label reads "Agent · <task>".
  const agent = session.agent;
  const AgentIcon = agent ? agentAdapter(agent.type).Icon : null;

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    // Clear the cancel latch up front: it's a plain ref (not reset on
    // re-render), so a prior Escape-cancel could leave it set and make the
    // next edit's first blur silently drop instead of commit.
    skipBlurRef.current = false;
    setDraft(session.title);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    onRename(draft);
  };
  const cancel = () => {
    skipBlurRef.current = true;
    setEditing(false);
    setDraft(session.title);
  };

  return (
    <div
      role="presentation"
      className={cn(
        'group flex h-7 max-w-[220px] items-center gap-2 rounded-md border px-2.5 text-xs',
        active
          ? 'border-[var(--color-border-strong)] bg-[var(--color-accent)] text-[var(--color-foreground)]'
          : 'border-[var(--color-border)] bg-transparent text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)]',
        // Agent tabs carry a faint cyan ring so they stand apart from the
        // shells in the same strip, even before you read the glyph. A `ring`
        // (box-shadow) is used rather than a border colour so it can't lose
        // the cascade to the active tab's `border-…-strong` (both would be
        // `border-color` utilities, and source order — not class order —
        // would decide the winner).
        agent && !dead && 'ring-1 ring-inset ring-[var(--color-info-border)]',
        dead && 'opacity-60'
      )}
      title={
        agent
          ? `${session.title} — ${agentLabel(agent.type)} agent on ${session.subtitle} · run ${agentStatusLabel(
              agent.status,
              agent.mode
            )} (shell ${statusLabel(session.status)})`
          : `${session.title} — ${session.subtitle} (${statusLabel(session.status)})`
      }
    >
      <StatusDot
        tone={terminalStatusTone(session.status)}
        label={statusLabel(session.status)}
        activity={session.status === 'open' || session.status === 'connecting' ? 'pulse' : 'static'}
        size="sm"
      />
      {agent && AgentIcon ? (
        <AgentIcon
          aria-hidden
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            dead ? 'text-[var(--color-muted-foreground)]' : 'text-[var(--color-info-foreground)]'
          )}
        />
      ) : null}
      {agent ? <AgentStatusBadge status={agent.status} mode={agent.mode} /> : null}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            // Cancel (Escape) unmounts this still-focused input, which fires
            // a blur on the removed node; that blur must NOT commit the draft
            // the user just discarded — swallow it once and reset the latch.
            if (skipBlurRef.current) {
              skipBlurRef.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(e) => {
            // Keep keystrokes out of any underlying terminal.
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') cancel();
          }}
          className="w-28 bg-transparent text-xs text-[var(--color-foreground)] outline-none"
          aria-label="Rename terminal tab"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={startEdit}
          onKeyDown={(e) => {
            // Keyboard rename path: F2 starts editing the focused tab, so
            // rename isn't double-click-only (and double-click stays as the
            // discoverable mouse route, hinted by the button title).
            if (e.key === 'F2') {
              e.preventDefault();
              startEdit();
            }
          }}
          className="min-w-0 flex-1 truncate rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          role="tab"
          data-terminal-tab
          data-session-id={session.id}
          aria-selected={active}
          tabIndex={tabStop ? 0 : -1}
          // Fold the status word (and agent label) into the accessible name
          // so a screen-reader / keyboard user can tell a live tab from a
          // dead one, and an agent from a shell — the dot + per-type glyph are
          // colour-only and aria-hidden.
          aria-label={
            agent
              ? `${session.title}, ${agentLabel(agent.type)} agent, run ${agentStatusLabel(
                  agent.status,
                  agent.mode
                )} (shell ${statusLabel(session.status)})`
              : `${session.title} (${statusLabel(session.status)})`
          }
          aria-keyshortcuts="F2"
          title="Double-click or press F2 to rename"
        >
          {session.title}
        </button>
      )}
      <span className="text-micro text-[var(--color-muted-foreground)]" aria-hidden>
        {statusLabel(session.status)}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          'shrink-0 rounded p-0.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-destructive-background)] hover:text-[var(--color-destructive-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] group-hover:opacity-100 group-focus-within:opacity-100',
          active ? 'opacity-100' : 'opacity-60'
        )}
        aria-label={dead ? `Remove ${session.title}` : `End ${session.title}`}
        title={dead ? 'Remove ended tab' : agent ? 'End agent' : 'End shell'}
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}

export function TerminalTabBar() {
  const { sessions, activeId, focusSession, closeSession, renameSession, duplicateSession } = useTerminalSessions();
  const confirm = useConfirm();

  // Close: a live shell is a destructive End (confirm first, mirroring the
  // drawer's "End shell"); a self-exited / errored tab is removed silently.
  const handleClose = React.useCallback(
    async (session: TerminalSessionMeta) => {
      if (session.status === 'open' || session.status === 'connecting') {
        const ok = await confirm(
          session.agent
            ? {
                title: 'End this agent?',
                description: "The agent's session and its running process will be terminated.",
                confirmLabel: 'End agent',
              }
            : {
                title: 'End this shell?',
                description: 'The running process will be terminated.',
                confirmLabel: 'End shell',
              }
        );
        if (!ok) return;
      }
      const index = sessions.findIndex((candidate) => candidate.id === session.id);
      const focusTarget = sessions[index + 1] ?? sessions[index - 1];
      closeSession(session.id);
      requestAnimationFrame(() => {
        const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-terminal-tab]'));
        const next = focusTarget ? tabs.find((tab) => tab.dataset.sessionId === focusTarget.id) : null;
        (next ?? document.querySelector<HTMLButtonElement>('[data-open-another-shell]'))?.focus();
      });
    },
    [confirm, closeSession, sessions]
  );

  // The "+" forks a new concurrent shell from the active tab (or the most
  // recent one) — the dock has no VM context of its own to target. The dock
  // only mounts with ≥1 session, so a fork source always exists; no disabled
  // guard is needed.
  const handleNew = React.useCallback(() => {
    const source = sessions.find((s) => s.id === activeId) ?? sessions[sessions.length - 1];
    if (source) duplicateSession(source.id);
  }, [duplicateSession, sessions, activeId]);

  return (
    <div className="flex items-center gap-2">
      {/* "Sessions" label and "+" sit OUTSIDE the scroll strip so they stay
          pinned when the tabs overflow horizontally. The strip now mixes
          plain shells and agent tabs, so it's labelled for both. */}
      <span className="shrink-0 text-micro font-medium uppercase tracking-[0.08em] text-[var(--color-muted-foreground)]">
        Sessions
      </span>
      <div
        role="tablist"
        aria-label="Terminal sessions"
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
          if (current < 0) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
          tabs[next]?.focus();
          tabs[next]?.click();
        }}
      >
        {sessions.map((session, index) => (
          <TerminalTab
            key={session.id}
            session={session}
            active={session.id === activeId}
            tabStop={session.id === activeId || (activeId === null && index === 0)}
            onSelect={() => focusSession(session.id)}
            onClose={() => void handleClose(session)}
            onRename={(title) => renameSession(session.id, title)}
          />
        ))}
      </div>
      <button
        type="button"
        data-open-another-shell
        onClick={handleNew}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        title="Open another shell on the same target"
        aria-label="Open another shell"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
