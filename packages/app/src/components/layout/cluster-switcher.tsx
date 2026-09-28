'use client';

import * as React from 'react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@appliance.sh/ui/dropdown-menu';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Check, Monitor, Plus } from 'lucide-react';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { cn } from '@/lib/utils';
import {
  devMachineLabel,
  isMicroVmClusterId,
  localMachineLabel,
  localMachineLabelInline,
  microVmNameFromClusterId,
} from '@/lib/host';
import { useDevMachineTargets } from '@/hooks/use-dev-machine-targets';
import type { Cluster, HostPlatform } from '@/lib/host';
import { Tag } from '@/components/ui/tag';
import { Banner } from '@/components/ui/banner';
import { StatusDot } from '@/components/ui/status-dot';

/** Display name for a deploy target: the local VM's own `microvm*`
 *  cluster shows as the Dev Machine; everything else keeps its given
 *  name. Only canonical rows render here — an alias entry that folds
 *  into a VM (see lib/dev-machine-targets.ts) never reaches this. */
function targetName(cluster: Cluster): string {
  const vm = microVmNameFromClusterId(cluster.id);
  return vm ? devMachineLabel(vm) : cluster.name;
}

export type WorkspaceKind = 'local' | 'cloud';

export function workspaceKind(cluster: Pick<Cluster, 'id'>): WorkspaceKind {
  return isMicroVmClusterId(cluster.id) ? 'local' : 'cloud';
}

export function switcherName(
  presentation: 'developer' | 'workspace',
  cluster: Cluster | null,
  platform: HostPlatform,
  isLoading = false
): string {
  if (cluster) {
    return presentation === 'workspace' && workspaceKind(cluster) === 'local'
      ? localMachineLabel(platform)
      : targetName(cluster);
  }
  if (presentation === 'workspace') return localMachineLabel(platform);
  return isLoading ? '…' : 'Select target';
}

/** The workspace is the selected cluster/profile target under user-mode copy. */
export function useCurrentWorkspace() {
  const selected = useSelectedCluster();
  return {
    ...selected,
    kind: selected.cluster ? workspaceKind(selected.cluster) : null,
  };
}

function EngineBadge({ local }: { local: boolean }) {
  if (!local) return null;
  return <Tag emphasis="sandbox">this computer</Tag>;
}

export interface ClusterSwitcherProps {
  presentation?: 'developer' | 'workspace';
  onSetupWorkspace?: () => void;
}

export function ClusterSwitcher({ presentation = 'developer', onSetupWorkspace }: ClusterSwitcherProps) {
  const workspacePresentation = presentation === 'workspace';
  const host = useHost();
  const localLabel = localMachineLabel(host.platform);
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
  const orderedClusters = React.useMemo(
    () => [
      ...visibleClusters.filter((item) => isMicroVmClusterId(item.id)),
      ...visibleClusters.filter((item) => !isMicroVmClusterId(item.id)),
    ],
    [visibleClusters]
  );

  const [open, setOpen] = React.useState(false);
  const localClusters = orderedClusters.filter((item) => isMicroVmClusterId(item.id));
  const cloudClusters = orderedClusters.filter((item) => !isMicroVmClusterId(item.id));
  const developerMissingLocal = coreMachines.length === 0 && localClusters.length === 0;

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
      const stayable = ['apps', 'catalogue', 'projects', 'machine', 'cloud', 'settings', 'agents', 'deployments'];
      if (segments.length !== 1 || !stayable.includes(segments[0])) {
        navigate('/');
      }
      setOpen(false);
    },
    onError: () => {
      setOpen(true);
    },
  });

  if (clusters.length === 0 && coreMachines.length === 0 && isMachineLoading) {
    return <div className="text-xs text-[var(--color-muted-foreground)]">…</div>;
  }
  if (clusters.length === 0 && coreMachines.length === 0 && !host.vm && !workspacePresentation) {
    return <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">Not connected</div>;
  }

  const currentName = switcherName(presentation, cluster, host.platform, isLoading);

  return (
    <div className="relative">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={workspacePresentation ? `Workspace: ${currentName}` : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-sm hover:bg-[var(--color-muted)]',
              open && 'bg-[var(--color-muted)]'
            )}
          >
            {/* While an alias selection is still resolving against the VM
            inventory, show a quiet ellipsis — never the alias identity. */}
            {workspacePresentation ? <Monitor className="h-4 w-4" aria-hidden /> : null}
            <span className="font-medium">{currentName}</span>
            {workspacePresentation ? (
              cluster ? (
                isMicroVmClusterId(cluster.id) ? (
                  <Tag emphasis="sandbox">sandboxed</Tag>
                ) : (
                  <Tag emphasis="info">cloud</Tag>
                )
              ) : (
                <Tag>not set up</Tag>
              )
            ) : cluster ? (
              <EngineBadge local={isMicroVmClusterId(cluster.id)} />
            ) : null}
            <ChevronDown className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          loop
          id="target-switcher-menu"
          aria-label={workspacePresentation ? 'Workspaces' : 'Deployment targets'}
          className="w-80 p-0"
        >
          {selectMutation.isError ? (
            <Banner tone="error" className="m-2" title="Couldn't switch target">
              Try again. Your current target has not changed.
            </Banner>
          ) : null}
          {workspacePresentation ? (
            <ul className="max-h-80 overflow-auto py-1">
              <li className="px-3 py-1 text-micro font-medium uppercase tracking-[0.08em] text-[var(--color-muted-foreground)]">
                Workspace
              </li>
              {localClusters.length > 0 ? (
                localClusters.map((c) => {
                  const isSelected = c.id === cluster?.id;
                  const pending = selectMutation.isPending && selectMutation.variables === c.id;
                  return (
                    <li key={c.id}>
                      <DropdownMenuItem
                        asChild
                        disabled={selectMutation.isPending && !pending}
                        onSelect={(event) => event.preventDefault()}
                      >
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          onClick={() => (isSelected ? setOpen(false) : selectMutation.mutate(c.id))}
                          disabled={selectMutation.isPending && !pending}
                          className={cn(
                            'grid w-full grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)] disabled:opacity-50',
                            isSelected && 'bg-[var(--color-muted)]'
                          )}
                        >
                          <div className="w-4">{isSelected ? <Check className="h-4 w-4" aria-hidden /> : null}</div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 font-medium">
                              {pending ? 'Switching…' : localLabel} <Tag emphasis="sandbox">sandboxed</Tag>
                            </div>
                            <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">
                              {c.apiServerUrl}
                            </div>
                          </div>
                        </button>
                      </DropdownMenuItem>
                    </li>
                  );
                })
              ) : (
                <li>
                  <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={onSetupWorkspace}
                      className="grid w-full grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]"
                    >
                      <div className="w-4" />
                      <div>
                        <div className="flex items-center gap-1.5 font-medium">
                          {localLabel} <Tag>not set up</Tag>
                        </div>
                        <div className="text-xs leading-4 text-[var(--color-muted-foreground)]">
                          Set up the sandbox on {localMachineLabelInline(host.platform)}
                        </div>
                      </div>
                    </button>
                  </DropdownMenuItem>
                </li>
              )}
              {cloudClusters.map((c) => {
                const isSelected = c.id === cluster?.id;
                const pending = selectMutation.isPending && selectMutation.variables === c.id;
                return (
                  <li key={c.id}>
                    <DropdownMenuItem
                      asChild
                      disabled={selectMutation.isPending && !pending}
                      onSelect={(event) => event.preventDefault()}
                    >
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        onClick={() => (isSelected ? setOpen(false) : selectMutation.mutate(c.id))}
                        disabled={selectMutation.isPending && !pending}
                        className={cn(
                          'grid w-full grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)] disabled:opacity-50',
                          isSelected && 'bg-[var(--color-muted)]'
                        )}
                      >
                        <div className="w-4">{isSelected ? <Check className="h-4 w-4" aria-hidden /> : null}</div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 font-medium">
                            {pending ? 'Switching…' : targetName(c)}
                            <Tag emphasis="info">cloud</Tag>
                          </div>
                          <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">
                            {c.apiServerUrl}
                          </div>
                        </div>
                      </button>
                    </DropdownMenuItem>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul className="max-h-80 overflow-auto py-1">
              <li className="px-3 py-1 text-micro font-medium uppercase tracking-[0.08em] text-[var(--color-muted-foreground)]">
                This computer
              </li>
              {developerMissingLocal ? (
                <li>
                  <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        navigate('/setup');
                        setOpen(false);
                      }}
                      className="grid w-full grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]"
                    >
                      <div className="w-4" />
                      <div>
                        <div className="flex items-center gap-1.5 font-medium">
                          {localLabel} <Tag>not set up</Tag>
                        </div>
                        <div className="text-xs leading-4 text-[var(--color-muted-foreground)]">Open Setup</div>
                      </div>
                    </button>
                  </DropdownMenuItem>
                </li>
              ) : null}
              {coreMachines.map((vm) => (
                <li key={`core-${vm.name}`}>
                  <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        const suffix = vm.name === 'appliance' ? '' : `?vm=${encodeURIComponent(vm.name)}`;
                        navigate(`/machine${suffix}`);
                        setOpen(false);
                      }}
                      className="grid w-full grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]"
                    >
                      <StatusDot
                        tone={vm.running ? 'sandbox' : 'neutral'}
                        label={vm.running ? 'Sandbox ready' : 'Stopped'}
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-medium">
                          {devMachineLabel(vm.name)} <EngineBadge local />
                        </div>
                        <div className="text-xs leading-4 text-[var(--color-muted-foreground)]">
                          {vm.running
                            ? "Sandbox — can't deploy yet · Set up hosting"
                            : 'Stopped · open Machine to start'}
                        </div>
                      </div>
                    </button>
                  </DropdownMenuItem>
                </li>
              ))}
              {orderedClusters
                .filter((item) => isMicroVmClusterId(item.id))
                .map((c) => {
                  const isSelected = c.id === cluster?.id;
                  const pending = selectMutation.isPending && selectMutation.variables === c.id;
                  return (
                    <li key={c.id}>
                      <DropdownMenuItem
                        asChild
                        disabled={selectMutation.isPending && !pending}
                        onSelect={(event) => event.preventDefault()}
                      >
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          aria-current={isSelected ? 'true' : undefined}
                          onClick={() => {
                            if (!isSelected) selectMutation.mutate(c.id);
                            else setOpen(false);
                          }}
                          disabled={selectMutation.isPending && !pending}
                          className={cn(
                            'grid w-full grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)] disabled:opacity-50',
                            isSelected && 'bg-[var(--color-muted)]'
                          )}
                        >
                          <div className="w-4">{isSelected ? <Check className="h-4 w-4" aria-hidden /> : null}</div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 font-medium">
                              {pending ? 'Switching…' : targetName(c)} <EngineBadge local />
                            </div>
                            <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">
                              Sandbox + hosting · {c.apiServerUrl}
                            </div>
                          </div>
                        </button>
                      </DropdownMenuItem>
                    </li>
                  );
                })}
              <li className="mt-1 border-t border-[var(--color-border)] px-3 py-1 text-micro font-medium uppercase tracking-[0.08em] text-[var(--color-muted-foreground)]">
                Cloud
              </li>
              {visibleClusters.filter((item) => !isMicroVmClusterId(item.id)).length === 0 ? (
                <li className="px-3 py-2 text-xs text-[var(--color-muted-foreground)]">None paired yet</li>
              ) : null}
              {orderedClusters
                .filter((item) => !isMicroVmClusterId(item.id))
                .map((c) => {
                  const isSelected = c.id === cluster?.id;
                  const pending = selectMutation.isPending && selectMutation.variables === c.id;
                  return (
                    <li key={c.id}>
                      <DropdownMenuItem
                        asChild
                        disabled={selectMutation.isPending && !pending}
                        onSelect={(event) => event.preventDefault()}
                      >
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          aria-current={isSelected ? 'true' : undefined}
                          onClick={() => {
                            if (!isSelected) selectMutation.mutate(c.id);
                            else setOpen(false);
                          }}
                          disabled={selectMutation.isPending && !pending}
                          className={cn(
                            'grid w-full grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)] disabled:opacity-50',
                            isSelected && 'bg-[var(--color-muted)]'
                          )}
                        >
                          <div className="w-4">
                            {isSelected ? <Check className="h-4 w-4 text-[var(--color-accent)]" /> : null}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 font-medium">
                              {pending ? 'Switching…' : targetName(c)} <EngineBadge local={isMicroVmClusterId(c.id)} />
                            </div>
                            <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">
                              {c.apiServerUrl}
                            </div>
                          </div>
                        </button>
                      </DropdownMenuItem>
                    </li>
                  );
                })}
            </ul>
          )}
          <div className="border-t border-[var(--color-border)] p-1">
            <DropdownMenuItem asChild>
              <Link
                // Canonical add-cloud surface (§5.2 dedup / Devon nit) —
                // the onboarding Connect form, not the old bare /connect.
                to="/setup/connect"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-[var(--color-muted)]"
              >
                <Plus className="h-4 w-4" />
                {workspacePresentation ? 'Add a workspace…' : 'Pair a cloud'}
              </Link>
            </DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
