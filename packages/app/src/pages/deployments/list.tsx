import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { StatusDot } from '@/components/ui/status-dot';
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
    refetchInterval: 5_000,
  });

  if (!cluster) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Deployments</h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            In-flight and recent deployment runs across all environments.
          </p>
        </div>
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-8 text-center text-sm text-[var(--color-muted-foreground)]">
          Connect to a cluster to see deployments.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Deployments</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          In-flight and recent deployment runs across all environments.
        </p>
      </div>

      {deploymentsQuery.error ? (
        <FriendlyError error={deploymentsQuery.error} fallbackHeadline="Couldn't load deployments" />
      ) : deploymentsQuery.isLoading && !deploymentsQuery.data ? (
        <ListSkeleton />
      ) : !deploymentsQuery.data || deploymentsQuery.data.length === 0 ? (
        <EmptyState title="No deployments yet" description="Deploy an environment and its runs will show up here." />
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          {deploymentsQuery.data.map((d) => (
            <li key={d.id}>
              <Link
                to={`/deployments/${d.id}`}
                className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-[var(--color-accent)]"
              >
                <StatusDot status={d.status} />
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
                <div className="text-xs text-[var(--color-muted-foreground)]">{durationOf(d) ?? d.status}</div>
                <div className="w-16 text-right text-xs text-[var(--color-muted-foreground)]">
                  {relativeTime(d.startedAt)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
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
