import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, FileText, RefreshCw, Terminal as TerminalIcon } from 'lucide-react';
import { type ApplianceClient } from '@appliance.sh/sdk/client';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
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
            {scopeNote ? <p className="mt-0.5 text-[11px] text-[var(--color-muted-foreground)]">{scopeNote}</p> : null}
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
              Switch to this Dev Machine to read its workloads through the api-server.
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
          <p className="text-xs text-red-300">{(workloadsQuery.error as Error).message}</p>
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
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Deployments</div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th className="py-1 pr-3">Name</th>
            <th className="py-1 pr-3">Image</th>
            <th className="py-1 pr-3">Replicas</th>
            <th className="py-1 pr-3">Age</th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((d) => (
            <tr key={d.name} className="border-t border-[var(--color-border)]">
              <td className="py-1.5 pr-3 font-medium">{d.name}</td>
              <td className="py-1.5 pr-3 font-mono text-xs">{d.image ?? <em>—</em>}</td>
              <td className="py-1.5 pr-3">
                <span className={d.ready === d.desired ? 'text-green-300' : 'text-amber-300'}>
                  {d.ready}/{d.desired}
                </span>
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
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Pods</div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th className="py-1 pr-3">Name</th>
            <th className="py-1 pr-3">Phase</th>
            <th className="py-1 pr-3">Ready</th>
            <th className="py-1 pr-3">Restarts</th>
            <th className="py-1 pr-3">Age</th>
            <th className="py-1 pr-3" />
          </tr>
        </thead>
        <tbody>
          {pods.map((p) => (
            <tr key={p.name} className="border-t border-[var(--color-border)]">
              <td className="py-1.5 pr-3 font-medium">{p.name}</td>
              <td className="py-1.5 pr-3">
                <span className={p.phase === 'Running' ? 'text-green-300' : 'text-amber-300'}>{p.phase}</span>
              </td>
              <td className="py-1.5 pr-3">{p.ready ? '✓' : '—'}</td>
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
    <div>
      <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Services</div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th className="py-1 pr-3">Name</th>
            <th className="py-1 pr-3">Type</th>
            <th className="py-1 pr-3">Cluster IP</th>
            <th className="py-1 pr-3">NodePort</th>
            <th className="py-1 pr-3">URL</th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => {
            const url = s.nodePort ? `http://localhost:${s.nodePort}` : null;
            return (
              <tr key={s.name} className="border-t border-[var(--color-border)]">
                <td className="py-1.5 pr-3 font-medium">{s.name}</td>
                <td className="py-1.5 pr-3 text-xs">{s.serviceType}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{s.clusterIp ?? '—'}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{s.nodePort ?? '—'}</td>
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
  const preRef = React.useRef<HTMLPreElement | null>(null);

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
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [lines]);

  const text = lines.join('\n');
  const copy = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 md:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex h-[70vh] w-full max-w-4xl flex-col overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-background)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Logs for ${pod.name}`}
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
          <div>
            <div className="text-sm font-semibold">Pod logs</div>
            <div className="font-mono text-xs text-[var(--color-muted-foreground)]">{pod.name}</div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium',
                phase === 'live'
                  ? 'bg-green-500/15 text-green-300'
                  : phase === 'error'
                    ? 'bg-red-500/15 text-red-300'
                    : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]'
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  phase === 'live'
                    ? 'animate-pulse bg-green-400'
                    : phase === 'error'
                      ? 'bg-red-400'
                      : 'bg-[var(--color-muted-foreground)]'
                )}
              />
              {phase === 'live'
                ? 'Live'
                : phase === 'connecting'
                  ? 'Connecting…'
                  : phase === 'error'
                    ? 'Error'
                    : 'Ended'}
            </span>
            <Button variant="outline" size="sm" onClick={copy}>
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </header>
        <pre
          ref={preRef}
          className="flex-1 overflow-auto whitespace-pre-wrap bg-black/40 p-3 font-mono text-xs leading-relaxed"
        >
          {phase === 'error' ? (
            <span className="text-red-300">{error}</span>
          ) : text ? (
            text
          ) : phase === 'connecting' ? (
            'Connecting…'
          ) : (
            <span className="text-[var(--color-muted-foreground)]">No log lines yet.</span>
          )}
        </pre>
      </div>
    </div>
  );
}
