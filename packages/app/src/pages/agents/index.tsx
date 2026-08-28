import * as React from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Circle, Server, Square, Terminal as TerminalIcon, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/ui/banner';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Tag } from '@/components/ui/tag';
import { FriendlyError } from '@/components/friendly-error';
import { AgentLoginPanel, useAgentSignedIn } from '@/components/agent-login';
import { AGENT_ADAPTERS, DEFAULT_AGENT_TYPE, agentAdapter, agentLabel } from '@/lib/agents';
import { useHost } from '@/providers/host-provider';
import { useTerminalSessions, agentSessionKey, agentBadgeStatus } from '@/providers/terminal-sessions-provider';
import { cn } from '@/lib/utils';
import type { AgentInfo, MicroVmStatus, MicroVmSummary } from '@/lib/host';
import { LaunchAgentButton } from './launch-agent-button';

// Agents is a primary area (docs/desktop-ia.md). Three surfaces are
// assembled here: per-agent SIGN-IN (moved out of ⑤ Settings), the LAUNCHER
// (moved out of ② cluster detail — pick a runtime + agent type + task), and a
// RUNS list (each runtime's `agent.list`, the durable index behind the dock's
// agent tabs). The observe terminals stay in the GLOBAL dock
// (`TerminalSessionsProvider`); this area links to them, it does not own a
// second terminal stack. Desktop-only (`host.vm`) — the nav item is hidden on
// the web shell, and the route renders a "desktop app only" message there.
export function AgentsPage() {
  const host = useHost();
  const supported = Boolean(host.vm);
  const canAgentAuth = Boolean(host.agentAuth);

  // The per-agent "signed in" map drives BOTH the sign-in picker dots and the
  // page-level cold-start banner, so it is lifted here (one probe) and shared.
  // Bumped after a login so a freshly-signed-in agent lights up and the
  // cold-start banner dismisses without a remount.
  const [authBump, setAuthBump] = React.useState(0);
  const signedIn = useAgentSignedIn(canAgentAuth, authBump);

  // ONE agent-type selection for the whole page (Devon I4): the sign-in section
  // and the launcher used to each own an independent, identical picker, so they
  // could desync — sign in Copilot up top while the launcher still defaulted to
  // Claude. Lifting `agentType` here makes the page about a single agent: its
  // sign-in state AND launching it. Both pickers read/write this one source.
  const [agentType, setAgentType] = React.useState<string>(DEFAULT_AGENT_TYPE);

  if (!supported) {
    return (
      <PageShell rail="detail">
        <PageHeader title="Agents" description="Coding agents run in a Sandbox in the Appliance desktop app." />
      </PageShell>
    );
  }

  // Cold-start (Parker I0): the host can store credentials but NONE of the
  // three agents is signed in yet. Only treat it as the no-signed-in state once
  // the probe has RESOLVED (every adapter present in the map), so the banner
  // doesn't flash before the first status read.
  const authResolved = AGENT_ADAPTERS.every((a) => a.type in signedIn);
  const anySignedIn = AGENT_ADAPTERS.some((a) => signedIn[a.type]);
  const noAgentSignedIn = canAgentAuth && authResolved && !anySignedIn;

  return (
    <PageShell rail="detail" className="space-y-6">
      <PageHeader
        title="Agents"
        description="Sign in, run a coding agent in your Sandbox workspace, and follow its session below. Sign-in details stay on this computer."
      />

      {/* Cold-start, "no signed-in agent" state (named): lead with a clear
          "sign in, then launch" call rather than dropping the user straight
          onto a launcher whose first action would 502 on a missing key. */}
      {noAgentSignedIn ? <NoSignedInAgentBanner /> : null}

      {canAgentAuth ? (
        <AgentSignIn
          signedIn={signedIn}
          agentType={agentType}
          onAgentTypeChange={setAgentType}
          onAuthenticated={() => setAuthBump((n) => n + 1)}
        />
      ) : null}

      <LauncherSection
        agentType={agentType}
        onAgentTypeChange={setAgentType}
        onAuthenticated={() => setAuthBump((n) => n + 1)}
      />

      <RunsList />
    </PageShell>
  );
}

// The "no signed-in agent" cold-start banner (Parker I0). Distinct from the
// "no runs" empty state below: this one is about CREDENTIALS, and points at the
// sign-in section that immediately follows.
function NoSignedInAgentBanner() {
  return (
    <Banner tone="info" title="Sign in to get started">
      Choose an agent and sign in. Your sign-in details stay on this computer.
    </Banner>
  );
}

function onRadioGroupKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'));
  if (!buttons.length) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (current + delta + buttons.length) % buttons.length;
  buttons[next]?.focus();
  buttons[next]?.click();
}

// Per-agent sign-in (moved out of Settings; see docs/desktop-ia.md).
// The agent-type picker + per-type "signed in" dots + the shared
// `AgentLoginPanel`. Fully presentational: the signed-in map, the login
// refresh, AND the selected `agentType` are owned by the page so this picker
// and the launcher's share one selection (Devon I4) and the cold-start banner
// stays in lock-step.
function AgentSignIn({
  signedIn,
  agentType,
  onAgentTypeChange,
  onAuthenticated,
}: {
  signedIn: Record<string, boolean>;
  agentType: string;
  onAgentTypeChange: (type: string) => void;
  onAuthenticated: () => void;
}) {
  const [manageSignIn, setManageSignIn] = React.useState(false);
  const selectedSignedIn = Boolean(signedIn[agentType]);
  React.useEffect(() => setManageSignIn(false), [agentType]);

  return (
    <SectionCard
      title="Agent sign-in"
      description="Choose the agent you want to run. Sign-in details are saved securely on this computer."
      action={
        <StatusPill
          tone={selectedSignedIn ? 'neutral' : 'warning'}
          label={selectedSignedIn ? 'Signed in' : 'Signed out'}
        />
      }
    >
      <div role="radiogroup" aria-label="Agent type" onKeyDown={onRadioGroupKeyDown} className="flex flex-wrap gap-1">
        {AGENT_ADAPTERS.map((a) => {
          const active = a.type === agentType;
          return (
            <button
              key={a.type}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onAgentTypeChange(a.type)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
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
      <div className="mt-3">
        {selectedSignedIn && !manageSignIn ? (
          <Button variant="outline" size="sm" onClick={() => setManageSignIn(true)}>
            Manage sign-in
          </Button>
        ) : (
          <AgentLoginPanel agentType={agentType} onAuthenticated={onAuthenticated} />
        )}
      </div>
    </SectionCard>
  );
}

// The launcher — pick a RUNTIME, then the task (the `LaunchAgentButton`). The
// agent TYPE is the page-level selection shared with the sign-in section above
// (Devon I4), so the launcher targets exactly the agent the user just signed in
// to. Agents need a running local runtime with a shared workspace; we list the
// running VMs and gate the launch on the selected one's `devMount`, mirroring
// the gating ② cluster detail used to apply.
function LauncherSection({
  agentType,
  onAgentTypeChange,
  onAuthenticated,
}: {
  agentType: string;
  onAgentTypeChange: (type: string) => void;
  onAuthenticated: () => void;
}) {
  const host = useHost();
  const [searchParams] = useSearchParams();
  // ② "Run agent →" deep-links with `?runtime=<name>` so the picker preselects
  // the runtime the user came from.
  const preferred = searchParams.get('runtime');

  const vmListQuery = useQuery({
    queryKey: ['microvm', 'list'],
    queryFn: () => host.vm!.list(),
    refetchInterval: 8_000,
  });
  const runningVms = (vmListQuery.data ?? []).filter((v) => v.running);

  // Which runtime to launch into. Default to the deep-link hint when it is
  // running, else the first running VM; re-resolve when the selection stops
  // running so we never strand the launcher on a dead VM.
  const [selected, setSelected] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (runningVms.length === 0) {
      if (selected !== null) setSelected(null);
      return;
    }
    const stillRunning = selected !== null && runningVms.some((v) => v.name === selected);
    if (!stillRunning) {
      const hint = preferred && runningVms.some((v) => v.name === preferred) ? preferred : runningVms[0].name;
      setSelected(hint);
    }
  }, [runningVms, selected, preferred]);

  return (
    <section className="space-y-3" aria-labelledby="launch-agent-heading">
      <h2 id="launch-agent-heading" className="text-sm font-semibold">
        Run an agent
      </h2>
      {vmListQuery.isLoading && runningVms.length === 0 ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">Checking the Sandbox…</p>
      ) : vmListQuery.isError ? (
        <EmptyState
          icon={Server}
          title="Couldn't reach the host"
          description="The Sandbox status couldn't be read. Check that the desktop app is available, then retry."
          action={
            <Button variant="outline" onClick={() => vmListQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : runningVms.length === 0 ? (
        <EmptyState
          icon={Server}
          title="Sandbox not running"
          description="Start the Sandbox to run coding agents in its shared workspace."
          action={
            <Button asChild>
              <Link to="/machine">
                <Server className="h-4 w-4" /> Go to Machine
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
          {runningVms.length > 1 ? <RuntimePicker vms={runningVms} selected={selected} onSelect={setSelected} /> : null}
          {selected ? (
            <RuntimeLauncher
              name={selected}
              agentType={agentType}
              onAgentTypeChange={onAgentTypeChange}
              onAuthenticated={onAuthenticated}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

// Pick which running runtime to launch into, when more than one is up.
function RuntimePicker({
  vms,
  selected,
  onSelect,
}: {
  vms: MicroVmSummary[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Sandbox" onKeyDown={onRadioGroupKeyDown} className="flex flex-wrap gap-1">
      {vms.map((v) => {
        const active = v.name === selected;
        return (
          <button
            key={v.name}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(v.name)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
              active
                ? 'border-[var(--color-sandbox-border)] bg-[var(--color-sandbox-background)] text-[var(--color-sandbox-foreground)]'
                : 'border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]'
            )}
          >
            <Server className="h-3.5 w-3.5" /> {v.name}
          </button>
        );
      })}
    </div>
  );
}

// The launch affordance for one runtime: resolve its status to gate on a shared
// workspace (the launcher needs `devMount`), then render the moved
// `LaunchAgentButton` with the page-shared agent type. Shares the
// `['microvm', name, 'status']` query key with ② cluster detail, so TanStack
// dedupes the poll.
function RuntimeLauncher({
  name,
  agentType,
  onAgentTypeChange,
  onAuthenticated,
}: {
  name: string;
  agentType: string;
  onAgentTypeChange: (type: string) => void;
  onAuthenticated: () => void;
}) {
  const host = useHost();
  const statusQuery = useQuery({
    queryKey: ['microvm', name, 'status'],
    queryFn: () => host.vm!.instance(name).status(),
    refetchInterval: (q) => {
      const data = q.state.data as MicroVmStatus | undefined;
      if (!data?.available) return 30_000;
      return data.running ? 8_000 : 4_000;
    },
  });
  const status = statusQuery.data;

  const needsWorkspace = Boolean(status?.running) && !status?.devMount;
  const disabledReason = statusQuery.isError
    ? "Couldn't read the Sandbox — retry below."
    : !status
      ? 'Checking the Sandbox…'
      : !status.running
        ? 'Start the Sandbox to run agents'
        : status.devMount
          ? null
          : "This machine doesn't have a shared workspace folder yet. Agents work in that folder, so set one up first.";

  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Sandbox <code className="font-mono">{name}</code>
        {status?.devMount ? (
          <>
            {' '}
            — shared workspace <code className="font-mono">{status.devMount}</code>
          </>
        ) : null}
      </p>
      <LaunchAgentButton
        name={name}
        agentType={agentType}
        onAgentTypeChange={onAgentTypeChange}
        disabledReason={disabledReason}
        onAuthenticated={onAuthenticated}
      />
      {statusQuery.isError ? (
        <FriendlyError
          error={statusQuery.error}
          headline="Couldn't read the Sandbox"
          actions={
            <Button variant="outline" size="sm" onClick={() => statusQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : null}
      {/* The fix lives on the Machine page (restart as a dev environment) —
          give it a button rather than describing the path in prose. */}
      {needsWorkspace ? (
        <Button asChild variant="outline" size="sm">
          <Link to="/machine">
            <Server className="h-3.5 w-3.5" /> Set it up on the Machine page
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

// The runs list — each running runtime's reconciled agent registry
// (`agent.list`), the durable index behind the dock's agent tabs. "Observe"
// focuses-or-opens the agent's tab through the SAME provider the launcher uses.
function RunsList() {
  const host = useHost();
  const terminals = useTerminalSessions();

  const vmListQuery = useQuery({
    queryKey: ['microvm', 'list'],
    queryFn: () => host.vm!.list(),
    refetchInterval: 8_000,
  });
  const runningVms = (vmListQuery.data ?? []).filter((v) => v.running);
  const vmNames = runningVms.map((v) => v.name).sort();

  // Fan `agent.list` out across every running VM and flatten — keyed on the
  // running-VM set so the poll re-subscribes only when a VM starts/stops.
  const runsQuery = useQuery({
    queryKey: ['agents', 'runs', vmNames.join(',')],
    enabled: vmNames.length > 0,
    queryFn: async () => {
      const perVm = await Promise.all(
        vmNames.map(async (vmName) => {
          const list = await host.vm!.instance(vmName).agent.list();
          return list.map((a) => ({ ...a, vmName }));
        })
      );
      return perVm.flat();
    },
    refetchInterval: 5_000,
  });
  const runs = runsQuery.data ?? [];

  const observe = (run: AgentInfo & { vmName: string }) => {
    // Reuse the SAME provider wiring the launcher + rehydrate use: opening a
    // session with this agent's guest id focuses an existing observe tab or
    // attaches a new one. The dock owns the terminal — this only links to it.
    terminals.openSession({
      target: run.vmName,
      engine: 'microvm',
      clusterName: run.vmName,
      mode: 'host',
      sessionKey: agentSessionKey(run.sessionId),
      sessionId: run.sessionId,
      agent: { type: run.type, status: agentBadgeStatus(run.status), mode: run.mode },
      title: run.task ? `Agent · ${run.task}` : `Agent · ${agentLabel(run.type)}`,
    });
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Runs</h2>
      {runsQuery.isLoading && runs.length === 0 ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">Loading runs…</p>
      ) : vmListQuery.isError || runsQuery.isError ? (
        <EmptyState
          icon={Bot}
          title="Couldn't load agent runs"
          description="The host didn't return the current agent sessions. Retry to check again."
          action={
            <Button
              variant="outline"
              onClick={() => {
                void vmListQuery.refetch();
                void runsQuery.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : runs.length === 0 ? (
        <NoRunsState hasRuntime={runningVms.length > 0} />
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
          {runs.map((run) => (
            <RunRow key={`${run.vmName}:${run.sessionId}`} run={run} onObserve={() => observe(run)} />
          ))}
        </ul>
      )}
    </section>
  );
}

// The "no runs" empty state (named, distinct from the no-signed-in banner): an
// agent is signed in (or a runtime is up) but nothing has been launched yet —
// point at the launcher, don't render a bare empty table.
function NoRunsState({ hasRuntime }: { hasRuntime: boolean }) {
  return (
    <EmptyState
      icon={Bot}
      title="No agents running"
      description={
        hasRuntime
          ? 'Launch a coding agent above and it appears here with its live status; its observe tab opens in the terminal dock.'
          : 'Start the Sandbox, then launch a coding agent — runs show up here with their live status.'
      }
    />
  );
}

function RunRow({ run, onObserve }: { run: AgentInfo & { vmName: string }; onObserve: () => void }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const adapter = agentAdapter(run.type);
  // An agent is observable while it is the live, attached TTY. A reconciled
  // `live: false` means the tmux session is gone, so reattaching would just
  // surface a dead shell — hide Observe then.
  const observable = run.status === 'running' && run.live !== false;
  const stopMutation = useMutation({
    mutationFn: () => host.vm!.instance(run.vmName).agent.stop(run.sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents', 'runs'] }),
  });
  const stopLabel = observable ? 'Stop' : 'Remove';
  const statusLabel =
    run.status === 'running'
      ? run.mode === 'interactive'
        ? 'Attached'
        : 'Running'
      : run.status === 'error'
        ? 'Failed'
        : run.status === 'done'
          ? 'Finished'
          : 'Ended';
  return (
    <li
      aria-label={`${agentLabel(run.type)}, ${run.task || 'no task'}, Sandbox ${run.vmName}, ${run.mode ?? 'interactive'} mode, ${statusLabel}`}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <adapter.Icon className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{run.task ? run.task : agentLabel(run.type)}</span>
            <Tag>{agentLabel(run.type)}</Tag>
          </div>
          <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">
            {run.vmName} · {run.mode ?? 'interactive'}
          </div>
        </div>
        <RunStatusPill status={run.status} mode={run.mode} />
        {observable ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onObserve}
            aria-label={`Open session for ${run.task || agentLabel(run.type)}`}
          >
            <TerminalIcon className="h-3.5 w-3.5" /> Open session
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => stopMutation.mutate()}
          disabled={stopMutation.isPending}
          aria-label={`${stopLabel} ${run.task || agentLabel(run.type)}`}
        >
          {observable ? <Square className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
          {stopMutation.isPending ? 'Stopping…' : stopLabel}
        </Button>
      </div>
      {stopMutation.error ? (
        <FriendlyError
          error={stopMutation.error}
          fallbackHeadline={`Couldn't ${stopLabel.toLowerCase()} this agent`}
          className="mx-3 mb-3"
        />
      ) : null}
    </li>
  );
}

// Registry status badge — the four-way `agent.list` status (running / done /
// error / exited), shown verbatim. `exited`/`done` read as muted (terminal),
// `error` red, `running` green.
function RunStatusPill({ status, mode }: { status: AgentInfo['status']; mode?: AgentInfo['mode'] }) {
  const running = status === 'running';
  const label = running
    ? mode === 'interactive'
      ? 'Attached'
      : 'Running'
    : status === 'error'
      ? 'Failed'
      : status === 'done'
        ? 'Finished'
        : 'Ended';
  const Icon = running ? Circle : status === 'error' ? X : Check;
  return (
    <span role="status" aria-live="polite" aria-atomic="true">
      <StatusPill
        tone={running ? 'info' : status === 'error' ? 'error' : 'neutral'}
        activity={running && mode !== 'interactive' ? 'pulse' : 'static'}
        label={
          <span className="inline-flex items-center gap-1">
            <Icon className="h-3 w-3" aria-hidden />
            {label}
          </span>
        }
      />
    </span>
  );
}
