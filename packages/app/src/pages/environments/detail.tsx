import * as React from 'react';
import { Link, useNavigate, useParams, Navigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ExternalLink, Play, Rocket, Trash2 } from 'lucide-react';
import { LiveUrl } from '@/components/ui/live-url';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FriendlyError } from '@/components/friendly-error';
import { CommandSnippet } from '@/components/ui/command-snippet';
import { StatusDot, resolveStatusDot } from '@/components/ui/status-dot';
import { StatusPill } from '@/components/ui/status-pill';
import { Banner } from '@/components/ui/banner';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { SectionCard } from '@/components/ui/section-card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { useEnvironmentHealth } from '@/hooks/use-environment-health';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useHost } from '@/providers/host-provider';
import { relativeTime } from '@/lib/time';
import { urlForEnvironment } from '@/lib/deployment';
import { microVmNameFromClusterId } from '@/lib/host';
import { formatCpu, formatMemory, healthDotStatus, healthLabel } from '@/lib/health';
import { EnvironmentHealthStatus, type Environment, type EnvironmentHealth } from '@appliance.sh/sdk/models';
import { WorkloadsPanel } from './workloads-panel';

// "pending" looks like in-flight but is also the initial status a
// freshly-created environment has before any deployment runs, so we
// must NOT lump it in here — otherwise Deploy/Destroy stay disabled
// on a brand-new env forever. Real in-flight work always corresponds
// to a non-terminal Deployment record; the per-deployment polling
// surfaces that.
const ENV_IN_FLIGHT = new Set(['deploying', 'destroying', 'refreshing']);

export function EnvironmentDetailPage() {
  const { projectId, id } = useParams<{ projectId: string; id: string }>();
  const navigate = useNavigate();
  const client = useApplianceClient();
  const queryClient = useQueryClient();
  const host = useHost();
  const confirm = useConfirm();
  const canRunDeployWizard = Boolean(host.local?.packageAndUploadBuild);
  // ③ env-detail absorbs the runtime Workloads surface (move-map 4a). It
  // reads through the selected cluster's in-VM api-server, so it's only
  // meaningful when the env's cluster is a local microVM runtime this shell
  // can see (host.vm). Cloud / web env-detail keeps the Health section below.
  const { cluster: selectedCluster } = useSelectedCluster();
  const workloadsVmName = host.vm && selectedCluster ? microVmNameFromClusterId(selectedCluster.id) : null;

  const envQuery = useQuery({
    queryKey: ['environment', projectId, id],
    enabled: !!client && !!projectId && !!id,
    queryFn: async () => {
      const r = await client!.getEnvironment(projectId!, id!);
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: (query) => {
      const data = query.state.data as Environment | undefined;
      if (!data) return 5_000;
      return ENV_IN_FLIGHT.has(data.status) ? 3_000 : 10_000;
    },
  });

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    enabled: !!client && !!projectId,
    queryFn: async () => {
      const r = await client!.getProject(projectId!);
      if (!r.success) throw r.error;
      return r.data;
    },
  });

  const deploymentsQuery = useQuery({
    queryKey: ['deployments', 'by-environment', id],
    enabled: !!client && !!id,
    queryFn: async () => {
      const r = await client!.listDeployments({ environmentId: id, limit: 20 });
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: 5_000,
  });

  // Only poll health once the env has deployed at least once — a
  // brand-new env has no workload, so health would just read "not
  // deployed". The server still degrades gracefully if we're wrong.
  const env = envQuery.data;
  const healthQuery = useEnvironmentHealth(projectId, id, Boolean(env?.lastDeployedAt));

  const [actionError, setActionError] = React.useState<string | null>(null);

  const invalidateAll = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['environment', projectId, id] });
    queryClient.invalidateQueries({ queryKey: ['deployments', 'by-environment', id] });
    queryClient.invalidateQueries({ queryKey: ['deployments'] });
  }, [queryClient, projectId, id]);

  const deployMutation = useMutation({
    mutationFn: async () => {
      const r = await client!.deploy(id!);
      if (!r.success) throw r.error;
      return r.data;
    },
    onSuccess: (deployment) => {
      setActionError(null);
      invalidateAll();
      navigate(`/deployments/${deployment.id}`);
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
  });

  const destroyMutation = useMutation({
    mutationFn: async () => {
      const r = await client!.destroy(id!);
      if (!r.success) throw r.error;
      return r.data;
    },
    onSuccess: (deployment) => {
      setActionError(null);
      invalidateAll();
      navigate(`/deployments/${deployment.id}`);
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : String(err)),
  });

  if (!projectId || !id) return <Navigate to="/projects" replace />;

  const inFlight = env ? ENV_IN_FLIGHT.has(env.status) : false;
  const busy = deployMutation.isPending || destroyMutation.isPending || inFlight;

  const onDestroy = async () => {
    if (!env) return;
    const ok = await confirm({
      title: `Destroy environment "${env.name}"?`,
      description: 'Apps in this environment stop, but the environment record remains and can be deployed again.',
      confirmLabel: 'Destroy environment',
    });
    if (!ok) return;
    destroyMutation.mutate();
  };

  return (
    <PageShell rail="detail" className="space-y-6">
      <div>
        {/* Nested under ③ Apps — back goes to the parent app, not a flat
            environments list, so the area reads coherently. */}
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to={`/projects/${projectId}`}>
            <ChevronLeft className="h-4 w-4" /> {projectQuery.data?.name ?? 'App'}
          </Link>
        </Button>
      </div>

      {envQuery.error ? (
        <FriendlyError error={envQuery.error} fallbackHeadline="Couldn't load this environment" />
      ) : null}

      {envQuery.error ? null : !env ? (
        <div className="text-sm text-[var(--color-muted-foreground)]">
          {envQuery.isLoading ? 'Loading…' : 'Not found.'}
        </div>
      ) : (
        <>
          <PageHeader
            title={
              <span className="inline-flex items-center gap-3">
                {env.name}
                <StatusPill {...resolveStatusDot(env.status)} />
              </span>
            }
            description={projectQuery.data?.name ?? env.projectId}
            action={
              <>
                {(() => {
                  // First-time deploys have no image to redeploy from, so
                  // `client.deploy(id)` would fail with "No image available…"
                  // on the server. When the desktop's local-runtime wizard
                  // is available, route the user there with the env preset
                  // so they can build + push an image in one flow. On the
                  // web shell the first deploy happens from the CLI — the
                  // guidance card below replaces a button that could only
                  // ever fail.
                  const hasImage = Boolean(env.lastDeployedAt);
                  if (!hasImage && canRunDeployWizard) {
                    const target = `/projects/deploy?project=${encodeURIComponent(
                      projectQuery.data?.name ?? env.projectId
                    )}&environment=${encodeURIComponent(env.name)}`;
                    return (
                      <Button asChild disabled={busy}>
                        <Link to={target}>
                          <Rocket className="h-4 w-4" /> Deploy this app
                        </Link>
                      </Button>
                    );
                  }
                  if (!hasImage) return null;
                  return (
                    <Button onClick={() => deployMutation.mutate()} disabled={busy}>
                      <Play className="h-4 w-4" />
                      {deployMutation.isPending ? 'Starting…' : 'Redeploy'}
                    </Button>
                  );
                })()}
              </>
            }
          />

          {!env.lastDeployedAt && !canRunDeployWizard ? (
            <div className="space-y-2 rounded-md border border-[var(--color-border)] p-4">
              <div className="text-sm font-semibold">Deploy your first build</div>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                This environment has no build yet. Run this from your application directory — it builds, uploads, and
                deploys in one step. Redeploys are available here afterwards.
              </p>
              <CommandSnippet command={`appliance deploy ${projectQuery.data?.name ?? env.projectId} ${env.name}`} />
            </div>
          ) : null}

          {(() => {
            // Prefer the canonical env.url; fall back to the latest
            // deploy's message for environments that predate the field.
            const url = urlForEnvironment(env, deploymentsQuery.data);
            if (!url) return null;
            return (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
                <div className="flex min-w-0 items-center gap-3 text-sm">
                  <StatusPill tone="success" label="Live" />
                  <LiveUrl url={url} className="min-w-0 text-sm" />
                </div>
                <Button asChild size="sm">
                  <a href={url} target="_blank" rel="noreferrer">
                    Visit <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            );
          })()}

          <section className="grid gap-x-6 gap-y-3 rounded-md border border-[var(--color-border)] p-4 sm:grid-cols-2">
            <Row label="Status" value={env.status} />
            <Row label="Stack" value={<code className="font-mono text-xs">{env.stackName}</code>} />
            <Row
              label="Last deployed"
              value={
                env.lastDeployedAt ? (
                  <span title={env.lastDeployedAt}>{relativeTime(env.lastDeployedAt)}</span>
                ) : (
                  <span className="text-[var(--color-muted-foreground)]">never</span>
                )
              }
            />
            <Row label="Created" value={<span title={env.createdAt}>{relativeTime(env.createdAt)}</span>} />
          </section>

          {env.lastDeployedAt ? <HealthSection health={healthQuery.data} loading={healthQuery.isLoading} /> : null}

          {/* Runtime workloads (deployments / pods / services + live logs +
              pod-shell), moved here from the runtimes page — it belongs with
              the env that was deployed. Local microVM runtimes only; cloud /
              web env-detail relies on the Health section above. The panel is
              runtime-scoped (it backs ②'s aggregate), so it carries a scope
              clarifier here under a single environment (Parker I3). */}
          {workloadsVmName && selectedCluster ? (
            <WorkloadsPanel
              clusterId={selectedCluster.id}
              vmName={workloadsVmName}
              scopeNote="Showing everything hosted on this Dev Machine, not only this environment."
            />
          ) : null}

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
                      aria-label={`${d.action}, ${resolveStatusDot(d.status).label}, ${relativeTime(d.startedAt)}`}
                      className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2 hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]"
                    >
                      <StatusPill {...resolveStatusDot(d.status)} />
                      <div className="min-w-0 text-sm">
                        <div className="font-medium">{d.action}</div>
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
            title={`Destroy ${env.name}`}
            description="Stop apps in this environment while keeping the environment record."
            action={
              <Button variant="destructive" onClick={onDestroy} disabled={busy}>
                <Trash2 className="h-4 w-4" /> {destroyMutation.isPending ? 'Starting…' : 'Destroy environment'}
              </Button>
            }
          >
            {actionError ? (
              <Banner tone="error" className="mt-2">
                {actionError}
              </Banner>
            ) : (
              <span className="sr-only">Destructive environment action</span>
            )}
          </SectionCard>
        </>
      )}
    </PageShell>
  );
}

function HealthSection({ health, loading }: { health: EnvironmentHealth | undefined; loading: boolean }) {
  return (
    <section className="rounded-md border border-[var(--color-border)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="text-sm font-semibold">Health</h2>
        {health ? (
          <span className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
            <StatusDot status={healthDotStatus(health.status)} />
            {healthLabel(health.status)}
          </span>
        ) : null}
      </div>
      {loading && !health ? (
        <div className="px-4 py-3 text-xs text-[var(--color-muted-foreground)]">Loading…</div>
      ) : !health || health.status === EnvironmentHealthStatus.Unknown ? (
        <div className="px-4 py-3 text-xs text-[var(--color-muted-foreground)]">
          {health?.message ?? 'Health metrics are unavailable for this environment.'}
        </div>
      ) : (
        <div className="space-y-3 px-4 py-3">
          <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Row label="Replicas" value={`${health.readyReplicas} / ${health.desiredReplicas} ready`} />
            <Row label="Restarts" value={String(health.restarts)} />
            {health.usage ? (
              <>
                <Row label="CPU" value={formatCpu(health.usage.cpuMillicores)} />
                <Row label="Memory" value={formatMemory(health.usage.memoryBytes)} />
              </>
            ) : (
              <Row
                label="CPU / Memory"
                value={<span className="text-[var(--color-muted-foreground)]">metrics-server not available</span>}
              />
            )}
          </div>
          {health.pods.length > 0 ? (
            <ul className="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
              {health.pods.map((pod) => (
                <li key={pod.name} className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 text-xs">
                  <span className="min-w-0">
                    <span className="font-mono">{pod.name}</span>
                    {pod.reason ? (
                      <span className="ml-2 text-[var(--color-destructive-foreground)]">{pod.reason}</span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-3 text-[var(--color-muted-foreground)]">
                    <span>{pod.ready ? 'Ready' : pod.phase}</span>
                    <span>
                      {pod.restarts} restart{pod.restarts === 1 ? '' : 's'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </section>
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
