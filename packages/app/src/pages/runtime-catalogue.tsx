import * as React from 'react';
import type { CatalogueEntry } from '@appliance.sh/sdk';
import { Search, ShieldAlert } from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { useHost } from '@/providers/host-provider';
import { verifyHostCatalogue, type CatalogueViewData } from '@/lib/trust/catalogue';
import { useCurrentWorkspace } from '@/components/layout/workspace-switcher';
import { parseUnknownPublisherError, type UnknownPublisherPrompt } from '@/lib/installed-apps';
import { InstalledAppsPage, UnknownPublisherDialog } from '@/pages/installed-apps';

export { InstalledAppsPage };

export function CataloguePage() {
  const host = useHost();
  const { cluster } = useCurrentWorkspace();
  const target = cluster?.id ?? 'local';
  const [data, setData] = React.useState<CatalogueViewData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<{ entry: CatalogueEntry; prompt: UnknownPublisherPrompt } | null>(null);
  const [installing, setInstalling] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    if (!host.catalogue) {
      setError('The signed catalogue is available in the Appliance desktop app.');
      return;
    }
    void host.catalogue
      .fetchCatalogue()
      .then(async (pair) => {
        const next = await verifyHostCatalogue(pair);
        await host.catalogue?.cacheVerified?.(pair, next.generation, next.verifiedAt);
        return next;
      })
      .then((next) => {
        if (!active) return;
        setData(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setData(null);
        setError(cause instanceof Error ? cause.message : 'Catalogue verification failed.');
      });
    return () => {
      active = false;
    };
  }, [host.catalogue]);

  const installEntry = async (entry: CatalogueEntry): Promise<string> => {
    if (!host.installedApps) throw new Error('Installation is available in the Appliance desktop app.');
    try {
      const installed = await host.installedApps.installBundle(entry.url, target);
      return `${installed.name} ${installed.version} was installed.`;
    } catch (cause) {
      const prompt = parseUnknownPublisherError(cause);
      if (!prompt) throw cause;
      setPending({ entry, prompt });
      return 'Review the Unknown Publisher warning to continue.';
    }
  };

  const acceptUnknown = async () => {
    if (!pending || !host.installedApps) return;
    setInstalling(true);
    try {
      await host.installedApps.installBundle(pending.entry.url, target, { acceptUnknownPublisher: true });
      setPending(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The bundle could not be installed.');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      <CatalogueContent data={data} error={error} loading={!data && !error} onInstall={installEntry} />
      {pending ? (
        <UnknownPublisherDialog
          prompt={pending.prompt}
          action="install"
          busy={installing}
          onCancel={() => setPending(null)}
          onAccept={() => void acceptUnknown()}
        />
      ) : null}
    </>
  );
}

type Category = 'All' | NonNullable<CatalogueEntry['category']>;
const CATEGORIES: Category[] = ['All', 'Productivity', 'Media', 'Data', 'Dev tools'];

function relativeVerifiedAt(value: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (elapsedSeconds < 60) return 'just now';
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function verificationReason(reason: string): string {
  const trimmed = reason.trim().replace(/\.+$/, '');
  const capitalised = `${trimmed.slice(0, 1).toLocaleUpperCase()}${trimmed.slice(1)}`;
  return `${capitalised}.`;
}

export function CatalogueContent({
  data,
  error,
  loading = false,
  onInstall,
}: {
  data: CatalogueViewData | null;
  error: string | null;
  loading?: boolean;
  onInstall?: (entry: CatalogueEntry) => Promise<string>;
}) {
  const [query, setQuery] = React.useState(() =>
    typeof window === 'undefined' ? '' : (new URLSearchParams(window.location.search).get('q') ?? '')
  );
  const [category, setCategory] = React.useState<Category>('All');
  const [installMessage, setInstallMessage] = React.useState<string | null>(null);
  const categoryRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const entries = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (data?.entries ?? []).filter((entry) => {
      if (entry.paid === true) return false;
      if (category !== 'All' && entry.category !== category) return false;
      if (!needle) return true;
      return [entry.name, entry.description, entry.license, entry.publisher.name]
        .join('\n')
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [category, data?.entries, query]);

  const status = data?.stale
    ? { tone: 'info' as const, label: 'Stale' }
    : data
      ? { tone: 'success' as const, label: 'Verified index ✓ signed' }
      : { tone: 'warning' as const, label: 'Unverified' };

  return (
    <PageShell rail="browse">
      <PageHeader
        title="Catalogue"
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>Free and open-source apps that run on this Mac.</span>
            <StatusPill tone={status.tone} label={status.label} dot={false} />
            {data ? (
              <span className="text-xs tabular-nums" title={new Date(data.verifiedAt).toLocaleString()}>
                · verified {relativeVerifiedAt(data.verifiedAt)}
              </span>
            ) : null}
          </span>
        }
      />

      {data?.stale ? (
        <Banner tone="info" title="This catalogue index is stale" className="mb-4">
          These previously verified entries remain visible offline, but new installs are disabled until a fresh signed
          index is available.
        </Banner>
      ) : null}
      {data?.refreshError ? (
        <Banner tone="warning" title="Refresh failed" className="mb-4">
          Showing the last verified catalogue. {data.refreshError}
        </Banner>
      ) : null}
      {installMessage ? (
        <Banner tone="info" title="Installation" className="mb-4" onDismiss={() => setInstallMessage(null)}>
          {installMessage}
        </Banner>
      ) : null}

      {loading ? (
        <SectionCard>
          <div
            className="flex min-h-52 items-center justify-center text-sm text-[var(--color-muted-foreground)]"
            role="status"
          >
            Fetching and verifying the signed index…
          </div>
        </SectionCard>
      ) : error || !data ? (
        <SectionCard>
          <div className="flex min-h-52 flex-col items-center justify-center text-center">
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-[var(--color-warning-border)] bg-[var(--color-warning-background)] text-[var(--color-warning-foreground)]">
              <ShieldAlert className="h-5 w-5" aria-hidden />
            </span>
            <h2 className="text-sm font-semibold">Catalogue could not be verified</h2>
            <p className="mt-1 max-w-md text-xs leading-4 text-[var(--color-muted-foreground)]">
              No catalogue apps are shown because the signed index could not be verified.
            </p>
            {error ? (
              <p className="mt-2 max-w-md font-mono text-micro text-[var(--color-muted-foreground)]">
                Reason: {verificationReason(error)}
              </p>
            ) : null}
          </div>
        </SectionCard>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <label className="relative min-w-56 flex-1">
              <span className="sr-only">Search catalogue apps</span>
              <Search
                className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[var(--color-muted-foreground)]"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${data.entries.length} apps…`}
                className="pl-9"
              />
            </label>
            <div
              className="inline-flex flex-wrap rounded-md border border-[var(--color-border)] p-0.5"
              role="radiogroup"
              aria-label="Catalogue category"
            >
              {CATEGORIES.map((item, index) => (
                <button
                  key={item}
                  ref={(element) => {
                    categoryRefs.current[index] = element;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={category === item}
                  tabIndex={category === item ? 0 : -1}
                  onClick={() => setCategory(item)}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    const direction = event.key === 'ArrowLeft' ? -1 : 1;
                    const nextIndex = (index + direction + CATEGORIES.length) % CATEGORIES.length;
                    setCategory(CATEGORIES[nextIndex]!);
                    categoryRefs.current[nextIndex]?.focus();
                  }}
                  className={`rounded px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] ${
                    category === item
                      ? 'bg-[var(--color-accent)] text-[var(--color-foreground)]'
                      : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]'
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          <p className="sr-only" role="status">
            {entries.length === 0 ? 'No apps match' : `${entries.length} apps`}
          </p>

          {entries.length === 0 ? (
            <SectionCard>
              <p className="py-16 text-center text-sm text-[var(--color-muted-foreground)]">No free apps match.</p>
            </SectionCard>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {entries.map((entry) => (
                <article
                  key={entry.id}
                  className="flex min-h-48 flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-sm font-semibold"
                        aria-hidden
                      >
                        {entry.name.slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <h2 className="truncate text-sm font-semibold">{entry.name}</h2>
                        <div className="font-mono text-xs tabular-nums text-[var(--color-muted-foreground)]">
                          v{entry.version}
                        </div>
                      </div>
                    </div>
                    <span className="rounded bg-[var(--color-muted)] px-1.5 py-0.5 text-micro font-medium text-[var(--color-muted-foreground)]">
                      {entry.license}
                    </span>
                  </div>
                  <p className="mt-3 flex-1 text-xs leading-4 text-[var(--color-muted-foreground)]">
                    {entry.description}
                  </p>
                  <div className="mt-4 flex items-center justify-between gap-2">
                    <span className="truncate text-micro text-[var(--color-muted-foreground)]">
                      {entry.publisher.name}
                    </span>
                    <Button
                      size="sm"
                      disabled={data.stale}
                      aria-label={`Install ${entry.name}`}
                      onClick={() => {
                        setInstallMessage(null);
                        void (onInstall
                          ? onInstall(entry)
                              .then(setInstallMessage)
                              .catch((cause: unknown) =>
                                setInstallMessage(cause instanceof Error ? cause.message : 'Installation failed.')
                              )
                          : Promise.resolve(
                              setInstallMessage('Installation is available in the Appliance desktop app.')
                            ));
                      }}
                    >
                      Install
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
          <p className="mt-4 text-xs leading-4 text-[var(--color-muted-foreground)]">
            Only free, open-source apps are listed. The signed index is verified before every refresh. License terms are
            recorded on install.
          </p>
        </>
      )}
    </PageShell>
  );
}
