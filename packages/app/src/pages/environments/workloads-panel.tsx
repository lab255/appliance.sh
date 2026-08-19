import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, RefreshCw, Terminal as TerminalIcon } from 'lucide-react';
import { type ApplianceClient } from '@appliance.sh/sdk/client';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Banner } from '@/components/ui/banner';
import { LogPane } from '@/components/ui/log-pane';
import { StatusPill } from '@/components/ui/status-pill';
import { useHost } from '@/providers/host-provider';
import { useTerminalSessions } from '@/providers/terminal-sessions-provider';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { cn } from '@/lib/utils';
import { relativeAge } from '@/lib/time';
import type { LocalDeploymentInfo, LocalPodInfo, LocalServiceInfo } from '@/lib/host';

// Workloads / pods / services tables + live pod-log tail + pod-shell. Reads
// through the in-VM api-server (the same signed ApplianceClient that powers
// projects / deployments). Extracted from `local-runtime/index.tsx` and now
// homed here in ③ env-detail (docs/desktop-ia.md §3 / move-map 4a) —
// deployment runtime state belongs with the environment that was deployed.
//
// PARKER CONTINUITY: this panel is inherently RUNTIME-SCOPED — it lists
// everything the selected cluster's api-server reports, not just one env's
// objects. So the SAME component still backs the ② cluster-detail Workloads
// tab (a deep-link to "what's running on THIS engine, across all projects"),
// which imports it from here. Don't collapse it to a single-env filter.
//
// `scopeNote` (Parker I3): in the ③ env-detail context this card sits under a
// single environment but still shows the WHOLE runtime, so env-detail passes a
// clarifier ("all on this runtime") to make the scope unmistakable. ② cluster
// detail omits it — there the runtime scope is already self-evident.
export function WorkloadsPanel({
  clusterId,
  vmName,
  scopeNote,
}: {
  clusterId: string;
  vmName?: string;
  scopeNote?: string;
}) {
  const host = useHost();
  const terminals = useTerminalSessions();
  const queryClient = useQueryClient();
  const [activePod, setActivePod] = React.useState<LocalPodInfo | null>(null);

  // Workloads + pod logs read through the in-VM api-server (the same
  // signed ApplianceClient that powers projects/deployments) instead of
  // a kubectl shell-out. The client is bound to the *active* cluster, so
  // we can only read this VM's workloads when it is the selected one;
  // otherwise we'd surface another cluster's state under this card.
  const client = useApplianceClient();
  const { data: config } = useQuery({ queryKey: ['host', 'config'], queryFn: () => host.getConfig() });
  const isActive = config?.selectedClusterId === clusterId;

  const workloadsQuery = useQuery({
    queryKey: ['local-runtime', 'workloads', clusterId],
    enabled: Boolean(client) && isActive,
    queryFn: async () => {
      const res = await client!.listWorkloads();
      if (!res.success) throw res.error;
      return res.data;
    },
    refetchInterval: 5_000,
  });

  const data = workloadsQuery.data;
  const empty = data && data.deployments.length === 0 && data.pods.length === 0 && data.services.length === 0;

  return (
    <>
      <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold">Workloads · {vmName ?? 'appliance'}</h2>
            {scopeNote ? (
              <p className="mt-0.5 text-xs leading-4 text-[var(--color-muted-foreground)]">{scopeNote}</p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh workloads"
            onClick={() => workloadsQuery.refetch()}
            disabled={workloadsQuery.isFetching || !isActive}
          >
            <RefreshCw className={cn('h-4 w-4', workloadsQuery.isFetching && 'animate-spin')} />
          </Button>
        </div>

        {!isActive ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Switch to this Dev Machine to load its workloads.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await host.selectCluster(clusterId);
                queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
              }}
            >
              Switch
            </Button>
          </div>
        ) : workloadsQuery.isLoading ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">Loading…</p>
        ) : workloadsQuery.isError ? (
          <Banner tone="error">{(workloadsQuery.error as Error).message}</Banner>
        ) : empty ? (
          <EmptyState
            title="No workloads yet"
            description="Deploy an app (Apps → Deploy your first app) to see it here."
          />
        ) : data ? (
          <div className="space-y-5">
            <DeploymentsTable deployments={data.deployments} />
            <PodsTable
              pods={data.pods}
              onLogs={setActivePod}
              onShell={
                host.terminal
                  ? (pod) => terminals.openSession({ target: pod.name, engine: 'microvm', clusterName: vmName })
                  : undefined
              }
            />
            <ServicesTable services={data.services} />
          </div>
        ) : null}
      </section>

      {activePod && client ? (
        <PodLogsDrawer pod={activePod} client={client} onClose={() => setActivePod(null)} />
      ) : null}
    </>
  );
}

function DeploymentsTable({ deployments }: { deployments: LocalDeploymentInfo[] }) {
  if (deployments.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Deployments</div>
      <table className="w-full text-sm">
        <caption className="sr-only">Deployments hosted on this Dev Machine</caption>
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th scope="col" className="sticky left-0 bg-[var(--color-background)] py-1 pr-3">
              Name
            </th>
            <th scope="col" className="py-1 pr-3">
              Image
            </th>
            <th scope="col" className="py-1 pr-3">
              Replicas
            </th>
            <th scope="col" className="py-1 pr-3">
              Age
            </th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((d) => (
            <tr key={d.name} className="border-t border-[var(--color-border)]">
              <td className="sticky left-0 bg-[var(--color-background)] py-1.5 pr-3 font-medium">{d.name}</td>
              <td className="py-1.5 pr-3 font-mono text-xs">{d.image ?? <em>—</em>}</td>
              <td className="py-1.5 pr-3">
                <StatusPill
                  tone={d.ready === d.desired ? 'success' : 'warning'}
                  label={`${d.ready} of ${d.desired} ready`}
                />
              </td>
              <td className="py-1.5 pr-3 text-xs text-[var(--color-muted-foreground)]">{relativeAge(d.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PodsTable({
  pods,
  onLogs,
  onShell,
}: {
  pods: LocalPodInfo[];
  onLogs: (pod: LocalPodInfo) => void;
  onShell?: (pod: LocalPodInfo) => void;
}) {
  if (pods.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Pods</div>
      <table className="w-full text-sm">
        <caption className="sr-only">Pods hosted on this Dev Machine</caption>
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th scope="col" className="sticky left-0 bg-[var(--color-background)] py-1 pr-3">
              Name
            </th>
            <th scope="col" className="py-1 pr-3">
              Phase
            </th>
            <th scope="col" className="py-1 pr-3">
              Ready
            </th>
            <th scope="col" className="py-1 pr-3">
              Restarts
            </th>
            <th scope="col" className="py-1 pr-3">
              Age
            </th>
            <th scope="col" className="py-1 pr-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {pods.map((p) => (
            <tr key={p.name} className="border-t border-[var(--color-border)]">
              <td className="sticky left-0 bg-[var(--color-background)] py-1.5 pr-3 font-medium">{p.name}</td>
              <td className="py-1.5 pr-3">
                <StatusPill
                  tone={p.phase === 'Running' ? 'info' : 'warning'}
                  label={p.phase}
                  activity={p.phase === 'Running' ? 'pulse' : 'static'}
                />
              </td>
              <td className="py-1.5 pr-3">{p.ready ? 'Ready' : 'Not ready'}</td>
              <td className="py-1.5 pr-3">{p.restartCount}</td>
              <td className="py-1.5 pr-3 text-xs text-[var(--color-muted-foreground)]">{relativeAge(p.createdAt)}</td>
              <td className="py-1.5 pr-3 text-right">
                <div className="flex items-center justify-end gap-1">
                  {onShell && p.phase === 'Running' ? (
                    <Button variant="ghost" size="sm" onClick={() => onShell(p)}>
                      <TerminalIcon className="h-3.5 w-3.5" /> Shell
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => onLogs(p)}>
                    <FileText className="h-3.5 w-3.5" /> Logs
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ServicesTable({ services }: { services: LocalServiceInfo[] }) {
  if (services.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Services</div>
      <table className="w-full text-sm">
        <caption className="sr-only">Services hosted on this Dev Machine</caption>
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th scope="col" className="sticky left-0 bg-[var(--color-background)] py-1 pr-3">
              Name
            </th>
            <th scope="col" className="py-1 pr-3">
              Local port
            </th>
            <th scope="col" className="py-1 pr-3">
              URL
            </th>
            <th scope="col" className="py-1 pr-3">
              <span className="sr-only">Technical details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => {
            const url = s.nodePort ? `http://localhost:${s.nodePort}` : null;
            return (
              <tr key={s.name} className="border-t border-[var(--color-border)]">
                <td className="sticky left-0 bg-[var(--color-background)] py-1.5 pr-3 font-medium">{s.name}</td>
                <td className="py-1.5 pr-3 font-mono text-xs tabular-nums">{s.nodePort ?? '—'}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">
                  {url ? (
                    <a
                      className="underline hover:text-[var(--color-accent)]"
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {url}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="py-1.5 pr-3 text-xs">
                  <details>
                    <summary className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
                      Technical details
                    </summary>
                    <dl className="mt-1 grid grid-cols-[5rem_1fr] gap-x-2">
                      <dt>Type</dt>
                      <dd>{s.serviceType}</dd>
                      <dt>Cluster IP</dt>
                      <dd className="font-mono">{s.clusterIp ?? '—'}</dd>
                      <dt>NodePort</dt>
                      <dd className="font-mono">{s.nodePort ?? '—'}</dd>
                    </dl>
                  </details>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Live pod-log tail. Opens a single chunked `follow` stream against the
// api-server (`streamPodLogs`) — the last 500 lines, then new lines as
// they arrive — instead of polling a snapshot. The stream is aborted on
// unmount or when the viewed pod changes.
const LOG_BUFFER_MAX = 5_000;

function PodLogsDrawer({ pod, client, onClose }: { pod: LocalPodInfo; client: ApplianceClient; onClose: () => void }) {
  const [lines, setLines] = React.useState<string[]>([]);
  const [phase, setPhase] = React.useState<'connecting' | 'live' | 'ended' | 'error'>('connecting');
  const [error, setError] = React.useState<string | null>(null);
  const [announcedLineCount, setAnnouncedLineCount] = React.useState(0);
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement) : null
  );

  React.useEffect(() => {
    const controller = new AbortController();
    setLines([]);
    setError(null);
    setPhase('connecting');
    let started = false;
    void client
      .streamPodLogs(pod.name, { tailLines: 500, signal: controller.signal }, (line) => {
        if (!started) {
          started = true;
          setPhase('live');
        }
        setLines((prev) => {
          const next = prev.length >= LOG_BUFFER_MAX ? prev.slice(prev.length - LOG_BUFFER_MAX + 1) : prev.slice();
          next.push(line);
          return next;
        });
      })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (!res.success) {
          setError(res.error.message);
          setPhase('error');
        } else {
          setPhase('ended');
        }
      });
    // Abort the follow on unmount / pod switch — the SDK treats an abort
    // as a clean close, not a failure.
    return () => controller.abort();
  }, [client, pod.name]);

  // Keep the newest lines in view as the stream appends.
  React.useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  React.useEffect(() => {
    if (lines.length === announcedLineCount) return;
    const timer = window.setTimeout(() => setAnnouncedLineCount(lines.length), 2_000);
    return () => window.clearTimeout(timer);
  }, [announcedLineCount, lines.length]);

  const text = lines.join('\n');
  React.useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [onClose]);

  const phaseMeta =
    phase === 'live'
      ? { tone: 'info' as const, label: 'Live', activity: 'pulse' as const }
      : phase === 'connecting'
        ? { tone: 'info' as const, label: 'Connecting…', activity: 'spin' as const }
        : phase === 'error'
          ? { tone: 'error' as const, label: 'Error', activity: 'static' as const }
          : { tone: 'neutral' as const, label: 'Ended', activity: 'static' as const };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 md:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="flex h-[70vh] w-full max-w-4xl flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-background)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Logs for ${pod.name}`}
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
          <div>
            <div className="text-sm font-semibold">Pod logs</div>
            <div className="font-mono text-xs text-[var(--color-muted-foreground)]">{pod.name}</div>
          </div>
          <div className="flex items-center gap-2">
            <div role="status" aria-live="polite" aria-atomic="true">
              <StatusPill {...phaseMeta} />
            </div>
            <span className="sr-only" role="status" aria-live="polite" aria-relevant="additions text">
              {announcedLineCount ? `${announcedLineCount} log lines received` : ''}
            </span>
            <Button ref={closeRef} variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>
        <LogPane
          label="Log output"
          height="fill"
          open
          copyText={text}
          viewportRef={logRef}
          empty={phase === 'connecting' ? 'Connecting…' : 'No log lines yet.'}
        >
          {phase === 'error' ? (
            <div className="text-[var(--color-destructive-foreground)]">{error}</div>
          ) : (
            lines.map((line, index) => <div key={index}>{line}</div>)
          )}
        </LogPane>
      </div>
    </div>
  );
}
