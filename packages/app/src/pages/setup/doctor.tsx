import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, Download, Play, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { SectionCard } from '@/components/ui/section-card';
import { ListSkeleton } from '@/components/ui/skeleton';
import { useHost } from '@/providers/host-provider';
import { cn } from '@/lib/utils';
import type { LocalPreflightCheck } from '@/lib/host';

// ① Setup → Doctor (docs/desktop-ia.md §3 / move-map 4a). The prerequisite
// preflight that used to sit atop the runtimes page now stands alone as the
// canonical Doctor at `/setup/doctor`. I5 extracted it here out of the old
// `pages/local-runtime/index.tsx` kitchen-sink page (now deleted); everything
// else that page once carried has moved — Dev Machine management to
// `pages/machine/*`, `WorkloadsPanel` to ③ env-detail
// (`pages/environments/workloads-panel.tsx`), and the agent launcher
// (`LaunchAgentButton`) to ④ Agents (`pages/agents/launch-agent-button.tsx`).
// This page hosts the shared `DoctorPanel`, which is also rendered from the
// machine detail's "Re-run checks" entry — one PreflightPanel, two entry points.
export function SetupDoctorPage() {
  const host = useHost();
  const supported = Boolean(host.vm);

  if (!supported) {
    return (
      <PageShell rail="focused">
        <PageHeader title="Doctor" description="Checks for this computer are available in the desktop app." />
      </PageShell>
    );
  }

  return (
    <PageShell rail="focused" className="space-y-6">
      <PageHeader
        title="Doctor"
        description="Check what this computer needs for workload views and shells. Appliance can install missing tools for you."
      />
      <DoctorPanel />
    </PageShell>
  );
}

// The prerequisite preflight, self-contained: the host query + the
// `PreflightPanel`. Rendered both here (the canonical ① Doctor) and from the
// ② runtime detail's "Re-run checks" entry — one PreflightPanel, two entry
// points (docs/desktop-ia.md §8 Q4).
export function DoctorPanel() {
  const host = useHost();
  const local = host.local;
  const supported = Boolean(host.vm);

  // Preflight: ask the host which of docker/kubectl are installed.
  // Image builds shell out to docker and workload/log reads to kubectl;
  // if either is missing the relevant action would surface a cryptic
  // "failed to spawn" error. We render an actionable install panel
  // instead. Polled lazily so installing a tool in a separate terminal
  // is reflected within a few seconds without requiring a page reload.
  const preflightQuery = useQuery({
    queryKey: ['local-runtime', 'preflight'],
    enabled: supported && Boolean(local?.preflight),
    queryFn: () => local!.preflight(),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 5_000;
      // Keep polling while anything's not ready — including docker
      // installed-but-daemon-down — so starting a tool in another
      // window clears the panel within a few seconds.
      return data.every(checkReady) ? false : 5_000;
    },
  });
  const preflightChecks = preflightQuery.data ?? [];

  return (
    <PreflightPanel
      checks={preflightChecks}
      loading={preflightQuery.isFetching}
      onRefresh={() => preflightQuery.refetch()}
      canInstall={Boolean(local?.installPrereq)}
      onInstall={async (tool) => {
        if (!local?.installPrereq) return;
        await local.installPrereq([tool], () => {});
        preflightQuery.refetch();
      }}
      canStartRuntime={Boolean(local?.startContainerRuntime)}
      onStartRuntime={async () => {
        if (!local?.startContainerRuntime) return;
        await local.startContainerRuntime();
        preflightQuery.refetch();
      }}
    />
  );
}

// A prerequisite is "ready" when it's installed AND — for docker — its
// daemon is actually reachable. `daemonRunning` is undefined for tools
// with no daemon (kubectl), so `!== false` leaves those as ready on
// install alone.
function checkReady(c: LocalPreflightCheck): boolean {
  return c.installed && c.daemonRunning !== false;
}

function PreflightPanel({
  checks,
  loading,
  onRefresh,
  canInstall,
  onInstall,
  canStartRuntime,
  onStartRuntime,
}: {
  checks: LocalPreflightCheck[];
  loading: boolean;
  onRefresh: () => void;
  canInstall: boolean;
  onInstall: (tool: string) => Promise<void>;
  canStartRuntime: boolean;
  onStartRuntime: () => Promise<void>;
}) {
  if (loading && checks.length === 0)
    return (
      <div className="space-y-3">
        <p role="status" className="text-sm">
          Checking this computer…
        </p>
        <ListSkeleton rows={3} />
      </div>
    );
  if (checks.length === 0) return null;
  const notReady = checks.filter((c) => !checkReady(c));
  // When everything's installed and the only thing wrong is a stopped
  // daemon, the panel is about starting the runtime, not installing —
  // reword the heading so it doesn't tell the user to install tools
  // they already have.
  const onlyDaemonDown = notReady.length > 0 && notReady.every((c) => c.installed);
  if (notReady.length === 0) {
    return (
      <SectionCard
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex items-center justify-between gap-3"
      >
        <span className="inline-flex items-center gap-2">
          <Check className="h-3.5 w-3.5" aria-hidden />
          {loading ? 'Re-checking this computer…' : `${checks.length} checks complete. This computer is ready.`}
        </span>
        <Button variant="ghost" size="icon" aria-label="Re-check this computer" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </SectionCard>
    );
  }
  return (
    <SectionCard className="space-y-3">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-[var(--color-warning-foreground)]" aria-hidden />
          <div>
            <h2 className="text-sm font-semibold">
              {onlyDaemonDown ? 'Container runtime not running' : 'Install missing tools'}
            </h2>
            <p className="mt-0.5 text-xs leading-4 text-[var(--color-muted-foreground)]">
              {onlyDaemonDown
                ? 'Docker is installed but not running. The Dev Machine doesn’t need it — images build server-side — so start it only if you use the deprecated host-Docker runtime, then re-check.'
                : 'Workload views and shells need one additional helper. Appliance can install it for you. Optional legacy runtime checks remain under Technical details.'}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Re-check
        </Button>
      </header>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loading
          ? 'Re-checking this computer…'
          : `${checks.length} checks complete, ${notReady.length} need attention.`}
      </div>
      <ul className="space-y-2">
        {checks.map((c) => (
          <PreflightRow
            key={c.tool}
            check={c}
            canInstall={canInstall && c.autoInstallable}
            onInstall={onInstall}
            canStartRuntime={canStartRuntime}
            onStartRuntime={onStartRuntime}
          />
        ))}
      </ul>
    </SectionCard>
  );
}

function PreflightRow({
  check,
  canInstall,
  onInstall,
  canStartRuntime,
  onStartRuntime,
}: {
  check: LocalPreflightCheck;
  canInstall: boolean;
  onInstall: (tool: string) => Promise<void>;
  canStartRuntime: boolean;
  onStartRuntime: () => Promise<void>;
}) {
  const [copied, setCopied] = React.useState(false);
  const [installing, setInstalling] = React.useState(false);
  const [installError, setInstallError] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);

  const ready = checkReady(check);
  // Installed CLI, but no reachable daemon — the "start your runtime"
  // state, distinct from "not installed".
  const daemonDown = check.installed && check.daemonRunning === false;

  const onCopy = async () => {
    if (!check.installHint || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(check.installHint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard permission denied or unavailable — leave the hint
      // visible and let the user copy it manually.
    }
  };

  const onClickInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      await onInstall(check.tool);
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const onClickStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await onStartRuntime();
    } catch (err) {
      // Surfaces the backend's actionable message (e.g. colima failed,
      // or this runtime can't be auto-started).
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <li className="rounded-md border border-[var(--color-border)] px-3 py-2 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-medium">
            {ready ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <X className="h-3.5 w-3.5 text-[var(--color-warning-foreground)]" aria-hidden />
            )}
            <span>{check.tool === 'kubectl' ? 'Workload command-line helper' : check.tool}</span>
            <span className="text-[var(--color-muted-foreground)]">
              — {ready ? 'Ready' : daemonDown ? 'Not running' : 'Needs attention'}
            </span>
            {check.version ? <span className="text-[var(--color-muted-foreground)]">— {check.version}</span> : null}
          </div>
          <p className="mt-1 text-[var(--color-muted-foreground)]">{check.purpose}</p>
          {daemonDown ? (
            <div className="mt-2 space-y-2">
              {canStartRuntime && check.daemonStartable ? (
                <Button onClick={onClickStart} disabled={starting} size="sm">
                  <Play className={cn('h-3.5 w-3.5', starting && 'animate-pulse')} />
                  {starting ? 'Starting…' : 'Start runtime'}
                </Button>
              ) : null}
              {check.error ? <p className="text-[var(--color-muted-foreground)]">{check.error}</p> : null}
              {startError ? (
                <p role="alert" className="font-mono text-xs text-[var(--color-destructive-foreground)]">
                  {startError}
                </p>
              ) : null}
            </div>
          ) : null}
          {!check.installed ? (
            <div className="mt-2 space-y-2">
              {canInstall ? (
                <div>
                  <Button onClick={onClickInstall} disabled={installing} size="sm">
                    <Download className={cn('h-3.5 w-3.5', installing && 'animate-pulse')} />
                    {installing ? 'Installing…' : 'Install helper'}
                  </Button>
                  <p className="mt-1 text-xs leading-4 text-[var(--color-muted-foreground)]">
                    Downloads from the upstream release into <code>~/.appliance/bin/</code>. No admin password needed.
                  </p>
                </div>
              ) : null}
              {check.installHint ? (
                <div>
                  {canInstall ? (
                    <p className="text-micro font-medium uppercase tracking-[0.08em] text-[var(--color-muted-foreground)]">
                      Or install manually:
                    </p>
                  ) : null}
                  <div className="mt-1 flex items-center gap-2">
                    <code className="block flex-1 overflow-x-auto rounded bg-[var(--color-muted)] px-2 py-1 font-mono text-xs">
                      {check.installHint}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onCopy}
                      aria-label={`Copy install command for ${check.tool}`}
                    >
                      <Copy className="h-3 w-3" />
                      <span role="status" aria-live="polite" aria-atomic="true">
                        {copied ? 'Copied' : 'Copy'}
                      </span>
                    </Button>
                  </div>
                </div>
              ) : null}
              {installError ? (
                <p role="alert" className="font-mono text-xs text-[var(--color-destructive-foreground)]">
                  {installError}
                </p>
              ) : check.error ? (
                <p className="font-mono text-xs text-[var(--color-warning-foreground)]">{check.error}</p>
              ) : null}
              <details>
                <summary className="cursor-pointer text-xs font-medium text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
                  Technical details
                </summary>
                <p className="mt-1 font-mono text-xs">Tool: {check.tool}</p>
              </details>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
