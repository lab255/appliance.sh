import { Link, Navigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FriendlyError } from '@/components/friendly-error';
import { resolveStatusDot } from '@/components/ui/status-dot';
import { StatusPill } from '@/components/ui/status-pill';
import { Banner } from '@/components/ui/banner';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { KeyValueList } from '@/components/ui/key-value-list';
import { EntityLabel } from '@/components/ui/entity-label';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { durationMs, relativeTime } from '@/lib/time';
import { extractDeploymentUrl } from '@/lib/deployment';
import type { Deployment } from '@appliance.sh/sdk/models';

const TERMINAL = new Set(['succeeded', 'failed']);

export function DeploymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const client = useApplianceClient();

  const deploymentQuery = useQuery({
    queryKey: ['deployment', id],
    enabled: !!client && !!id,
    queryFn: async () => {
      const r = await client!.getDeployment(id!);
      if (!r.success) throw r.error;
      return r.data;
    },
    // Poll while the deployment is still running. Stop polling once
    // a terminal status is reached to avoid extra noise.
    refetchInterval: (query) => {
      const data = query.state.data as Deployment | undefined;
      if (!data) return 3_000;
      return TERMINAL.has(data.status) ? false : 3_000;
    },
  });

  const d = deploymentQuery.data;

  const projectQuery = useQuery({
    queryKey: ['project', d?.projectId],
    enabled: !!client && !!d?.projectId,
    queryFn: async () => {
      const r = await client!.getProject(d!.projectId);
      if (!r.success) throw r.error;
      return r.data;
    },
  });

  const environmentQuery = useQuery({
    queryKey: ['environment', d?.projectId, d?.environmentId],
    enabled: !!client && !!d?.projectId && !!d?.environmentId,
    queryFn: async () => {
      const r = await client!.getEnvironment(d!.projectId, d!.environmentId);
      if (!r.success) throw r.error;
      return r.data;
    },
  });

  if (!id) return <Navigate to="/deployments" replace />;

  return (
    <PageShell rail="detail" className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/deployments">
            <ChevronLeft className="h-4 w-4" /> Deployments
          </Link>
        </Button>
      </div>

      {deploymentQuery.error ? (
        <FriendlyError error={deploymentQuery.error} fallbackHeadline="Couldn't load this deployment" />
      ) : null}

      {deploymentQuery.error ? null : !d && deploymentQuery.isLoading ? (
        <div className="text-sm text-[var(--color-muted-foreground)]">Loading…</div>
      ) : !d ? (
        <div className="text-sm text-[var(--color-muted-foreground)]">Not found.</div>
      ) : (
        <>
          <PageHeader
            title={
              <>
                <EntityLabel id={d.projectId} name={projectQuery.data?.name} /> /{' '}
                <EntityLabel id={d.environmentId} name={environmentQuery.data?.name} />
              </>
            }
            description={`${d.action} deploy`}
            action={
              <div role="status" aria-live="polite" aria-atomic="true">
                <StatusPill {...resolveStatusDot(d.status)} />
              </div>
            }
          />

          {(() => {
            const url = extractDeploymentUrl(d.message) ?? environmentQuery.data?.url;
            if (!url) return null;
            return (
              <Banner
                tone="success"
                title="Deployed at"
                action={
                  <Button asChild size="sm">
                    <a href={url} target="_blank" rel="noreferrer">
                      Open app <ExternalLink className="h-4 w-4" aria-hidden />
                      <span className="sr-only"> (opens in a new window)</span>
                    </a>
                  </Button>
                }
              >
                <code className="font-mono text-xs">{url}</code>
              </Banner>
            );
          })()}

          {d.message ? (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] p-3 text-xs">
              {d.message}
            </div>
          ) : null}

          <section className="grid gap-x-6 gap-y-3 rounded-md border border-[var(--color-border)] p-4 sm:grid-cols-2">
            <Row label="Status" value={d.status} />
            <Row label="Action" value={d.action} />
            <Row
              label="App"
              value={
                projectQuery.data ? (
                  <Link to={`/projects/${d.projectId}`} className="underline-offset-2 hover:underline">
                    {projectQuery.data.name}
                  </Link>
                ) : (
                  <EntityLabel id={d.projectId} />
                )
              }
            />
            <Row
              label="Environment"
              value={
                environmentQuery.data ? (
                  <Link
                    to={`/projects/${d.projectId}/environments/${d.environmentId}`}
                    className="underline-offset-2 hover:underline"
                  >
                    {environmentQuery.data.name}
                  </Link>
                ) : (
                  <EntityLabel id={d.environmentId} />
                )
              }
            />
            <Row
              label="Started"
              value={
                <span title={d.startedAt}>
                  {relativeTime(d.startedAt)} · {new Date(d.startedAt).toLocaleTimeString()}
                </span>
              }
            />
            <Row
              label="Completed"
              value={
                d.completedAt ? (
                  <span title={d.completedAt}>
                    {relativeTime(d.completedAt)} · {new Date(d.completedAt).toLocaleTimeString()}
                  </span>
                ) : (
                  <span className="text-[var(--color-muted-foreground)]">—</span>
                )
              }
            />
            <Row label="Duration" value={durationMs(d.startedAt, d.completedAt) ?? '—'} />
          </section>

          <details className="rounded-md border border-[var(--color-border)] p-4">
            <summary className="cursor-pointer text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
              Technical details
            </summary>
            <KeyValueList
              className="mt-3"
              items={[
                { key: 'deployment', label: 'Deployment ID', value: d.id, mono: true },
                ...(d.buildId ? [{ key: 'build', label: 'Build ID', value: d.buildId, mono: true }] : []),
                ...(d.idempotentNoop ? [{ key: 'changes', label: 'Changes', value: 'No changes were needed.' }] : []),
              ]}
            />
          </details>

          <p className="text-xs text-[var(--color-muted-foreground)]">
            {TERMINAL.has(d.status) ? 'Run complete.' : 'Updating automatically while this deploy runs.'}
          </p>
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
