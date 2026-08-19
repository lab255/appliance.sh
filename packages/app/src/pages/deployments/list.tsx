import * as React from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { resolveStatusDot } from '@/components/ui/status-dot';
import { StatusPill } from '@/components/ui/status-pill';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { EntityLabel } from '@/components/ui/entity-label';
import { EmptyState } from '@/components/ui/empty-state';
import { FriendlyError } from '@/components/friendly-error';
import { ListSkeleton } from '@/components/ui/skeleton';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useEnvironmentsMap, useProjectsMap } from '@/hooks/use-lookups';
import { relativeTime } from '@/lib/time';

export function DeploymentsPage() {
  const client = useApplianceClient();
  const envs = useEnvironmentsMap();
  const projects = useProjectsMap();
  const { cluster } = useSelectedCluster();

  const deploymentsQuery = useQuery({
    queryKey: ['deployments', 'all'],
    enabled: !!client,
    queryFn: async () => {
      const r = await client!.listDeployments({ limit: 100 });
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: () => (typeof document !== 'undefined' && document.hidden ? false : 5_000),
  });

  const [statusFilter, setStatusFilter] = React.useState('all');
  const [appFilter, setAppFilter] = React.useState('all');
  const deployments = deploymentsQuery.data ?? [];
  const appIds = [...new Set(deployments.map((d) => d.projectId))];
  const visible = deployments.filter(
    (d) => (statusFilter === 'all' || d.status === statusFilter) && (appFilter === 'all' || d.projectId === appFilter)
  );

  if (!cluster) {
    return (
      <PageShell rail="browse" className="space-y-4">
        <PageHeader title="Deployments" description="Recent and running deploys for this target." />
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-muted-foreground)]">
          Connect to a cluster to see deployments.
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell rail="browse" className="space-y-6">
      <PageHeader title="Deployments" description="Recent and running deploys for this target." />

      {deployments.length > 20 ? (
        <div className="flex flex-wrap gap-2" aria-label="Deployment filters">
          <label className="text-xs font-medium">
            Status{' '}
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="ml-1 h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
            >
              <option value="all">All</option>
              {[...new Set(deployments.map((d) => d.status))].map((s) => (
                <option key={s} value={s}>
                  {resolveStatusDot(s).label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium">
            App{' '}
            <select
              value={appFilter}
              onChange={(e) => setAppFilter(e.target.value)}
              className="ml-1 h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
            >
              <option value="all">All</option>
              {appIds.map((appId) => (
                <option key={appId} value={appId}>
                  {projects.get(appId)?.name ?? appId}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {deploymentsQuery.error ? (
        <FriendlyError error={deploymentsQuery.error} fallbackHeadline="Couldn't load deployments" />
      ) : deploymentsQuery.isLoading && !deploymentsQuery.data ? (
        <ListSkeleton />
      ) : !deploymentsQuery.data || deploymentsQuery.data.length === 0 ? (
        <EmptyState title="No deployments yet" description="Deploy an environment and its runs will show up here." />
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          {visible.map((d) => (
            <li key={d.id}>
              <Link
                to={`/deployments/${d.id}`}
                aria-label={`${projects.get(d.projectId)?.name ?? d.projectId}, ${envs.get(d.environmentId)?.name ?? d.environmentId}, ${d.action}, ${resolveStatusDot(d.status).label}, ${durationOf(d) ?? 'in progress'}, ${relativeTime(d.startedAt)}`}
                className="grid grid-cols-[7rem_minmax(0,1fr)_5rem_4rem] items-center gap-4 px-4 py-3 transition-colors hover:bg-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]"
              >
                <StatusPill {...resolveStatusDot(d.status)} className="transition-colors" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    <EntityLabel id={d.projectId} name={projects.get(d.projectId)?.name} />
                    <span className="text-[var(--color-muted-foreground)]">/</span>
                    <EntityLabel id={d.environmentId} name={envs.get(d.environmentId)?.name} />
                    <span className="ml-2 text-xs font-normal text-[var(--color-muted-foreground)]">{d.action}</span>
                  </div>
                  {d.message ? (
                    <div className="truncate text-xs text-[var(--color-muted-foreground)]">{d.message}</div>
                  ) : null}
                </div>
                <div className="font-mono text-xs tabular-nums text-[var(--color-muted-foreground)]">
                  {durationOf(d) ?? '—'}
                </div>
                <div className="w-16 text-right text-xs text-[var(--color-muted-foreground)]">
                  {relativeTime(d.startedAt)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}

/** Wall-clock duration of a finished run (e.g. "12s", "2m 4s"). */
function durationOf(d: { startedAt: string; completedAt?: string }): string | null {
  if (!d.completedAt) return null;
  const ms = new Date(d.completedAt).getTime() - new Date(d.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
