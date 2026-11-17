import { RefetchButton } from '@/components/refetch-button';
import type { Inspection } from '@/lib/inspection';
import { SessionsObservation } from './sessions-observation';
import { PackageSection } from './package-section';
import { isUnreadableWorkbenchFile, workbenchErrorMessage } from './errors';
import * as React from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { WorkspaceInspector } from './workspace-inspector';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useDevMachineTargets } from '@/hooks/use-dev-machine-targets';
import { workspaceKind } from '@/components/layout/cluster-switcher';
import type { WorkbenchWorkspace } from '@/lib/host';
import { workspaceName } from './index';
import { useReadinessFixture, type ReadinessFixtureSource } from '@/lib/workbench-readiness';

export function WorkbenchDetailPage({ readinessSource }: { readinessSource?: ReadinessFixtureSource } = {}) {
  const { workspaceId = '' } = useParams();
  const readinessProposal = useReadinessFixture(workspaceId, readinessSource);
  const host = useHost();
  const location = useLocation();
  const cache = useQueryClient();
  const { config } = useSelectedCluster();
  const { visibleClusters } = useDevMachineTargets(config?.clusters ?? []);
  const [inspection, setInspection] = React.useState<Inspection>();
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const initial = (location.state as { workspace?: WorkbenchWorkspace } | null)?.workspace;
  const query = useQuery({
    queryKey: ['workbench', workspaceId],
    queryFn: () => host.workbench!.open(workspaceId),
    enabled: !!host.workbench,
    initialData: initial?.directory === workspaceId ? initial : undefined,
    staleTime: Infinity,
    retry: (failureCount, error) => !isUnreadableWorkbenchFile(error) && failureCount < 3,
  });
  const workspace = query.data;
  if (!host.workbench)
    return (
      <PageShell>
        <PageHeader title="Workbench" />
        <p>Workbench requires the desktop app. Agent execution is available on a development machine.</p>
      </PageShell>
    );
  if (!workspace)
    return (
      <PageShell>
        <PageHeader title="Workbench" />
        <div className="min-h-64">
          {query.isError ? (
            <p role="alert">
              {workbenchErrorMessage(query.error)}{' '}
              {!isUnreadableWorkbenchFile(query.error) && (
                <RefetchButton onRefetch={() => query.refetch()}>Retry</RefetchButton>
              )}
              <Link to="/workbench" className="underline">
                Back to Workbench
              </Link>
            </p>
          ) : (
            <p role="status">Opening workspace…</p>
          )}
        </div>
      </PageShell>
    );
  const target = workspace.binding.selectedTarget;
  const targetExists = visibleClusters.some((cluster) => cluster.id === target?.ref);
  const mismatch = workspace.mount && workspace.mount !== workspace.directory;
  async function select(ref: string) {
    const cluster = visibleClusters.find((item) => item.id === ref);
    if (!cluster || !workspace) return;
    setSaving(true);
    setError('');
    try {
      const updated = await host.workbench!.update(workspace.directory, {
        ...workspace.binding,
        selectedTarget: { kind: workspaceKind(cluster), ref },
      });
      cache.setQueryData(['workbench', workspaceId], updated);
      void cache.invalidateQueries({ queryKey: ['workbench'], exact: true });
    } catch (e) {
      setError(workbenchErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <PageShell rail="browse">
      <Link to="/workbench" className="text-sm underline">
        Workbench
      </Link>
      <PageHeader
        title={<span className="break-all">{workspaceName(workspace)}</span>}
        description={<span className="break-all font-mono">{workspace.directory}</span>}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <div>
          <h2 className="font-semibold">Agent machine</h2>
          <p>{workspace.machine || 'Not assigned'}</p>
          <p className="break-all text-sm text-[var(--color-muted-foreground)]">
            {workspace.mount ? `Mounted folder: ${workspace.mount}` : 'No mounted folder reported'}
          </p>
        </div>
        <div>
          <label htmlFor="workbench-target" className="block font-semibold">
            Deployment target
          </label>
          <select
            id="workbench-target"
            value={target?.ref || ''}
            disabled={saving}
            onChange={(e) => void select(e.target.value)}
            className="mt-2 max-w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background)] p-2 text-sm"
          >
            <option value="" disabled>
              Choose a deployment target
            </option>
            {target && !targetExists && <option value={target.ref}>Unavailable target · {target.ref}</option>}
            {[...visibleClusters]
              .sort((a, b) => workspaceKind(a).localeCompare(workspaceKind(b)))
              .map((cluster) => (
                <option key={cluster.id} value={cluster.id}>
                  Deployment target: {workspaceKind(cluster) === 'local' ? 'Local' : 'Cloud'} · {cluster.name}
                </option>
              ))}
          </select>
          <div className="min-h-6 break-words text-sm">
            {error ? (
              <p role="alert">{error}</p>
            ) : (
              <p role="status">{saving ? 'Saving deployment target…' : 'Applies to this workspace only.'}</p>
            )}
          </div>
        </div>
      </div>
      {mismatch && (
        <section className="mb-4 rounded-lg border border-[var(--color-border)] p-4">
          <h2 className="font-semibold">This machine is using another folder</h2>
          <p className="break-all font-mono text-sm">{workspace.mount}</p>
          <p>
            Affected recorded sessions:{' '}
            {(workspace.affectedSessions ?? workspace.sessions)
              .filter((s) => s.vm === workspace.machine && s.status === 'running')
              .map((s) => s.sessionId)
              .join(', ') || 'None recorded for this workspace; other folders may have active sessions.'}
          </p>
          <Link className="underline" to={`/machine?vm=${encodeURIComponent(workspace.machine || 'appliance')}`}>
            Open Machine
          </Link>
        </section>
      )}
      <div className="grid gap-6 md:grid-cols-2">
        <SessionsObservation key={workspace.directory} workspace={workspace} />
        <section className="min-w-0 rounded-lg border border-[var(--color-border)] p-4">
          <div id="workbench-inspection" tabIndex={-1}>
            <WorkspaceInspector directory={workspace.directory} onSnapshot={setInspection} />
          </div>
          {/* Workbench Package: sibling action; registry reads never invoke it. */}
          <div className="mt-4 border-t border-[var(--color-border)] pt-4">
            <PackageSection
              key={workspace.directory}
              directory={workspace.directory}
              packageHost={host.workbenchPackage}
              readinessProposal={readinessProposal}
              readinessContext={{
                directory: workspace.directory,
                sessions: workspace.sessions,
                snapshotId:
                  inspection?.directory === workspace.directory && !inspection.comparisonError
                    ? inspection.snapshotId
                    : undefined,
                baselineId:
                  inspection?.directory === workspace.directory && !inspection.comparisonError
                    ? inspection.baselineId
                    : undefined,
              }}
              filesChanging={workspace.sessions.some((session) => ['running', 'spawning'].includes(session.status))}
            />
          </div>
        </section>
      </div>
    </PageShell>
  );
}
