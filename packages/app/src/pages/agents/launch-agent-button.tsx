import * as React from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { FriendlyError } from '@/components/friendly-error';
import { AgentLoginPanel, useAgentSignedIn } from '@/components/agent-login';
import { AGENT_ADAPTERS, agentAdapter, agentLabel } from '@/lib/agents';
import { useHost } from '@/providers/host-provider';
import { useTerminalSessions, mintAgentSessionId, agentSessionKey } from '@/providers/terminal-sessions-provider';
import { cn } from '@/lib/utils';
import type { AgentAuthStatus } from '@/lib/host';

// The agent launcher lives under Agents (docs/desktop-ia.md). Moved
// here out of `pages/local-runtime/index.tsx` (where it rode along inside ②
// cluster detail until I4); ② now keeps only a thin "Run agent →" deep-link
// into this area. The observe tab it opens still lives in the GLOBAL terminal
// dock (`TerminalSessionsProvider`) — this owns the launch affordance, not a
// second terminal stack.

/** Heuristic: does an agent-launch error look like an UPSTREAM auth rejection
 *  (a stale one-year OAuth token or a bad API key)? The one-year token has no
 *  expiry surfacing — the broker injects the stored credential host-side, so an
 *  EXPIRED token does NOT trip the keyless gate; it surfaces as an opaque 401 /
 *  authentication_error from the agent. Rather than thread a mint timestamp
 *  through the `{kind,value}` Keychain envelope (a risky dual Rust+TS writer
 *  change), we detect the failure SHAPE here and offer a re-login.
 *
 *  NOTE: this catches auth failures that surface through `agent.start()` (and
 *  any error routed to the launcher). A 401 that only appears mid-run inside
 *  the observe tab's output is not auto-detected — that would need the
 *  broker/egress to thread upstream response status back to the desktop. */
export function looksLikeAuthFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('401') ||
    m.includes('unauthorized') ||
    m.includes('authentication_error') ||
    m.includes('invalid x-api-key') ||
    m.includes('invalid api key') ||
    m.includes('oauth token') ||
    m.includes('token has expired') ||
    m.includes('token expired') ||
    (m.includes('token') && m.includes('invalid'))
  );
}

// "Launch agent" (Phase 5, A5 / multi-agent G3): pick an agent type
// (claude-code / copilot / codex — driven by the AGENT_ADAPTERS registry),
// spawn it into the VM's shared workspace, and attach it as an agent-typed dock
// tab to observe + steer it. The selected agent's credential is brokered
// host-side per provider and never enters the VM — sign in here, or run
// `appliance agent login --type <agent>` once. The detached, broker-wired
// `agent-<id>` tmux session is created first (so it exists), then the observe
// tab attaches via the reattachable host-shell transport. Only rendered for dev
// VMs with a shared workspace folder.
export function LaunchAgentButton({
  name,
  agentType,
  onAgentTypeChange,
  disabledReason,
  onAuthenticated,
}: {
  name: string;
  // The agent to launch + authenticate (the `--type` key). CONTROLLED by ④
  // AgentsPage (Devon I4) so this picker and the sign-in section above share
  // one selection — switching here updates sign-in, and vice versa. Drives the
  // login panel, the per-agent sign-in status, and the launch/tab metadata.
  agentType: string;
  onAgentTypeChange: (type: string) => void;
  disabledReason?: string | null;
  onAuthenticated?: () => void;
}) {
  const host = useHost();
  const terminals = useTerminalSessions();
  const agentAuth = host.agentAuth;
  const [open, setOpen] = React.useState(false);
  const [task, setTask] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // Host-side credential status (L3). Null while unknown (still loading, or
  // the web shell has no `agentAuth`); when the desktop reports `configured:
  // false`, the launcher shows the in-app login affordance instead of the
  // task input — so a desktop-only user can authenticate without a terminal
  // rather than hitting the keyless 502.
  const [authStatus, setAuthStatus] = React.useState<AgentAuthStatus | null>(null);
  // A stored credential that upstream now REJECTS (most often a stale one-year
  // OAuth token) keeps `configured: true`, so the keyless gate won't trip — set
  // this when a launch fails with an auth-shaped error, to swap in a re-login
  // nudge instead of a dead 401. See `looksLikeAuthFailure`.
  const [reauthNudge, setReauthNudge] = React.useState(false);
  // Synchronous re-entrancy latch: the `busy` state in the keydown closure
  // is stale within the same tick, so a rapid double-Enter could fire two
  // launches before the first re-render disables the input. The ref flips
  // before any await, so the second Enter is dropped.
  const launchingRef = React.useRef(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const launcherRef = React.useRef<HTMLDivElement>(null);
  const wasOpen = React.useRef(false);

  // Per-agent "signed in" dots on the picker (Devon nit): probe every agent's
  // host store while the launcher is open, re-running after a login (keyed on
  // the selected agent's `authStatus`) so a freshly-signed-in agent lights up.
  const signedIn = useAgentSignedIn(open && Boolean(agentAuth), authStatus);

  // Refresh the SELECTED agent's credential status when the launcher opens,
  // when the agent type changes (each type has its own provider store), and
  // after a login or a keyless failure — so the gate reflects the live host
  // store for the agent the user is about to launch.
  const refreshAuth = React.useCallback(() => {
    if (!agentAuth) return;
    void agentAuth
      .status(agentType)
      .then(setAuthStatus)
      .catch(() => setAuthStatus(null));
  }, [agentAuth, agentType]);
  React.useEffect(() => {
    if (open) {
      setReauthNudge(false);
      // Clear the previous agent's status so switching types can't briefly
      // show a stale "signed in" for the new agent before its status resolves.
      setAuthStatus(null);
      refreshAuth();
    }
  }, [open, refreshAuth]);

  const needsLogin = Boolean(agentAuth) && authStatus !== null && !authStatus.configured;
  // Brief loading gate (avoids a one-frame flash of the task input before the
  // login panel): the host has the capability but the status hasn't resolved.
  const authLoading = Boolean(agentAuth) && authStatus === null;

  React.useEffect(() => {
    if (open && !authLoading) {
      requestAnimationFrame(() => {
        const launcher = launcherRef.current;
        (
          launcher?.querySelector<HTMLElement>('[data-launch-task]') ??
          launcher?.querySelector<HTMLElement>('input, button:not([disabled])')
        )?.focus();
      });
    } else if (!open && wasOpen.current) {
      triggerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open, authLoading]);

  const launch = async () => {
    if (launchingRef.current) return;
    launchingRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      const sessionId = mintAgentSessionId();
      const t = task.trim() || undefined;
      // Spawn the agent FIRST so its tmux session exists, then attach the
      // observe tab — attaching first would create an empty shell session
      // under the agent id instead of reattaching the agent. `--type` is the
      // selected adapter (claude-code / copilot / codex).
      await host.vm!.instance(name).agent.start({ type: agentType, task: t, sessionId });
      terminals.openSession({
        target: name,
        engine: 'microvm',
        clusterName: name,
        mode: 'host',
        // Distinct de-dupe namespace so a plain "Open shell" on this VM
        // can't focus/steal the agent tab (and vice versa).
        sessionKey: agentSessionKey(sessionId),
        sessionId,
        // The desktop launcher only spawns interactive agents — tag the mode
        // so the tab badge shows a steady "attached" glyph instead of the
        // perpetual "working" spinner reserved for autonomous runs. `type`
        // labels the tab so a user can tell which agent it is.
        agent: { type: agentType, status: 'running', mode: 'interactive' },
        title: t ? `Agent · ${t}` : `Agent · ${agentLabel(agentType)}`,
      });
      setOpen(false);
      setTask('');
    } catch (e) {
      // Surfaces the CLI's stderr verbatim — most often "No Anthropic key
      // configured". Re-check the host store so a keyless failure flips the
      // launcher to the in-app login affordance.
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      refreshAuth();
      // A stored-but-rejected credential (expired one-year OAuth token / bad
      // key) leaves `configured: true`, so `needsLogin` stays false — detect
      // the auth shape and offer a re-login rather than a dead error.
      if (looksLikeAuthFailure(msg)) setReauthNudge(true);
    } finally {
      setBusy(false);
      launchingRef.current = false;
    }
  };

  if (!open) {
    // Gating-off: when the VM has no shared workspace the agent can't run,
    // but keep the control visible (disabled) so the feature stays
    // discoverable rather than silently absent — AND make the reason
    // genuinely reachable (Devon). `buttonVariants` sets
    // `disabled:pointer-events-none`, so a disabled button swallows hover:
    // its native `title` tooltip never fires and it can't be focused or
    // announced. So (a) wrap it in a `<span title>` that keeps
    // pointer-events (the tooltip now fires on the span), and (b) render
    // the reason as adjacent muted text so it reaches everyone regardless.
    if (disabledReason) {
      return (
        <span className="inline-flex items-center gap-2" title={disabledReason}>
          <Button variant="outline" size="sm" disabled>
            <Bot className="h-4 w-4" /> Run agent
          </Button>
          <span role="note" className="max-w-[18rem] text-[11px] leading-snug text-[var(--color-muted-foreground)]">
            {disabledReason}
          </span>
        </span>
      );
    }
    return (
      <Button
        ref={triggerRef}
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title="Run a coding agent in the workspace and observe it in a tab"
      >
        <Bot className="h-4 w-4" /> Run agent
      </Button>
    );
  }
  const selectedLabel = agentLabel(agentType);
  const selectedBin = agentAdapter(agentType).bin;

  // The agent-type picker — claude-code / copilot / codex from the registry —
  // shown above every open-state body so the user can switch which agent they
  // launch + authenticate (each agent has its own host store, so switching
  // re-resolves the sign-in status).
  const picker = (
    <div
      role="radiogroup"
      aria-label="Agent type"
      className="flex flex-wrap gap-1"
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')
        );
        event.preventDefault();
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (current + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
        buttons[next]?.click();
      }}
    >
      {AGENT_ADAPTERS.map((a) => {
        const active = a.type === agentType;
        return (
          <button
            key={a.type}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={busy}
            onClick={() => onAgentTypeChange(a.type)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:opacity-50',
              active
                ? 'border-[var(--color-border-strong)] bg-[var(--color-accent)] text-[var(--color-foreground)]'
                : 'border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]'
            )}
          >
            <a.Icon className="h-3.5 w-3.5" aria-hidden /> {a.label}
            <span className="text-micro text-[var(--color-muted-foreground)]">
              {signedIn[a.type] ? 'Signed in' : 'Signed out'}
            </span>
          </button>
        );
      })}
    </div>
  );

  // Brief loading state while the host credential status resolves, so the task
  // input doesn't render for one frame and then swap to the login panel.
  if (authLoading) {
    return (
      <div
        ref={launcherRef}
        className="flex flex-col items-start gap-2"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <h3 className="text-sm font-semibold">Run {selectedLabel}</h3>
        {picker}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking {selectedLabel} sign-in…
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  // Keyless gate (L3): the desktop reports no stored credential for the SELECTED
  // agent, so offer its in-app login right here instead of letting the launch
  // fail at the broker. The credential is brokered in and never enters the VM.
  // The `reauthNudge` branch reuses the same panel when a stored credential was
  // rejected upstream (likely an expired token / bad key).
  if (needsLogin || reauthNudge) {
    return (
      <div
        ref={launcherRef}
        className="flex max-w-md flex-col items-start gap-2"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <h3 className="text-sm font-semibold">Run {selectedLabel}</h3>
        {picker}
        <p
          className={cn(
            'text-xs',
            reauthNudge ? 'text-[var(--color-warning-foreground)]' : 'text-[var(--color-muted-foreground)]'
          )}
        >
          {reauthNudge
            ? `Your ${selectedLabel} sign-in may have expired. Sign in again; the details stay on this computer.`
            : `Sign in to run ${selectedLabel}. Your sign-in details stay on this computer.`}
        </p>
        <AgentLoginPanel
          agentType={agentType}
          onAuthenticated={(s) => {
            setReauthNudge(false);
            setErr(null);
            setAuthStatus(s);
            onAuthenticated?.();
          }}
        />
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <div
      ref={launcherRef}
      className="flex flex-col items-start gap-2"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <h3 className="text-sm font-semibold">Run {selectedLabel}</h3>
      {picker}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Task" htmlFor={`agent-task-${name}`} optional className="w-64">
          <Input
            data-launch-task
            id={`agent-task-${name}`}
            type="text"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="e.g. Fix the failing test"
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void launch();
              if (e.key === 'Escape') setOpen(false);
            }}
          />
        </Field>
        <Button size="sm" onClick={() => void launch()} disabled={busy} aria-describedby="agent-launch-status">
          <Bot className={cn('h-3.5 w-3.5', busy && 'animate-pulse')} /> {busy ? 'Starting…' : 'Run'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          {busy ? 'Close after start' : 'Cancel'}
        </Button>
      </div>
      <span id="agent-launch-status" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {busy ? `Starting ${selectedLabel}` : ''}
      </span>
      {busy ? (
        <p className="text-xs leading-4 text-[var(--color-muted-foreground)]">
          Starting continues if you close this form.
        </p>
      ) : null}
      {/* Task-box honesty (Parker): claude + codex seed the typed task as the
          interactive TUI's first prompt; Copilot's interactive seeding is
          unverified, so its task box only LABELS the tab — say so rather than
          imply it runs. */}
      {agentType === 'copilot' ? (
        <p className="text-xs leading-4 text-[var(--color-muted-foreground)]">
          Copilot opens a fresh interactive session — a task here only labels the tab; it isn&rsquo;t run automatically.
        </p>
      ) : null}
      {/* A keyless/auth failure flips the launcher to the re-login affordance
          above; any other error shows here — plain headline, raw text behind
          Details. hideReconnect: the fix for agent-auth errors is the login
          panel, not the server connect page. */}
      {err ? (
        <FriendlyError
          error={err}
          fallbackHeadline="The agent couldn't start"
          hideReconnect
          className="max-w-[28rem] text-xs"
        />
      ) : null}
      <p className="text-xs leading-4 text-[var(--color-muted-foreground)]">
        Runs <code className="font-mono">{selectedBin}</code> in the shared workspace. Your {selectedLabel} sign-in
        details stay on this computer and are used only when the agent connects.{' '}
        {agentAuth ? (
          authStatus?.configured ? (
            <>
              Signed in
              {authStatus.kind
                ? ` (${authStatus.kind === 'oauth' ? 'Claude subscription' : authStatus.kind === 'pat' ? 'GitHub PAT' : 'API key'})`
                : ''}{' '}
              — manage above.
            </>
          ) : null
        ) : (
          <>
            Store its credential once with <code className="font-mono">appliance agent login --type {agentType}</code>.
          </>
        )}
      </p>
      {/* Honest-limits caveat (Parker): the key is brokered, but the
          workspace is not. Surface the blast radius where the user launches —
          calm plain language, same honest content. */}
      <Banner tone="warning">
        The agent can read and change files in the shared workspace folder. Don&rsquo;t point it at folders you
        don&rsquo;t want modified.
      </Banner>
    </div>
  );
}
