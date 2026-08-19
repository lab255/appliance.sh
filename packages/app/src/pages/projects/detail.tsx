import * as React from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ExternalLink, Rocket, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusDot } from '@/components/ui/status-dot';
import { FriendlyError } from '@/components/friendly-error';
import { EntityLabel } from '@/components/ui/entity-label';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { relativeTime } from '@/lib/time';
import { urlMapForEnvironments } from '@/lib/deployment';

// Matches environments/detail.tsx — `pending` is the initial status
// of a freshly-created env, not in-flight work.
const ENV_IN_FLIGHT = new Set(['deploying', 'destroying', 'refreshing']);

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const client = useApplianceClient();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();

  const projectQuery = useQuery({
    queryKey: ['project', id],
    enabled: !!client && !!id,
    queryFn: async () => {
      const r = await client!.getProject(id!);
      if (!r.success) throw r.error;
      return r.data;
    },
  });

  const environmentsQuery = useQuery({
    queryKey: ['environments', id],
    enabled: !!client && !!id,
    queryFn: async () => {
      const r = await client!.listEnvironments(id!);
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: (query) => {
      const envs = query.state.data as { status: string }[] | undefined;
      if (!envs) return 10_000;
      return envs.some((e) => ENV_IN_FLIGHT.has(e.status)) ? 3_000 : 10_000;
    },
  });

  const deploymentsQuery = useQuery({
    queryKey: ['deployments', 'by-project', id],
    enabled: !!client && !!id,
    queryFn: async () => {
      const r = await client!.listDeployments({ projectId: id, limit: 20 });
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: 5_000,
  });

  const envsById = React.useMemo(() => {
    const m = new Map<string, string>();
    (environmentsQuery.data ?? []).forEach((e) => m.set(e.id, e.name));
    return m;
  }, [environmentsQuery.data]);

  const urlByEnvId = React.useMemo(
    () => urlMapForEnvironments(environmentsQuery.data, deploymentsQuery.data),
    [environmentsQuery.data, deploymentsQuery.data]
  );

  const [actionError, setActionError] = React.useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const r = await client!.deleteProject(id!);
      if (!r.success) throw r.error;
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast(`App "${projectQuery.data?.name ?? id}" deleted`);
      navigate('/projects');
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
  });

  if (!id) return <Navigate to="/projects" replace />;

  const onDelete = async () => {
    if (!projectQuery.data) return;
    const ok = await confirm({
      title: `Delete app "${projectQuery.data.name}"?`,
      description: 'Its environments must already be destroyed.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    deleteMutation.mutate();
  };

  const project = projectQuery.data;

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/projects">
            <ChevronLeft className="h-4 w-4" /> Apps
          </Link>
        </Button>
      </div>

      {projectQuery.error ? (
        <FriendlyError error={projectQuery.error} fallbackHeadline="Couldn't load this app" />
      ) : null}

      {projectQuery.error ? null : !project ? (
        <div className="text-sm text-[var(--color-muted-foreground)]">
          {projectQuery.isLoading ? 'Loading…' : 'Not found.'}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold">{project.name}</h1>
              {project.description ? (
                <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{project.description}</p>
              ) : null}
            </div>
            <div className="flex gap-2">
              {/* Deploy via the wizard with this app preset — same
                  `?project=<name>` param the environment detail page
                  sends (the wizard reads it via useSearchParams). */}
              <Button asChild>
                <Link to={`/projects/deploy?project=${encodeURIComponent(project.name)}`}>
                  <Rocket className="h-4 w-4" /> Deploy
                </Link>
              </Button>
              <Button variant="destructive" onClick={onDelete} disabled={deleteMutation.isPending}>
                <Trash2 className="h-4 w-4" />
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>

          {actionError ? (
            <div className="rounded-md border border-red-500/50 bg-red-500/5 p-3 text-xs text-red-400">
              {actionError}
            </div>
          ) : null}

          <section className="grid gap-x-6 gap-y-3 rounded-md border border-[var(--color-border)] p-4 sm:grid-cols-2">
            <Row label="Status" value={project.status} />
            <Row label="ID" value={<code className="font-mono text-xs">{project.id}</code>} />
            <Row label="Created" value={<span title={project.createdAt}>{relativeTime(project.createdAt)}</span>} />
            <Row label="Updated" value={<span title={project.updatedAt}>{relativeTime(project.updatedAt)}</span>} />
          </section>

          <section className="rounded-md border border-[var(--color-border)]">
            {/* Environments manage inline — each row opens its nested
                detail (deploy / destroy live there). The old "Manage"
                jump to the flat /environments list is gone with the list. */}
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
              <h2 className="text-sm font-semibold">Environments</h2>
            </div>
            {environmentsQuery.isLoading && !environmentsQuery.data ? (
              <div className="px-4 py-3 text-xs text-[var(--color-muted-foreground)]">Loading…</div>
            ) : !environmentsQuery.data || environmentsQuery.data.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No environments yet" />
              </div>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {environmentsQuery.data.map((env) => {
                  const url = urlByEnvId.get(env.id);
                  return (
                    <li
                      key={env.id}
                      className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-4 px-4 py-2 hover:bg-[var(--color-muted)]"
                    >
                      <Link to={`/projects/${env.projectId}/environments/${env.id}`} aria-label={`Open ${env.name}`}>
                        <StatusDot status={env.status} />
                      </Link>
                      <div className="min-w-0">
                        <Link
                          to={`/projects/${env.projectId}/environments/${env.id}`}
                          className="block text-sm font-medium hover:underline"
                        >
                          {env.name}
                        </Link>
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] hover:underline"
                            title="Open deployed URL"
                          >
                            {url}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : null}
                      </div>
                      <div className="text-xs text-[var(--color-muted-foreground)]">{env.status}</div>
                      <div className="text-xs text-[var(--color-muted-foreground)]">
                        {env.lastDeployedAt ? relativeTime(env.lastDeployedAt) : '—'}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="rounded-md border border-[var(--color-border)]">
            <div className="border-b border-[var(--color-border)] px-4 py-3">
              <h2 className="text-sm font-semibold">Recent deployments</h2>
            </div>
            {deploymentsQuery.isLoading && !deploymentsQuery.data ? (
              <div className="px-4 py-3 text-xs text-[var(--color-muted-foreground)]">Loading…</div>
            ) : !deploymentsQuery.data || deploymentsQuery.data.length === 0 ? (
              <div className="p-4">
                <EmptyState title="No deployments yet" />
              </div>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {deploymentsQuery.data.map((d) => (
                  <li key={d.id}>
                    <Link
                      to={`/deployments/${d.id}`}
                      className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2 hover:bg-[var(--color-muted)]"
                    >
                      <StatusDot status={d.status} />
                      <div className="min-w-0 text-sm">
                        <div className="font-medium">
                          {d.action} · <EntityLabel id={d.environmentId} name={envsById.get(d.environmentId)} />
                        </div>
                        {d.message ? (
                          <div className="truncate text-xs text-[var(--color-muted-foreground)]">{d.message}</div>
                        ) : null}
                      </div>
                      <div className="text-right text-xs text-[var(--color-muted-foreground)]">
                        {relativeTime(d.startedAt)}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-baseline gap-3">
      <dt className="text-xs text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}
