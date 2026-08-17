import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Download,
  FolderOpen,
  Play,
  Rocket,
  Square,
  Stethoscope,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from 'lucide-react';
import { createApplianceClient } from '@appliance.sh/sdk/client';
import { Button } from '@/components/ui/button';
import { FriendlyError } from '@/components/friendly-error';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useHost } from '@/providers/host-provider';
import { useTerminalSessions } from '@/providers/terminal-sessions-provider';
import { cn } from '@/lib/utils';
import { devMachineLabel } from '@/lib/host';
import type { MicroVmStatus, MicroVmSummary } from '@/lib/host';
import { DoctorPanel } from '@/pages/setup/doctor';
// PARKER CONTINUITY: workloads moved to ③ env-detail in I3, but the
// machine-scoped "what's running on THIS VM, across all apps" view stays
// reachable here as the Workloads tab — it imports the same panel from its
// new home rather than being stranded or duplicated.
import { WorkloadsPanel } from '@/pages/environments/workloads-panel';
import { EgressPanel } from './egress-panel';
import { CredentialsPanel } from './credentials-panel';

type RuntimeTab = 'lifecycle' | 'egress' | 'credentials' | 'facts' | 'workloads';

// The Dev Machine detail — per-VM management rendered as TABS (Parker) —
// Lifecycle · Egress · Credentials · Facts — so the decomposition isn't
// undone in one long scroll at the leaf. Workloads is the machine-scoped
// 5th tab (its panel lives in ③ env-detail; this is the deep-link to
// "what's running on THIS VM"). The agent launcher lives in ④ Agents —
// Lifecycle keeps a thin "Run agent →" deep-link (preselecting this VM).
// Rendered by /machine (pages/machine/index.tsx) for the selected local VM.
//
// THE EGRESS DOUBLE-FETCH FIX (docs/desktop-ia.md §5.5): the single
// `['microvm', name, 'egress']` policy poll lives HERE and is passed down —
// `policy` to the Egress tab, `mitm` to the Credentials tab — instead of
// each panel registering its own 15 s observer.
export function RuntimeDetail({ name, clusterId }: { name: string; clusterId: string }) {
  const host = useHost();
  const terminals = useTerminalSessions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const vm = React.useMemo(() => host.vm!.instance(name), [host, name]);
  const isDefault = name === 'appliance';

  const [tab, setTab] = React.useState<RuntimeTab>('lifecycle');

  const statusQuery = useQuery({
    queryKey: ['microvm', name, 'status'],
    queryFn: () => vm.status(),
    refetchInterval: (q) => {
      const data = q.state.data as MicroVmStatus | undefined;
      if (!data?.available) return 30_000;
      return data.running ? 8_000 : 4_000;
    },
  });
  const status = statusQuery.data;

  // The VM's `list` summary carries the allocated host ports for the Facts
  // tab. Same key the clusters index uses, so TanStack dedupes the fetch.
  const vmListQuery = useQuery({
    queryKey: ['microvm', 'list'],
    queryFn: () => host.vm!.list(),
    refetchInterval: 8_000,
  });
  const summary: MicroVmSummary | undefined = vmListQuery.data?.find((v) => v.name === name);

  const [busy, setBusy] = React.useState<'install' | 'up' | 'cluster' | 'stop' | 'delete' | null>(null);
  const [log, setLog] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  // Which lifecycle action produced `error` — picks the plain-language
  // headline ("couldn't start" vs "couldn't be installed" …).
  const [errorAction, setErrorAction] = React.useState<'install' | 'up' | 'cluster' | 'stop' | 'delete' | null>(null);
  // Whether the next Start should provision a dev environment. Forced on
  // once the VM is already a dev VM (the engine flag is one-way).
  const [devMode, setDevMode] = React.useState(false);
  // Host folder to share into /persist/workspace on the next dev boot.
  const [mountPath, setMountPath] = React.useState<string | null>(null);
  const logRef = React.useRef<HTMLPreElement | null>(null);

  React.useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['microvm', name] });
    queryClient.invalidateQueries({ queryKey: ['microvm', 'list'] });
  };

  const run = async (
    kind: 'install' | 'up' | 'cluster' | 'stop' | 'delete',
    action: () => Promise<void>
  ): Promise<boolean> => {
    setBusy(kind);
    setError(null);
    setErrorAction(null);
    if (kind === 'up' || kind === 'cluster') setLog([]);
    try {
      await action();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setErrorAction(kind);
      return false;
    } finally {
      setBusy(null);
      refresh();
      // Cluster promotion registers the microVM cluster; delete removes it.
      if (kind === 'cluster' || kind === 'delete') {
        queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      }
    }
  };

  // Deploy into this engine: make its cluster the selected one (the
  // wizard targets the selection), then open the wizard.
  const deployHere = async () => {
    if (!status?.clusterProvisioned) {
      const onLog = (e: { message: string }) => setLog((prev) => [...prev.slice(-199), e.message]);
      const provisioned = await run('cluster', () => vm.clusterUp(onLog));
      if (!provisioned) return;
    }
    try {
      const cfg = await host.getConfig();
      if (cfg.selectedClusterId !== clusterId) {
        await host.selectCluster(clusterId);
        queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      }
    } catch {
      // Selection is a convenience — the wizard surfaces the actual
      // target either way.
    }
    navigate('/projects/deploy');
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: `Delete the "${name}" VM?`,
      description: 'Everything inside the VM (apps, images, deployments) is destroyed.',
      confirmLabel: 'Delete VM',
    });
    if (!ok) return;
    void run('delete', () => vm.remove());
  };

  // The Rust side registers the microVM as a regular cluster once it's
  // ready (sync_microvm_cluster). That can happen on a passive status poll
  // — nudge the host-config query once per ready transition so the freshly-
  // registered cluster becomes selectable without a desktop restart.
  const vmRunning = Boolean(status?.running);
  const microVmReady = Boolean(status?.running && status?.kubeconfigReady);
  const refreshedForReady = React.useRef(false);
  React.useEffect(() => {
    if (microVmReady && !refreshedForReady.current) {
      refreshedForReady.current = true;
      queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
    } else if (!microVmReady) {
      refreshedForReady.current = false;
    }
  }, [microVmReady, queryClient]);

  // Cluster-ready probe: the engine's `kubeconfigReady` says k3s answers,
  // but "ready" for the console means the in-VM api-server is actually
  // serving. Probe its unauthenticated `/healthz` once the VM reports ready.
  const healthClient = React.useMemo(
    () => (status?.apiServerUrl ? createApplianceClient({ baseUrl: status.apiServerUrl }) : null),
    [status?.apiServerUrl]
  );
  const healthzQuery = useQuery({
    queryKey: ['microvm', name, 'healthz', status?.apiServerUrl ?? ''],
    enabled: Boolean(healthClient) && microVmReady,
    queryFn: async () => {
      const res = await healthClient!.healthz();
      return res.success;
    },
    refetchInterval: (q) => (q.state.data === true ? 15_000 : 3_000),
  });
  const clusterServing = microVmReady && healthzQuery.data === true;

  // THE lifted egress-policy query — one observer for the whole detail.
  // Egress and the credential broker are core-layer services, so they are
  // available as soon as the VM is running; they do not wait for k3s.
  // The Egress tab reads `policy`; the Credentials tab reads `mitm`.
  const policyQuery = useQuery({
    queryKey: ['microvm', name, 'egress'],
    enabled: vmRunning,
    queryFn: () => vm.egress.get(),
    refetchInterval: 15_000,
  });

  const state = !status
    ? 'checking…'
    : !status.available
      ? busy === 'install'
        ? 'installing…'
        : status.installable
          ? 'not installed'
          : 'unavailable'
      : busy === 'up'
        ? 'starting…'
        : busy === 'cluster'
          ? 'provisioning…'
          : status.running
            ? status.phase === 'failed'
              ? 'failed'
              : !status.clusterProvisioned
                ? 'core ready'
                : clusterServing
                  ? 'running'
                  : 'starting…'
            : status.exists
              ? 'stopped'
              : 'not created';

  // Q4 (docs/desktop-ia.md §8): surface the prerequisite Doctor prominently
  // when the runtime can't start (failed / engine unavailable), otherwise
  // offer it behind a "Re-run checks" toggle. Either way it's the SAME
  // PreflightPanel as ① /setup/doctor — one implementation, two entry points.
  const wontStart = state === 'failed' || state === 'unavailable';

  const statusPill = (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md px-2 py-1 text-xs font-medium',
        state === 'running' || state === 'core ready'
          ? 'border border-green-500/40 bg-green-500/15 text-green-300'
          : state === 'starting…'
            ? 'border border-cyan-500/40 bg-cyan-500/15 text-cyan-300'
            : state === 'failed'
              ? 'border border-red-500/40 bg-red-500/15 text-red-300'
              : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]'
      )}
    >
      {state}
    </span>
  );

  const tabs: Array<{ id: RuntimeTab; label: string; enabled: boolean }> = [
    { id: 'lifecycle', label: 'Lifecycle', enabled: true },
    { id: 'egress', label: 'Egress', enabled: vmRunning },
    { id: 'credentials', label: 'Credentials', enabled: vmRunning },
    { id: 'facts', label: 'Facts', enabled: vmRunning },
    { id: 'workloads', label: 'Workloads', enabled: clusterServing },
  ];
  // Don't strand the user on a tab that just became disabled (VM stopped).
  const activeTab = tabs.find((t) => t.id === tab && t.enabled) ? tab : 'lifecycle';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-sm font-semibold">{name}</code>
          <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300">
            isolated VM
          </span>
          {isDefault ? (
            <span className="rounded bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-muted-foreground)]">
              default
            </span>
          ) : null}
        </div>
        {statusPill}
      </div>

      {/* Tab strip */}
      <div
        role="tablist"
        aria-label="Dev Machine detail"
        className="flex flex-wrap gap-1 border-b border-[var(--color-border)]"
      >
        {tabs.map((t) => {
          const active = t.id === activeTab;
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={active}
              disabled={!t.enabled}
              onClick={() => setTab(t.id)}
              title={
                t.enabled
                  ? undefined
                  : t.id === 'workloads' && vmRunning
                    ? 'Provision the deployment layer to use this tab'
                    : 'Start the Dev Machine to use this tab'
              }
              className={cn(
                '-mb-px border-b-2 px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40',
                active
                  ? 'border-[var(--color-accent)] text-[var(--color-foreground)]'
                  : 'border-transparent text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]'
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab panels */}
      {activeTab === 'lifecycle' ? (
        <div className="space-y-3">
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {status?.clusterProvisioned ? (
              <>
                Deploys use the <code className="font-mono">{clusterId}</code> profile.
              </>
            ) : (
              'Core sandbox boots stay fast; the deployment layer is added only when you need it.'
            )}
          </p>

          {status && !status.available ? (
            status.installable ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] px-3 py-2">
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  The engine binary (<code className="font-mono">appliance-vm</code>) isn&apos;t installed yet —
                  Appliance installs it into <code className="font-mono">~/.appliance/bin</code>.
                </p>
                <Button onClick={() => run('install', () => host.vm!.install())} disabled={busy !== null}>
                  <Download className="h-4 w-4" /> {busy === 'install' ? 'Installing…' : 'Install engine'}
                </Button>
              </div>
            ) : (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
                {status.message ?? 'appliance-vm is not installed on this machine.'}
              </p>
            )
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  const onLog = (e: { message: string }) => setLog((prev) => [...prev.slice(-199), e.message]);
                  // Dev once dev: the engine flag is one-way, so a dev VM
                  // always re-provisions through `dev up`.
                  const wantDev = devMode || status?.dev === true;
                  void run('up', () => (wantDev ? vm.devUp(onLog, { mount: mountPath ?? undefined }) : vm.up(onLog)));
                }}
                disabled={busy !== null || status?.running === true}
              >
                <Play className="h-4 w-4" />{' '}
                {busy === 'up'
                  ? 'Starting…'
                  : status?.running
                    ? 'Running'
                    : devMode || status?.dev
                      ? 'Start dev env'
                      : 'Start'}
              </Button>
              <Button
                variant="outline"
                onClick={() => run('stop', () => vm.stop())}
                disabled={busy !== null || !status?.running}
              >
                <Square className="h-4 w-4" /> {busy === 'stop' ? 'Stopping…' : 'Stop'}
              </Button>
              <Button variant="destructive" onClick={onDelete} disabled={busy !== null || !status?.exists}>
                <Trash2 className="h-4 w-4" /> {busy === 'delete' ? 'Deleting…' : 'Delete'}
              </Button>
              {status?.dev ? (
                <span className="inline-flex items-center gap-1 rounded bg-violet-500/15 px-2 py-1 text-xs text-violet-300">
                  <TerminalIcon className="h-3.5 w-3.5" /> dev environment
                </span>
              ) : !status?.running ? (
                <label
                  className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]"
                  title="Provision a dev toolchain + a persistent /persist/workspace you can shell into"
                >
                  <input
                    type="checkbox"
                    checked={devMode}
                    onChange={(e) => setDevMode(e.target.checked)}
                    disabled={busy !== null}
                  />
                  dev environment
                </label>
              ) : null}
              {(devMode || status?.dev) && !status?.running && host.local?.pickDirectory ? (
                <div className="inline-flex items-center gap-1.5 text-xs">
                  <button
                    type="button"
                    onClick={async () => {
                      const picked = await host.local?.pickDirectory();
                      if (picked) setMountPath(picked);
                    }}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-muted)]"
                    title="Share a host folder into /persist/workspace (edit on host, run in VM)"
                  >
                    <FolderOpen className="h-3.5 w-3.5" /> {mountPath ? 'Change folder' : 'Share a folder…'}
                  </button>
                  {mountPath ? (
                    <span
                      className="inline-flex items-center gap-1 text-[var(--color-muted-foreground)]"
                      title={mountPath}
                    >
                      <span className="max-w-[14rem] truncate font-mono">{mountPath}</span>
                      <button
                        type="button"
                        onClick={() => setMountPath(null)}
                        className="hover:text-[var(--color-foreground)]"
                        title="Stop sharing this folder"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          {status?.running && !status.clusterProvisioned ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-cyan-500/40 bg-cyan-500/5 px-3 py-2">
              <div>
                <p className="text-sm font-medium text-cyan-200">Core sandbox ready</p>
                <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                  The deployment layer is not provisioned. Adding it restarts this VM once and preserves dev mode.
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  const onLog = (e: { message: string }) => setLog((prev) => [...prev.slice(-199), e.message]);
                  void run('cluster', () => vm.clusterUp(onLog));
                }}
                disabled={busy !== null}
              >
                <Rocket className="h-4 w-4" />
                {busy === 'cluster' ? 'Provisioning…' : 'Provision deployment layer'}
              </Button>
            </div>
          ) : null}

          {error ? (
            <FriendlyError
              error={error}
              fallbackHeadline={
                errorAction === 'install'
                  ? "The local runtime couldn't be installed"
                  : errorAction === 'stop'
                    ? "The machine couldn't be stopped"
                    : errorAction === 'delete'
                      ? "The machine couldn't be deleted"
                      : errorAction === 'cluster'
                        ? "The deployment layer couldn't be provisioned"
                        : "The local machine couldn't start"
              }
            />
          ) : null}

          {busy === 'up' || busy === 'cluster' || log.length > 0 ? (
            <pre
              ref={logRef}
              className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-black/40 p-3 font-mono text-[11px] leading-relaxed"
            >
              {log.join('\n') || (busy === 'cluster' ? 'Provisioning deployment layer…' : 'Starting…')}
            </pre>
          ) : null}

          {status?.running && status.kubeconfigReady ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Available as <span className="font-medium text-[var(--color-foreground)]">{devMachineLabel(name)}</span>{' '}
                in the target switcher
              </p>
              <div className="flex items-center gap-2">
                {host.terminal ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      terminals.openSession({
                        target: name,
                        engine: 'microvm',
                        clusterName: name,
                        mode: status.dev ? 'dev' : 'host',
                      })
                    }
                    disabled={busy !== null}
                    title={
                      status.dev
                        ? 'Open a shell in the dev workspace (/persist/workspace)'
                        : 'Open a root shell on the microVM host'
                    }
                  >
                    <TerminalIcon className="h-4 w-4" /> {status.dev ? 'Open dev shell' : 'Open shell'}
                  </Button>
                ) : null}
                {/* The launcher itself lives in ④ Agents (I4). Keep a thin
                    deep-link here, preselecting this VM via `?runtime=`,
                    so "run an agent on this VM" stays one click from detail. */}
                {host.terminal && host.vm ? (
                  <Button asChild variant="outline" size="sm">
                    <Link
                      to={`/agents?runtime=${encodeURIComponent(name)}`}
                      title="Launch a coding agent in the Agents area"
                    >
                      <Bot className="h-4 w-4" /> Run agent →
                    </Link>
                  </Button>
                ) : null}
                <Button variant="outline" size="sm" onClick={() => void deployHere()} disabled={busy !== null}>
                  <Rocket className="h-4 w-4" /> Deploy app
                </Button>
              </div>
            </div>
          ) : null}

          {/* Q4 — Doctor re-run entry. Prominent when the runtime won't start;
              otherwise tucked behind a toggle. Reuses ① /setup/doctor's panel. */}
          <RuntimeDiagnostics defaultOpen={wontStart} />
        </div>
      ) : null}

      {activeTab === 'egress' ? (
        <EgressPanel vm={vm} name={name} policy={policyQuery.data} policyError={policyQuery.error} />
      ) : null}

      {activeTab === 'credentials' ? (
        <CredentialsPanel vm={vm} name={name} mitmOn={policyQuery.data?.mitm ?? false} />
      ) : null}

      {activeTab === 'facts' && status ? (
        <MicroVmFacts apiServerUrl={status.apiServerUrl} clusterId={clusterId} summary={summary} />
      ) : null}

      {/* Machine-scoped Workloads — the same panel ③ env-detail renders,
          here scoped to this VM (Parker continuity). */}
      {activeTab === 'workloads' ? <WorkloadsPanel clusterId={clusterId} vmName={name} /> : null}
    </div>
  );
}

// Q4: the prerequisite Doctor, reachable from the machine detail. Reuses the
// SAME DoctorPanel as ① /setup/doctor — one PreflightPanel, two entry points.
function RuntimeDiagnostics({ defaultOpen }: { defaultOpen: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  // Re-open automatically if the VM transitions into a won't-start state
  // while the section is collapsed.
  React.useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Stethoscope className="h-3.5 w-3.5" /> Re-run checks
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Stethoscope className="h-4 w-4" /> Diagnose prerequisites
        </div>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Hide
        </Button>
      </div>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        The same prerequisite checks as <span className="font-medium">Setup → Doctor</span> — kubectl for workload views
        and pod shells, with one-click installs. Docker isn&rsquo;t required — images build server-side.
      </p>
      <DoctorPanel />
    </div>
  );
}

// Facts for a running VM. The plain-language summary (what this machine
// is, where it shows up) leads; the raw technical facts — Kubernetes URL,
// profile id, port numbers — live behind a collapsed "Technical details"
// disclosure rather than top-level.
function MicroVmFacts({
  apiServerUrl,
  clusterId,
  summary,
}: {
  apiServerUrl: string;
  clusterId: string;
  summary?: MicroVmSummary;
}) {
  const facts: Array<[string, React.ReactNode]> = [
    ['Kubernetes', <code className="font-mono">{apiServerUrl}</code>],
    ['Profile', <code className="font-mono">{clusterId}</code>],
  ];
  if (summary) {
    facts.push([
      'Ports',
      <code className="font-mono">
        ingress :{summary.hostPort} · k8s :{summary.apiPort} · registry :{summary.registryPort} · egress :
        {summary.egressPort}
      </code>,
    ]);
  }
  return (
    <div className="space-y-2 rounded-md border border-[var(--color-border)] px-3 py-2">
      <p className="text-xs text-[var(--color-muted-foreground)]">
        An isolated virtual machine running on this computer. It shows up as a deploy target in the target switcher.
      </p>
      <details>
        <summary className="cursor-pointer select-none text-xs font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]">
          Technical details
        </summary>
        <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
          {facts.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-[11px] text-[var(--color-muted-foreground)]">{label}</dt>
              <dd className="min-w-0 truncate text-[11px]">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      </details>
    </div>
  );
}
