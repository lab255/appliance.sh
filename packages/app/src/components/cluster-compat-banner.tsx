import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useClusterCompat } from '@/hooks/use-cluster-compat';
import { Banner } from '@/components/ui/banner';
import { useHost } from '@/providers/host-provider';

// Cluster-level version-compat banner (generalized from the deploy
// wizard's capability banner): one amber line at the top of the shell
// when the selected cluster's control plane and this app have drifted
// apart, with the remediation that actually applies. Also surfaces the
// server's operational `warnings[]` (e.g. the guest watchdog's "legacy
// deploy removed — update the CLI") verbatim. Renders nothing when
// versions agree and no warnings exist, while data is loading, and for
// cloud clusters whose (independent) version merely differs.

export function ClusterCompatBanner() {
  const host = useHost();
  const queryClient = useQueryClient();
  const compat = useClusterCompat();
  const [updating, setUpdating] = React.useState(false);
  const [updatePhase, setUpdatePhase] = React.useState<string | null>(null);
  const [updateError, setUpdateError] = React.useState<string | null>(null);
  const [updateSuccess, setUpdateSuccess] = React.useState<string | null>(null);
  if (updateSuccess) {
    return (
      <Banner tone="success" role="status" icon={CheckCircle2} className="mb-4">
        {updateSuccess}
      </Banner>
    );
  }
  if (compat.loading) return null;

  const machineRestart = (
    <>
      restart it from the{' '}
      <Link to="/machine" className="underline">
        Machine page
      </Link>
    </>
  );
  const updateAction =
    compat.controlPlaneUpdateCapable && compat.selfUpdateEnabled && compat.vmName && host.vm ? (
      <button
        type="button"
        disabled={updating}
        className="underline disabled:opacity-60"
        onClick={() => {
          setUpdating(true);
          setUpdatePhase('Checking VM capability…');
          setUpdateError(null);
          void host
            .vm!.instance(compat.vmName)
            .update(compat.clientVersion, ({ message }) => setUpdatePhase(message.replace(/^»\s*/u, '')))
            .then(async () => {
              setUpdateSuccess(
                `Control plane updated: v${compat.serverVersion ?? 'unknown'} → v${compat.clientVersion}`
              );
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['cluster-info'] }),
                queryClient.invalidateQueries({ queryKey: ['microvm', compat.vmName, 'status'] }),
              ]);
            })
            .catch((error: unknown) => setUpdateError(error instanceof Error ? error.message : String(error)))
            .finally(() => {
              setUpdating(false);
              setUpdatePhase(null);
            });
        }}
      >
        {updating ? (updatePhase ?? 'Updating…') : 'Update now'}
      </button>
    ) : compat.controlPlaneUpdateCapable && !compat.selfUpdateEnabled ? (
      <>in-place updates are not enabled in this build; {machineRestart}</>
    ) : (
      machineRestart
    );

  let message: React.ReactNode = null;
  if (compat.clientBelowMinimum) {
    message = (
      <>
        This app (v{compat.clientVersion}) is older than the server&apos;s minimum supported client (v
        {compat.minClientVersion}) — update the app, then reload.
      </>
    );
  } else if (compat.controlPlanePredatesReporting) {
    message = <>The Dev Machine&apos;s control plane is too old for in-place updates — {machineRestart}.</>;
  } else if (compat.versionDrift && compat.isMicroVm) {
    message = (
      <>
        The Dev Machine&apos;s control plane (v{compat.serverVersion}) doesn&apos;t match this app (v
        {compat.clientVersion}) — {updateAction}.
      </>
    );
  }
  // Server-reported operational warnings ride the same banner, one
  // line each, straight through (already deduplicated by the hook).
  if (!message && compat.warnings.length === 0) return null;

  return (
    <Banner tone="warning" role="status" icon={AlertTriangle} className="mb-4">
      <span className="flex flex-col gap-1 text-xs leading-4">
        {message ? <span>{message}</span> : null}
        {updateError ? <span>Update failed: {updateError}</span> : null}
        {compat.warnings.map((warning) => (
          <span key={warning}>{warning}</span>
        ))}
      </span>
    </Banner>
  );
}
