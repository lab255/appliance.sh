import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  FolderOpen,
  Trash2,
  Plus,
  ChevronRight,
  Play,
  Rocket,
  X,
  History,
} from 'lucide-react';
import { isKubernetesBase } from '@appliance.sh/sdk';
import { Button } from '@/components/ui/button';
import { CommandSnippet } from '@/components/ui/command-snippet';
import { FriendlyError } from '@/components/friendly-error';
import { useHost } from '@/providers/host-provider';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useRecentFolders, type RecentFolder } from '@/hooks/use-recent-folders';
import { useTailAutoscroll } from '@/hooks/use-tail-autoscroll';
import { cn } from '@/lib/utils';
import { DEFAULT_MICROVM_NAME, devMachineLabel, microVmClusterId, microVmNameFromClusterId } from '@/lib/host';
import { resolveDevMachineTargets } from '@/lib/dev-machine-targets';
import type { Cluster, LocalApplianceManifest, LocalLogEvent } from '@/lib/host';
import { extractDeploymentUrl } from '@/lib/deployment';
import { parseStructuredHttpError } from '@/lib/http-error';

// Docker Desktop-style deploy wizard, the canonical ③ /projects/deploy.
// It deploys into the *selected* target — the Dev Machine registers as a
// regular deploy target — gating readiness on that VM and uploading the
// app source to its api-server. Four steps:
//   0. TARGET (Q5) — choose the deploy target. When the chosen Dev
//      Machine isn't serving yet, start it inline (one click brings the
//      VM up, installing the engine if needed) rather than dead-ending
//      the wizard. The deploy intent (?project=&environment=) is captured
//      on mount and survives the bring-up, so the user never loses it.
//      Auto-skipped when exactly one distinct ready target exists —
//      there's no decision to make; Back still returns here.
//   1. Pick a folder containing an appliance.{json,ts,js} manifest.
//      Programmatic .ts/.js manifests run in the CLI's QuickJS
//      sandbox (sidecar invocation).
//   2. Configure the deploy — app / environment names, env vars,
//      optional runtime overrides (memory / timeout / storage).
//   3. Run — mints a build via the SDK, packages + uploads the source
//      through the host bridge (the bundled CLI zips exactly like
//      `appliance deploy` does), then the api-server builds the image
//      next to where it runs (in-VM BuildKit locally, the
//      installation's builder on cloud) while the wizard polls the
//      deploy to a terminal state. No Docker on this machine — the
//      desktop and the terminal share one server-side pipeline.
//
// The wizard talks to the api-server through the SDK client wired up
// by useApplianceClient(), which already holds the selected target's
// signed credentials. The only host-bridge step is
// packageAndUploadBuild — its upload URL is minted by createBuild()
// and carries its own one-time authorization.

type Phase = 'target' | 'pick' | 'configure' | 'run';

type RunStatus = 'idle' | 'running' | 'succeeded' | 'failed';

interface EnvEntry {
  key: string;
  value: string;
}

export function DeployPage() {
  const host = useHost();
  const client = useApplianceClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const local = host.local;
  const { recent: recentFolders, record: recordRecentFolder, forget: forgetRecentFolder } = useRecentFolders();

  // Pre-selected target via query params — e.g. the Environment detail
  // page sends `?project=foo&environment=bar` when its first-time
  // Deploy button is clicked. Captured once on mount so navigating
  // away (e.g. to /local-runtime) and back doesn't blow away in-flight
  // form state.
  const [searchParams] = useSearchParams();
  const presetProject = React.useMemo(() => searchParams.get('project') ?? null, [searchParams]);
  const presetEnvironment = React.useMemo(() => searchParams.get('environment') ?? null, [searchParams]);

  // The wizard deploys into the *selected* cluster (the SDK client is
  // bound to it). The selection arrives ALREADY resolved: a CLI-profile
  // alias of a running local VM reads as the VM's own `microvm*` cluster
  // (useSelectedCluster rebinds it), so "is this a microVM target?" is
  // answerable from the cluster id alone. When it is one, readiness is
  // gated on that VM being up — surfaced up front since the wizard is
  // reachable while the VM is down (deep links, or the user stopped it
  // mid-session). A non-microVM selection is a cloud / BYO cluster the
  // client already targets. Query keys are shared with the Clusters area
  // so the two views never disagree.
  const { cluster: selectedCluster, config, isLoading: selectionLoading } = useSelectedCluster();
  const vmName = selectedCluster ? microVmNameFromClusterId(selectedCluster.id) : null;
  const isMicroVmTarget = vmName !== null;
  const vmQuery = useQuery({
    queryKey: ['microvm', 'status', vmName],
    enabled: Boolean(host.vm) && isMicroVmTarget,
    queryFn: () => host.vm!.instance(vmName!).status(),
    refetchInterval: 5_000,
  });
  const vmUp = Boolean(vmQuery.data?.running && vmQuery.data?.kubeconfigReady);
  const targetUp = isMicroVmTarget ? vmUp : Boolean(client);
  const targetLoading = selectionLoading || (isMicroVmTarget ? vmQuery.isLoading : false);
  const readyToDeploy = targetUp && Boolean(client);

  // Probe the selected cloud target's base type up front. The desktop
  // builds container images (Kubernetes / local-runtime targets); an
  // AWS/Lambda cloud base deploys an uploaded bundle instead, which the
  // desktop can't build. When the target is such a base we surface a CLI
  // handoff on the TARGET step — before the user picks a folder and
  // configures — rather than letting them reach a run step that can only
  // fail. microVMs are always Kubernetes, so skip the probe for them.
  const baseConfigQuery = useQuery({
    queryKey: ['deploy', 'target-base', selectedCluster?.id],
    enabled: Boolean(client) && !isMicroVmTarget,
    queryFn: async () => {
      const r = await client!.getClusterInfo();
      if (!r.success) throw r.error;
      return r.data.baseConfig;
    },
    retry: false,
  });
  const targetIsAwsBase = !isMicroVmTarget && baseConfigQuery.data ? !isKubernetesBase(baseConfigQuery.data) : false;
  // Devon's probe-race nit: `targetIsAwsBase` reads false until this probe
  // resolves, so a fast Next click could advance a cloud target before we
  // know it's an AWS base. Gate Next on the probe while it's in flight.
  const baseProbeLoading = baseConfigQuery.isLoading;

  // Local VM inventory — same query key TargetStep and the Machine page
  // poll, so the cache is shared. Needed page-wide to decide the one-time
  // auto-skip (the canonical target count folds Dev Machine aliases away)
  // before the target step ever renders.
  const vmListQuery = useQuery({
    queryKey: ['microvm', 'list'],
    enabled: Boolean(host.vm),
    queryFn: () => host.vm!.list(),
    refetchInterval: 6_000,
  });
  const vms = vmListQuery.data ?? [];

  const targetLabel = selectedCluster ? (vmName ? devMachineLabel(vmName) : selectedCluster.name) : null;

  // Q5: the wizard opens on the TARGET step so the first decision is always
  // "where does this deploy?". A user with a ready runtime confirms + clicks
  // Next; a user with none starts one inline without leaving the wizard.
  const [phase, setPhase] = React.useState<Phase>('target');

  // …unless there's nothing to decide: exactly ONE distinct ready target
  // ⇒ start on Pick folder (Back still returns to the target step).
  // "Distinct" counts canonical targets (lib/dev-machine-targets.ts) —
  // an alias of a running VM folds into that VM, and counting it would
  // force a first-run user to choose between two names for the one
  // machine they set up. Decided ONCE, on the first render where the
  // cluster list, the VM inventory, the selection resolution, and the
  // readiness probe have all answered — never re-evaluated, so going
  // Back doesn't bounce the user forward again. Multiple targets, or a
  // single target that isn't ready (a stopped VM needing the inline
  // start), still land on the target step.
  const autoSkipDecided = React.useRef(false);
  React.useEffect(() => {
    if (autoSkipDecided.current) return;
    if (!config || selectionLoading) return;
    if (host.vm && !vmListQuery.data) return;
    if (isMicroVmTarget && vmQuery.isLoading) return;
    autoSkipDecided.current = true;
    const { cloudClusters } = resolveDevMachineTargets(config.clusters, vms);
    // Mirrors TargetStep's runtime list: the canonical VM is always
    // offered (even before it's created), plus any the engine reports.
    const runtimeTargets = host.vm ? new Set([DEFAULT_MICROVM_NAME, ...vms.map((v) => v.name)]).size : 0;
    if (cloudClusters.length + runtimeTargets === 1 && readyToDeploy) {
      setPhase('pick');
    }
  }, [config, host.vm, isMicroVmTarget, readyToDeploy, selectionLoading, vmListQuery.data, vmQuery.isLoading, vms]);

  // Capability preflight: newer api-servers advertise what they can do
  // on GET /api/v1/cluster-info — `capabilities.uploadBuilds: false`
  // means this control plane can't mint upload builds (a Dev Machine
  // guest binary older than this app). Surfaced as a banner + a disabled
  // "Build & deploy" so the failure is explained BEFORE step 3, not as a
  // raw 4xx after packaging. The field is OPTIONAL: an older server
  // omits `capabilities` entirely and nothing is blocked — missing data
  // must never strand a working pre-capabilities server.
  const clusterInfoQuery = useQuery({
    queryKey: ['cluster-info', selectedCluster?.id],
    enabled: Boolean(client) && targetUp,
    queryFn: async () => {
      const r = await client!.getClusterInfo();
      if (!r.success) throw r.error;
      return r.data;
    },
    retry: false,
  });
  // A microVM control plane that doesn't report a version at all is a
  // guest binary older than capability reporting — treat it exactly
  // like "can't upload builds" (a restart updates it). Cloud clusters
  // keep the permissive default: missing data never strands a working
  // pre-capabilities server.
  const microVmPredatesReporting =
    isMicroVmTarget && Boolean(clusterInfoQuery.data) && !clusterInfoQuery.data?.serverVersion;
  const sourceBuildsUnsupported =
    clusterInfoQuery.data?.capabilities?.uploadBuilds === false || microVmPredatesReporting;

  // Step 1 — folder + manifest
  const [folderPath, setFolderPath] = React.useState<string | null>(null);
  const [manifest, setManifest] = React.useState<LocalApplianceManifest | null>(null);
  const [pickError, setPickError] = React.useState<string | null>(null);
  const [pickBusy, setPickBusy] = React.useState(false);

  // Step 2 — config form. Preset target wins over manifest defaults so
  // a "Deploy to foo/bar" click from elsewhere in the app lands on bar
  // even if the picked folder's manifest names a different project.
  const [projectName, setProjectName] = React.useState(presetProject ?? '');
  const [envName, setEnvName] = React.useState(presetEnvironment ?? 'local');
  const [envEntries, setEnvEntries] = React.useState<EnvEntry[]>([]);
  const [memory, setMemory] = React.useState('');
  const [timeout, setTimeoutField] = React.useState('');
  const [storage, setStorage] = React.useState('');

  // Step 3 — run state
  const [runStatus, setRunStatus] = React.useState<RunStatus>('idle');
  const [logs, setLogs] = React.useState<LogLine[]>([]);
  const [runError, setRunError] = React.useState<RunFailure | null>(null);
  const [resultUrl, setResultUrl] = React.useState<string | null>(null);
  const { ref: logBoxRef, onScroll: onLogScroll } = useTailAutoscroll<HTMLPreElement>([logs]);

  // AWS / bundle cloud one-click deploy (W2). An AWS base deploys an
  // uploaded manifest zip, which the desktop can't build itself — so the
  // Target step shells the bundled `appliance deploy` (which builds the zip
  // + uploads it via the SDK's presigned PUT) against the selected cluster's
  // mirrored CLI profile, streaming into this same run/log UI. `cloudDeploy`
  // is set while (and after) an AWS run so Retry re-runs it without
  // re-opening the folder picker; the k8s image path leaves it null.
  const canShellDeploy = Boolean(local?.deployToCloud);
  const [cloudDeploy, setCloudDeploy] = React.useState<{
    path: string;
    project: string;
    environment: string;
  } | null>(null);
  const [cloudPickBusy, setCloudPickBusy] = React.useState(false);
  // Pre-fire confirm state (W2 polish). A cloud deploy ships to real
  // infra — often production — so after the folder is picked we surface a
  // confirm (project + folder + cluster + a chosen environment) rather than
  // firing silently. `cloudPending` holds the picked folder/project until
  // the user confirms; `cloudEnv` is the editable target env (default
  // `production`); `cloudKnownEnvs` are the project's existing envs, fetched
  // best-effort for quick-pick when the project already exists.
  const [cloudPending, setCloudPending] = React.useState<{ path: string; project: string } | null>(null);
  const [cloudEnv, setCloudEnv] = React.useState('production');
  const [cloudKnownEnvs, setCloudKnownEnvs] = React.useState<string[]>([]);

  // ============================================================
  // Step 1 — pick a folder, read its manifest.
  // ============================================================
  const applyPickedManifest = (picked: string, m: LocalApplianceManifest) => {
    setFolderPath(picked);
    setManifest(m);
    // Reasonable defaults for step 2 form. Don't clobber a preset
    // project/env passed via URL — those were chosen explicitly
    // upstream (e.g. from the environment detail page).
    if (!presetProject) setProjectName(m.name);
    const envFromManifest = Object.entries(m.env ?? {}).map(([key, value]) => ({ key, value }));
    // Prefill PORT from manifest so the container's listen port and
    // the Service / NodePort agree. Without this the executor falls
    // back to 8080, which doesn't match e.g. demo-node-container.
    if (m.port && !envFromManifest.some((e) => e.key === 'PORT')) {
      envFromManifest.unshift({ key: 'PORT', value: String(m.port) });
    }
    setEnvEntries(envFromManifest);
  };

  const onPickFolder = async () => {
    if (!local?.pickDirectory) return;
    setPickBusy(true);
    setPickError(null);
    try {
      const picked = await local.pickDirectory();
      if (!picked) return;
      const m = await local.readApplianceManifest(picked);
      applyPickedManifest(picked, m);
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickBusy(false);
    }
  };

  const onPickRecent = async (entry: RecentFolder) => {
    if (!local?.readApplianceManifest) return;
    setPickBusy(true);
    setPickError(null);
    try {
      const m = await local.readApplianceManifest(entry.path);
      applyPickedManifest(entry.path, m);
    } catch (err) {
      // Folder moved / manifest gone — forget the entry so it doesn't
      // keep failing every time. Surface the error so the user knows.
      forgetRecentFolder(entry.path);
      setPickError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickBusy(false);
    }
  };

  // ============================================================
  // Step 3 — package + upload source, deploy, poll.
  // ============================================================
  const runDeploy = async () => {
    if (!folderPath || !manifest || !local?.packageAndUploadBuild) return;
    // Defense in depth behind the banner/disabled button: a silent
    // return here used to leave step 3 stuck on "Starting…" forever.
    if (!client) {
      setRunStatus('failed');
      setRunError({
        message:
          'No deploy target is selected, so there are no credentials to deploy with. Start the Dev Machine (it registers itself automatically), then retry.',
      });
      return;
    }
    if (!targetUp) {
      setRunStatus('failed');
      setRunError({
        message: isMicroVmTarget
          ? 'The Dev Machine is not running. Go back to the Target step to start it (or start it from the Machine page), then retry.'
          : 'The deploy target is not reachable. Go back to the Target step to pick another, then retry.',
      });
      return;
    }
    setRunStatus('running');
    setLogs([]);
    setRunError(null);
    setResultUrl(null);

    const append = (line: LogLine) => setLogs((prev) => [...prev, line]);

    try {
      // 1. Decide packaging for the target: Kubernetes bases (the Dev
      //    Machine, BYO clusters) build a container image from the
      //    uploaded source server-side, so the zip skips the Lambda
      //    zip-runtime prep; cloud/Lambda bases consume the prepped
      //    zip. Mirrors the CLI deploy pipeline's lambdaPrep decision.
      let noLambdaPrep = isMicroVmTarget;
      if (!noLambdaPrep) {
        const info = await client.getClusterInfo();
        noLambdaPrep = info.success && Boolean(info.data.baseConfig.kubernetes);
      }

      // 2. Mint the build record + one-time upload URL, then package +
      //    upload the source through the host bridge (bundled CLI —
      //    same zip a terminal `appliance deploy` ships). The image is
      //    built server-side, next to where it runs.
      append({ stream: 'meta', message: `==> packaging ${manifest.name} and uploading source from ${folderPath}` });
      const build = await client.createBuild();
      if (!build.success) throw new Error(`createBuild: ${build.error.message}`);
      const { buildId, uploadUrl } = build.data;
      if (!uploadUrl) {
        throw new Error('the api-server did not return an upload URL for this build — is its builder configured?');
      }
      await local.packageAndUploadBuild({ path: folderPath, uploadUrl, noLambdaPrep }, (event: LocalLogEvent) =>
        append({ stream: event.stream, message: event.message })
      );

      // 3. SDK path: find-or-create app + environment, dispatch the
      //    deploy with the uploaded build, poll until a terminal
      //    state arrives.
      append({ stream: 'meta', message: `==> registering app "${projectName}" / env "${envName}"` });
      const project = await findOrCreateProject(client, projectName);
      const env = await findOrCreateEnvironment(client, project.id, projectName, envName);

      const envVars: Record<string, string> = {};
      for (const { key, value } of envEntries) {
        if (key.trim()) envVars[key.trim()] = value;
      }

      append({ stream: 'meta', message: `==> dispatching deploy (build ${buildId})` });
      const deploy = await client.deploy(env.id, {
        buildId,
        environment: Object.keys(envVars).length ? envVars : undefined,
        memory: memory ? Number(memory) : undefined,
        timeout: timeout ? Number(timeout) : undefined,
        storage: storage ? Number(storage) : undefined,
      });
      if (!deploy.success) throw new Error(`deploy: ${deploy.error.message}`);

      // Poll for terminal status.
      const finalDeploy = await pollDeploymentUntilDone(client, deploy.data.id, (msg) =>
        append({ stream: 'meta', message: `  ${msg}` })
      );
      append({
        stream: 'meta',
        message: `==> ${finalDeploy.status}${finalDeploy.message ? ': ' + finalDeploy.message : ''}`,
      });

      if (finalDeploy.status === 'failed') {
        throw new Error(finalDeploy.message ?? 'deployment failed');
      }

      const url = extractDeploymentUrl(finalDeploy.message);
      if (url) setResultUrl(url);

      // Folder + project shipped successfully — remember it so the
      // next run of this wizard offers it as a one-click chip.
      recordRecentFolder({ path: folderPath, projectName: manifest.name });

      // Nudge the workloads + deployments queries on the rest of the UI.
      queryClient.invalidateQueries({ queryKey: ['local-runtime'] });
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      queryClient.invalidateQueries({ queryKey: ['environments'] });
      setRunStatus('succeeded');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      append({ stream: 'stderr', message });
      // Structured server failures ({error, detail?, requestId} — e.g.
      // build-create's 409 missing-builder precondition) promote the
      // server's own words to the headline; anything else renders raw
      // exactly as before.
      setRunError({ message, ...(parseStructuredFailure(message) ?? {}) });
      setRunStatus('failed');
    }
  };

  // ============================================================
  // AWS / bundle cloud base — shell the bundled `appliance deploy`.
  // ============================================================
  // The streaming run itself (reused by the Target-step Deploy action and
  // by Retry). Delegates the build+upload entirely to the CLI; we only
  // stream its output and watch for the final deployed URL banner.
  const runCloudDeploy = async (target: { path: string; project: string; environment: string }) => {
    if (!local?.deployToCloud || !selectedCluster) return;
    setRunStatus('running');
    setLogs([]);
    setRunError(null);
    setResultUrl(null);
    const append = (line: LogLine) => setLogs((prev) => [...prev, line]);
    append({
      stream: 'meta',
      message: `==> deploying ${target.project}/${target.environment} to ${selectedCluster.name} via the bundled CLI`,
    });
    let deployedUrl: string | null = null;
    try {
      await local.deployToCloud(
        {
          path: target.path,
          profile: selectedCluster.id,
          project: target.project,
          environment: target.environment,
        },
        (event: LocalLogEvent) => {
          append({ stream: event.stream, message: event.message });
          // The CLI prints a `  URL: <url>` banner on success. Anchor the
          // match to that exact line shape so a `curl …` / "presigned url …"
          // line in the build/upload output can't false-match. Nothing
          // matches → no link, just a "Succeeded" state (fine). (chalk colour
          // is off in the non-TTY sidecar, so the line is plain text.)
          const m = event.message.match(/^\s*URL:\s*(https?:\/\/\S+)/);
          if (m) deployedUrl = m[1];
        }
      );
      if (deployedUrl) setResultUrl(deployedUrl);
      // Shipped — remember the folder so the wizard offers it as a chip next
      // time, and nudge the rest of the UI to refetch.
      recordRecentFolder({ path: target.path, projectName: target.project });
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      queryClient.invalidateQueries({ queryKey: ['environments'] });
      setRunStatus('succeeded');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      append({ stream: 'stderr', message });
      setRunError({ message, ...(parseStructuredFailure(message) ?? {}) });
      setRunStatus('failed');
    }
  };

  // Target-step entry point: pick the project folder, then raise the
  // pre-fire confirm (it does NOT deploy yet). Reading the manifest up front
  // names the project and confirms the folder actually has one before we
  // shell the CLI (which needs it to build the zip). A preset project /
  // environment (deep link) wins over the defaults.
  const pickFolderForCloud = async () => {
    if (!local?.deployToCloud || !local?.pickDirectory || !selectedCluster) return;
    setCloudPickBusy(true);
    setPickError(null);
    try {
      const picked = await local.pickDirectory();
      if (!picked) return;
      const m = await local.readApplianceManifest(picked);
      const project = (presetProject ?? m.name).trim();
      setFolderPath(picked);
      setManifest(m);
      setProjectName(project);
      setCloudEnv((presetEnvironment ?? 'production').trim() || 'production');
      setCloudKnownEnvs([]);
      setCloudPending({ path: picked, project });
      // Best-effort: if the project already exists on the target, offer its
      // known environments as quick-pick chips. A brand-new project has none
      // yet — the editable field still lets the user name one.
      void fetchKnownCloudEnvs(project);
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err));
    } finally {
      setCloudPickBusy(false);
    }
  };

  const fetchKnownCloudEnvs = async (projectName: string) => {
    if (!client) return;
    try {
      const projects = await client.listProjects();
      if (!projects.success) return;
      const proj = projects.data.find((p) => p.name === projectName);
      if (!proj) return; // new project → no known envs yet
      const envs = await client.listEnvironments(proj.id);
      if (envs.success) setCloudKnownEnvs(envs.data.map((e) => e.name));
    } catch {
      // best-effort — a fetch hiccup just means no quick-pick chips.
    }
  };

  // Confirm → fire the deploy with the chosen environment.
  const confirmCloudDeploy = () => {
    if (!cloudPending) return;
    const environment = cloudEnv.trim() || 'production';
    const target = { path: cloudPending.path, project: cloudPending.project, environment };
    setEnvName(environment);
    setCloudDeploy(target);
    setCloudPending(null);
    setPhase('run');
    void runCloudDeploy(target);
  };

  const cancelCloudDeploy = () => {
    setCloudPending(null);
    setCloudKnownEnvs([]);
  };

  // ============================================================
  // Render
  // ============================================================
  if (!local?.packageAndUploadBuild) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-xl font-semibold">Deploy an app</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          The visual deploy wizard is only available in the desktop app. From a terminal, run this in your app folder —
          it uploads the source and builds on the server:
        </p>
        <CommandSnippet command="appliance deploy" />
      </div>
    );
  }

  const canAdvanceToConfigure = manifest !== null;
  const canRun = projectName.trim().length > 0 && envName.trim().length > 0;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/projects">
            <ChevronLeft className="h-4 w-4" /> Apps
          </Link>
        </Button>
      </div>

      <header>
        <h1 className="text-xl font-semibold">Deploy an app</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Pick a folder with an <code>appliance.json</code>, <code>.ts</code>, or <code>.js</code> manifest, configure
          overrides, then upload the source — it builds and deploys on the selected target.
        </p>
        {selectedCluster ? (
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]">
            Target:
            <span className="inline-flex items-center rounded-md border border-[var(--color-border)] px-1.5 py-0.5 font-medium text-[var(--color-foreground)]">
              {targetLabel}
            </span>
            <span>· switch with the target menu in the top bar</span>
          </p>
        ) : null}
      </header>

      {/* Once past the target step, if the runtime fell out of ready (e.g. it
          was stopped mid-flow), nudge back to the target step where it can be
          restarted inline — never a dead link off to another page (Q5). */}
      {phase !== 'target' && !readyToDeploy && !targetLoading ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            The {isMicroVmTarget ? 'Dev Machine' : 'deploy target'} isn&apos;t serving — builds deploy into it, so the
            final step needs it up.{' '}
            <button type="button" className="underline" onClick={() => setPhase('target')}>
              Back to choose / start a target
            </button>
            . You can still pick a folder and configure in the meantime.
          </span>
        </div>
      ) : null}

      {/* Capability preflight — the selected control plane said it can't
          accept source-build uploads. Rendered only where it bites (the
          configure/run steps); older servers that don't report
          capabilities are assumed capable and never see this. The
          remediation depends on the target: a Dev Machine's guest binary
          genuinely updates on restart (banner + hard-disable below), but
          a BYO kubernetes cluster just has no builder configured — that's
          an info state with a remote-image alternative, and the button
          stays enabled (the server's 409 carries the same remediation as
          the backstop). */}
      {(phase === 'configure' || phase === 'run') && sourceBuildsUnsupported ? (
        isMicroVmTarget ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              The Dev Machine&apos;s control plane doesn&apos;t support source builds — it&apos;s likely older than this
              app. Restart the Dev Machine from the{' '}
              <Link to="/machine" className="underline">
                Machine page
              </Link>{' '}
              to update it, then retry here.
            </span>
          </div>
        ) : (
          <div className="space-y-2 rounded-md border border-cyan-500/40 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-200">
            <p>
              No build system is configured on this target, so it can&apos;t build the uploaded source into an image.
              You can deploy a prebuilt image from a terminal instead:
            </p>
            <CommandSnippet command="appliance deploy --image-uri <registry>/<image>:<tag>" />
          </div>
        )
      ) : null}

      {presetProject || presetEnvironment ? (
        <div className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">
          Deploying to{' '}
          <code className="font-mono">
            {presetProject ?? projectName}
            {presetEnvironment ? ` / ${presetEnvironment}` : ''}
          </code>
          .
        </div>
      ) : null}

      <Stepper phase={phase} />

      {phase === 'target' ? (
        <TargetStep
          selectedCluster={selectedCluster}
          vmName={vmName}
          readyToDeploy={readyToDeploy}
          targetLoading={targetLoading}
          targetIsAwsBase={targetIsAwsBase}
          baseProbeLoading={baseProbeLoading}
          aws={{
            canShell: canShellDeploy,
            busy: cloudPickBusy,
            pending: cloudPending,
            env: cloudEnv,
            setEnv: setCloudEnv,
            knownEnvs: cloudKnownEnvs,
            onPickFolder: () => void pickFolderForCloud(),
            onConfirm: confirmCloudDeploy,
            onCancel: cancelCloudDeploy,
          }}
          onNext={() => setPhase('pick')}
        />
      ) : null}

      {phase === 'pick' ? (
        <PickStep
          folderPath={folderPath}
          manifest={manifest}
          onPick={onPickFolder}
          pickBusy={pickBusy}
          pickError={pickError}
          onNext={() => setPhase('configure')}
          canNext={canAdvanceToConfigure}
          recent={recentFolders}
          onPickRecent={onPickRecent}
          onForgetRecent={forgetRecentFolder}
        />
      ) : null}

      {phase === 'configure' ? (
        <ConfigureStep
          manifest={manifest!}
          isCloudTarget={!isMicroVmTarget}
          projectName={projectName}
          setProjectName={setProjectName}
          envName={envName}
          setEnvName={setEnvName}
          envEntries={envEntries}
          setEnvEntries={setEnvEntries}
          memory={memory}
          setMemory={setMemory}
          timeout={timeout}
          setTimeout={setTimeoutField}
          storage={storage}
          setStorage={setStorage}
          onBack={() => setPhase('pick')}
          onNext={() => {
            setPhase('run');
            void runDeploy();
          }}
          // Hard-block the AWS one-click path (it deploys from the Target
          // step) and the Dev Machine when a restart genuinely fixes it;
          // a builder-less BYO target keeps the button — see the banner.
          canNext={canRun && readyToDeploy && !targetIsAwsBase && !(isMicroVmTarget && sourceBuildsUnsupported)}
        />
      ) : null}

      {phase === 'run' ? (
        <RunStep
          runStatus={runStatus}
          logs={logs}
          logBoxRef={logBoxRef}
          onLogScroll={onLogScroll}
          error={runError}
          resultUrl={resultUrl}
          onRetry={cloudDeploy ? () => void runCloudDeploy(cloudDeploy) : runDeploy}
          onDone={() => navigate('/projects')}
        />
      ) : null}
    </div>
  );
}

// ----- step UIs ------------------------------------------------------

// Q5 — TARGET step. Choose where this app deploys (a cloud installation or
// the Dev Machine), and when the chosen machine isn't serving yet, START IT
// INLINE instead of bouncing the operator to the Machine page. Selecting a
// target makes it the active one (the SDK client binds to the selection),
// so by the time the wizard reaches "Build & deploy" the credentials +
// registry are the target's. The page captures `?project=&environment=` on
// mount, so the intent survives the bring-up here.
// Controls for the AWS/bundle-base one-click deploy affordance. Grouped so
// TargetStep's own signature stays about "choose a target", with the deploy
// flow (folder pick → env pick + confirm → fire) threaded as one object.
interface AwsDeployControls {
  /** Host can shell the bundled CLI (desktop). False → web/no-CLI fallback. */
  canShell: boolean;
  /** A folder pick is in flight. */
  busy: boolean;
  /** Picked folder + resolved project, awaiting the pre-fire confirm. */
  pending: { path: string; project: string } | null;
  /** The chosen (editable) target environment. */
  env: string;
  setEnv: (v: string) => void;
  /** The project's existing environments, for quick-pick (may be empty). */
  knownEnvs: string[];
  /** Open the folder picker, then raise the confirm. */
  onPickFolder: () => void;
  /** Fire the deploy with the chosen env. */
  onConfirm: () => void;
  /** Dismiss the confirm without deploying. */
  onCancel: () => void;
}

function TargetStep({
  selectedCluster,
  vmName,
  readyToDeploy,
  targetLoading,
  targetIsAwsBase,
  baseProbeLoading,
  aws,
  onNext,
}: {
  selectedCluster: Cluster | null;
  vmName: string | null;
  readyToDeploy: boolean;
  targetLoading: boolean;
  targetIsAwsBase: boolean;
  baseProbeLoading: boolean;
  aws: AwsDeployControls;
  onNext: () => void;
}) {
  const host = useHost();
  const queryClient = useQueryClient();
  const showRuntimes = Boolean(host.vm);
  const { config } = useSelectedCluster();
  // Core-only VMs have no profile to select yet. Preserve the clicked VM
  // locally until clusterUp writes and the desktop adopts that profile.
  const [pendingVmName, setPendingVmName] = React.useState<string | null>(null);

  const vmListQuery = useQuery({
    queryKey: ['microvm', 'list'],
    enabled: showRuntimes,
    queryFn: () => host.vm!.list(),
    refetchInterval: 6_000,
  });
  const vms = vmListQuery.data ?? [];

  // Canonical dedupe (see lib/dev-machine-targets.ts): a CLI profile
  // whose URL points at a running local VM's forwarded api-server port
  // IS that VM — one machine must not read as two targets, the duplicate
  // mislabeled "cloud". The alias folds out of the cloud list into the
  // VM's row; and because useSelectedCluster REBINDS an alias selection
  // to the `microvm*` twin, `selectedCluster.id` is always the canonical
  // id — the VM row's selected state needs no alias special case.
  const selectedLabel = selectedCluster ? (vmName ? devMachineLabel(vmName) : selectedCluster.name) : null;
  const effectiveSelectedLabel = pendingVmName ? devMachineLabel(pendingVmName) : selectedLabel;
  const effectiveReadyToDeploy = readyToDeploy && !pendingVmName;
  const effectiveTargetIsAwsBase = targetIsAwsBase && !pendingVmName;
  const effectiveBaseProbeLoading = baseProbeLoading && !pendingVmName;
  const { cloudClusters } = resolveDevMachineTargets(config?.clusters ?? [], vms);
  const runtimeNames = React.useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const n of ['appliance', ...vms.map((v) => v.name)]) {
      if (!seen.has(n)) {
        seen.add(n);
        ordered.push(n);
      }
    }
    return ordered;
  }, [vms]);

  const selectTarget = async (id: string) => {
    if (selectedCluster?.id === id) return;
    setPendingVmName(microVmNameFromClusterId(id));
    try {
      await host.selectCluster(id);
      setPendingVmName(null);
    } catch {
      // A never-started microVM has no registered cluster to select yet —
      // the inline Start below registers it, then selects it.
    }
    queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
  };

  // Inline prepare (Q5). Boot a stopped VM, lazily promote a core-only VM,
  // then select the newly adopted profile for the SDK-backed deploy flow.
  const startTargetName = vmName ?? pendingVmName ?? (!selectedCluster && showRuntimes ? 'appliance' : null);
  const needsStart = !effectiveReadyToDeploy && Boolean(startTargetName);
  const [starting, setStarting] = React.useState(false);
  const [startLog, setStartLog] = React.useState<string[]>([]);
  const [startError, setStartError] = React.useState<string | null>(null);

  const startRuntime = async () => {
    if (!host.vm || !startTargetName) return;
    setStarting(true);
    setStartError(null);
    setStartLog([]);
    const append = (m: string) => setStartLog((p) => [...p.slice(-120), m]);
    try {
      const vm = host.vm.instance(startTargetName);
      let st = await vm.status();
      if (!st.available && st.installable) {
        append('Installing engine…');
        await host.vm.install();
        st = await vm.status();
      }
      if (!st.running) {
        await vm.up((e) => append(e.message));
      }
      if (!st.clusterProvisioned) {
        append('Provisioning deployment layer…');
        await vm.clusterUp((e) => append(e.message));
      }
      // clusterUp synchronously adopts the profile. Do not let the wizard
      // proceed against an unbound SDK client if selection fails.
      await host.selectCluster(microVmClusterId(startTargetName));
      setPendingVmName(null);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
      queryClient.invalidateQueries({ queryKey: ['microvm'] });
      queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
    }
  };

  return (
    <section className="space-y-4 rounded-md border border-[var(--color-border)] p-4">
      <div>
        <h2 className="text-sm font-semibold">Choose a deploy target</h2>
        <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
          Builds deploy into the selected target. Pick where this app should run — you can also switch from the target
          menu in the top bar.
        </p>
      </div>

      <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
        {cloudClusters.map((c) => (
          <TargetRow
            key={c.id}
            name={c.name}
            sub={c.apiServerUrl}
            kind="cloud"
            selected={selectedCluster?.id === c.id}
            stateLabel="ready"
            onSelect={() => void selectTarget(c.id)}
          />
        ))}
        {showRuntimes
          ? runtimeNames.map((name) => {
              const id = microVmClusterId(name);
              const summary = vms.find((v) => v.name === name);
              const state = !summary
                ? 'not created'
                : summary.running
                  ? !summary.clusterProvisioned
                    ? 'core ready'
                    : summary.clusterReady
                      ? 'running'
                      : summary.phase === 'failed'
                        ? 'failed'
                        : 'starting…'
                  : 'stopped';
              return (
                <TargetRow
                  key={id}
                  name={name}
                  sub={id}
                  kind="dev machine"
                  selected={selectedCluster?.id === id || pendingVmName === name}
                  stateLabel={state}
                  onSelect={() => void selectTarget(id)}
                />
              );
            })
          : null}
      </ul>

      {/* Selected target isn't serving — start it here, don't dead-end. */}
      {needsStart ? (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="text-xs text-amber-200">
            {targetLoading
              ? 'Checking the Dev Machine…'
              : `The Dev Machine (${startTargetName}) needs its deployment layer ready before deploy. It will boot first if needed, then provision and adopt the cluster profile. Your app / environment selection is kept.`}
          </p>
          <Button size="sm" onClick={() => void startRuntime()} disabled={starting || targetLoading}>
            <Play className={cn('h-3.5 w-3.5', starting && 'animate-pulse')} />
            {starting ? 'Preparing deployment layer…' : 'Prepare Dev Machine for deploy'}
          </Button>
          {startError ? (
            <FriendlyError error={startError} fallbackHeadline="The local machine couldn't start" className="text-xs" />
          ) : null}
          {starting || startLog.length > 0 ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[10px] leading-relaxed">
              {startLog.join('\n') || 'Starting…'}
            </pre>
          ) : null}
        </div>
      ) : null}

      {/* Selected target deploys an uploaded bundle, not a container image
          (an AWS/Lambda cloud base). The desktop can't build that bundle
          itself — but the bundled `appliance` CLI can. When we can shell it,
          this is a real one-click "Deploy": it runs `appliance deploy`
          against the selected cloud's mirrored profile and streams the
          output into the run step. On a host that can't shell (web), fall
          back to the copyable snippet so the user can run it themselves. */}
      {effectiveTargetIsAwsBase ? (
        <div className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/30 p-3">
          {!aws.canShell ? (
            // Web / no-CLI host: explain + hand off the copyable snippet.
            <>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                <span className="font-medium text-[var(--color-foreground)]">{selectedCluster?.name}</span> runs on an
                AWS base, which deploys an uploaded bundle rather than a container image. The desktop builds container
                images (for Kubernetes / local-runtime targets), so deploy to this cloud with the CLI — it builds and
                uploads the bundle for you. Run this from your app folder:
              </p>
              <CommandSnippet command="appliance deploy" />
            </>
          ) : aws.pending ? (
            // Pre-fire confirm: a cloud deploy ships to real infra, so review
            // project + folder + cluster and pick the target environment
            // before it fires. Non-prod is first-class here, not CLI-only.
            <div className="space-y-3">
              <p className="text-xs font-medium text-[var(--color-foreground)]">Review this deploy</p>
              <dl className="grid grid-cols-[5.5rem_1fr] gap-y-1 rounded-md border border-[var(--color-border)] p-2.5 text-sm">
                <Row label="Project" value={<code className="font-mono text-xs">{aws.pending.project}</code>} />
                <Row
                  label="Folder"
                  value={<code className="block truncate font-mono text-xs">{aws.pending.path}</code>}
                />
                <Row
                  label="Cluster"
                  value={<span className="text-xs">{selectedCluster?.name ?? 'selected cloud'}</span>}
                />
              </dl>
              <label className="block space-y-1">
                <span className="block text-xs font-medium">Environment</span>
                <input
                  type="text"
                  value={aws.env}
                  list="aws-known-envs"
                  onChange={(e) => aws.setEnv(e.target.value)}
                  placeholder="production"
                  className="w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-xs"
                />
                {aws.knownEnvs.length > 0 ? (
                  <datalist id="aws-known-envs">
                    {aws.knownEnvs.map((e) => (
                      <option key={e} value={e} />
                    ))}
                  </datalist>
                ) : null}
                <span className="block text-[10px] text-[var(--color-muted-foreground)]">
                  Created if it doesn&rsquo;t exist. Deploys to{' '}
                  <code className="font-mono">
                    {aws.pending.project}/{aws.env.trim() || 'production'}
                  </code>
                  .
                </span>
              </label>
              {aws.knownEnvs.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {aws.knownEnvs.map((e) => (
                    <button
                      key={e}
                      type="button"
                      aria-pressed={aws.env.trim() === e}
                      onClick={() => aws.setEnv(e)}
                      className={cn(
                        'rounded-md border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[11px]',
                        aws.env.trim() === e
                          ? 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)]'
                          : 'hover:text-[var(--color-accent)]'
                      )}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                {/* Empty env resolves to `production` (label above +
                    confirmCloudDeploy both default it), so keep the button
                    enabled — no "says production, refuses" contradiction. */}
                <Button size="sm" onClick={aws.onConfirm}>
                  <Rocket className="h-3.5 w-3.5" />
                  Deploy to {selectedCluster?.name ?? 'cloud'} / {aws.env.trim() || 'production'}
                </Button>
                <Button size="sm" variant="outline" onClick={aws.onCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            // Initial: one click opens the folder picker, then the confirm.
            <>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                <span className="font-medium text-[var(--color-foreground)]">{selectedCluster?.name}</span> runs on an
                AWS base, which deploys an uploaded bundle rather than a container image. Pick your app folder — the
                bundled CLI builds and uploads the bundle for you.
              </p>
              <Button size="sm" onClick={aws.onPickFolder} disabled={aws.busy || baseProbeLoading}>
                <Rocket className={cn('h-3.5 w-3.5', aws.busy && 'animate-pulse')} />
                {aws.busy ? 'Opening folder…' : `Deploy to ${selectedCluster?.name ?? 'cloud'}`}
              </Button>
              <p className="text-[10px] text-[var(--color-muted-foreground)]">
                Prefer the terminal? Run <code className="font-mono">appliance deploy</code> from your app folder.
              </p>
            </>
          )}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--color-muted-foreground)]">
          {!effectiveSelectedLabel ? (
            'No deploy target selected yet.'
          ) : effectiveBaseProbeLoading ? (
            <>
              Checking how <span className="font-medium text-[var(--color-foreground)]">{effectiveSelectedLabel}</span>{' '}
              deploys…
            </>
          ) : effectiveTargetIsAwsBase ? (
            <>
              Target <span className="font-medium text-[var(--color-foreground)]">{effectiveSelectedLabel}</span>{' '}
              deploys {aws.canShell ? 'with the button above' : 'via the CLI (see above)'}.
            </>
          ) : effectiveReadyToDeploy ? (
            <>
              Target <span className="font-medium text-[var(--color-foreground)]">{effectiveSelectedLabel}</span> is
              ready.
            </>
          ) : (
            <>
              Selected <span className="font-medium text-[var(--color-foreground)]">{effectiveSelectedLabel}</span>.
            </>
          )}
        </p>
        <Button
          onClick={onNext}
          disabled={!effectiveReadyToDeploy || effectiveTargetIsAwsBase || effectiveBaseProbeLoading}
        >
          Next: pick folder <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </section>
  );
}

function TargetRow({
  name,
  sub,
  kind,
  selected,
  stateLabel,
  onSelect,
}: {
  name: string;
  sub: string;
  kind: 'cloud' | 'dev machine';
  selected: boolean;
  stateLabel: string;
  onSelect: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <div className="w-4 shrink-0">{selected ? <Check className="h-4 w-4 text-[var(--color-accent)]" /> : null}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('truncate text-sm font-medium', kind === 'dev machine' && 'font-mono')}>{name}</span>
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
              kind === 'dev machine'
                ? 'bg-cyan-500/15 text-cyan-300'
                : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]'
            )}
          >
            {kind === 'dev machine' ? 'Dev Machine' : 'cloud'}
          </span>
        </div>
        <div className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">{sub}</div>
      </div>
      <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">{stateLabel}</span>
      {!selected ? (
        <Button variant="outline" size="sm" onClick={onSelect}>
          Select
        </Button>
      ) : null}
    </li>
  );
}

function Stepper({ phase }: { phase: Phase }) {
  const steps: Array<{ id: Phase; label: string }> = [
    { id: 'target', label: '1. Target' },
    { id: 'pick', label: '2. Pick folder' },
    { id: 'configure', label: '3. Configure' },
    { id: 'run', label: '4. Build & deploy' },
  ];
  const activeIdx = steps.findIndex((s) => s.id === phase);
  return (
    <ol className="flex items-center gap-2 text-xs">
      {steps.map((s, i) => {
        const state = i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'upcoming';
        return (
          <React.Fragment key={s.id}>
            <li
              className={cn(
                'rounded-md px-2 py-1',
                state === 'active' && 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)] font-medium',
                state === 'done' && 'text-green-300',
                state === 'upcoming' && 'text-[var(--color-muted-foreground)]'
              )}
            >
              {s.label}
            </li>
            {i < steps.length - 1 ? <ChevronRight className="h-3 w-3 text-[var(--color-muted-foreground)]" /> : null}
          </React.Fragment>
        );
      })}
    </ol>
  );
}

function PickStep({
  folderPath,
  manifest,
  onPick,
  pickBusy,
  pickError,
  onNext,
  canNext,
  recent,
  onPickRecent,
  onForgetRecent,
}: {
  folderPath: string | null;
  manifest: LocalApplianceManifest | null;
  onPick: () => void;
  pickBusy: boolean;
  pickError: string | null;
  onNext: () => void;
  canNext: boolean;
  recent: RecentFolder[];
  onPickRecent: (entry: RecentFolder) => void;
  onForgetRecent: (path: string) => void;
}) {
  return (
    <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
      <h2 className="text-sm font-semibold">Source folder</h2>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        The folder must contain an <code>appliance.json</code>, <code>appliance.ts</code>, or <code>appliance.js</code>{' '}
        manifest (container apps also ship their <code>Dockerfile</code>; framework apps need none — the server
        generates one). Programmatic manifests run inside a QuickJS sandbox — no host filesystem, process, or network
        access; only <code>@appliance.sh/sdk</code> imports resolve.
      </p>
      <div className="flex items-center gap-2">
        <Button onClick={onPick} disabled={pickBusy}>
          <FolderOpen className="h-4 w-4" />{' '}
          {pickBusy ? 'Reading…' : folderPath ? 'Pick a different folder' : 'Pick folder'}
        </Button>
        {folderPath ? <code className="truncate font-mono text-xs">{folderPath}</code> : null}
      </div>

      {recent.length > 0 && !folderPath ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--color-muted-foreground)]">
            <History className="h-3 w-3" /> Recent
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {recent.map((entry) => (
              <li key={entry.path}>
                <span className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/30 pl-2 pr-0.5 py-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => onPickRecent(entry)}
                    disabled={pickBusy}
                    className="font-mono text-[11px] hover:text-[var(--color-accent)] disabled:opacity-50"
                    title={entry.path}
                  >
                    {entry.projectName ?? basename(entry.path)}
                  </button>
                  <button
                    type="button"
                    aria-label={`Forget ${entry.path}`}
                    onClick={() => onForgetRecent(entry.path)}
                    className="rounded p-0.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pickError ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">{pickError}</div>
      ) : null}

      {/* Multi-service stacks (appliance.stack.json): the manifest reader
          rejects them — the wizard deploys ONE app. Point at the CLI's
          stack-aware flow instead of leaving a bare parse error. */}
      {pickError && /stack/i.test(pickError) ? (
        <div className="space-y-2 rounded-md border border-cyan-500/40 bg-cyan-500/5 p-3 text-xs text-cyan-200">
          <p>
            This folder looks like a multi-service stack. The wizard deploys a single app — for stacks, run this from a
            terminal in that folder instead:
          </p>
          <CommandSnippet command="appliance dev" />
        </div>
      ) : null}

      {manifest ? (
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1 rounded-md border border-[var(--color-border)] p-3 text-sm">
          <Row label="Name" value={<code className="font-mono text-xs">{manifest.name}</code>} />
          <Row label="Type" value={<code className="font-mono text-xs">{manifest.type ?? '—'}</code>} />
          <Row label="Port" value={<code className="font-mono text-xs">{manifest.port ?? '—'}</code>} />
          <Row label="Platform" value={<code className="font-mono text-xs">{manifest.platform ?? 'host'}</code>} />
          <Row label="Manifest" value={<code className="truncate font-mono text-xs">{manifest.manifestPath}</code>} />
        </dl>
      ) : null}

      <div className="flex justify-end">
        <Button onClick={onNext} disabled={!canNext}>
          Next: configure <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </section>
  );
}

function ConfigureStep({
  manifest,
  isCloudTarget,
  projectName,
  setProjectName,
  envName,
  setEnvName,
  envEntries,
  setEnvEntries,
  memory,
  setMemory,
  timeout,
  setTimeout,
  storage,
  setStorage,
  onBack,
  onNext,
  canNext,
}: {
  manifest: LocalApplianceManifest;
  /** The memory/timeout/storage overrides only do anything on cloud
   *  installations — hide them entirely for a local (Dev Machine) target. */
  isCloudTarget: boolean;
  projectName: string;
  setProjectName: (v: string) => void;
  envName: string;
  setEnvName: (v: string) => void;
  envEntries: EnvEntry[];
  setEnvEntries: React.Dispatch<React.SetStateAction<EnvEntry[]>>;
  memory: string;
  setMemory: (v: string) => void;
  timeout: string;
  setTimeout: (v: string) => void;
  storage: string;
  setStorage: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
  canNext: boolean;
}) {
  const addEnv = () => setEnvEntries((prev) => [...prev, { key: '', value: '' }]);
  const removeEnv = (idx: number) => setEnvEntries((prev) => prev.filter((_, i) => i !== idx));
  const setEnv = (idx: number, patch: Partial<EnvEntry>) =>
    setEnvEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));

  return (
    <section className="space-y-5 rounded-md border border-[var(--color-border)] p-4">
      <h2 className="text-sm font-semibold">Configure deploy</h2>

      <div className="grid grid-cols-2 gap-3">
        <Field label="App name" hint={`Default from manifest: ${manifest.name}`}>
          <TextInput value={projectName} onChange={setProjectName} placeholder={manifest.name} />
        </Field>
        <Field label="Environment name" hint="Created if absent.">
          <TextInput value={envName} onChange={setEnvName} placeholder="local" />
        </Field>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h3 className="text-xs font-medium">Environment variables</h3>
            <p className="text-[10px] text-[var(--color-muted-foreground)]">
              Forwarded as container env. <code>PORT</code> also drives the Service&rsquo;s port + NodePort target.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={addEnv}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
        {envEntries.length === 0 ? (
          <p className="rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-foreground)]">
            No env vars. Manifest didn&rsquo;t declare any.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {envEntries.map((entry, idx) => (
              <li key={idx} className="grid grid-cols-[1fr_2fr_auto] items-center gap-2">
                <TextInput value={entry.key} onChange={(v) => setEnv(idx, { key: v })} placeholder="KEY" mono />
                <TextInput value={entry.value} onChange={(v) => setEnv(idx, { value: v })} placeholder="value" mono />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${entry.key || 'env var'}`}
                  onClick={() => removeEnv(idx)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Cloud-only knobs — hidden entirely for a local (Dev Machine)
          target, where they'd be recorded but have no effect. */}
      {isCloudTarget ? (
        <details className="rounded-md border border-[var(--color-border)] p-3">
          <summary className="cursor-pointer text-xs font-medium">Cloud options (optional)</summary>
          <p className="mt-1 text-[10px] text-[var(--color-muted-foreground)]">
            Runtime limits applied by the cloud installation this app deploys into.
          </p>
          <div className="mt-2 grid grid-cols-3 gap-3">
            <Field label="Memory (MB)">
              <TextInput value={memory} onChange={setMemory} placeholder="1024" mono />
            </Field>
            <Field label="Timeout (s)">
              <TextInput value={timeout} onChange={setTimeout} placeholder="30" mono />
            </Field>
            <Field label="Storage (MB)">
              <TextInput value={storage} onChange={setStorage} placeholder="512" mono />
            </Field>
          </div>
        </details>
      ) : null}

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" /> Back
        </Button>
        <Button onClick={onNext} disabled={!canNext}>
          <Rocket className="h-4 w-4" /> Build & deploy
        </Button>
      </div>
    </section>
  );
}

function RunStep({
  runStatus,
  logs,
  logBoxRef,
  onLogScroll,
  error,
  resultUrl,
  onRetry,
  onDone,
}: {
  runStatus: RunStatus;
  logs: LogLine[];
  logBoxRef: React.RefObject<HTMLPreElement | null>;
  onLogScroll: (event: React.UIEvent<HTMLPreElement>) => void;
  error: RunFailure | null;
  resultUrl: string | null;
  onRetry: () => void;
  onDone: () => void;
}) {
  return (
    <section className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Build & deploy</h2>
        <StatusBadge status={runStatus} />
      </div>

      <pre
        ref={logBoxRef}
        onScroll={onLogScroll}
        className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--color-border)] bg-black/40 p-3 font-mono text-[11px] leading-relaxed"
      >
        {logs.length === 0 ? (
          <span className="text-[var(--color-muted-foreground)]">Starting…</span>
        ) : (
          logs.map((line, i) => (
            <div
              key={i}
              className={cn(line.stream === 'stderr' && 'text-red-300', line.stream === 'meta' && 'text-cyan-300')}
            >
              {line.message}
            </div>
          ))
        )}
      </pre>

      {/* Structured failures put the server's own error (+ detail) up
          front as the headline — the raw message stays in the log pane
          and the Details disclosure — with the requestId alongside so a
          user can correlate the failure with the server logs. */}
      {error ? (
        <div className="space-y-1">
          <FriendlyError
            error={error.message}
            headline={error.serverError}
            fallbackHeadline="The deploy didn't finish"
          />
          {error.requestId ? (
            <p className="text-[10px] text-[var(--color-muted-foreground)]">
              request id <code className="font-mono">{error.requestId}</code> — quote it to find this failure in the
              server logs
            </p>
          ) : null}
        </div>
      ) : null}

      {resultUrl ? (
        <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-xs text-green-300">
          Deployed at{' '}
          <a className="underline" href={resultUrl} target="_blank" rel="noreferrer">
            {resultUrl}
          </a>
        </div>
      ) : null}

      <div className="flex justify-between">
        {runStatus === 'failed' ? (
          <Button variant="outline" onClick={onRetry}>
            Retry
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={onDone} disabled={runStatus === 'running'}>
          {runStatus === 'succeeded' ? 'Done' : 'Close'}
        </Button>
      </div>
    </section>
  );
}

// ----- small UI primitives -------------------------------------------

interface LogLine {
  stream: 'stdout' | 'stderr' | 'meta';
  message: string;
}

/** A failed run, split for rendering: the raw `message` keeps feeding
 *  the log pane + the Details disclosure, while a STRUCTURED server body
 *  (`{error, detail?, requestId}` — build-create's 409 missing-builder
 *  precondition and its 500s) promotes the server's human-readable
 *  `error` to the headline and carries the requestId for correlating
 *  with the server logs. */
interface RunFailure {
  message: string;
  serverError?: string;
  requestId?: string;
}

/** Split a structured server failure (lib/http-error's shared parser)
 *  for this page's rendering: promote the server's human `error` (plus
 *  `detail`) to the headline, keep the requestId for correlating with
 *  server logs. Unparseable shapes return null → raw rendering. */
function parseStructuredFailure(message: string): { serverError: string; requestId?: string } | null {
  const parsed = parseStructuredHttpError(message);
  if (!parsed) return null;
  return {
    serverError: parsed.detail ? `${parsed.error} — ${parsed.detail}` : parsed.error,
    requestId: parsed.requestId,
  };
}

function StatusBadge({ status }: { status: RunStatus }) {
  const meta: Record<RunStatus, { label: string; tone: string }> = {
    idle: { label: 'Idle', tone: 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]' },
    running: { label: 'Running', tone: 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40' },
    succeeded: { label: 'Succeeded', tone: 'bg-green-500/15 text-green-300 border border-green-500/40' },
    failed: { label: 'Failed', tone: 'bg-red-500/15 text-red-300 border border-red-500/40' },
  };
  const m = meta[status];
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-1 text-xs font-medium', m.tone)}>{m.label}</span>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-[10px] text-[var(--color-muted-foreground)]">{hint}</span> : null}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        'w-full rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm',
        mono && 'font-mono text-xs'
      )}
    />
  );
}

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// ----- SDK helpers (small replicas of CLI deploy) --------------------

type Client = NonNullable<ReturnType<typeof useApplianceClient>>;

async function findOrCreateProject(client: Client, name: string) {
  const list = await client.listProjects();
  if (!list.success) throw new Error(`listProjects: ${list.error.message}`);
  const existing = list.data.find((p) => p.name === name);
  if (existing) return existing;
  const created = await client.createProject({ name });
  if (!created.success) throw new Error(`createProject: ${created.error.message}`);
  return created.data;
}

async function findOrCreateEnvironment(client: Client, projectId: string, projectName: string, envName: string) {
  const expectedStack = `${projectName}-${envName}`;
  const list = await client.listEnvironments(projectId);
  if (!list.success) throw new Error(`listEnvironments: ${list.error.message}`);
  const existing = list.data.find((e) => e.name === envName);
  if (existing && existing.stackName === expectedStack) return existing;
  if (existing) {
    // Stale stack name — drop and recreate so the executor's resources
    // line up with the new environment id. Mirrors what the CLI does.
    await client.deleteEnvironment(projectId, existing.id);
  }
  const created = await client.createEnvironment({ name: envName, projectId });
  if (!created.success) throw new Error(`createEnvironment: ${created.error.message}`);
  return created.data;
}

const POLL_INTERVAL_MS = 2000;

async function pollDeploymentUntilDone(client: Client, deploymentId: string, onProgress: (msg: string) => void) {
  // Poll until the deployment lands in a terminal state. Cap at 5 min
  // to avoid hanging forever on a stuck deploy — the user can always
  // re-run.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const r = await client.getDeployment(deploymentId);
    if (!r.success) throw new Error(`getDeployment: ${r.error.message}`);
    onProgress(`status: ${r.data.status}${r.data.message ? ' — ' + r.data.message : ''}`);
    if (r.data.status === 'succeeded' || r.data.status === 'failed') {
      return r.data;
    }
  }
  throw new Error('deployment polling timed out after 5 minutes');
}
