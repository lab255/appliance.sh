import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Check, Plus } from 'lucide-react';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { cn } from '@/lib/utils';
import { devMachineLabel, isMicroVmClusterId, microVmNameFromClusterId } from '@/lib/host';
import { useDevMachineTargets } from '@/hooks/use-dev-machine-targets';
import type { Cluster } from '@/lib/host';

/** Display name for a deploy target: the local VM's own `microvm*`
 *  cluster shows as the Dev Machine; everything else keeps its given
 *  name. Only canonical rows render here — an alias entry that folds
 *  into a VM (see lib/dev-machine-targets.ts) never reaches this. */
function targetName(cluster: Cluster): string {
  const vm = microVmNameFromClusterId(cluster.id);
  return vm ? devMachineLabel(vm) : cluster.name;
}

function EngineBadge({ local }: { local: boolean }) {
  if (!local) return null;
  return (
    <span className="shrink-0 rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-300">
      this computer
    </span>
  );
}

export function ClusterSwitcher() {
  const host = useHost();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { config, cluster, isLoading } = useSelectedCluster();
  const clusters = config?.clusters ?? [];

  // Canonical dedupe (see lib/dev-machine-targets.ts): a CLI profile
  // whose URL points at a running local VM's forwarded api-server port
  // IS that VM — one machine must not list as two targets. The alias row
  // never renders when its `microvm*` twin exists; there's no "selected
  // alias" special case because useSelectedCluster REBINDS an alias
  // selection to the twin, so the check mark always lands on the
  // surviving row and clicking it selects the working identity.
  const { visibleClusters, coreMachines, isLoading: isMachineLoading } = useDevMachineTargets(clusters);

  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectMutation = useMutation({
    mutationFn: async (id: string) => host.selectCluster(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      // Deep-linked rows (a project, an environment, a deployment)
      // belong to the previous cluster and would 404 after the switch —
      // those reset to the landing. Top-level sections carry no
      // per-cluster ids and just refetch, so stay put instead of
      // yanking the user off the page they were reading.
      const segments = window.location.pathname.split('/').filter(Boolean);
      const stayable = ['projects', 'machine', 'cloud', 'settings', 'agents', 'deployments'];
      if (segments.length !== 1 || !stayable.includes(segments[0])) {
        navigate('/');
      }
      setOpen(false);
    },
  });

  if (clusters.length === 0 && coreMachines.length === 0 && isMachineLoading) {
    return <div className="text-xs text-[var(--color-muted-foreground)]">…</div>;
  }
  if (clusters.length === 0 && coreMachines.length === 0) {
    return <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">Not connected</div>;
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-sm hover:bg-[var(--color-muted)]',
          open && 'bg-[var(--color-muted)]'
        )}
      >
        {/* While an alias selection is still resolving against the VM
            inventory, show a quiet ellipsis — never the alias identity. */}
        <span className="font-medium">{cluster ? targetName(cluster) : isLoading ? '…' : 'Select target'}</span>
        {cluster ? <EngineBadge local={isMicroVmClusterId(cluster.id)} /> : null}
        <ChevronDown className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-1 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-lg">
          <ul className="max-h-72 overflow-auto py-1">
            {coreMachines.map((vm) => (
              <li key={`core-${vm.name}`}>
                <button
                  type="button"
                  onClick={() => {
                    const suffix = vm.name === 'appliance' ? '' : `?vm=${encodeURIComponent(vm.name)}`;
                    navigate(`/machine${suffix}`);
                    setOpen(false);
                  }}
                  className="grid w-full grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-muted)]"
                >
                  <div className="w-4" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-medium">
                      {devMachineLabel(vm.name)} <EngineBadge local />
                    </div>
                    <div className="text-xs text-cyan-300">{vm.running ? 'core ready' : 'stopped'}</div>
                  </div>
                </button>
              </li>
            ))}
            {visibleClusters.map((c) => {
              const isSelected = c.id === cluster?.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!isSelected) selectMutation.mutate(c.id);
                      else setOpen(false);
                    }}
                    disabled={selectMutation.isPending}
                    className={cn(
                      'grid w-full grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-muted)]',
                      isSelected && 'bg-[var(--color-muted)]'
                    )}
                  >
                    <div className="w-4">
                      {isSelected ? <Check className="h-4 w-4 text-[var(--color-accent)]" /> : null}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-medium">
                        {targetName(c)} <EngineBadge local={isMicroVmClusterId(c.id)} />
                      </div>
                      <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">
                        {c.apiServerUrl}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-[var(--color-border)] p-1">
            <Link
              // Canonical add-cloud surface (§5.2 dedup / Devon nit) —
              // the onboarding Connect form, not the old bare /connect.
              to="/setup/connect"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-[var(--color-muted)]"
            >
              <Plus className="h-4 w-4" />
              Add cloud
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
