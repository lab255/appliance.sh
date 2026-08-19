import * as React from 'react';
import { RefreshCw, Download, ArrowUpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FriendlyError } from '@/components/friendly-error';
import { useToast } from '@/components/ui/toast';
import { useHost } from '@/providers/host-provider';
import { useKeyRole } from '@/hooks/use-key-role';
import { resetOnboarding } from '@/lib/local-runtime';
import { TeamSection } from '@/pages/settings-team';
import type { AvailableUpdate, UpdateProgress } from '@/lib/host';
import { cn } from '@/lib/utils';

// ⑤ Settings — slimmed to Updates · About · Preferences (docs/desktop-ia.md
// §3 / move-map 4b). Cluster CRUD and the cloud-lifecycle panels moved to ②
// Clusters (`/clusters` + `/clusters/:id`) in I2; agent sign-in moved to ④
// Agents in I4. The header keeps the "find them under Clusters / Agents"
// redirect note so no one dead-ends here looking for the old surfaces.
export function SettingsPage() {
  const host = useHost();
  const { role } = useKeyRole();
  const canBootstrap = Boolean(host.bootstrap);
  const canSelfUpdate = Boolean(host.updater);
  // The first-run "replay setup" preference only has an effect where the
  // first-run welcome shows — the desktop local-runtime shell (host.vm).
  const canReplaySetup = Boolean(host.vm);

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Shell info, updates, and app preferences.
          {role === 'admin' && host.vm ? (
            <>
              {' '}
              Manage the Dev Machine under <span className="font-medium text-[var(--color-foreground)]">Machine</span>,
              cloud installations under <span className="font-medium text-[var(--color-foreground)]">Cloud</span>, and
              sign in to coding agents under <span className="font-medium text-[var(--color-foreground)]">Agents</span>.
            </>
          ) : null}
        </p>
      </div>

      <TeamSection />

      {canSelfUpdate ? <UpdatesSection /> : null}

      {canReplaySetup ? <PreferencesSection /> : null}

      <Section title="About">
        <Row label="Version" value={<code className="font-mono text-xs">{__APPLIANCE_VERSION__}</code>} />
        <Row
          label="Built"
          value={
            <span className="text-[var(--color-muted-foreground)]" title={__APPLIANCE_BUILD_TIME__}>
              {new Date(__APPLIANCE_BUILD_TIME__).toLocaleString()}
            </span>
          }
        />
        <Row
          label="Shell"
          value={
            <span className="text-[var(--color-muted-foreground)]">{canBootstrap ? 'Desktop (Tauri)' : 'Web'}</span>
          }
        />
      </Section>
    </div>
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
  const { toast } = useToast();
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
      toast(`Update ${update?.version ?? ''} installed — restart to apply`.trim());
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
      toast('Could not restart automatically — quit and reopen to finish updating', { variant: 'error' });
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
          <div className="rounded-md border border-[var(--color-border)] bg-black/20 px-3 py-2 text-xs whitespace-pre-wrap text-[var(--color-muted-foreground)]">
            {update.notes}
          </div>
        ) : null}

        {phase === 'downloading' ? (
          <div className="space-y-1">
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
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

          {phase === 'up-to-date' ? (
            <span className="text-xs text-green-400">✓ You&apos;re on the latest version</span>
          ) : null}
          {phase === 'ready' ? <span className="text-xs text-green-400">✓ Installed</span> : null}
          {phase === 'failed' ? <span className="text-xs text-red-400">Update failed</span> : null}
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
  const { toast } = useToast();
  const onReplay = () => {
    resetOnboarding();
    toast('First-run setup will show again the next time nothing is connected');
  };
  return (
    <Section title="Preferences" description="App-level preferences for this shell.">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm">Replay first-run setup</div>
          <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
            Re-show the welcome + get-started prompt the next time this shell has nothing connected.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onReplay}>
          <RefreshCw className="h-3.5 w-3.5" /> Reset
        </Button>
      </div>
    </Section>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">{description}</p> : null}
      </div>
      <dl className="space-y-2">{children}</dl>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-baseline gap-4">
      <dt className="text-xs text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}
