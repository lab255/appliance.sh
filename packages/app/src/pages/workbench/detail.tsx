import { isUnreadableWorkbenchFile, workbenchErrorMessage } from './errors';
import * as React from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@appliance.sh/ui/tabs';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useDevMachineTargets } from '@/hooks/use-dev-machine-targets';
import { workspaceKind } from '@/components/layout/cluster-switcher';
import type { WorkbenchWorkspace } from '@/lib/host';
import { workspaceName } from './index';

export function WorkbenchDetailPage() {
  const { workspaceId = '' } = useParams();
  const host = useHost();
  const location = useLocation();
  const cache = useQueryClient();
  const { config } = useSelectedCluster();
  const { visibleClusters } = useDevMachineTargets(config?.clusters ?? []);
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const initial = (location.state as { workspace?: WorkbenchWorkspace } | null)?.workspace;
  const query = useQuery({
    queryKey: ['workbench', workspaceId],
    queryFn: () => host.workbench!.open(workspaceId),
    enabled: !!host.workbench,
    initialData: initial?.directory === workspaceId ? initial : undefined,
    staleTime: Infinity,
    retry: false,
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
              {!isUnreadableWorkbenchFile(query.error) && <Button onClick={() => query.refetch()}>Retry</Button>}
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
      cache.setQueryData(['workbench', workspaceId], { ...updated, baselineWarning: workspace.baselineWarning });
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
        <section className="min-h-64 rounded-lg border border-[var(--color-border)] p-4">
          <h2 className="mb-3 font-semibold">Sessions</h2>
          <p>{workspace.sessions.length} recorded sessions. Live session controls are not available yet.</p>
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">No agent is launched from this shell.</p>
        </section>
        <section className="min-w-0 rounded-lg border border-[var(--color-border)] p-4">
          <Tabs defaultValue="changes">
            <TabsList aria-label="Workspace inspection">
              {['Changes', 'Files', 'Logs'].map((tab) => (
                <TabsTrigger key={tab} value={tab.toLowerCase()}>
                  {tab}
                </TabsTrigger>
              ))}
            </TabsList>
            {['Changes', 'Files', 'Logs'].map((tab) => (
              <TabsContent key={tab} value={tab.toLowerCase()} className="min-h-40 py-4">
                <p>{tab} inspection is not available yet.</p>
              </TabsContent>
            ))}
          </Tabs>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {workspace.baselineWarning || 'No baseline captured — change comparison will be unavailable'}
          </p>
          {/* Persistent action section: W2 Package / wave 2b Deploy integration seam. */}
          <div className="mt-4 space-y-4 border-t border-[var(--color-border)] pt-4">
            <div>
              <Button disabled>Package</Button>
              <p className="mt-2 text-sm">Packaging is not available yet.</p>
            </div>
            <div>
              <Button variant="outline" disabled>
                Deploy
              </Button>
              <p className="mt-2 text-sm">
                Workspace deployment is not available yet.{' '}
                <Link to="/projects/deploy" className="underline">
                  Open ordinary source deployment
                </Link>
              </p>
            </div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
