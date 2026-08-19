import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { CloudClusterDetail } from './panels';

// /cloud/:id — one cloud installation's management page. Resolves the
// cluster from the shell's registry and hands off to the lifecycle
// panels (Advanced disclosure + Destroy). MicroVM ids never land here —
// the router's /clusters/:id redirect sends those to /machine.
export function CloudDetailPage() {
  const { id = '' } = useParams();
  const { config, isLoading } = useSelectedCluster();
  const cluster = config?.clusters.find((c) => c.id === id) ?? null;

  return (
    <PageShell rail="detail" className="space-y-5">
      <div>
        <Link
          to="/cloud"
          className="inline-flex items-center gap-1.5 rounded text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Cloud
        </Link>
        <PageHeader
          className="mb-0 mt-2"
          title={cluster?.name ?? id}
          description="Cloud installation status, deployment, and management."
        />
      </div>

      {isLoading ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">Loading…</p>
      ) : cluster ? (
        <CloudClusterDetail cluster={cluster} />
      ) : (
        <Banner tone="warning">
          No cloud installation with id <code className="font-mono">{id}</code> is connected.{' '}
          <Link
            to="/cloud"
            className="rounded underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          >
            Back to Cloud
          </Link>
          .
        </Banner>
      )}
    </PageShell>
  );
}
