import * as React from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Cloud as CloudIcon, Loader2, Plus, X } from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { StatusPill } from '@/components/ui/status-pill';
import { Tag } from '@/components/ui/tag';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { isMicroVmClusterId } from '@/lib/host';
import type { Cluster } from '@/lib/host';
import { durationEstimates } from '@/lib/duration-estimates';

// The Cloud area — every cloud installation this shell is connected to
// (bootstrapped AWS installations and manually-added clusters). Switch /
// remove / manage from here; per-installation lifecycle lives at
// /cloud/:id. The Dev Machine is NOT listed here — it has its own page at
// /machine.
export function CloudPage() {
  const host = useHost();
  const canBootstrap = Boolean(host.bootstrap);
  const { config, isLoading } = useSelectedCluster();
  const selectedId = config?.selectedClusterId ?? null;

  // Cloud clusters only — the Dev Machine's auto-registered entry lives
  // on /machine, so we don't list it twice.
  const cloudClusters = (config?.clusters ?? []).filter((c) => !isMicroVmClusterId(c.id));
  const hasDevMachine = (config?.clusters ?? []).some((c) => isMicroVmClusterId(c.id));

  return (
    <PageShell rail="browse" className="space-y-6">
      <PageHeader
        title="Cloud"
        description="Pair this computer with a cloud installation."
        action={
          <>
            <Button asChild>
              {/* Canonical add-cloud surface (§5.2 dedup) — one form. */}
              <Link to="/setup/connect">
                <Plus className="h-4 w-4" /> Pair a cloud
              </Link>
            </Button>
            {canBootstrap ? (
              <Button asChild variant="outline">
                <Link to="/cloud/bootstrap">Create in AWS</Link>
              </Button>
            ) : null}
          </>
        }
      />

      <section className="space-y-3">
        {isLoading ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">Loading…</p>
        ) : cloudClusters.length === 0 ? (
          <EmptyState
            icon={CloudIcon}
            title={hasDevMachine ? 'Your apps currently live on this computer' : 'No cloud paired yet'}
            description={
              <>
                {hasDevMachine
                  ? 'Apps here use private local URLs and run while this computer is on. Pair a cloud when an app needs a public URL, more uptime, or teammates.'
                  : 'Pair an existing Appliance cloud installation, or create one in your AWS account.'}
                <span className="mt-2 block text-xs leading-4">
                  Creating in AWS takes {durationEstimates.cloudCreate}. Connecting to a cloud your team already runs
                  takes {durationEstimates.cloudConnect}.
                </span>
              </>
            }
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button asChild>
                  <Link to="/setup/connect">
                    <Plus className="h-4 w-4" /> Connect an existing cloud
                  </Link>
                </Button>
                {canBootstrap ? (
                  <Button asChild variant="outline">
                    <Link to="/cloud/bootstrap">Create one on AWS</Link>
                  </Button>
                ) : null}
              </div>
            }
          />
        ) : (
          <>
            <p className="text-sm leading-5 text-[var(--color-muted-foreground)]">
              Deploys go to the selected target — switch between this computer and your clouds in the target menu, or
              per deploy in the wizard.
            </p>
            <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
              {cloudClusters.map((c) => (
                <CloudRow key={c.id} cluster={c} isSelected={c.id === selectedId} />
              ))}
            </ul>
          </>
        )}
      </section>
    </PageShell>
  );
}

// One connected cloud installation. The whole row links to its detail;
// Switch is a sibling action so we don't nest a button inside the link.
function CloudRow({ cluster, isSelected }: { cluster: Cluster; isSelected: boolean }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [selectionMessage, setSelectionMessage] = React.useState('');
  const selectMutation = useMutation({
    mutationFn: async () => host.selectCluster(cluster.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      setSelectionMessage(`${cluster.name} is now the selected target`);
    },
  });
  const removeMutation = useMutation({
    mutationFn: async () => host.removeCluster(cluster.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      toast(`Removed "${cluster.name}"`);
    },
  });

  const remove = async () => {
    const ok = await confirm({
      title: `Remove "${cluster.name}"?`,
      description:
        'Forgets this cloud’s saved server address and access key on this computer. Its cloud resources keep running, and you can pair it again later.',
      confirmLabel: 'Remove cloud',
      destructive: false,
    });
    if (ok) removeMutation.mutate();
  };

  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <Link
        to={`/cloud/${cluster.id}`}
        className="group min-w-0 flex-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium group-hover:underline">{cluster.name}</span>
          <Tag>Cloud</Tag>
          {isSelected ? (
            <StatusPill
              tone="success"
              label={
                <span className="inline-flex items-center gap-1">
                  <Check className="h-3 w-3" aria-hidden />
                  Selected target
                </span>
              }
            />
          ) : null}
        </div>
        <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">{cluster.apiServerUrl}</div>
      </Link>
      <div className="flex shrink-0 items-center gap-1">
        {!isSelected ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => selectMutation.mutate()}
            disabled={selectMutation.isPending || removeMutation.isPending}
          >
            {selectMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Switching…
              </>
            ) : (
              'Switch'
            )}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label={
            removeMutation.isPending ? `Removing ${cluster.name}…` : `Remove ${cluster.name} from this computer`
          }
          onClick={() => void remove()}
          disabled={removeMutation.isPending}
        >
          {removeMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <X className="h-4 w-4" aria-hidden />
          )}
        </Button>
      </div>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {selectionMessage}
      </span>
      {selectMutation.error ? (
        <Banner
          tone="error"
          className="w-full"
          action={
            <Button variant="outline" size="sm" onClick={() => selectMutation.mutate()}>
              Retry
            </Button>
          }
        >
          Couldn&rsquo;t switch to {cluster.name}.
        </Banner>
      ) : null}
      {removeMutation.error ? (
        <Banner
          tone="error"
          className="w-full"
          action={
            <Button variant="outline" size="sm" onClick={() => removeMutation.mutate()}>
              Retry
            </Button>
          }
        >
          Couldn&rsquo;t remove {cluster.name} from this computer.
        </Banner>
      ) : null}
    </li>
  );
}
