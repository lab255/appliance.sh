import * as React from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Rocket, Trash2 } from 'lucide-react';
import { applianceBaseConfig, type ApplianceBaseConfig } from '@appliance.sh/sdk';
import { Button } from '@/components/ui/button';
import { CommandSnippet } from '@/components/ui/command-snippet';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import type { BootstrapEvent, Cluster, ConsoleHost } from '@/lib/host';
import { cn } from '@/lib/utils';

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
    <div className="rounded-md border border-[var(--color-border)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Deploy an app to this cloud</div>
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            Build a local project and ship it to{' '}
            <span className="font-medium text-[var(--color-foreground)]">{cluster.name}</span>
            {canDeployInApp
              ? ' — the wizard targets this cluster.'
              : ' with the CLI (the in-app wizard is desktop-only).'}
          </p>
        </div>
        {canDeployInApp ? (
          <Button onClick={() => void deployHere()} disabled={busy}>
            <Rocket className="h-4 w-4" /> {busy ? 'Opening…' : 'Deploy an app'}
          </Button>
        ) : null}
      </div>
      {canDeployInApp ? null : (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs text-[var(--color-muted-foreground)]">Run this from your app folder:</p>
          <CommandSnippet command="appliance deploy" />
        </div>
      )}
    </div>
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
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] px-3 py-3">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Switch to this cluster to read its installer state and run lifecycle operations — they authenticate through
          this cluster&apos;s api-server.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => selectMutation.mutate(cluster.id)}
          disabled={selectMutation.isPending}
        >
          Switch to this cluster
        </Button>
      </div>
    );
  }

  if (clusterInfoQuery.isPending && client) {
    return (
      <p className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
        Checking this cluster&apos;s installer type…
      </p>
    );
  }

  if (provisioner === 'cloudformation-v1') {
    return <CloudFormationLifecycleHandoff />;
  }

  if (!canBootstrap) {
    // Web shell (no local Pulumi / AWS creds): the lifecycle ops can't run
    // here. Connect-added clusters are still usable for deploys; only the
    // installer-level operations are desktop-only.
    return (
      <p className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
        Cluster lifecycle operations (baseline / api-server updates, installer-state migration, destroy) run from the
        desktop app — they need local AWS credentials and Pulumi. This shell can deploy to the cluster, but can&apos;t
        manage its installer infrastructure.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* The heavyweight installer panels, collapsed by default — deep
          Pulumi/AWS territory that most visits don't need. */}
      <details className="rounded-md border border-[var(--color-border)]">
        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
          Advanced
          <span className="ml-2 text-xs font-normal text-[var(--color-muted-foreground)]">
            baseline / api-server updates · installer-state migration
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

function CloudFormationLifecycleHandoff() {
  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
        <div>
          <div className="text-sm font-medium">Update cloud installation</div>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            This installation is managed by CloudFormation. Run updates with the Appliance CLI.
          </p>
        </div>
        <CommandSnippet command="appliance cloud update" />
      </div>
      <div className="space-y-2 rounded-md border border-red-500/40 p-3">
        <div>
          <div className="text-sm font-medium text-red-400">Destroy cloud installation</div>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Teardown is destructive and is managed by the CloudFormation-aware CLI.
          </p>
        </div>
        <CommandSnippet command="appliance cloud teardown" />
      </div>
    </div>
  );
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
    <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
      <div>
        <div className="text-sm font-medium">Update infra baseline</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">
          Re-run phase 1 against the cluster&apos;s installer stack to apply infra changes that ship with the bundled
          @appliance.sh/infra package (state bucket policy, ECR, CloudFront, edge router, system roles, etc.). The
          running api-server keeps its cached APPLIANCE_BASE_CONFIG until its next deploy — run an api-server update
          afterwards to propagate any baseline value changes.
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
          <input
            type="text"
            value={awsProfile}
            onChange={(e) => setAwsProfile(e.target.value)}
            placeholder="leave empty to use shell env"
            disabled={status === 'running'}
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-sm disabled:opacity-50"
          />
        )}
      </label>

      {!cluster.lastBootstrapInput ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-2 text-xs text-[var(--color-muted-foreground)]">
          No cached bootstrap input on this cluster — needed to preserve dns / vpc choices when re-running phase 1.
          Re-run the bootstrap wizard (<code className="font-mono">/cloud/bootstrap</code>) from this device to cache
          it, or operate via the CLI.
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onRun} disabled={status === 'running' || !canUpdate}>
          {status === 'running' ? 'Updating…' : `Update baseline to ${bundledVersion}`}
        </Button>
        {status === 'succeeded' ? <span className="text-xs text-green-400">✓ Baseline updated</span> : null}
        {status === 'failed' ? <span className="text-xs text-red-400">Failed</span> : null}
      </div>

      {logs.length > 0 || error ? (
        <div className="rounded-md border border-[var(--color-border)] bg-black/30">
          <div className="max-h-48 overflow-auto px-2 py-1.5 font-mono text-xs leading-relaxed">
            {logs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {l}
              </div>
            ))}
            {error ? <div className={cn('whitespace-pre-wrap', 'text-red-400')}>{error}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UpdateApiServerPanel({ cluster }: { cluster: Cluster }) {
  const host = useHost();
  const client = useApplianceClient();
  const { config } = useSelectedCluster();
  const apiKey = config?.apiKey ?? null;
  const [status, setStatus] = React.useState<RunStatus>('idle');
  const [logs, setLogs] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
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
  const runningVersion = clusterInfoQuery.data?.version ?? null;

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
    if (latestVersion) setTargetVersion(latestVersion);
    else if (runningVersion) setTargetVersion(runningVersion);
  }, [latestVersion, runningVersion, targetVersion]);

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
    if (!overrideValid) return;
    if (!host.bootstrap?.updateApiServer) return;
    if (!apiKey) {
      setStatus('failed');
      setError('No API key loaded for this cluster — switch to it first.');
      return;
    }
    setStatus('running');
    setLogs([]);
    setError(null);
    try {
      await host.bootstrap.updateApiServer(
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
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
      <div>
        <div className="text-sm font-medium">Update api-server / api-worker</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">
          Mirror a new <code className="font-mono">ghcr.io/appliance-sh/api-server</code> tag into this cluster&apos;s
          ECR and redeploy the system Lambdas. Worker is updated first; the api-server&apos;s deploy goes through the
          (now upgraded) worker.
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

      {clusterInfoUnavailable ? (
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
            <span className="text-red-400">
              Invalid JSON or schema mismatch — couldn&apos;t parse as ApplianceBaseConfig.
            </span>
          ) : null}
        </label>
      ) : null}

      <label className="block space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">Target version</span>
        <input
          type="text"
          value={targetVersion}
          onChange={(e) => setTargetVersion(e.target.value)}
          placeholder="1.37.0"
          disabled={status === 'running'}
          spellCheck={false}
          className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-sm disabled:opacity-50"
        />
      </label>

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
          <input
            type="text"
            value={awsProfile}
            onChange={(e) => setAwsProfile(e.target.value)}
            placeholder="leave empty to use shell env"
            disabled={status === 'running'}
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-sm disabled:opacity-50"
          />
        )}
      </label>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onRun} disabled={status === 'running' || !targetValid || !overrideValid}>
          {status === 'running' ? 'Updating…' : `Update to ${targetVersion || '…'}`}
        </Button>
        {status === 'succeeded' ? <span className="text-xs text-green-400">✓ Update complete</span> : null}
        {status === 'failed' ? <span className="text-xs text-red-400">Failed</span> : null}
      </div>

      {logs.length > 0 || error ? (
        <div className="rounded-md border border-[var(--color-border)] bg-black/30">
          <div className="max-h-48 overflow-auto px-2 py-1.5 font-mono text-xs leading-relaxed">
            {logs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {l}
              </div>
            ))}
            {error ? <div className={cn('whitespace-pre-wrap', 'text-red-400')}>{error}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type RunStatus = 'idle' | 'running' | 'succeeded' | 'failed';
type Direction = 'promote' | 'demote';

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
        Move this cluster&apos;s installer Pulumi state from{' '}
        <code className="font-mono">~/.appliance/pulumi-state</code> into the cluster&apos;s S3 state bucket so future
        operations don&apos;t require this machine.
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
        Pull installer state from the cluster&apos;s S3 backend back to{' '}
        <code className="font-mono">~/.appliance/pulumi-state</code>. Refuses to overwrite an existing local state dir —
        archive or remove it first. The S3 stack is left in place as a backup.
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
    <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
      <div>
        <div className="text-sm font-medium">{copy.title}</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">{copy.description}</div>
      </div>

      <div className="space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">State backend</span>
        <div className="rounded-md border border-[var(--color-border)] bg-black/20 px-2 py-1.5 font-mono text-sm">
          {clusterInfoQuery.isLoading ? (
            <span className="text-[var(--color-muted-foreground)]">Loading from api-server…</span>
          ) : clusterInfoQuery.isError ? (
            <span className="text-red-400">
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
          <input
            type="text"
            value={awsProfile}
            onChange={(e) => setAwsProfile(e.target.value)}
            placeholder="leave empty to use shell env"
            disabled={status === 'running'}
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-sm disabled:opacity-50"
          />
        )}
      </label>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onRun} disabled={status === 'running' || !stateBackendUrlValid}>
          {status === 'running' ? copy.runningLabel : copy.runLabel}
        </Button>
        {status === 'succeeded' ? <span className="text-xs text-green-400">{copy.successLabel}</span> : null}
        {status === 'failed' ? <span className="text-xs text-red-400">Failed</span> : null}
      </div>

      {logs.length > 0 || error ? (
        <div className="rounded-md border border-[var(--color-border)] bg-black/30">
          <div className="max-h-48 overflow-auto px-2 py-1.5 font-mono text-xs leading-relaxed">
            {logs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {l}
              </div>
            ))}
            {error ? <div className={cn('whitespace-pre-wrap', 'text-red-400')}>{error}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
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
      title: `Destroy cluster "${cluster.name}"?`,
      description:
        'This runs pulumi destroy against the installer stack and tears down every base AWS resource it created ' +
        '(Route53 zone, CloudFront distribution, ACM certificate, edge router Lambda, S3 state + data buckets, ECR ' +
        'repository, IAM roles). User-deployed appliances live in a separate project and are NOT destroyed — destroy ' +
        'them first or their AWS resources will be orphaned. This cannot be undone.',
      confirmLabel: 'Destroy cluster',
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
      toast(`Cluster "${cluster.name}" destroyed`);
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
    <div className="space-y-2 rounded-md border border-red-500/40 p-3">
      <div>
        <div className="text-sm font-medium text-red-400">Destroy cluster</div>
        <div className="text-xs text-[var(--color-muted-foreground)]">
          Run <code className="font-mono">pulumi destroy</code> against this cluster&apos;s installer stack using the
          state on this device — it tears down the <span className="font-medium">real AWS infrastructure</span> it
          created (Route53 zone, CloudFront, ACM cert, edge router Lambda, S3 state + data buckets, ECR, IAM roles).
          Destroy any deployed appliances first — they live in a separate Pulumi project and would otherwise be
          orphaned. <span className="font-medium text-red-300">This cannot be undone</span> — archived Pulumi state
          can&apos;t restore deleted AWS resources.
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
          <input
            type="text"
            value={awsProfile}
            onChange={(e) => setAwsProfile(e.target.value)}
            placeholder="leave empty to use shell env"
            disabled={status === 'running'}
            className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-sm disabled:opacity-50"
          />
        )}
      </label>

      <label className="block space-y-1 text-xs">
        <span className="text-[var(--color-muted-foreground)]">
          Type <code className="font-mono text-[var(--color-foreground)]">{cluster.name}</code> to confirm
        </span>
        <input
          type="text"
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
          placeholder={cluster.name}
          autoComplete="off"
          spellCheck={false}
          disabled={status === 'running'}
          className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-sm disabled:opacity-50"
        />
      </label>

      <div className="flex items-center gap-2">
        <Button variant="destructive" size="sm" onClick={onRun} disabled={status === 'running' || !nameConfirmed}>
          <Trash2 className="h-4 w-4" />
          {status === 'running' ? 'Destroying…' : 'Destroy cluster'}
        </Button>
        {status === 'succeeded' ? <span className="text-xs text-green-400">✓ Cluster destroyed</span> : null}
        {status === 'failed' ? <span className="text-xs text-red-400">Failed</span> : null}
      </div>

      {logs.length > 0 || error ? (
        <div className="rounded-md border border-[var(--color-border)] bg-black/30">
          <div className="max-h-48 overflow-auto px-2 py-1.5 font-mono text-xs leading-relaxed">
            {logs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {l}
              </div>
            ))}
            {error ? <div className={cn('whitespace-pre-wrap', 'text-red-400')}>{error}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
