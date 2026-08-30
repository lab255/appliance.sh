import * as React from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Rocket, Trash2 } from 'lucide-react';
import { applianceBaseConfig, type ApplianceBaseConfig } from '@appliance.sh/sdk';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { CommandSnippet } from '@/components/ui/command-snippet';
import { FriendlyError } from '@/components/friendly-error';
import { Input } from '@/components/ui/input';
import { LongOperation } from '@/components/ui/long-operation';
import { SectionCard } from '@/components/ui/section-card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import type { BootstrapEvent, Cluster, ConsoleHost } from '@/lib/host';
import {
  desktopSelfUpdateError,
  runDesktopCloudSelfUpdate,
  selfUpdatePhaseMessage,
  selfUpdateRollbackMessage,
  selfUpdateTerminalError,
} from '@/lib/self-update-ui';

// Cloud installation detail — the lifecycle ops for one bootstrapped AWS
// installation: update baseline, update api-server/worker, detach/reattach
// installer state, and destroy. Rendered by /cloud/:id.
//
// The four update/migration panels are deep Pulumi/AWS surface most
// operators never touch, so they sit COLLAPSED under an "Advanced"
// disclosure; Destroy stays visible (it's the one op people come here
// for) but last.
//
// These all read cluster metadata from the api-server's `/cluster-info`
// endpoint, which needs an authenticated SDK client — and we only hold a
// key for the CURRENTLY SELECTED cluster. So the panels render only when
// this cluster is the selected one; otherwise we show a "switch first"
// affordance. Host-capability gated on `host.bootstrap.*` (§6: absent on
// web → the whole surface is hidden behind a desktop-only note).
export function CloudClusterDetail({ cluster }: { cluster: Cluster }) {
  // The one-click deploy wedge: "ship a local app to this cloud" is a
  // first-class action on the cloud cluster's own page (parity with the
  // local-runtime detail's "Deploy application"), above the installer
  // lifecycle ops. It's shown regardless of `host.bootstrap` — a
  // Connect-added cluster can't run installer ops but can still be a
  // deploy target.
  return (
    <div className="space-y-4">
      <DeployToCloudCard cluster={cluster} />
      <CloudLifecyclePanels cluster={cluster} />
    </div>
  );
}

// One-click "deploy a local app to this cloud". Selects this cluster (the
// deploy wizard targets the selection + the SDK client binds to it), then
// opens the target-aware wizard at ③ /projects/deploy. The wizard's own
// Target step lets the user confirm / switch, so selection here is a
// convenience, not a hard dependency.
function DeployToCloudCard({ cluster }: { cluster: Cluster }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { config } = useSelectedCluster();
  const isSelected = config?.selectedClusterId === cluster.id;
  const [busy, setBusy] = React.useState(false);

  // The in-app cloud deploy is desktop-only — it shells the bundled
  // `appliance deploy` CLI. On the web shell there's nothing to shell,
  // so hand off to the CLI instead of routing to a "desktop only"
  // wall. This also reconciles the sibling lifecycle copy below, which
  // tells web users "this shell can deploy to the cluster".
  const canDeployInApp = Boolean(host.local?.deployToCloud);

  const deployHere = async () => {
    setBusy(true);
    try {
      if (!isSelected) {
        await host.selectCluster(cluster.id);
        await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      }
    } catch {
      // Selection is best-effort — the wizard's Target step surfaces the
      // real target either way, so never dead-end here.
    } finally {
      setBusy(false);
    }
    navigate('/projects/deploy');
  };

  return (
    <SectionCard
      title="Deploy an app to this cloud"
      description={
        <>
          Build a local project and ship it to{' '}
          <span className="font-medium text-[var(--color-foreground)]">{cluster.name}</span>
          {canDeployInApp
            ? ' — the deploy flow starts with this target.'
            : ' with the CLI (the in-app wizard is desktop-only).'}
        </>
      }
      action={
        canDeployInApp ? (
          <Button onClick={() => void deployHere()} disabled={busy}>
            <Rocket className="h-4 w-4" aria-hidden /> {busy ? 'Opening…' : 'Deploy an app'}
          </Button>
        ) : undefined
      }
    >
      {canDeployInApp ? null : (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs text-[var(--color-muted-foreground)]">Run this from your app folder:</p>
          <CommandSnippet command="appliance deploy" />
        </div>
      )}
    </SectionCard>
  );
}

// Installer-level lifecycle ops for a cloud cluster (baseline / api-server
// updates, state migration, destroy). Split out of `CloudClusterDetail` so
// the deploy action above it always renders, even on shells / states where
// these panels are gated behind a "switch first" or "desktop only" note.
function CloudLifecyclePanels({ cluster }: { cluster: Cluster }) {
  const host = useHost();
  const client = useApplianceClient();
  const queryClient = useQueryClient();
  const { config } = useSelectedCluster();
  const canBootstrap = Boolean(host.bootstrap);
  const desktop = host.desktop === true;
  const canTeardown = Boolean(host.bootstrap?.teardown);
  const isSelected = config?.selectedClusterId === cluster.id;

  const clusterInfoQuery = useQuery({
    queryKey: ['cluster-info', cluster.id],
    enabled: isSelected && Boolean(client),
    queryFn: async () => {
      const r = await client!.getClusterInfo();
      if (!r.success) throw r.error;
      return r.data;
    },
    retry: false,
  });

  // The server is authoritative when reachable. Persisted install
  // generation is deliberately only an offline fallback for clusters
  // added by `appliance cloud install` and later connected here.
  const provisioner = clusterInfoQuery.isSuccess
    ? clusterInfoQuery.data.baseConfig.provisioner
    : clusterInfoQuery.isError || !client
      ? cluster.installGeneration
      : undefined;

  const selectMutation = useMutation({
    mutationFn: async (id: string) => host.selectCluster(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', 'config'] }),
  });

  if (!isSelected) {
    return (
      <Banner
        tone="info"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => selectMutation.mutate(cluster.id)}
            disabled={selectMutation.isPending}
          >
            Switch target
          </Button>
        }
      >
        Select this cloud to read its installation details and run management actions.
      </Banner>
    );
  }

  if (clusterInfoQuery.isPending && client) {
    return (
      <Banner tone="info" role="status">
        Checking installation details…
      </Banner>
    );
  }

  if (provisioner === 'cloudformation-v1') {
    return <CloudFormationLifecycleHandoff cluster={cluster} desktop={desktop} />;
  }

  if (!canBootstrap) {
    // Web shell (no local Pulumi / AWS creds): the lifecycle ops can't run
    // here. Connect-added clusters are still usable for deploys; only the
    // installer-level operations are desktop-only.
    return (
      <Banner tone="neutral">
        Installation updates and recovery run from the desktop app. You can still deploy to this cloud here.
      </Banner>
    );
  }

  return (
    <div className="space-y-3">
      {/* The heavyweight installer panels, collapsed by default — deep
          Pulumi/AWS territory that most visits don't need. */}
      <details className="rounded-md border border-[var(--color-border)]">
        <summary className="cursor-pointer select-none rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
          Technical details — installation updates and recovery
          <span className="ml-2 text-xs font-normal text-[var(--color-muted-foreground)]">
            versions · installation records
          </span>
        </summary>
        <div className="space-y-3 border-t border-[var(--color-border)] p-3">
          <UpdateBaselinePanel cluster={cluster} />
          <UpdateApiServerPanel cluster={cluster} />
          <StateMigrationPanel cluster={cluster} direction="promote" />
          <StateMigrationPanel cluster={cluster} direction="demote" />
        </div>
      </details>
      {/* Teardown reads installer state from this device's ~/.appliance
          cache, so it's only meaningful for clusters bootstrapped here
          (lastBootstrapInput is the signal). A Connect-added cluster has
          no local state to destroy. Kept visible (not under Advanced) but
          last. */}
      {canTeardown && cluster.lastBootstrapInput ? <DestroyClusterPanel cluster={cluster} /> : null}
    </div>
  );
}

export function CloudFormationLifecycleHandoff({ cluster, desktop }: { cluster: Cluster; desktop: boolean }) {
  return (
    <div className="space-y-3">
      {desktop ? (
        <UpdateApiServerPanel cluster={cluster} cloudFormation />
      ) : (
        <SectionCard
          title="Update cloud installation"
          description="Run the signed self-update from the Appliance desktop or CLI."
        >
          <CommandSnippet command="appliance cloud update" />
        </SectionCard>
      )}
      <SectionCard
        tone="danger"
        title="Destroy cloud installation"
        description="CloudFormation must remove the AWS resources it created. This cannot be undone."
      >
        <CommandSnippet command="appliance cloud teardown" />
      </SectionCard>
    </div>
  );
}

export function defaultSelfUpdateTarget(
  latestVersion: string | null,
  runningVersion: string | null,
  latestPending: boolean
): string | null {
  if (latestVersion) return latestVersion;
  return latestPending ? null : runningVersion;
}

function UpdateBaselinePanel({ cluster }: { cluster: Cluster }) {
  const host = useHost();
  const client = useApplianceClient();
  const { config } = useSelectedCluster();
  const apiKey = config?.apiKey ?? null;
  const [status, setStatus] = React.useState<RunStatus>('idle');
  const [logs, setLogs] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [awsProfile, setAwsProfile] = React.useState('');

  const clusterInfoQuery = useQuery({
    queryKey: ['cluster-info', cluster.id],
    enabled: Boolean(client),
    queryFn: async () => {
      const r = await client!.getClusterInfo();
      if (!r.success) throw r.error;
      return r.data;
    },
    retry: false,
  });
  const stateBackendUrl = clusterInfoQuery.data?.baseConfig.stateBackendUrl ?? cluster.stateBackendUrl ?? '';
  const runningBaselineVersion = clusterInfoQuery.data?.baseConfig.baselineVersion ?? null;
  // The desktop ships infra at __APPLIANCE_VERSION__ — every package
  // in the monorepo moves in lockstep, so the bundled SDK / infra /
  // bootstrap versions all match the shell's reported version.
  const bundledVersion = __APPLIANCE_VERSION__;

  const profilesQuery = useQuery({
    queryKey: ['aws-profiles'],
    enabled: Boolean(host.bootstrap?.listAwsProfiles),
    queryFn: () => host.bootstrap!.listAwsProfiles!(),
  });
  const profiles = profilesQuery.data ?? [];
  const canEnumerateProfiles = Boolean(host.bootstrap?.listAwsProfiles);

  const handleEvent = React.useCallback((e: BootstrapEvent) => {
    switch (e.type) {
      case 'log':
        setLogs((prev) => [...prev, e.message]);
        break;
      case 'phase-failed':
        setLogs((prev) => [...prev, `phase failed: ${e.error}`]);
        break;
      case 'resource':
        if (e.op === 'same') return;
        setLogs((prev) => [...prev, `${e.op.padEnd(7)} ${e.resourceType}  ${e.name}`]);
        break;
      default:
        break;
    }
  }, []);

  const canUpdate = Boolean(host.bootstrap?.updateBaseline && cluster.lastBootstrapInput);

  const onRun = async () => {
    if (!host.bootstrap?.updateBaseline) return;
    if (!cluster.lastBootstrapInput) return;
    setStatus('running');
    setLogs([]);
    setError(null);
    try {
      await host.bootstrap.updateBaseline(
        {
          bootstrap: cluster.lastBootstrapInput,
          stateBackendUrl: stateBackendUrl || undefined,
          awsProfile: awsProfile || undefined,
          cluster: apiKey ? { apiServerUrl: cluster.apiServerUrl, apiKey } : undefined,
        },
        undefined,
        handleEvent
      );
      setStatus('succeeded');
    } catch (err) {
      setStatus('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SectionCard className="space-y-2">
      <div>
        <div className="text-sm font-medium">Update installation foundation</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">
          Apply the installation changes bundled with this version of Appliance.
          <details className="mt-1">
            <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
              Technical details
            </summary>
            <p className="mt-1">
              Updates the Pulumi foundation stack. The running service keeps its cached base configuration until the
              next service update.
            </p>
          </details>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-[var(--color-muted-foreground)]">Running</span>
          <div className="font-mono">
            {clusterInfoQuery.isLoading ? (
              <span className="text-[var(--color-muted-foreground)]">…</span>
            ) : runningBaselineVersion ? (
              runningBaselineVersion
            ) : (
              <span
                className="text-[var(--color-muted-foreground)]"
                title="baselineVersion missing — cluster predates the field"
              >
                unknown
              </span>
            )}
          </div>
        </div>
        <div>
          <span className="text-[var(--color-muted-foreground)]">Bundled with this shell</span>
          <div className="font-mono">{bundledVersion}</div>
        </div>
      </div>

      <label className="block space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">AWS profile</span>
        {canEnumerateProfiles ? (
          <select
            value={awsProfile}
            onChange={(e) => setAwsProfile(e.target.value)}
            disabled={status === 'running'}
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="">— shell environment —</option>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.isSso ? '  (SSO)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <Input
            type="text"
            value={awsProfile}
            onChange={(e) => setAwsProfile(e.target.value)}
            placeholder="leave empty to use shell env"
            disabled={status === 'running'}
            mono
          />
        )}
      </label>

      {!cluster.lastBootstrapInput ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-2 text-xs text-[var(--color-muted-foreground)]">
          This computer does not have the setup record needed to preserve the cloud&rsquo;s network and DNS choices.
          Create or manage the installation from the computer that set it up, or use the CLI.
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onRun} disabled={status === 'running' || !canUpdate}>
          {status === 'running' ? 'Updating…' : `Update baseline to ${bundledVersion}`}
        </Button>
      </div>
      <InstallerOperation
        title="Updating installation baseline"
        status={status}
        logs={logs}
        error={error}
        onRetry={() => void onRun()}
      />
    </SectionCard>
  );
}

function UpdateApiServerPanel({ cluster, cloudFormation = false }: { cluster: Cluster; cloudFormation?: boolean }) {
  const host = useHost();
  const client = useApplianceClient();
  const { config } = useSelectedCluster();
  const apiKey = config?.apiKey ?? null;
  const [status, setStatus] = React.useState<RunStatus>('idle');
  const [logs, setLogs] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [rollbackMessage, setRollbackMessage] = React.useState<string | null>(null);
  const [awsProfile, setAwsProfile] = React.useState('');
  const [targetVersion, setTargetVersion] = React.useState('');
  const [baseConfigJson, setBaseConfigJson] = React.useState('');

  // Same cluster-info query the migration panels use — TanStack Query
  // dedupes by key so this doesn't generate a second request.
  const clusterInfoQuery = useQuery({
    queryKey: ['cluster-info', cluster.id],
    enabled: Boolean(client),
    queryFn: async () => {
      const r = await client!.getClusterInfo();
      if (!r.success) throw r.error;
      return r.data;
    },
    retry: false,
  });
  const runningVersion = clusterInfoQuery.data?.serverVersion ?? clusterInfoQuery.data?.version ?? null;

  // Latest semver tag on ghcr.io/appliance-sh/api-server. Best-effort:
  // if the lookup fails (no network, package private, etc.) the user
  // can still type a version manually.
  const latestQuery = useQuery({
    queryKey: ['ghcr-latest', 'appliance-sh/api-server'],
    enabled: Boolean(host.bootstrap?.latestApiServerVersion),
    queryFn: async () => host.bootstrap!.latestApiServerVersion!(),
    retry: false,
    staleTime: 60_000,
  });
  const latestVersion = latestQuery.data?.version ?? null;

  // Default the input to whatever we know: latest from GHCR, else the
  // running version (so the user can re-pin), else empty.
  React.useEffect(() => {
    if (targetVersion) return;
    const defaultTarget = defaultSelfUpdateTarget(latestVersion, runningVersion, latestQuery.isPending);
    if (defaultTarget) setTargetVersion(defaultTarget);
  }, [latestQuery.isPending, latestVersion, runningVersion, targetVersion]);

  const profilesQuery = useQuery({
    queryKey: ['aws-profiles'],
    enabled: !cloudFormation && Boolean(host.bootstrap?.listAwsProfiles),
    queryFn: () => host.bootstrap!.listAwsProfiles!(),
  });
  const profiles = profilesQuery.data ?? [];
  const canEnumerateProfiles = Boolean(host.bootstrap?.listAwsProfiles);

  const handleEvent = React.useCallback((e: BootstrapEvent) => {
    switch (e.type) {
      case 'log':
        setLogs((prev) => [...prev, e.message]);
        break;
      case 'phase-failed':
        setLogs((prev) => [...prev, `phase failed: ${e.error}`]);
        break;
      case 'resource':
        if (e.op === 'same') return;
        setLogs((prev) => [...prev, `${e.op.padEnd(7)} ${e.resourceType}  ${e.name}`]);
        break;
      default:
        break;
    }
  }, []);

  const targetValid = /^\d+\.\d+\.\d+$/.test(targetVersion);
  // Older api-server images (deployed before /cluster-info shipped) 404
  // the cluster-info route. The user can fall back to pasting the
  // APPLIANCE_BASE_CONFIG env var directly. We only require the paste
  // when the query has actually errored — TanStack's `isError` covers
  // 4xx/5xx + network failures.
  const clusterInfoUnavailable = clusterInfoQuery.isError;
  const parsedOverride = React.useMemo<ApplianceBaseConfig | null>(() => {
    if (!baseConfigJson.trim()) return null;
    try {
      return applianceBaseConfig.parse(JSON.parse(baseConfigJson));
    } catch {
      return null;
    }
  }, [baseConfigJson]);
  const overrideValid = !clusterInfoUnavailable || parsedOverride !== null;

  const onRun = async () => {
    if (!targetValid) return;
    if (!cloudFormation && !overrideValid) return;
    if (!cloudFormation && !host.bootstrap?.updateApiServer) return;
    if (!client || !apiKey) {
      setStatus('failed');
      setError('No API key loaded for this cluster — switch to it first.');
      return;
    }
    setStatus('running');
    setLogs([]);
    setError(null);
    setRollbackMessage(null);
    try {
      if (cloudFormation) {
        const update = await runDesktopCloudSelfUpdate(client, targetVersion, {
          idempotencyKey: `desktop-cloud-update-${crypto.randomUUID()}`,
          intervalMs: 2_000,
          onPhase: (job) => setLogs((prev) => [...prev, selfUpdatePhaseMessage(job)]),
          onExistingJob: (statusUrl, jobId) =>
            setLogs((prev) => [...prev, `An update is already running at ${statusUrl}; attaching to ${jobId}.`]),
        });
        if (update.job.status === 'failed' && update.job.recovered) {
          setRollbackMessage(selfUpdateRollbackMessage(update.job, runningVersion));
          setStatus('rolled-back');
          await clusterInfoQuery.refetch();
          return;
        }
        if (update.job.status === 'failed') throw new Error(selfUpdateTerminalError(update.job));
        await clusterInfoQuery.refetch();
        setStatus('succeeded');
        return;
      }
      await host.bootstrap!.updateApiServer(
        {
          apiServerUrl: cluster.apiServerUrl,
          apiKey,
          targetVersion,
          awsProfile: awsProfile || undefined,
          baseConfigOverride: clusterInfoUnavailable ? (parsedOverride ?? undefined) : undefined,
        },
        undefined,
        handleEvent
      );
      setStatus('succeeded');
    } catch (err) {
      setStatus('failed');
      setError(cloudFormation ? desktopSelfUpdateError(err) : err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SectionCard className="space-y-2">
      <div>
        <div className="text-sm font-medium">Update Appliance service</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">
          {cloudFormation
            ? 'Updates to the latest signed release; the running service does the work.'
            : 'Choose a service version and update the installation.'}
          <details className="mt-1">
            <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
              Technical details
            </summary>
            <p className="mt-1">
              {cloudFormation
                ? 'The running service verifies signed release evidence, mirrors the bound digest, updates CloudFormation, probes health, and automatically re-pins the previous image on failure.'
                : 'Copies the selected registry image into ECR, then updates the worker and service Lambdas in order.'}
            </p>
          </details>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-[var(--color-muted-foreground)]">Running</span>
          <div className="font-mono">
            {clusterInfoQuery.isLoading ? (
              <span className="text-[var(--color-muted-foreground)]">…</span>
            ) : runningVersion ? (
              runningVersion
            ) : (
              <span className="text-[var(--color-muted-foreground)]" title="version field missing from /cluster-info">
                unknown
              </span>
            )}
          </div>
        </div>
        <div>
          <span className="text-[var(--color-muted-foreground)]">Latest on ghcr.io</span>
          <div className="font-mono">
            {latestQuery.isLoading ? (
              <span className="text-[var(--color-muted-foreground)]">…</span>
            ) : latestVersion ? (
              latestVersion
            ) : (
              <span
                className="text-[var(--color-muted-foreground)]"
                title={latestQuery.error instanceof Error ? latestQuery.error.message : String(latestQuery.error ?? '')}
              >
                unavailable
              </span>
            )}
          </div>
        </div>
      </div>

      {!cloudFormation && clusterInfoUnavailable ? (
        <label className="block space-y-1 text-xs">
          <span className="text-[var(--color-muted-foreground)]">
            APPLIANCE_BASE_CONFIG (paste JSON — fallback when /cluster-info isn&apos;t available)
          </span>
          <textarea
            value={baseConfigJson}
            onChange={(e) => setBaseConfigJson(e.target.value)}
            disabled={status === 'running'}
            rows={6}
            spellCheck={false}
            placeholder={'{ "name": "...", "type": "appliance-base-aws-public", "stateBackendUrl": "s3://...", ... }'}
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-xs disabled:opacity-50"
          />
          <span className="text-[var(--color-muted-foreground)]">
            Recover via{' '}
            <code className="font-mono">
              aws lambda get-function-configuration --function-name &lt;api-server-handler&gt; --query
              &apos;Environment.Variables.APPLIANCE_BASE_CONFIG&apos; --output text
            </code>
            . Required only on first update from a pre-/cluster-info api-server.
          </span>
          {baseConfigJson.trim() && parsedOverride === null ? (
            <span className="text-[var(--color-destructive-foreground)]">
              Invalid JSON or schema mismatch — couldn&apos;t parse as ApplianceBaseConfig.
            </span>
          ) : null}
        </label>
      ) : null}

      <label className="block space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">Target version</span>
        <Input
          type="text"
          value={targetVersion}
          onChange={(e) => setTargetVersion(e.target.value)}
          placeholder="1.37.0"
          disabled={status === 'running'}
          spellCheck={false}
          mono
        />
      </label>

      {!cloudFormation ? (
        <label className="block space-y-1 text-xs">
          <span className="text-[var(--color-muted-foreground)]">AWS profile</span>
          {canEnumerateProfiles ? (
            <select
              value={awsProfile}
              onChange={(e) => setAwsProfile(e.target.value)}
              disabled={status === 'running'}
              className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm disabled:opacity-50"
            >
              <option value="">— shell environment —</option>
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                  {p.isSso ? '  (SSO)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <Input
              type="text"
              value={awsProfile}
              onChange={(e) => setAwsProfile(e.target.value)}
              placeholder="leave empty to use shell env"
              disabled={status === 'running'}
              mono
            />
          )}
        </label>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onRun}
          disabled={
            status === 'running' ||
            !targetValid ||
            (!cloudFormation && !overrideValid) ||
            (cloudFormation && latestVersion === runningVersion && targetVersion === runningVersion)
          }
        >
          {status === 'running'
            ? 'Updating…'
            : cloudFormation && latestVersion === runningVersion && targetVersion === runningVersion
              ? 'Up to date'
              : `Update to ${targetVersion || '…'}`}
        </Button>
      </div>
      <InstallerOperation
        title="Updating Appliance service"
        status={status}
        logs={logs}
        error={error}
        rollbackMessage={rollbackMessage}
        onRetry={() => void onRun()}
      />
    </SectionCard>
  );
}

type RunStatus = 'idle' | 'running' | 'succeeded' | 'rolled-back' | 'failed';
type Direction = 'promote' | 'demote';

function InstallerOperation({
  title,
  status,
  logs,
  error,
  rollbackMessage,
  onRetry,
}: {
  title: string;
  status: RunStatus;
  logs: string[];
  error: string | null;
  rollbackMessage?: string | null;
  onRetry: () => void;
}) {
  const failureRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (status === 'failed') failureRef.current?.focus();
  }, [status]);
  if (status === 'idle') return null;
  if (status === 'rolled-back') {
    return (
      <div className="space-y-2">
        <Banner tone="warning" role="status" title="Update rolled back">
          {rollbackMessage ?? 'The previous version is serving and healthy.'}
        </Banner>
        {logs.length ? (
          <details className="rounded-md border border-[var(--color-border)] px-3 py-2 text-xs">
            <summary className="cursor-pointer">Updating Appliance service technical details</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono">{logs.join('\n')}</pre>
          </details>
        ) : null}
      </div>
    );
  }
  return (
    <div ref={failureRef} tabIndex={status === 'failed' ? -1 : undefined} className="focus:outline-none">
      <LongOperation
        title={title}
        status={status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : 'running'}
        timeClass="minutes"
        estimate="Timing varies with the AWS changes in this run"
        leaveSafety="keep-page"
        log={logs.map((line, index) => (
          <div key={`${index}:${line}`}>{line}</div>
        ))}
        logProps={{ label: `${title} technical details`, height: 'compact', live: 'polite', copyText: logs.join('\n') }}
      />
      {status === 'failed' ? (
        <FriendlyError
          error={error ?? 'The operation failed.'}
          fallbackHeadline={`${title} failed`}
          actions={
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

const COPY: Record<
  Direction,
  {
    title: string;
    description: React.ReactNode;
    runLabel: string;
    runningLabel: string;
    successLabel: string;
  }
> = {
  promote: {
    title: 'Detach state from this device',
    description: (
      <>
        Move this cloud&apos;s installation records from <code className="font-mono">~/.appliance/pulumi-state</code>{' '}
        into the cluster&apos;s S3 state bucket so future operations don&apos;t require this machine.
      </>
    ),
    runLabel: 'Detach state',
    runningLabel: 'Detaching…',
    successLabel: '✓ State moved to S3',
  },
  demote: {
    title: 'Reattach state to this device',
    description: (
      <>
        Pull installation records from the cloud back to <code className="font-mono">~/.appliance/pulumi-state</code>.
        Refuses to overwrite an existing local state dir — archive or remove it first. The S3 stack is left in place as
        a backup.
      </>
    ),
    runLabel: 'Reattach state',
    runningLabel: 'Reattaching…',
    successLabel: '✓ State copied to local',
  },
};

function StateMigrationPanel({ cluster, direction }: { cluster: Cluster; direction: Direction }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const client = useApplianceClient();
  const { config } = useSelectedCluster();
  const apiKey = config?.apiKey ?? null;
  const [status, setStatus] = React.useState<RunStatus>('idle');
  const [logs, setLogs] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [awsProfile, setAwsProfile] = React.useState('');

  // Pull the cluster's state backend URL from the api-server's
  // base config rather than asking the user to paste it. The bucket
  // is created by `applianceBase` and recorded as `stateBackendUrl`
  // in APPLIANCE_BASE_CONFIG; `/api/v1/cluster-info` exposes it.
  const clusterInfoQuery = useQuery({
    queryKey: ['cluster-info', cluster.id],
    enabled: Boolean(client),
    queryFn: async () => {
      const r = await client!.getClusterInfo();
      if (!r.success) throw r.error;
      return r.data;
    },
  });
  const stateBackendUrl = clusterInfoQuery.data?.baseConfig.stateBackendUrl ?? '';
  const stateBackendUrlValid = stateBackendUrl.startsWith('s3://') && stateBackendUrl.length > 's3://'.length;

  const profilesQuery = useQuery({
    queryKey: ['aws-profiles'],
    enabled: Boolean(host.bootstrap?.listAwsProfiles),
    queryFn: () => host.bootstrap!.listAwsProfiles!(),
  });
  const profiles = profilesQuery.data ?? [];
  const canEnumerateProfiles = Boolean(host.bootstrap?.listAwsProfiles);

  const handleEvent = React.useCallback((e: BootstrapEvent) => {
    switch (e.type) {
      case 'log':
        setLogs((prev) => [...prev, e.message]);
        break;
      case 'phase-failed':
        setLogs((prev) => [...prev, `phase 3 failed: ${e.error}`]);
        break;
      case 'resource':
        if (e.op === 'same') return;
        setLogs((prev) => [...prev, `${e.op.padEnd(7)} ${e.resourceType}  ${e.name}`]);
        break;
      default:
        break;
    }
  }, []);

  const onRun = async () => {
    if (!stateBackendUrlValid) return;
    const action = direction === 'promote' ? host.bootstrap?.promoteState : host.bootstrap?.demoteState;
    if (!action) return;
    setStatus('running');
    setLogs([]);
    setError(null);
    try {
      await action.call(
        host.bootstrap,
        {
          stateBackendUrl,
          awsProfile: awsProfile || undefined,
          // Cluster ref lets the bootstrap pkg verify the URL we're
          // about to operate on against /cluster-info. This panel
          // already sources stateBackendUrl from cluster-info via
          // the same client, so the verification is effectively a
          // belt + braces check — but it covers the path where the
          // sidecar is fed a different value somehow (compromised
          // IPC, future caller changes).
          cluster: apiKey ? { apiServerUrl: cluster.apiServerUrl, apiKey } : undefined,
        },
        undefined,
        handleEvent
      );
      // After promote: clear the cached URL — local state is gone.
      // After demote: cache the URL so a future re-promote can default it.
      await setClusterStateBackendIfPossible(host, cluster.id, direction === 'promote' ? null : stateBackendUrl);
      await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      setStatus('succeeded');
    } catch (err) {
      setStatus('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copy = COPY[direction];

  return (
    <SectionCard className="space-y-2">
      <div>
        <div className="text-sm font-medium">{copy.title}</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">{copy.description}</div>
      </div>

      <div className="space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">Installation records</span>
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-sm">
          {clusterInfoQuery.isLoading ? (
            <span className="text-[var(--color-muted-foreground)]">Loading installation records…</span>
          ) : clusterInfoQuery.isError ? (
            <span className="text-[var(--color-destructive-foreground)]">
              Failed to read /api/v1/cluster-info:{' '}
              {clusterInfoQuery.error instanceof Error
                ? clusterInfoQuery.error.message
                : String(clusterInfoQuery.error)}
            </span>
          ) : stateBackendUrl ? (
            stateBackendUrl
          ) : (
            <span className="text-[var(--color-muted-foreground)]">no stateBackendUrl in cluster info</span>
          )}
        </div>
        <span className="text-[var(--color-muted-foreground)]">
          Read from <code className="font-mono">/api/v1/cluster-info</code> — this is the bucket{' '}
          <code className="font-mono">applianceBase</code> created for the cluster.
        </span>
      </div>

      <label className="block space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">AWS profile</span>
        {canEnumerateProfiles ? (
          <select
            value={awsProfile}
            onChange={(e) => setAwsProfile(e.target.value)}
            disabled={status === 'running'}
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="">— shell environment —</option>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.isSso ? '  (SSO)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <Input
            type="text"
            value={awsProfile}
            onChange={(e) => setAwsProfile(e.target.value)}
            placeholder="leave empty to use shell env"
            disabled={status === 'running'}
            mono
          />
        )}
      </label>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onRun} disabled={status === 'running' || !stateBackendUrlValid}>
          {status === 'running' ? copy.runningLabel : copy.runLabel}
        </Button>
      </div>
      <InstallerOperation
        title={copy.runningLabel.replace('…', '')}
        status={status}
        logs={logs}
        error={error}
        onRetry={() => void onRun()}
      />
    </SectionCard>
  );
}

async function setClusterStateBackendIfPossible(
  host: ConsoleHost,
  clusterId: string,
  url: string | null
): Promise<void> {
  if (!host.setClusterStateBackend) return;
  try {
    await host.setClusterStateBackend(clusterId, url);
  } catch {
    // Best-effort: caching the URL is convenience, not correctness.
    // Failure here doesn't affect the state migration that succeeded.
  }
}

/**
 * Destroy the cluster's base AWS infrastructure from the desktop — the
 * inverse of the bootstrap wizard. Drives `host.bootstrap.teardown`,
 * which runs `pulumi destroy` against the installer state cached in
 * `~/.appliance`. Gated (by the caller) to clusters this device
 * bootstrapped. On success the local registration is forgotten so the
 * dead cluster drops off the list.
 */
function DestroyClusterPanel({ cluster }: { cluster: Cluster }) {
  const host = useHost();
  const { config } = useSelectedCluster();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [status, setStatus] = React.useState<RunStatus>('idle');
  const [logs, setLogs] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [awsProfile, setAwsProfile] = React.useState('');
  // Type-the-cluster-name gate: destroying real AWS infra is irreversible, so
  // arm the button only once the operator re-types the exact cluster name.
  const [confirmName, setConfirmName] = React.useState('');
  const nameConfirmed = confirmName.trim() === cluster.name;

  const profilesQuery = useQuery({
    queryKey: ['aws-profiles'],
    enabled: Boolean(host.bootstrap?.listAwsProfiles),
    queryFn: () => host.bootstrap!.listAwsProfiles!(),
  });
  const profiles = profilesQuery.data ?? [];
  const canEnumerateProfiles = Boolean(host.bootstrap?.listAwsProfiles);

  const handleEvent = React.useCallback((e: BootstrapEvent) => {
    switch (e.type) {
      case 'log':
        setLogs((prev) => [...prev, e.message]);
        break;
      case 'phase-failed':
        setLogs((prev) => [...prev, `phase failed: ${e.error}`]);
        break;
      case 'resource':
        if (e.op === 'same') return;
        setLogs((prev) => [...prev, `${e.op.padEnd(7)} ${e.resourceType}  ${e.name}`]);
        break;
      default:
        break;
    }
  }, []);

  const onRun = async () => {
    if (!host.bootstrap?.teardown) return;
    const ok = await confirm({
      title: `Destroy cloud installation "${cluster.name}"?`,
      description:
        'The Pulumi installer will delete its network, DNS, certificate, edge routing, storage, registry, and access resources in AWS. Apps use separate AWS resources and are not deleted; remove them first or they may be left behind. This cannot be undone.',
      confirmLabel: 'Destroy cloud installation',
    });
    if (!ok) return;
    setStatus('running');
    setLogs([]);
    setError(null);
    try {
      await host.bootstrap.teardown(
        { awsProfile: awsProfile || undefined, cluster, apiKey: config?.apiKey ?? undefined },
        handleEvent
      );
      setStatus('succeeded');
      toast(`Cloud installation "${cluster.name}" destroyed`);
      // The infra is gone, so the local (URL, key) registration is now
      // stale — forget it so the dead cluster drops off the list. Best
      // effort: a failure to forget doesn't undo the successful destroy.
      try {
        await host.removeCluster(cluster.id);
        await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      } catch {
        // Leave the row in place; the user can remove it manually.
      }
    } catch (err) {
      setStatus('failed');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SectionCard
      tone="danger"
      title="Destroy cloud installation"
      description="Deletes the AWS infrastructure created for this cloud. Apps use separate resources and must be removed first. This cannot be undone."
    >
      <label className="block space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">AWS profile</span>
        {canEnumerateProfiles ? (
          <select
            value={awsProfile}
            onChange={(e) => setAwsProfile(e.target.value)}
            disabled={status === 'running'}
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="">— shell environment —</option>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.isSso ? '  (SSO)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <Input
            type="text"
            value={awsProfile}
            onChange={(e) => setAwsProfile(e.target.value)}
            placeholder="leave empty to use shell env"
            disabled={status === 'running'}
            mono
          />
        )}
      </label>

      <label className="block space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">
          Type <code className="font-mono text-[var(--color-foreground)]">{cluster.name}</code> to confirm
        </span>
        <Input
          type="text"
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
          placeholder={cluster.name}
          autoComplete="off"
          spellCheck={false}
          disabled={status === 'running'}
          mono
        />
      </label>

      <div className="flex items-center gap-2">
        <Button variant="destructive" size="sm" onClick={onRun} disabled={status === 'running' || !nameConfirmed}>
          <Trash2 className="h-4 w-4" />
          {status === 'running' ? 'Destroying…' : 'Destroy cloud installation'}
        </Button>
      </div>
      <InstallerOperation
        title="Destroying cloud installation"
        status={status}
        logs={logs}
        error={error}
        onRetry={() => void onRun()}
      />
    </SectionCard>
  );
}
