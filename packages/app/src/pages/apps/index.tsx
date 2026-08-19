import * as React from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { Plus, Rocket, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CommandSnippet } from '@/components/ui/command-snippet';
import { FriendlyError, classifyError } from '@/components/friendly-error';
import { StartMachineRecovery, useStartableDevMachine } from '@/components/start-machine-recovery';
import { EntityLabel } from '@/components/ui/entity-label';
import { LiveUrl } from '@/components/ui/live-url';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusDot } from '@/components/ui/status-dot';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { useKeyRole } from '@/hooks/use-key-role';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useEnvironmentsMap, useProjectsMap } from '@/hooks/use-lookups';
import { relativeTime } from '@/lib/time';
import { extractDeploymentUrl } from '@/lib/deployment';
import { formatCpu, formatMemory, hasHealthSignal, healthDotStatus, healthLabel } from '@/lib/health';
import { EnvironmentHealthStatus, type EnvironmentHealth } from '@appliance.sh/sdk/models';
import type { Environment, Project } from '@appliance.sh/sdk/models';

// ③ Apps — the pure overview home at /projects (the Vercel-style card grid +
// health rollup + recent activity). The first-run / setup branches that used
// to share this component live at ① /setup now (pages/setup/index.tsx); an
// unconfigured shell landing here is bounced there instead of rendering a
// broken empty grid.
export function AppsPage() {
  const { cluster, isLoading } = useSelectedCluster();
  if (isLoading) return null;
  if (!cluster) return <Navigate to="/setup" replace />;
  return <Overview clusterName={cluster.name} clusterId={cluster.id} serverUrl={cluster.apiServerUrl} />;
}

// The app grid. Owns the app CRUD the old `pages/projects.tsx`
// (`ConnectedProjects`) carried: inline create + per-card delete + the live
// URLs (the cards surface the primary live deployment; the app detail lists
// every env's URL). "Project" survives only as internal ids/props — the
// user-facing unit is an App.

function Overview({
  clusterName,
  clusterId,
  serverUrl,
}: {
  clusterName: string;
  clusterId: string;
  serverUrl: string;
}) {
  const client = useApplianceClient();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const { role } = useKeyRole();
  const canManageApps = role === 'admin';
  const [filter, setFilter] = React.useState('');
  // When the apps query fails because the local Dev Machine isn't running,
  // offer a one-click Start instead of a dead-end error (post-delete / stop
  // / fresh install). Null unless the selected target is a startable local
  // VM on this (desktop) host.
  const startableVm = useStartableDevMachine({ id: clusterId, apiServerUrl: serverUrl });

  // Inline "New app" create (folded in from ConnectedProjects) — the
  // grid's create CTA used to dead-link back to /projects.
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [newDescription, setNewDescription] = React.useState('');
  const [mutationError, setMutationError] = React.useState<string | null>(null);

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    enabled: !!client,
    queryFn: async () => {
      const r = await client!.listProjects();
      if (!r.success) throw r.error;
      return r.data;
    },
    refetchInterval: 10_000,
  });

  const createMutation = useMutation({
    mutationFn: async (input: { name: string; description?: string }) => {
      const r = await client!.createProject(input);
      if (!r.success) throw r.error;
      return r.data;
    },
    onSuccess: (project) => {
      setCreating(false);
      setNewName('');
      setNewDescription('');
      setMutationError(null);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast(`App "${project.name}" created`);
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : String(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: async (p: Project) => {
      const r = await client!.deleteProject(p.id);
      if (!r.success) throw r.error;
      return p;
    },
    onSuccess: (p) => {
      setMutationError(null);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast(`App "${p.name}" deleted`);
    },
    onError: (err) => setMutationError(err instanceof Error ? err.message : String(err)),
  });

  const onCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName) return;
    createMutation.mutate({ name: newName, description: newDescription || undefined });
  };

  const onDeleteProject = async (p: Project) => {
    const ok = await confirm({
      title: `Delete app "${p.name}"?`,
      description: 'Its environments must already be destroyed.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    deleteMutation.mutate(p);
  };

  const environmentQueries = useQueries({
    queries: (projectsQuery.data ?? []).map((p) => ({
      queryKey: ['environments', p.id],
      enabled: !!client,
      queryFn: async () => {
        const r = await client!.listEnvironments(p.id);
        if (!r.success) throw r.error;
        return r.data;
      },
      refetchInterval: 10_000,
    })),
  });

  // Shares the deployments-list page's query key so navigation between
  // the two never double-fetches.
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

  const error = projectsQuery.error ?? environmentQueries.find((q) => q.error)?.error ?? deploymentsQuery.error;
  const loading = projectsQuery.isLoading;
  const projects = projectsQuery.data ?? [];
  const envsByProject = new Map<string, Environment[]>();
  projects.forEach((p, i) => envsByProject.set(p.id, environmentQueries[i]?.data ?? []));

  const visible = filter.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : projects;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Apps</h1>
          <p className="mt-0.5 text-sm text-[var(--color-muted-foreground)]">
            {clusterName} · <span className="font-mono text-xs">{serverUrl}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted-foreground)]" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search apps…"
              className="h-9 w-56 rounded-md border border-[var(--color-border)] bg-transparent pl-8 pr-3 text-sm placeholder:text-[var(--color-muted-foreground)] focus:border-[var(--color-border-strong)] focus:outline-none"
            />
          </div>
          {/* Deploy is the primary action — the wizard find-or-creates the
              app + environment and deploys in one flow. "New app" (a bare
              app record, no deploy) stays as the secondary path. */}
          {canManageApps ? (
            <>
              <Button asChild>
                <Link to="/projects/deploy">
                  <Rocket className="h-4 w-4" /> Deploy an app
                </Link>
              </Button>
              {!creating ? (
                <Button variant="outline" onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" /> New app
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {canManageApps && creating ? (
        <form onSubmit={onCreate} className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
          <h2 className="text-sm font-semibold">New app</h2>
          <label className="block space-y-1 text-sm">
            <span className="text-[var(--color-muted-foreground)]">Name</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              pattern="[a-z][a-z0-9\-]*"
              required
              autoFocus
              placeholder="my-app"
              className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-[var(--color-muted-foreground)]">Description (optional)</span>
            <input
              type="text"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCreating(false);
                setNewName('');
                setNewDescription('');
                setMutationError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {mutationError ? (
        <FriendlyError error={mutationError} fallbackHeadline="That change didn't go through" />
      ) : error ? (
        classifyError(error) === 'network' && startableVm ? (
          <StartMachineRecovery vmName={startableVm} error={error} />
        ) : (
          <FriendlyError error={error} fallbackHeadline="Couldn't load your apps" />
        )
      ) : null}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-3 rounded-lg border border-[var(--color-border)] p-5">
              <Skeleton className="h-5 w-2/5" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          ))}
        </div>
      ) : !client || projectsQuery.isPending ? (
        // The apps query is DISABLED (no SDK client — e.g. the selected
        // cluster's signing secret is missing or an alias rebind is still
        // converging) or hasn't produced data yet. That is NOT "zero
        // apps": rendering the first-app CTA here misreads a machine we
        // simply aren't connected to yet as an empty one.
        <p className="py-16 text-center text-sm text-[var(--color-muted-foreground)]">Connecting to {clusterName}…</p>
      ) : projects.length === 0 ? (
        <EmptyApps canManageApps={canManageApps} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((project) => (
            <AppCard
              key={project.id}
              project={project}
              environments={envsByProject.get(project.id) ?? []}
              onDelete={canManageApps ? onDeleteProject : undefined}
              deleting={deleteMutation.isPending}
            />
          ))}
          {visible.length === 0 ? (
            <p className="col-span-full py-12 text-center text-sm text-[var(--color-muted-foreground)]">
              No apps match “{filter.trim()}”.
            </p>
          ) : null}
        </div>
      )}

      {projects.length > 0 ? (
        <RecentActivity deployments={deploymentsQuery.data?.slice(0, 8)} loading={deploymentsQuery.isLoading} />
      ) : null}
    </div>
  );
}

function AppCard({
  project,
  environments,
  onDelete,
  deleting,
}: {
  project: Project;
  environments: Environment[];
  onDelete?: (p: Project) => void;
  deleting: boolean;
}) {
  const client = useApplianceClient();
  // Card status mirrors the "worst interesting" environment state:
  // anything failed wins, else in-flight, else deployed.
  const status = environments.some((e) => e.status === 'failed')
    ? 'failed'
    : environments.some((e) => ['deploying', 'destroying'].includes(e.status))
      ? 'deploying'
      : environments.some((e) => e.status === 'deployed')
        ? 'deployed'
        : 'pending';
  const live = environments.find((e) => e.status === 'deployed' && e.url);
  const deployedAts = environments
    .map((e) => e.lastDeployedAt)
    .filter((v): v is string => Boolean(v))
    .sort();
  const lastDeployed = deployedAts[deployedAts.length - 1];

  // Fetch health only for environments that have actually deployed —
  // the server returns `unknown` on non-Kubernetes bases / unreachable
  // clusters, so the card hides the badge unless there's real signal.
  const deployedEnvs = environments.filter((e) => Boolean(e.lastDeployedAt));
  const healthQueries = useQueries({
    queries: deployedEnvs.map((e) => ({
      queryKey: ['environment-health', project.id, e.id],
      enabled: !!client,
      queryFn: async () => {
        const r = await client!.getEnvironmentHealth(project.id, e.id);
        if (!r.success) throw r.error;
        return r.data;
      },
      refetchInterval: 10_000,
      retry: false,
    })),
  });
  const summary = summarizeHealth(healthQueries.map((q) => q.data));

  return (
    <div className="group relative flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-border-strong)]">
      {/* Per-card delete (folded from ConnectedProjects) — a sibling of the
          navigation Link, not nested inside it, so the markup stays valid.
          Revealed on hover / keyboard focus. */}
      {onDelete ? (
        <button
          type="button"
          aria-label={`Delete ${project.name}`}
          disabled={deleting}
          onClick={() => onDelete(project)}
          className="absolute right-2 top-2 z-10 rounded p-1 text-[var(--color-muted-foreground)] opacity-0 transition-opacity hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <Link to={`/projects/${project.id}`} className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-center justify-between gap-2 pr-6">
          <span className="truncate font-medium">{project.name}</span>
          <StatusDot status={status} />
        </div>
        <div className="min-h-5 text-sm">
          {live?.url ? (
            <LiveUrl url={live.url} />
          ) : (
            <span className="text-[var(--color-muted-foreground)]">No live deployment</span>
          )}
        </div>
        {summary ? (
          <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
            <StatusDot status={healthDotStatus(summary.status)} />
            <span>{healthLabel(summary.status)}</span>
            {summary.usage ? (
              <span className="font-mono">
                · {formatCpu(summary.usage.cpuMillicores)} · {formatMemory(summary.usage.memoryBytes)}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="mt-auto flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
          <span>
            {environments.length} environment{environments.length === 1 ? '' : 's'}
          </span>
          <span>{lastDeployed ? `Updated ${relativeTime(lastDeployed)}` : 'Never deployed'}</span>
        </div>
      </Link>
    </div>
  );
}

// Roll an app's per-environment health into one card-level verdict:
// the worst status wins (unhealthy > degraded > healthy), and CPU/mem
// are summed across environments that reported usage. Returns null when
// no environment carries actionable health signal (so the card stays
// uncluttered for non-Kubernetes bases / not-yet-deployed apps).
function summarizeHealth(
  healths: (EnvironmentHealth | undefined)[]
): { status: EnvironmentHealthStatus; usage?: { cpuMillicores: number; memoryBytes: number } } | null {
  const meaningful = healths.filter(hasHealthSignal) as EnvironmentHealth[];
  if (meaningful.length === 0) return null;

  const rank: Record<string, number> = {
    [EnvironmentHealthStatus.Unhealthy]: 3,
    [EnvironmentHealthStatus.Degraded]: 2,
    [EnvironmentHealthStatus.Healthy]: 1,
  };
  let status = EnvironmentHealthStatus.Healthy;
  for (const h of meaningful) {
    if ((rank[h.status] ?? 0) > (rank[status] ?? 0)) status = h.status;
  }

  let cpuMillicores = 0;
  let memoryBytes = 0;
  let hasUsage = false;
  for (const h of meaningful) {
    if (h.usage) {
      hasUsage = true;
      cpuMillicores += h.usage.cpuMillicores;
      memoryBytes += h.usage.memoryBytes;
    }
  }

  return { status, ...(hasUsage ? { usage: { cpuMillicores, memoryBytes } } : {}) };
}

function EmptyApps({ canManageApps }: { canManageApps: boolean }) {
  const navigate = useNavigate();
  if (!canManageApps) {
    return (
      <div className="mx-auto max-w-md space-y-2 py-16 text-center">
        <h2 className="text-lg font-semibold">No apps yet</h2>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Ask an operator to create or deploy an app to this cluster.
        </p>
      </div>
    );
  }
  // A freshly-onboarded user with no apps gets a button, not just a
  // command to copy. The deploy wizard (/projects/deploy) find-or-creates
  // the app + environment and writes the link itself, so there's no
  // separate setup step — the CLI snippet stays as a secondary hint for
  // terminal-first users.
  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <h2 className="text-lg font-semibold">Deploy your first app</h2>
      <p className="text-sm text-[var(--color-muted-foreground)]">
        Pick an application folder with an <code className="font-mono">appliance.json</code> — the wizard creates the
        app, builds, and deploys in one step.
      </p>
      <Button size="lg" onClick={() => navigate('/projects/deploy')}>
        Deploy your first app
      </Button>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Prefer the terminal? Run this from your app directory instead:
      </p>
      <CommandSnippet command="appliance deploy" className="text-left" />
      <p className="text-xs text-[var(--color-muted-foreground)]">The deployed app appears here with its live URL.</p>
    </div>
  );
}

function RecentActivity({
  deployments,
  loading,
}: {
  deployments: import('@appliance.sh/sdk/models').Deployment[] | undefined;
  loading: boolean;
}) {
  const envs = useEnvironmentsMap();
  const projects = useProjectsMap();
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-muted-foreground)]">Recent activity</h2>
        <Link
          to="/deployments"
          className="text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] hover:underline"
        >
          View all
        </Link>
      </div>
      {loading && !deployments ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : !deployments || deployments.length === 0 ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          No deployments yet. Runs triggered from the CLI or this console show up here.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
          {deployments.map((d) => {
            const env = envs.get(d.environmentId);
            const url = env?.url ?? extractDeploymentUrl(d.message);
            return (
              <li key={d.id}>
                <Link
                  to={`/deployments/${d.id}`}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[var(--color-accent)]"
                >
                  <StatusDot status={d.status} />
                  <div className="min-w-0 text-sm">
                    <span className="font-medium">
                      <EntityLabel id={d.projectId} name={projects.get(d.projectId)?.name} />
                      <span className="text-[var(--color-muted-foreground)]">/</span>
                      <EntityLabel id={d.environmentId} name={env?.name} />
                    </span>
                    <span className="ml-2 text-xs text-[var(--color-muted-foreground)]">
                      {d.action}
                      {url ? (
                        <>
                          {' · '}
                          <span className="font-mono">{url.replace(/^https?:\/\//, '')}</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <span className="text-right text-xs text-[var(--color-muted-foreground)]">
                    {relativeTime(d.startedAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
