import * as React from 'react';
import { FolderOpen, Grid2X2, Search } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { InstalledRuntimeApp } from '@/lib/host';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { useCurrentWorkspace } from '@/components/layout/workspace-switcher';
import {
  parseUnknownPublisherError,
  unknownPublisherWarningDue,
  type UnknownPublisherPrompt,
} from '@/lib/installed-apps';
import { useHost } from '@/providers/host-provider';
import { UnknownPublisherDialog } from './unknown-publisher-dialog';

type PendingWarning =
  | { action: 'install'; source: string; prompt: UnknownPublisherPrompt }
  | { action: 'open'; app: InstalledRuntimeApp; prompt: UnknownPublisherPrompt };

function promptForInstalledApp(item: InstalledRuntimeApp): UnknownPublisherPrompt {
  const app = item.app;
  return {
    appId: app.appId,
    name: app.name,
    version: app.version,
    license: app.license,
    source: app.source,
    digest: app.digest,
    signature: app.verification.signature === 'unsigned' ? 'unsigned' : 'invalid',
    publisher: app.publisher.name,
    controlsSummary: app.controlsSummary,
  };
}

export function InstalledAppCard({
  item,
  busy = false,
  onOpen = () => {},
  onStop = () => {},
}: {
  item: InstalledRuntimeApp;
  busy?: boolean;
  onOpen?: () => void;
  onStop?: () => void;
}) {
  const app = item.app;
  return (
    <article className="flex min-h-56 flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-sm font-semibold"
            aria-hidden
          >
            {app.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{app.name}</h2>
            <div className="font-mono text-xs text-[var(--color-muted-foreground)]">v{app.version}</div>
          </div>
        </div>
        <StatusPill
          tone={
            item.state === 'running'
              ? 'success'
              : item.state === 'failed'
                ? 'error'
                : item.state === 'starting'
                  ? 'info'
                  : 'neutral'
          }
          label={
            item.state === 'running'
              ? 'Running'
              : item.state === 'starting'
                ? 'Starting'
                : item.state === 'failed'
                  ? 'Failed'
                  : 'Stopped'
          }
          activity={item.state === 'starting' ? 'spin' : 'static'}
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
        <span className="rounded bg-[var(--color-muted)] px-1.5 py-0.5 text-micro font-medium">{app.license}</span>
        <span>granted {app.installedAt.slice(0, 10)}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {app.controlsSummary.serviceCount > 1 ? (
          <StatusPill tone="info" label={`${app.controlsSummary.serviceCount} services`} dot={false} />
        ) : null}
        <StatusPill tone="sandbox" label="sandboxed" dot={false} />
        <span className="font-mono text-micro text-[var(--color-muted-foreground)]">
          egress: {app.controlsSummary.egressHosts.length ? `${app.controlsSummary.egressHosts.length} hosts` : 'none'}
        </span>
      </div>
      <p className="mt-3 flex-1 text-xs text-[var(--color-muted-foreground)]">
        {app.publisher.tier === 'unknown' ? 'Unknown Publisher' : app.publisher.name}
      </p>
      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={onOpen}>
          Open
        </Button>
        {item.state === 'running' ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={onStop}>
            Stop
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export function InstalledAppsEmptyState({ filtered = false }: { filtered?: boolean }) {
  return (
    <SectionCard>
      <div className="flex min-h-52 flex-col items-center justify-center text-center">
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-muted-foreground)]">
          <Grid2X2 className="h-5 w-5" aria-hidden />
        </span>
        <h2 className="text-sm font-semibold">
          {filtered ? 'No installed apps match' : 'No apps installed in this workspace'}
        </h2>
        <p className="mt-1 max-w-md text-xs leading-4 text-[var(--color-muted-foreground)]">
          Browse the verified catalogue or install a local .appliance.zip bundle.
        </p>
      </div>
    </SectionCard>
  );
}

export function InstalledAppsPage() {
  const host = useHost();
  const navigate = useNavigate();
  const { cluster, kind, isLoading: workspaceLoading } = useCurrentWorkspace();
  const target = cluster?.id ?? 'local';
  const workspaceName = kind === 'cloud' ? (cluster?.name ?? target) : 'This Mac';
  const [apps, setApps] = React.useState<InstalledRuntimeApp[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [pending, setPending] = React.useState<PendingWarning | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!host.installedApps) {
      setError('Installed apps are available in the Appliance desktop app.');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setApps(await host.installedApps.list(target));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Installed apps could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [host.installedApps, target]);

  React.useEffect(() => {
    if (!workspaceLoading) void refresh();
  }, [refresh, workspaceLoading]);

  const installSource = async (source: string, accepted = false) => {
    if (!host.installedApps) return;
    setBusy('install');
    try {
      const installed = await host.installedApps.installBundle(source, target, { acceptUnknownPublisher: accepted });
      setPending(null);
      setNotice(`${installed.name} ${installed.version} was installed for ${workspaceName}.`);
      await refresh();
    } catch (cause) {
      const prompt = parseUnknownPublisherError(cause);
      if (prompt && !accepted) setPending({ action: 'install', source, prompt });
      else setError(cause instanceof Error ? cause.message : 'The bundle could not be installed.');
    } finally {
      setBusy(null);
    }
  };

  const pickAndInstall = async () => {
    const source = await host.installedApps?.pickBundle();
    if (source) await installSource(source);
  };

  const openApp = async (item: InstalledRuntimeApp, accepted = false, remember = false) => {
    if (!host.installedApps) return;
    if (!accepted && unknownPublisherWarningDue(item.app)) {
      setPending({ action: 'open', app: item, prompt: promptForInstalledApp(item) });
      return;
    }
    setBusy(item.app.appId);
    try {
      const result = await host.installedApps.run(item.app.appId, target, {
        acceptUnknownPublisher: accepted,
        rememberUnknownPublisher: remember,
      });
      setPending(null);
      if (result.urls[0]) await host.openExternal(result.urls[0]);
      else setNotice(`${item.app.name} started, but it does not publish a browser URL.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not open ${item.app.name}.`);
    } finally {
      setBusy(null);
    }
  };

  const stopApp = async (item: InstalledRuntimeApp) => {
    if (!host.installedApps) return;
    setBusy(item.app.appId);
    try {
      await host.installedApps.stop(item.app.appId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not stop ${item.app.name}.`);
    } finally {
      setBusy(null);
    }
  };

  const visible = apps.filter((item) =>
    [item.app.name, item.app.appId, item.app.version, item.app.license]
      .join('\n')
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  );
  const running = apps.filter((item) => item.state === 'running').length;

  return (
    <PageShell rail="browse">
      <PageHeader
        title="Installed Apps"
        description={`${workspaceName}${cluster?.apiServerUrl ? ` · ${cluster.apiServerUrl}` : ''} · ${apps.length} app${apps.length === 1 ? '' : 's'}, ${running} running`}
        action={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate('/catalogue')}>
              Browse catalogue
            </Button>
            <Button size="sm" onClick={() => void pickAndInstall()}>
              <FolderOpen className="h-4 w-4" aria-hidden /> Install from file
            </Button>
          </>
        }
      />

      {notice ? (
        <Banner tone="success" title="Installed" className="mb-4" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="error" title="Installed Apps error" className="mb-4" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      ) : null}

      {apps.length > 0 ? (
        <label className="relative mb-5 block max-w-sm">
          <span className="sr-only">Search installed apps</span>
          <Search
            className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[var(--color-muted-foreground)]"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search apps…"
            className="pl-9"
          />
        </label>
      ) : null}

      {loading ? (
        <SectionCard>
          <p className="py-16 text-center text-sm text-[var(--color-muted-foreground)]" role="status">
            Loading installed apps…
          </p>
        </SectionCard>
      ) : visible.length === 0 ? (
        <InstalledAppsEmptyState filtered={apps.length > 0} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((item) => (
            <InstalledAppCard
              key={item.app.appId}
              item={item}
              busy={busy === item.app.appId}
              onOpen={() => void openApp(item)}
              onStop={() => void stopApp(item)}
            />
          ))}
        </div>
      )}

      {pending ? (
        <UnknownPublisherDialog
          prompt={pending.prompt}
          action={pending.action}
          busy={busy !== null}
          onCancel={() => setPending(null)}
          onAccept={() =>
            void (pending.action === 'install' ? installSource(pending.source, true) : openApp(pending.app, true))
          }
          onRemember={pending.action === 'open' ? () => void openApp(pending.app, true, true) : undefined}
        />
      ) : null}
    </PageShell>
  );
}

export { UnknownPublisherDialog } from './unknown-publisher-dialog';
