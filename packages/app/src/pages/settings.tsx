import * as React from 'react';
import { RefreshCw, Download, ArrowUpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FriendlyError } from '@/components/friendly-error';
import { KeyValueList } from '@/components/ui/key-value-list';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { useHost } from '@/providers/host-provider';
import { dismissOnboarding, resetOnboarding } from '@/lib/local-runtime';
import { TeamSection } from '@/pages/settings-team';
import type { AvailableUpdate, UpdateProgress } from '@/lib/host';
import { cn } from '@/lib/utils';
import { useAppMode } from '@/hooks/use-app-mode';
import type { AppMode } from '@/lib/host';

// ⑤ Settings — slimmed to Updates · About · Preferences (docs/desktop-ia.md
// §3 / move-map 4b). Cluster CRUD and the cloud-lifecycle panels moved to ②
// Clusters (`/clusters` + `/clusters/:id`) in I2; agent sign-in moved to ④
// Agents in I4. The header keeps the "find them under Clusters / Agents"
// redirect note so no one dead-ends here looking for the old surfaces.
export function SettingsPage() {
  const host = useHost();
  const canBootstrap = Boolean(host.bootstrap);
  const canSelfUpdate = Boolean(host.updater);
  // The first-run "replay setup" preference only has an effect where the
  // first-run welcome shows — the desktop local-runtime shell (host.vm).
  const canReplaySetup = Boolean(host.vm);

  return (
    <PageShell rail="detail" className="space-y-6">
      <PageHeader title="Settings" description="Mode, updates, team access, and preferences for this desktop app." />

      {host.appMode ? <ModeSection /> : null}

      <TeamSection />

      {canSelfUpdate ? <UpdatesSection /> : null}

      {canReplaySetup ? <PreferencesSection /> : null}

      <section aria-labelledby="about-heading" className="px-1">
        <h2 id="about-heading" className="mb-2 text-sm font-semibold">
          About
        </h2>
        <KeyValueList
          items={[
            { key: 'version', label: 'Version', value: __APPLIANCE_VERSION__, mono: true },
            { key: 'built', label: 'Built', value: new Date(__APPLIANCE_BUILD_TIME__).toLocaleString() },
            { key: 'shell', label: 'App', value: canBootstrap ? 'Desktop' : 'Web' },
          ]}
        />
      </section>
    </PageShell>
  );
}

function ModeSection() {
  const { mode, isLoading, isSaving, error, setMode } = useAppMode();
  const options: Array<{ mode: AppMode; label: string }> = [
    { mode: 'user', label: 'Use apps' },
    { mode: 'developer', label: 'Build apps' },
  ];
  return (
    <Section title="Mode" description="Choose how much of the desktop workspace to show.">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm">App mode</div>
          <p className="mt-0.5 max-w-xl text-xs leading-4 text-[var(--color-muted-foreground)]">
            Developer mode adds Setup, Projects, Agents, Machine and Cloud to the sidebar, plus the terminal dock.
            Installed apps keep running either way.
          </p>
        </div>
        <div
          role="group"
          aria-label="App mode"
          className="inline-flex shrink-0 overflow-hidden rounded-md border border-[var(--color-border)]"
        >
          {options.map((option) => (
            <button
              key={option.mode}
              type="button"
              aria-pressed={mode === option.mode}
              disabled={isLoading || isSaving}
              onClick={() => void setMode(option.mode).catch(() => undefined)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)] disabled:opacity-60',
                mode === option.mode && 'bg-[var(--color-accent)] text-[var(--color-foreground)]'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-[var(--color-destructive-foreground)]">Couldn't save the mode change.</p>
      ) : null}
    </Section>
  );
}

type UpdatePhase = 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready' | 'failed';

/**
 * Self-update panel for the desktop shell. Drives the Tauri updater
 * through `host.updater`: check the signed feed, download+install the
 * new bundle with a progress bar, then offer a relaunch into it. Only
 * rendered when `host.updater` exists (desktop-only).
 */
function UpdatesSection() {
  const host = useHost();
  const [phase, setPhase] = React.useState<UpdatePhase>('idle');
  const [update, setUpdate] = React.useState<AvailableUpdate | null>(null);
  const [progress, setProgress] = React.useState<UpdateProgress | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Which step failed — picks the plain-language headline.
  const [errorStep, setErrorStep] = React.useState<'check' | 'install' | 'relaunch' | null>(null);

  const onCheck = async () => {
    if (!host.updater) return;
    setPhase('checking');
    setError(null);
    setErrorStep(null);
    setProgress(null);
    try {
      const found = await host.updater.check();
      if (found) {
        setUpdate(found);
        setPhase('available');
      } else {
        setUpdate(null);
        setPhase('up-to-date');
      }
    } catch (err) {
      setPhase('failed');
      setError(err instanceof Error ? err.message : String(err));
      setErrorStep('check');
    }
  };

  const onInstall = async () => {
    if (!host.updater) return;
    setPhase('downloading');
    setError(null);
    setErrorStep(null);
    setProgress({ downloaded: 0 });
    try {
      await host.updater.downloadAndInstall((p) => setProgress(p));
      setPhase('ready');
    } catch (err) {
      setPhase('failed');
      setError(err instanceof Error ? err.message : String(err));
      setErrorStep('install');
    }
  };

  const onRelaunch = async () => {
    if (!host.updater) return;
    try {
      await host.updater.relaunch();
    } catch (err) {
      // A failed relaunch isn't fatal — the update is already installed
      // and will apply on the next manual restart. Surface it but keep
      // the "ready" state so the user can retry or quit themselves.
      setError(err instanceof Error ? err.message : String(err));
      setErrorStep('relaunch');
    }
  };

  const pct =
    progress && progress.contentLength
      ? Math.min(100, Math.round((progress.downloaded / progress.contentLength) * 100))
      : null;

  return (
    <Section title="Updates" description="Check for a newer signed build and install it in place.">
      <div className="space-y-3">
        <div className="grid grid-cols-[auto_1fr] items-baseline gap-4">
          <dt className="text-xs text-[var(--color-muted-foreground)]">Installed</dt>
          <dd className="text-sm">
            <code className="font-mono text-xs">{__APPLIANCE_VERSION__}</code>
          </dd>
        </div>

        {phase === 'available' && update ? (
          <div className="grid grid-cols-[auto_1fr] items-baseline gap-4">
            <dt className="text-xs text-[var(--color-muted-foreground)]">Available</dt>
            <dd className="text-sm">
              <code className="font-mono text-xs text-[var(--color-accent)]">{update.version}</code>
              {update.date ? (
                <span className="ml-2 text-xs text-[var(--color-muted-foreground)]">
                  {new Date(update.date).toLocaleDateString()}
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}

        {phase === 'available' && update?.notes ? (
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs whitespace-pre-wrap text-[var(--color-muted-foreground)]">
            {update.notes}
          </div>
        ) : null}

        {phase === 'downloading' ? (
          <div className="space-y-1">
            <div
              role="progressbar"
              aria-label="Update download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct ?? undefined}
              aria-valuetext={pct === null ? 'Downloading' : `${pct}%`}
              className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-border)]"
            >
              <div
                className={cn('h-full bg-[var(--color-accent)] transition-all', pct === null && 'animate-pulse w-1/3')}
                style={pct === null ? undefined : { width: `${pct}%` }}
              />
            </div>
            <div className="text-xs text-[var(--color-muted-foreground)]">
              {pct === null ? 'Downloading…' : `Downloading ${pct}%`}
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          {phase === 'available' ? (
            <Button size="sm" onClick={onInstall}>
              <Download className="h-4 w-4" /> Download &amp; install {update?.version}
            </Button>
          ) : phase === 'ready' ? (
            <Button size="sm" onClick={onRelaunch}>
              <ArrowUpCircle className="h-4 w-4" /> Restart to update
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={onCheck}
              disabled={phase === 'checking' || phase === 'downloading'}
            >
              <RefreshCw className={cn('h-4 w-4', phase === 'checking' && 'animate-spin')} />
              {phase === 'checking' ? 'Checking…' : 'Check for updates'}
            </Button>
          )}

          <span role="status" aria-live="polite" aria-atomic="true">
            {phase === 'up-to-date' ? <StatusPill tone="neutral" label="Up to date" /> : null}
            {phase === 'available' ? <span className="sr-only">Update {update?.version} is available</span> : null}
            {phase === 'ready' ? <StatusPill tone="neutral" label="Installed — restart ready" /> : null}
            {phase === 'checking' ? <span className="sr-only">Checking for updates</span> : null}
            {phase === 'downloading' ? <span className="sr-only">Downloading update</span> : null}
            {phase === 'failed' ? <StatusPill tone="error" label="Update failed" /> : null}
          </span>
        </div>

        {error ? (
          <FriendlyError
            error={error}
            fallbackHeadline={
              errorStep === 'relaunch'
                ? "The app couldn't restart itself — quit and reopen to finish updating"
                : errorStep === 'check'
                  ? "Couldn't check for updates"
                  : "The update couldn't be installed"
            }
          />
        ) : null}
      </div>
    </Section>
  );
}

/**
 * App-level preferences (⑤ Settings → Preferences). Today this is just the
 * "replay first-run setup" control: it clears the onboarding-dismissed flag
 * so the welcome screen shows again next time the shell is unconfigured.
 * Only rendered on the desktop shell, where the first-run welcome exists.
 */
function PreferencesSection() {
  const [willShow, setWillShow] = React.useState(false);
  const onReplay = () => {
    resetOnboarding();
    setWillShow(true);
  };
  return (
    <Section title="Preferences" description="Preferences for this desktop app.">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm">Show welcome again</div>
          <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
            Show the welcome screen on the next launch when nothing is set up.
          </p>
        </div>
        {willShow ? (
          <span className="flex items-center gap-2">
            <StatusPill tone="neutral" label="Will show when nothing is set up" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                dismissOnboarding();
                setWillShow(false);
              }}
            >
              Undo
            </Button>
          </span>
        ) : (
          <Button variant="outline" size="sm" onClick={onReplay}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Show on next launch
          </Button>
        )}
      </div>
    </Section>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <SectionCard title={title} description={description}>
      <dl className="space-y-2">{children}</dl>
    </SectionCard>
  );
}
