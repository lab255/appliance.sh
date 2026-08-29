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
import { Banner } from '@/components/ui/banner';
import { KeyValueList } from '@/components/ui/key-value-list';
import { LongOperation } from '@/components/ui/long-operation';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { StatusDot } from '@/components/ui/status-dot';
import { Tag } from '@/components/ui/tag';
import { useToast } from '@/components/ui/toast';
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
import { durationEstimates } from '@/lib/duration-estimates';

type RuntimeTab = 'lifecycle' | 'egress' | 'credentials' | 'facts' | 'workloads';

function useBatchedLifecycleAnnouncement(lineCount: number): string {
  const [announcement, setAnnouncement] = React.useState('');
  const announced = React.useRef(0);
  const latest = React.useRef(lineCount);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = lineCount;
  React.useEffect(() => {
    if (lineCount <= announced.current || timer.current) return;
    timer.current = setTimeout(() => {
      const added = latest.current - announced.current;
      announced.current = latest.current;
      timer.current = null;
      setAnnouncement(`${added} new lifecycle log line${added === 1 ? '' : 's'}`);
    }, 2_000);
  }, [lineCount]);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  return announcement;
}

// The Dev Machine detail — per-VM management rendered as TABS (Parker) —
// Lifecycle · Egress · Credentials · Facts — so the decomposition isn't
// undone in one long scroll at the leaf. Workloads is the machine-scoped
// 5th tab (its panel lives in ③ env-detail; this is the deep-link to
// "what's running on THIS VM"). The agent launcher lives in ④ Agents —
// Lifecycle keeps a thin "Run agent →" deep-link (preselecting this VM).
// Rendered by /machine (pages/machine/index.tsx) for the selected local VM.
//
// The egress policy uses the current desktop IA (docs/desktop-ia.md): the single
// `['microvm', name, 'egress']` policy poll lives HERE and is passed down —
// `policy` to the Egress tab, `mitm` to the Credentials tab — instead of
// each panel registering its own 15 s observer.
export function RuntimeDetail({ name, clusterId }: { name: string; clusterId: string }) {
  const host = useHost();
  const terminals = useTerminalSessions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
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
  const [logAction, setLogAction] = React.useState<'up' | 'cluster' | null>(null);
  const lifecycleAnnouncement = useBatchedLifecycleAnnouncement(log.length);
  const [error, setError] = React.useState<string | null>(null);
  // Which lifecycle action produced `error` — picks the plain-language
  // headline ("couldn't start" vs "couldn't be installed" …).
  const [errorAction, setErrorAction] = React.useState<'install' | 'up' | 'cluster' | 'stop' | 'delete' | null>(null);
  // Whether the next Start should provision a dev environment. Forced on
  // once the VM is already a dev VM (the engine flag is one-way).
  const [devMode, setDevMode] = React.useState(false);
  // Host folder to share into /persist/workspace on the next dev boot.
  const [mountPath, setMountPath] = React.useState<string | null>(null);
  const [removedMount, setRemovedMount] = React.useState<string | null>(null);
  const [hostingConfirm, setHostingConfirm] = React.useState(false);

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
    if (kind === 'up' || kind === 'cluster') {
      setLog([]);
      setLogAction(kind);
    }
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

  const setUpHosting = async () => {
    setHostingConfirm(false);
    const onLog = (e: { message: string }) => setLog((prev) => [...prev.slice(-199), e.message]);
    const ready = await run('cluster', () => vm.clusterUp(onLog));
    if (ready) toast('appliance can now host apps');
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: `Delete the "${name}" Sandbox?`,
      description:
        'Deletes apps, images, and settings inside this Sandbox. Files in the shared host folder stay on this computer. Saved host credentials are kept.',
      confirmLabel: 'Delete Sandbox',
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

  const lifecycle = !status
    ? 'checking…'
    : !status.available
      ? busy === 'install'
        ? 'installing…'
        : status.installable
          ? 'not installed'
          : 'unavailable'
      : busy === 'up'
        ? 'starting…'
        : status.running
          ? status.phase === 'failed'
            ? 'failed'
            : 'running'
          : status.exists
            ? 'stopped'
            : 'not created';

  // Surface the prerequisite Doctor prominently (docs/desktop-ia.md)
  // when the runtime can't start (failed / engine unavailable), otherwise
  // offer it behind a "Re-run checks" toggle. Either way it's the SAME
  // PreflightPanel as ① /setup/doctor — one implementation, two entry points.
  const wontStart = lifecycle === 'failed' || lifecycle === 'unavailable';
  const lifecycleStatus = resolveMachineLifecycle(lifecycle);

  const tabs: Array<{ id: RuntimeTab; label: string; enabled: boolean }> = [
    { id: 'lifecycle', label: 'Lifecycle', enabled: true },
    { id: 'egress', label: 'Egress', enabled: vmRunning },
    { id: 'credentials', label: 'Credentials', enabled: vmRunning },
    { id: 'facts', label: 'Facts', enabled: vmRunning },
    { id: 'workloads', label: 'Workloads', enabled: clusterServing },
  ];
  // Don't strand the user on a tab that just became disabled (VM stopped).
  const activeTab = tabs.find((t) => t.id === tab && t.enabled) ? tab : 'lifecycle';
  const enabledTabs = tabs.filter((item) => item.enabled);
  const moveTab = (current: RuntimeTab, direction: number | 'home' | 'end') => {
    const index = enabledTabs.findIndex((item) => item.id === current);
    const next =
      direction === 'home'
        ? 0
        : direction === 'end'
          ? enabledTabs.length - 1
          : (index + direction + enabledTabs.length) % enabledTabs.length;
    setTab(enabledTabs[next].id);
    window.requestAnimationFrame(() => document.getElementById(`machine-tab-${enabledTabs[next].id}`)?.focus());
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-sm font-semibold">{name}</code>
          <Tag emphasis="sandbox">Sandbox</Tag>
          {isDefault ? <Tag>default</Tag> : null}
        </div>
        <StatusPill
          {...lifecycleStatus}
          className={lifecycle === 'running' ? 'border-[var(--color-success-border)]' : undefined}
        />
      </div>

      {status?.running && !status.clusterProvisioned && busy !== 'cluster' ? (
        <div className="flex flex-wrap gap-2" aria-label="Start something">
          <Button asChild size="sm">
            <Link to={`/agents?runtime=${encodeURIComponent(name)}`}>
              <Bot className="h-4 w-4" aria-hidden />
              Run an agent
            </Link>
          </Button>
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
            >
              <TerminalIcon className="h-4 w-4" aria-hidden />
              Open a shell
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setHostingConfirm(true)}>
            <Rocket className="h-4 w-4" aria-hidden />
            Set up hosting
          </Button>
        </div>
      ) : null}

      <CapabilityLedger
        running={Boolean(status?.running)}
        exists={Boolean(status?.exists)}
        starting={busy === 'up'}
        hostingProvisioned={Boolean(status?.clusterProvisioned)}
        hostingServing={clusterServing}
        hostingBusy={busy === 'cluster'}
        confirm={hostingConfirm}
        onConfirm={() => void setUpHosting()}
        onCancel={() => setHostingConfirm(false)}
        onStart={() => setHostingConfirm(true)}
      />

      {busy === 'cluster' || (errorAction === 'cluster' && error) ? (
        <SectionCard>
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {lifecycleAnnouncement}
          </div>
          <LongOperation
            title="Setting up App hosting"
            status={busy === 'cluster' ? 'running' : 'error'}
            steps={HOSTING_STEPS}
            activeStep={hostingStep(log)}
            nowLine={log.at(-1) ?? 'Restarting the Sandbox with hosting…'}
            timeClass="minutes"
            estimate={durationEstimates.hostingSetup}
            leaveSafety="resumable"
            stallMessage="First-time setup downloads the app platform's images — a quiet couple of minutes is normal."
            failure={error ?? undefined}
            retry={
              <Button size="sm" onClick={() => void setUpHosting()}>
                Retry hosting setup
              </Button>
            }
            log={log.map((line, index) => (
              <div key={`${index}-${line}`}>{line}</div>
            ))}
            logProps={{ height: 'compact', live: 'off', copyText: log.join('\n') }}
          />
        </SectionCard>
      ) : null}

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
              id={`machine-tab-${t.id}`}
              aria-controls={`machine-panel-${t.id}`}
              type="button"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              disabled={!t.enabled}
              onClick={() => setTab(t.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  moveTab(t.id, 1);
                }
                if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  moveTab(t.id, -1);
                }
                if (event.key === 'Home') {
                  event.preventDefault();
                  moveTab(t.id, 'home');
                }
                if (event.key === 'End') {
                  event.preventDefault();
                  moveTab(t.id, 'end');
                }
              }}
              className={cn(
                '-mb-px border-b-2 px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:opacity-40',
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
      {tabs.some((item) => !item.enabled) ? (
        <p className="text-xs leading-4 text-[var(--color-muted-foreground)]">
          Start the Sandbox to use Internet access, Credentials, and Facts. Set up hosting to use Workloads.
        </p>
      ) : null}

      {/* Tab panels */}
      {activeTab === 'lifecycle' ? (
        <div id="machine-panel-lifecycle" role="tabpanel" aria-labelledby="machine-tab-lifecycle" className="space-y-3">
          <p className="text-xs text-[var(--color-muted-foreground)]">
            {status?.clusterProvisioned ? (
              <>
                App hosting is on. Technical target: <code className="font-mono">{clusterId}</code>.
              </>
            ) : (
              'The Sandbox is ready for agents and shells. Set up App hosting when you want to deploy apps here.'
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
              <Banner tone="warning">
                {status.message ?? 'The Sandbox engine is not installed on this computer.'}
              </Banner>
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
                      ? 'Start Sandbox workspace'
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
                <Trash2 className="h-4 w-4" aria-hidden /> {busy === 'delete' ? 'Deleting…' : 'Delete Sandbox'}
              </Button>
              {status?.dev ? (
                <Tag>
                  <TerminalIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
                  shared workspace
                </Tag>
              ) : !status?.running ? (
                <label
                  className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]"
                  title="Add a persistent shared workspace for shells and agents"
                >
                  <input
                    type="checkbox"
                    checked={devMode}
                    onChange={(e) => setDevMode(e.target.checked)}
                    disabled={busy !== null}
                  />
                  shared workspace
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
                    className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
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
                        onClick={() => {
                          setRemovedMount(mountPath);
                          setMountPath(null);
                        }}
                        className="rounded hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
                        aria-label={`Stop sharing ${mountPath}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          {removedMount ? (
            <Banner
              tone="neutral"
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setMountPath(removedMount);
                    setRemovedMount(null);
                  }}
                >
                  Undo
                </Button>
              }
            >
              Shared folder removed. This change applies the next time the Sandbox starts.
            </Banner>
          ) : null}

          {error && errorAction !== 'cluster' && errorAction !== 'up' ? (
            <FriendlyError
              error={error}
              fallbackHeadline={
                errorAction === 'install'
                  ? "The local runtime couldn't be installed"
                  : errorAction === 'stop'
                    ? "The machine couldn't be stopped"
                    : errorAction === 'delete'
                      ? "The machine couldn't be deleted"
                      : "The local machine couldn't start"
              }
            />
          ) : null}

          {busy === 'up' || (logAction === 'up' && log.length > 0) ? (
            <>
              <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {lifecycleAnnouncement}
              </div>
              <LongOperation
                title="Starting the Sandbox"
                status={busy === 'up' ? 'running' : errorAction === 'up' && error ? 'error' : 'success'}
                timeClass="seconds"
                estimate=""
                leaveSafety="resumable"
                nowLine={log.at(-1) ?? 'Starting the Sandbox…'}
                failure={errorAction === 'up' ? (error ?? undefined) : undefined}
                retry={
                  errorAction === 'up' ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        const onLog = (event: { message: string }) =>
                          setLog((previous) => [...previous.slice(-199), event.message]);
                        const wantDev = devMode || status?.dev === true;
                        void run('up', () =>
                          wantDev ? vm.devUp(onLog, { mount: mountPath ?? undefined }) : vm.up(onLog)
                        );
                      }}
                    >
                      Retry
                    </Button>
                  ) : undefined
                }
                log={log.map((line, index) => (
                  <div key={`${index}-${line}`}>{line}</div>
                ))}
                logProps={{ height: 'compact', live: 'off', copyText: log.join('\n') }}
              />
            </>
          ) : null}

          {status?.running ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {status.kubeconfigReady ? (
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  Available as{' '}
                  <span className="font-medium text-[var(--color-foreground)]">{devMachineLabel(name)}</span> in the
                  target switcher
                </p>
              ) : (
                <p className="text-xs text-[var(--color-muted-foreground)]">Sandbox ready</p>
              )}
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
        <div id="machine-panel-egress" role="tabpanel" aria-labelledby="machine-tab-egress">
          <EgressPanel
            vm={vm}
            name={name}
            policy={policyQuery.data}
            policyError={policyQuery.error}
            platform={host.platform}
          />
        </div>
      ) : null}

      {activeTab === 'credentials' ? (
        <div id="machine-panel-credentials" role="tabpanel" aria-labelledby="machine-tab-credentials">
          <CredentialsPanel vm={vm} name={name} mitmOn={policyQuery.data?.mitm ?? false} platform={host.platform} />
        </div>
      ) : null}

      {activeTab === 'facts' && status ? (
        <div id="machine-panel-facts" role="tabpanel" aria-labelledby="machine-tab-facts">
          <MicroVmFacts apiServerUrl={status.apiServerUrl} clusterId={clusterId} summary={summary} />
        </div>
      ) : null}

      {/* Machine-scoped Workloads — the same panel ③ env-detail renders,
          here scoped to this VM (Parker continuity). */}
      {activeTab === 'workloads' ? (
        <div id="machine-panel-workloads" role="tabpanel" aria-labelledby="machine-tab-workloads">
          <WorkloadsPanel clusterId={clusterId} vmName={name} />
        </div>
      ) : null}
    </div>
  );
}

const HOSTING_STEPS = [
  { key: 'restart', label: 'Restarted with hosting', runningLabel: 'Restarting with hosting' },
  { key: 'platform', label: 'App platform started', runningLabel: 'Starting the app platform' },
  { key: 'ready', label: 'Ready for deploys', runningLabel: 'Checking hosting readiness' },
] as const;

function hostingStep(lines: string[]): number {
  const text = lines.join('\n').toLowerCase();
  if (/ingress|register|ready|health/.test(text)) return 2;
  if (/image|platform|kubernetes|service|cluster/.test(text)) return 1;
  return 0;
}

function resolveMachineLifecycle(state: string): { tone: StatusTone; label: string; activity: 'static' | 'spin' } {
  if (state === 'failed') return { tone: 'error', label: 'Failed', activity: 'static' };
  if (state === 'starting…' || state === 'installing…')
    return { tone: 'info', label: state === 'installing…' ? 'Installing…' : 'Starting…', activity: 'spin' };
  if (state === 'running') return { tone: 'neutral', label: 'Running', activity: 'static' };
  const label =
    state === 'not created'
      ? 'Not created'
      : state === 'not installed'
        ? 'Not installed'
        : state === 'checking…'
          ? 'Checking…'
          : state === 'unavailable'
            ? 'Unavailable'
            : 'Stopped';
  return { tone: 'neutral', label, activity: state === 'checking…' ? 'spin' : 'static' };
}

function CapabilityLedger({
  running,
  exists,
  starting,
  hostingProvisioned,
  hostingServing,
  hostingBusy,
  confirm,
  onStart,
  onConfirm,
  onCancel,
}: {
  running: boolean;
  exists: boolean;
  starting: boolean;
  hostingProvisioned: boolean;
  hostingServing: boolean;
  hostingBusy: boolean;
  confirm: boolean;
  onStart: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const sandboxLabel = starting ? 'Starting…' : running ? 'Ready' : 'Off';
  const hostingLabel = hostingBusy
    ? 'Setting up…'
    : hostingServing
      ? 'On'
      : hostingProvisioned && !running
        ? 'On — resumes on start'
        : hostingProvisioned
          ? 'Starting…'
          : 'Not set up';
  return (
    <section
      aria-label="Machine capabilities"
      className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]"
    >
      <div className="grid gap-2 p-3 sm:grid-cols-[7rem_8rem_minmax(0,1fr)] sm:items-center">
        <div className="text-sm font-medium">Sandbox</div>
        <div className="inline-flex items-center gap-2 text-sm">
          <StatusDot
            tone={starting || running ? 'sandbox' : 'neutral'}
            activity={starting ? 'pulse' : 'static'}
            label={sandboxLabel}
          />
          {sandboxLabel}
        </div>
        <div className="text-xs leading-4 text-[var(--color-muted-foreground)]">
          {running
            ? 'shells · agents · guarded internet'
            : exists
              ? 'Start the machine to use agents and shells'
              : 'Start the machine to create it'}
        </div>
      </div>
      <div className="grid gap-2 p-3 sm:grid-cols-[7rem_8rem_minmax(0,1fr)] sm:items-center">
        <div className="text-sm font-medium">App hosting</div>
        <div className="inline-flex items-center gap-2 text-sm">
          <StatusDot
            tone={hostingServing ? 'success' : hostingBusy || (hostingProvisioned && running) ? 'info' : 'neutral'}
            activity={hostingBusy || (hostingProvisioned && running && !hostingServing) ? 'pulse' : 'static'}
            label={hostingLabel}
          />
          {hostingLabel}
        </div>
        <div className="space-y-2 text-xs leading-4 text-[var(--color-muted-foreground)]">
          <p>
            {hostingServing
              ? 'apps deploy here · appears in the target switcher'
              : hostingProvisioned
                ? 'apps deploy here when the Sandbox is running'
                : 'apps deploy here once it is on'}
          </p>
          {running && !hostingProvisioned && !hostingBusy ? (
            confirm ? (
              <div className="space-y-2">
                <p>
                  One-time setup, usually 2–4 minutes. Restarts this machine; open shells close, agent workspace files
                  are kept.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={onConfirm}>
                    Set up
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onCancel}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={onStart}>
                Set up hosting
              </Button>
            )
          ) : null}
        </div>
      </div>
    </section>
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
        The same checks as <span className="font-medium">Setup → Doctor</span>, including the helper used by workload
        views and shells. Appliance can install it for you.
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
  const facts = [
    { key: 'server', label: 'Server address', value: apiServerUrl, mono: true },
    { key: 'profile', label: 'Profile', value: clusterId, mono: true },
  ];
  if (summary) {
    facts.push({
      key: 'ports',
      label: 'Ports',
      value: `ingress :${summary.hostPort} · service :${summary.apiPort} · registry :${summary.registryPort} · internet :${summary.egressPort}`,
      mono: true,
    });
  }
  return (
    <SectionCard>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Apps here get local web addresses. To put an app on the public internet,{' '}
        <Link to="/cloud" className="underline underline-offset-2">
          pair a cloud
        </Link>
        .
      </p>
      <details>
        <summary className="cursor-pointer select-none text-xs font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]">
          Technical details
        </summary>
        <KeyValueList className="mt-2" items={facts} />
      </details>
    </SectionCard>
  );
}
