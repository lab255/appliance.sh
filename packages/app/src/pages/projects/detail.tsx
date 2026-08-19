import * as React from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Rocket, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { resolveStatusDot } from '@/components/ui/status-dot';
import { StatusPill } from '@/components/ui/status-pill';
import { Banner } from '@/components/ui/banner';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { SectionCard } from '@/components/ui/section-card';
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
    <PageShell rail="detail" className="space-y-6">
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
          <PageHeader
            title={project.name}
            description={project.description}
            action={
              <>
                {/* Deploy via the wizard with this app preset — same
                  `?project=<name>` param the environment detail page
                  sends (the wizard reads it via useSearchParams). */}
                <Button asChild>
                  <Link to={`/projects/deploy?project=${encodeURIComponent(project.name)}`}>
                    <Rocket className="h-4 w-4" /> Deploy
                  </Link>
                </Button>
              </>
            }
          />

          {actionError ? <Banner tone="error">{actionError}</Banner> : null}

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
                    <li key={env.id}>
                      <Link
                        to={`/projects/${env.projectId}/environments/${env.id}`}
                        aria-label={`${env.name}, ${resolveStatusDot(env.status).label}, ${env.lastDeployedAt ? relativeTime(env.lastDeployedAt) : 'never deployed'}`}
                        className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-2 hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{env.name}</div>
                          {url ? (
                            <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">{url}</div>
                          ) : null}
                        </div>
                        <StatusPill {...resolveStatusDot(env.status)} />
                        <div className="text-xs text-[var(--color-muted-foreground)]">
                          {env.lastDeployedAt ? relativeTime(env.lastDeployedAt) : '—'}
                        </div>
                      </Link>
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
                      aria-label={`${d.action}, ${envsById.get(d.environmentId) ?? d.environmentId}, ${resolveStatusDot(d.status).label}, ${relativeTime(d.startedAt)}`}
                      className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2 hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]"
                    >
                      <StatusPill {...resolveStatusDot(d.status)} />
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

          <SectionCard
            tone="danger"
            title="Delete app"
            description="Delete this app record after its environments have been destroyed."
            action={
              <Button variant="destructive" onClick={onDelete} disabled={deleteMutation.isPending}>
                <Trash2 className="h-4 w-4" /> {deleteMutation.isPending ? 'Deleting…' : 'Delete app'}
              </Button>
            }
          >
            <span className="sr-only">Destructive app action</span>
          </SectionCard>
        </>
      )}
    </PageShell>
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
