import * as React from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Play, Settings } from 'lucide-react';
import { LogPane } from '@/components/ui/log-pane';
import { Button } from '@/components/ui/button';
import { FriendlyError } from '@/components/friendly-error';
import { useHost } from '@/providers/host-provider';
import { DEFAULT_MICROVM_NAME, devMachineLabel, microVmNameFromClusterId, type MicroVmStatus } from '@/lib/host';
import { couldBeDevMachineAlias } from '@/lib/dev-machine-targets';

// Recovery for the "Can't reach the server" dead-end when the unreachable
// target is the LOCAL Dev Machine (microVM) that simply isn't running —
// after a delete, a stop, or a fresh install. Instead of a terminal error
// card, the operator gets a one-click Start (or Install engine) with live
// bring-up progress, and the page reconnects itself once the machine
// answers. Desktop-only (needs host.vm); a no-op elsewhere.

/**
 * The VM name a failing cluster connection maps to, or null when the
 * failure isn't a local Dev Machine we can start from here. A `microvm*`
 * cluster id maps to its VM name directly; a CLI-profile alias whose URL
 * points at this computer (e.g. a `local` profile at
 * `http://api.appliance.localhost:8081`) maps to the default `appliance`
 * VM it forwards to. Requires a VM-capable host (the desktop) — the web
 * shell can't boot anything, so it always returns null there.
 */
export function useStartableDevMachine(cluster: { id: string; apiServerUrl: string }): string | null {
  const host = useHost();
  if (!host.vm) return null;
  const direct = microVmNameFromClusterId(cluster.id);
  if (direct) return direct;
  return couldBeDevMachineAlias(cluster) ? DEFAULT_MICROVM_NAME : null;
}

/**
 * The Start-the-machine recovery card. Render this in place of the plain
 * `FriendlyError` when `useStartableDevMachine` resolved a VM name and the
 * error is network-shaped. It reuses the same `FriendlyError` shell (so the
 * headline + raw-error "Details" disclosure match every other surface) and
 * adds the lifecycle actions below.
 */
export function StartMachineRecovery({
  vmName,
  error,
  onRecovered,
}: {
  vmName: string;
  error: unknown;
  /** Fired once the machine is up (or was started elsewhere). The parent
   *  typically refetches; this component already invalidates the cache. */
  onRecovered?: () => void;
}) {
  const host = useHost();
  const queryClient = useQueryClient();
  const vm = React.useMemo(() => host.vm!.instance(vmName), [host, vmName]);

  const [busy, setBusy] = React.useState<'install' | 'up' | null>(null);
  const [log, setLog] = React.useState<string[]>([]);
  const [startError, setStartError] = React.useState<string | null>(null);

  // Shares the machine page's status key so the two never double-poll.
  const statusQuery = useQuery({
    queryKey: ['microvm', vmName, 'status'],
    queryFn: () => vm.status(),
    refetchInterval: (q) => {
      const data = q.state.data as MicroVmStatus | undefined;
      if (!data?.available) return 30_000;
      return data.running ? 8_000 : 4_000;
    },
  });
  const status = statusQuery.data;

  // Self-dismiss: if the machine reaches ready (started here, on the
  // machine page, or from the CLI), refetch everything so the parent's
  // failing query recovers and this card unmounts.
  const ready = Boolean(status?.running && status?.kubeconfigReady);
  const notified = React.useRef(false);
  React.useEffect(() => {
    if (ready && !notified.current) {
      notified.current = true;
      void queryClient.invalidateQueries();
      onRecovered?.();
    } else if (!ready) {
      notified.current = false;
    }
  }, [ready, queryClient, onRecovered]);

  const startMachine = async () => {
    setBusy('up');
    setStartError(null);
    setLog([]);
    try {
      const onLog = (e: { message: string }) => setLog((prev) => [...prev.slice(-199), e.message]);
      // Dev is a one-way engine flag: a VM already provisioned as a dev
      // environment must re-provision through `dev up`.
      if (status?.dev === true) await vm.devUp(onLog);
      else await vm.up(onLog);
      // Up re-registers the microVM as a cluster and re-syncs its key —
      // refetch broadly so projects, config, and status all reconnect.
      await queryClient.invalidateQueries();
      onRecovered?.();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: ['microvm', vmName] });
      void queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
    }
  };

  const installEngine = async () => {
    setBusy('install');
    setStartError(null);
    try {
      await host.vm!.install();
      void queryClient.invalidateQueries({ queryKey: ['microvm', vmName, 'status'] });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const label = devMachineLabel(vmName);
  const running = status?.running === true;
  // Engine binary missing but the host can install it — offer that first.
  const needsInstall = status ? !status.available && status.installable : false;
  // Engine present but unavailable for a reason we can't fix from here
  // (e.g. virtualization unsupported): fall back to pointing at the machine
  // page's diagnostics rather than a Start button that can't work.
  const cannotStart = status ? !status.available && !status.installable : false;
  const machineHref = vmName === DEFAULT_MICROVM_NAME ? '/machine' : `/machine?vm=${encodeURIComponent(vmName)}`;

  const actions = (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {needsInstall ? (
          <Button onClick={installEngine} disabled={busy !== null}>
            <Download className="h-4 w-4" /> {busy === 'install' ? 'Installing engine…' : 'Install engine'}
          </Button>
        ) : (
          <Button onClick={startMachine} disabled={busy !== null || running || cannotStart}>
            <Play className="h-4 w-4" /> {busy === 'up' ? 'Starting…' : running ? 'Reconnecting…' : `Start ${label}`}
          </Button>
        )}
        <Button asChild variant="outline">
          <Link to={machineHref}>
            <Settings className="h-4 w-4" /> Manage machine
          </Link>
        </Button>
      </div>
      {busy === 'up' || log.length > 0 ? (
        <LogPane height="compact" defaultOpen empty="Starting…">
          {log.length > 0 ? log.join('\n') : undefined}
        </LogPane>
      ) : null}
      {cannotStart ? (
        <p className="text-xs text-[var(--color-warning-foreground)]">
          {status?.message ?? 'This computer can’t run the Dev Machine engine.'}
        </p>
      ) : null}
      {startError ? (
        <p className="text-xs text-[var(--color-destructive-foreground)]">Couldn’t start the machine: {startError}</p>
      ) : null}
    </div>
  );

  return <FriendlyError error={error} actions={actions} />;
}
