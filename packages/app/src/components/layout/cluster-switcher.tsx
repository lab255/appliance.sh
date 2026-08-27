import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Check, Monitor, Plus } from 'lucide-react';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { cn } from '@/lib/utils';
import { devMachineLabel, isMicroVmClusterId, microVmNameFromClusterId } from '@/lib/host';
import { useDevMachineTargets } from '@/hooks/use-dev-machine-targets';
import type { Cluster } from '@/lib/host';
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
  isLoading = false
): string {
  if (cluster) {
    return presentation === 'workspace' && workspaceKind(cluster) === 'local' ? 'This Mac' : targetName(cluster);
  }
  if (presentation === 'workspace') return 'This Mac';
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
  const orderedClusterIds = orderedClusters.map((item) => item.id).join(',');

  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [showSetupAction, setShowSetupAction] = React.useState(false);

  const localClusters = orderedClusters.filter((item) => isMicroVmClusterId(item.id));
  const cloudClusters = orderedClusters.filter((item) => !isMicroVmClusterId(item.id));
  const developerMissingLocal = coreMachines.length === 0 && localClusters.length === 0;

  const focusItem = React.useCallback((index: number) => {
    const count = itemRefs.current.length;
    if (!count) return;
    const next = ((index % count) + count) % count;
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    if (workspacePresentation) {
      const selectedLocalIndex = localClusters.findIndex((item) => item.id === cluster?.id);
      const selectedCloudIndex = cloudClusters.findIndex((item) => item.id === cluster?.id);
      const selectedIndex =
        selectedLocalIndex >= 0
          ? selectedLocalIndex
          : selectedCloudIndex >= 0
            ? (localClusters.length || 1) + selectedCloudIndex
            : 0;
      window.requestAnimationFrame(() => focusItem(selectedIndex));
      return;
    }
    const selectedIndex = orderedClusters.findIndex((item) => item.id === cluster?.id);
    window.requestAnimationFrame(() =>
      focusItem(selectedIndex >= 0 ? coreMachines.length + Number(developerMissingLocal) + selectedIndex : 0)
    );
  }, [
    open,
    cluster?.id,
    coreMachines.length,
    orderedClusterIds,
    workspacePresentation,
    localClusters.length,
    cloudClusters.length,
    developerMissingLocal,
    focusItem,
  ]);

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
      triggerRef.current?.focus();
    },
    onError: () => {
      setOpen(true);
      const failedIndex =
        coreMachines.length +
        Number(developerMissingLocal) +
        orderedClusters.findIndex((item) => item.id === selectMutation.variables);
      window.requestAnimationFrame(() => focusItem(Math.max(0, failedIndex)));
    },
  });

  if (clusters.length === 0 && coreMachines.length === 0 && isMachineLoading) {
    return <div className="text-xs text-[var(--color-muted-foreground)]">…</div>;
  }
  if (clusters.length === 0 && coreMachines.length === 0 && !host.vm) {
    return <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">Not connected</div>;
  }

  const currentName = switcherName(presentation, cluster, isLoading);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-label={workspacePresentation ? `Workspace: ${currentName}` : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="target-switcher-menu"
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
              <Tag className="bg-[var(--color-info-background)] text-[var(--color-info-foreground)]">cloud</Tag>
            )
          ) : (
            <Tag>not set up</Tag>
          )
        ) : cluster ? (
          <EngineBadge local={isMicroVmClusterId(cluster.id)} />
        ) : null}
        <ChevronDown className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
      </button>
      {open ? (
        <div
          id="target-switcher-menu"
          role="menu"
          aria-label={workspacePresentation ? 'Workspaces' : 'Deployment targets'}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              focusItem(activeIndex + 1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              focusItem(activeIndex - 1);
            } else if (event.key === 'Home') {
              event.preventDefault();
              focusItem(0);
            } else if (event.key === 'End') {
              event.preventDefault();
              focusItem(itemRefs.current.length - 1);
            }
          }}
          className="absolute left-0 top-full z-10 mt-1 w-80 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-lg"
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
                localClusters.map((c, index) => {
                  const isSelected = c.id === cluster?.id;
                  const pending = selectMutation.isPending && selectMutation.variables === c.id;
                  return (
                    <li key={c.id}>
                      <button
                        ref={(node) => {
                          itemRefs.current[index] = node;
                        }}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        tabIndex={activeIndex === index ? 0 : -1}
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
                            {pending ? 'Switching…' : 'This Mac'} <Tag emphasis="sandbox">sandboxed</Tag>
                          </div>
                          <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">
                            {c.apiServerUrl}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })
              ) : (
                <li>
                  <button
                    ref={(node) => {
                      itemRefs.current[0] = node;
                    }}
                    type="button"
                    role="menuitem"
                    tabIndex={activeIndex === 0 ? 0 : -1}
                    onClick={() => {
                      setShowSetupAction(true);
                    }}
                    className="grid w-full grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]"
                  >
                    <div className="w-4" />
                    <div>
                      <div className="flex items-center gap-1.5 font-medium">
                        This Mac <Tag>not set up</Tag>
                      </div>
                      <div className="text-xs leading-4 text-[var(--color-muted-foreground)]">
                        Select to set up a sandbox
                      </div>
                    </div>
                  </button>
                  {showSetupAction ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={onSetupWorkspace}
                      className="mx-3 mb-2 rounded-md border border-[var(--color-info-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-info-foreground)] hover:bg-[var(--color-info-background)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
                    >
                      Set up your Mac sandbox
                    </button>
                  ) : null}
                </li>
              )}
              {cloudClusters.map((c, cloudIndex) => {
                const index = (localClusters.length || 1) + cloudIndex;
                const isSelected = c.id === cluster?.id;
                const pending = selectMutation.isPending && selectMutation.variables === c.id;
                return (
                  <li key={c.id}>
                    <button
                      ref={(node) => {
                        itemRefs.current[index] = node;
                      }}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isSelected}
                      tabIndex={activeIndex === index ? 0 : -1}
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
                          <Tag className="bg-[var(--color-info-background)] text-[var(--color-info-foreground)]">
                            cloud
                          </Tag>
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
          ) : (
            <ul className="max-h-80 overflow-auto py-1">
              <li className="px-3 py-1 text-micro font-medium uppercase tracking-[0.08em] text-[var(--color-muted-foreground)]">
                This computer
              </li>
              {developerMissingLocal ? (
                <li>
                  <button
                    ref={(node) => {
                      itemRefs.current[0] = node;
                    }}
                    type="button"
                    role="menuitem"
                    tabIndex={activeIndex === 0 ? 0 : -1}
                    onClick={() => {
                      navigate('/setup');
                      setOpen(false);
                    }}
                    className="grid w-full grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]"
                  >
                    <div className="w-4" />
                    <div>
                      <div className="flex items-center gap-1.5 font-medium">
                        This Mac <Tag>not set up</Tag>
                      </div>
                      <div className="text-xs leading-4 text-[var(--color-muted-foreground)]">Open Setup</div>
                    </div>
                  </button>
                </li>
              ) : null}
              {coreMachines.map((vm) => (
                <li key={`core-${vm.name}`}>
                  <button
                    ref={(node) => {
                      itemRefs.current[coreMachines.indexOf(vm)] = node;
                    }}
                    type="button"
                    role="menuitem"
                    tabIndex={activeIndex === coreMachines.indexOf(vm) ? 0 : -1}
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
                        {vm.running ? "Sandbox — can't deploy yet · Set up hosting" : 'Stopped · open Machine to start'}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
              {orderedClusters
                .filter((item) => isMicroVmClusterId(item.id))
                .map((c) => {
                  const isSelected = c.id === cluster?.id;
                  const index = coreMachines.length + Number(developerMissingLocal) + orderedClusters.indexOf(c);
                  const pending = selectMutation.isPending && selectMutation.variables === c.id;
                  return (
                    <li key={c.id}>
                      <button
                        ref={(node) => {
                          itemRefs.current[index] = node;
                        }}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        aria-current={isSelected ? 'true' : undefined}
                        tabIndex={activeIndex === index ? 0 : -1}
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
                  const index = coreMachines.length + Number(developerMissingLocal) + orderedClusters.indexOf(c);
                  const pending = selectMutation.isPending && selectMutation.variables === c.id;
                  return (
                    <li key={c.id}>
                      <button
                        ref={(node) => {
                          itemRefs.current[index] = node;
                        }}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        aria-current={isSelected ? 'true' : undefined}
                        tabIndex={activeIndex === index ? 0 : -1}
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
                    </li>
                  );
                })}
            </ul>
          )}
          <div className="border-t border-[var(--color-border)] p-1">
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
          </div>
        </div>
      ) : null}
    </div>
  );
}
