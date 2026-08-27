import * as React from 'react';
import type { CatalogueEntry } from '@appliance.sh/sdk';
import { Grid2X2, Search, ShieldAlert } from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { useHost } from '@/providers/host-provider';
import { verifyHostCatalogue, type CatalogueViewData } from '@/lib/trust/catalogue';

function RuntimePlaceholder({
  title,
  description,
  emptyTitle,
  icon: Icon,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  icon: typeof Grid2X2;
}) {
  return (
    <PageShell rail="browse">
      <PageHeader title={title} description={description} />
      <SectionCard>
        <div className="flex min-h-52 flex-col items-center justify-center text-center">
          <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-muted-foreground)]">
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <h2 className="text-sm font-semibold">{emptyTitle}</h2>
          <p className="mt-1 max-w-md text-xs leading-4 text-[var(--color-muted-foreground)]">
            This page arrives with the Appliance app runtime. Runtime installation and catalogue content are tracked
            separately.
          </p>
        </div>
      </SectionCard>
    </PageShell>
  );
}

export function InstalledAppsPage() {
  return (
    <RuntimePlaceholder
      title="Installed Apps"
      description="Apps installed in this workspace."
      emptyTitle="Installed apps arrive with the runtime"
      icon={Grid2X2}
    />
  );
}

export function CataloguePage() {
  const host = useHost();
  const [data, setData] = React.useState<CatalogueViewData | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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

  return <CatalogueContent data={data} error={error} loading={!data && !error} />;
}

type Category = 'All' | NonNullable<CatalogueEntry['category']>;
const CATEGORIES: Category[] = ['All', 'Productivity', 'Media', 'Data', 'Dev tools'];

export function CatalogueContent({
  data,
  error,
  loading = false,
}: {
  data: CatalogueViewData | null;
  error: string | null;
  loading?: boolean;
}) {
  const [query, setQuery] = React.useState(() =>
    typeof window === 'undefined' ? '' : (new URLSearchParams(window.location.search).get('q') ?? '')
  );
  const [category, setCategory] = React.useState<Category>('All');
  const [installMessage, setInstallMessage] = React.useState<string | null>(null);
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
            {data ? <span className="text-xs tabular-nums">· verified {new Date(data.verifiedAt).toLocaleString()}</span> : null}
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
        <Banner tone="info" title="Installation is not available yet" className="mb-4" onDismiss={() => setInstallMessage(null)}>
          {installMessage}
        </Banner>
      ) : null}

      {loading ? (
        <SectionCard>
          <div className="flex min-h-52 items-center justify-center text-sm text-[var(--color-muted-foreground)]" role="status">
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
              No catalogue apps are shown because the signed index could not be verified. {error}
            </p>
          </div>
        </SectionCard>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <label className="relative min-w-56 flex-1">
              <span className="sr-only">Search catalogue apps</span>
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${data.entries.length} apps…`}
                className="pl-9"
              />
            </label>
            <div className="inline-flex flex-wrap rounded-md border border-[var(--color-border)] p-0.5" aria-label="Catalogue category">
              {CATEGORIES.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={category === item}
                  onClick={() => setCategory(item)}
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

          {entries.length === 0 ? (
            <SectionCard>
              <p className="py-16 text-center text-sm text-[var(--color-muted-foreground)]">No free apps match this search.</p>
            </SectionCard>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-live="polite">
              {entries.map((entry) => (
                <article key={entry.id} className="flex min-h-48 flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-sm font-semibold" aria-hidden>
                        {entry.name.slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <h2 className="truncate text-sm font-semibold">{entry.name}</h2>
                        <div className="font-mono text-xs tabular-nums text-[var(--color-muted-foreground)]">v{entry.version}</div>
                      </div>
                    </div>
                    <span className="rounded bg-[var(--color-muted)] px-1.5 py-0.5 text-micro font-medium text-[var(--color-muted-foreground)]">
                      {entry.license}
                    </span>
                  </div>
                  <p className="mt-3 flex-1 text-xs leading-4 text-[var(--color-muted-foreground)]">{entry.description}</p>
                  <div className="mt-4 flex items-center justify-between gap-2">
                    <span className="truncate text-micro text-[var(--color-muted-foreground)]">{entry.publisher.name}</span>
                    <Button
                      size="sm"
                      disabled={data.stale}
                      onClick={() => setInstallMessage('Install arrives with AP-173. Appliance did not report a successful install.')}
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
