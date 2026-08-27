import { Grid2X2, ShoppingBag } from 'lucide-react';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { SectionCard } from '@/components/ui/section-card';

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
  return (
    <RuntimePlaceholder
      title="Catalogue"
      description="Browse free, open-source apps for your workspace."
      emptyTitle="The catalogue arrives with the runtime"
      icon={ShoppingBag}
    />
  );
}
