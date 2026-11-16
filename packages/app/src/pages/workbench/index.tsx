import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from '@appliance.sh/ui/dialog';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { useHost } from '@/providers/host-provider';
import type { WorkbenchWorkspace } from '@/lib/host';

export const workspaceUrl = (directory: string) => `/workbench/${encodeURIComponent(directory)}`;
export const workspaceName = (workspace: WorkbenchWorkspace) =>
  workspace.binding.label || workspace.directory.split(/[/\\]/).filter(Boolean).at(-1) || workspace.directory;

export function WorkbenchPage() {
  const host = useHost();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [blank, setBlank] = React.useState(false);
  const [name, setName] = React.useState('');
  const [parent, setParent] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const query = useQuery({ queryKey: ['workbench'], queryFn: () => host.workbench!.list(), enabled: !!host.workbench });
  async function existing() {
    setError('');
    setBusy(true);
    try {
      const directory = await host.local?.pickDirectory();
      if (directory) {
        const workspace = await host.workbench!.open(directory);
        navigate(workspaceUrl(workspace.directory), { state: { workspace } });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const workspace = await host.workbench!.create(parent, name);
      navigate(workspaceUrl(workspace.directory), { state: { workspace } });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageShell rail="browse">
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value);
            if (!value) {
              setBlank(false);
              setError('');
            }
          }
        }}
      >
        <PageHeader
          title="Workbench"
          action={
            <DialogTrigger asChild>
              <Button disabled={!host.workbench}>Create workspace</Button>
            </DialogTrigger>
          }
        />
        <DialogContent className="left-0 top-0 right-0 bottom-0 m-auto h-fit translate-x-0 translate-y-0">
          <div className="mb-4 space-y-2">
            <DialogTitle>Create workspace</DialogTitle>
            <DialogDescription>Open a project folder or start with a blank folder.</DialogDescription>
          </div>
          {!blank ? (
            <div className="flex flex-wrap gap-3">
              <Button onClick={existing} disabled={busy}>
                Open existing project
              </Button>
              <Button variant="outline" onClick={() => setBlank(true)}>
                Create blank workspace
              </Button>
            </div>
          ) : (
            <form onSubmit={create} className="space-y-4">
              <label className="block space-y-2">
                Name
                <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus required disabled={busy} />
              </label>
              <label className="block space-y-2">
                Parent directory
                <Input value={parent} onChange={(e) => setParent(e.target.value)} required disabled={busy} />
              </label>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  try {
                    const value = await host.local?.pickDirectory();
                    if (value) setParent(value);
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Choose parent directory
              </Button>
              <p className="break-all font-mono text-sm">
                {parent
                  ? `${parent.replace(/[/\\]$/, '')}${parent.includes('\\') ? '\\' : '/'}${name}`
                  : 'Choose a parent directory to preview the absolute path.'}
              </p>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                Creates only a new folder. No agent starts automatically.
              </p>
              <div className="flex gap-3">
                <Button type="submit" disabled={busy || !name || !parent}>
                  {busy ? 'Creating…' : 'Create blank workspace'}
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          <div className="min-h-6">
            {error && (
              <p role="alert" className="text-sm text-[var(--color-destructive)]">
                {error}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {!host.workbench ? (
        <p>Workbench requires the desktop app. Agent execution is available on a development machine.</p>
      ) : (
        <div className="min-h-64">
          {query.isPending && <p role="status">Loading workspaces…</p>}
          {query.isError && (
            <div role="alert">
              Could not read workspaces.{' '}
              <Button variant="outline" onClick={() => query.refetch()}>
                Retry
              </Button>
            </div>
          )}
          {query.data?.length === 0 && (
            <div className="space-y-4 rounded-lg border border-[var(--color-border)] p-6">
              <p>No workspaces yet. Open a project folder or start with a blank folder.</p>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    setOpen(true);
                    void existing();
                  }}
                >
                  Open existing project
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setBlank(true);
                    setOpen(true);
                  }}
                >
                  Create blank workspace
                </Button>
              </div>
            </div>
          )}
          {query.data?.map((workspace) => {
            const latest = [...workspace.sessions].sort((a, b) =>
              (b.endedAt || b.launchedAt || '').localeCompare(a.endedAt || a.launchedAt || '')
            )[0];
            return (
              <Link
                key={workspace.directory}
                to={workspaceUrl(workspace.directory)}
                className="mb-3 block rounded-lg border border-[var(--color-border)] p-4 hover:bg-[var(--color-hover)] focus-visible:outline-2"
              >
                <h2 className="break-all font-semibold">{workspaceName(workspace)}</h2>
                <p className="break-all font-mono text-sm">{workspace.directory}</p>
                <dl className="mt-3 grid gap-3 break-words text-sm sm:grid-cols-4">
                  <div>
                    <dt>Agent machine</dt>
                    <dd>{workspace.machine || 'Not assigned'}</dd>
                  </div>
                  <div>
                    <dt>Sessions</dt>
                    <dd>{workspace.sessions.length} recorded</dd>
                  </div>
                  <div>
                    <dt>Last activity</dt>
                    <dd>{latest?.endedAt || latest?.launchedAt || 'Not recorded'}</dd>
                  </div>
                  <div>
                    <dt>Last outcome</dt>
                    <dd>{latest?.summary || latest?.status || 'No recorded outcome'}</dd>
                  </div>
                </dl>
                {workspace.error && <p role="alert">Could not read workspace: {workspace.error}</p>}
              </Link>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
