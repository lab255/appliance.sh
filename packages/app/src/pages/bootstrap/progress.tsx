import * as React from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApplianceBaseType } from '@appliance.sh/sdk/models';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/ui/banner';
import { KeyValueList } from '@/components/ui/key-value-list';
import { LongOperation } from '@/components/ui/long-operation';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { SectionCard } from '@/components/ui/section-card';
import { useHost } from '@/providers/host-provider';
import type {
  BootstrapEvent,
  BootstrapInput,
  BootstrapPhase,
  BootstrapPriorOutputs,
  BootstrapResult,
  MicroVmPhase,
} from '@/lib/host';
import type { AwsWizardValues, MicroVmWizardValues, WizardValues } from './wizard';
import { microVmClusterId } from '@/lib/host';
import { cn } from '@/lib/utils';
import { durationEstimates } from '@/lib/duration-estimates';
import { useTerminalSessions } from '@/providers/terminal-sessions-provider';

type PhaseState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

const PHASE_ORDER: BootstrapPhase[] = ['phase1', 'phase2', 'phase3'];

interface LogLine {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

type HandoffState = 'idle' | 'saving' | 'saved' | 'failed' | 'skipped';

const LEGACY_BOOTSTRAP_DEPRECATION =
  'deprecated: legacy 3-phase bootstrap; new installs use appliance cloud install (CloudFormation). Supported for 2 releases.';
const CLASSIC_INSTALLER_MESSAGE =
  'Using the classic Pulumi installer (a CloudFormation-based install is available via `appliance cloud install`).';

function useBatchedLogAnnouncement(lineCount: number): string {
  const [announcement, setAnnouncement] = React.useState('');
  const announced = React.useRef(0);
  const latest = React.useRef(lineCount);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = lineCount;
  React.useEffect(() => {
    if (lineCount <= announced.current || timer.current) return;
    timer.current = setTimeout(() => {
      const added = latest.current - announced.current;
      announced.current = latest.current;
      timer.current = null;
      setAnnouncement(`${added} new log line${added === 1 ? '' : 's'}`);
    }, 2_000);
  }, [lineCount]);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  return announcement;
}

export function BootstrapProgressPage() {
  const { state } = useLocation();
  const values = state as WizardValues | undefined;

  // The local runtime (microVM) takes a completely different code path
  // from AWS: no Pulumi phases, no api-server image — just boot the VM
  // and register its cluster. We branch at the top so AWS bootstrap's
  // state machine stays untouched.
  if (values?.mode === 'microvm') {
    return <MicroVmProgress values={values} />;
  }
  if (!values || values.mode === 'aws') {
    return <AwsProgress values={values} />;
  }
  return <Navigate to="/cloud/bootstrap" replace />;
}

function AwsProgress({ values }: { values: AwsWizardValues | undefined }) {
  const host = useHost();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [phases, setPhases] = React.useState<Record<BootstrapPhase, PhaseState>>({
    phase1: 'pending',
    phase2: 'pending',
    phase3: 'pending',
  });
  const [logs, setLogs] = React.useState<LogLine[]>([]);
  const [result, setResult] = React.useState<BootstrapResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [failedPhase, setFailedPhase] = React.useState<BootstrapPhase | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const [handoff, setHandoff] = React.useState<HandoffState>('idle');
  const [handoffError, setHandoffError] = React.useState<string | null>(null);
  const startedRef = React.useRef(false);
  const handoffStartedRef = React.useRef(false);
  const logIdRef = React.useRef(0);
  const [lastActivityAt, setLastActivityAt] = React.useState(Date.now());
  const logAnnouncement = useBatchedLogAnnouncement(logs.length);

  // Captured outputs of phases that have succeeded so far. Seeded
  // back into the engine on retry so phase 2 doesn't have to re-run
  // phase 1, etc.
  const priorRef = React.useRef<BootstrapPriorOutputs>({});
  // The exact BootstrapInput used for the original run. Reused
  // verbatim on retry — must not change between attempts or the
  // Pulumi stack would diverge from prior outputs.
  const inputRef = React.useRef<BootstrapInput | null>(null);
  // Phases the user originally asked for (e.g. ['phase1', 'phase2'])
  // — retry from phase N replays this list filtered to N onwards.
  const requestedRef = React.useRef<BootstrapPhase[]>([]);

  const appendLog = React.useCallback((level: LogLine['level'], message: string) => {
    logIdRef.current += 1;
    setLastActivityAt(Date.now());
    setLogs((prev) => [...prev, { id: logIdRef.current, level, message }]);
  }, []);

  const handleEvent = React.useCallback(
    (e: BootstrapEvent) => {
      switch (e.type) {
        case 'phase-started':
          setPhases((p) => ({ ...p, [e.phase]: 'running' }));
          break;
        case 'phase-completed':
          setPhases((p) => ({ ...p, [e.phase]: 'completed' }));
          break;
        case 'phase-failed':
          setPhases((p) => ({ ...p, [e.phase]: 'failed' }));
          setFailedPhase(e.phase);
          appendLog('error', `${e.phase}: ${e.error}`);
          break;
        case 'phase-skipped':
          // Don't visually demote a phase that has already
          // completed — on retry, the engine emits "skipped" for
          // phases not in the retry's phases list, which would
          // otherwise overwrite the green checkmark.
          setPhases((p) => (p[e.phase] === 'completed' ? p : { ...p, [e.phase]: 'skipped' }));
          break;
        case 'phase-output':
          if (e.phase === 'phase1') priorRef.current.phase1 = e.output;
          else if (e.phase === 'phase2') priorRef.current.phase2 = e.output;
          break;
        case 'resource':
          if (e.op === 'same') return;
          appendLog('info', `${e.op.padEnd(7)} ${e.resourceType}  ${e.name}`);
          break;
        case 'log':
          appendLog(e.level, e.message === LEGACY_BOOTSTRAP_DEPRECATION ? CLASSIC_INSTALLER_MESSAGE : e.message);
          break;
      }
    },
    [appendLog]
  );

  const runFrom = React.useCallback(
    (fromPhase: BootstrapPhase) => {
      const input = inputRef.current;
      if (!input || !host.bootstrap) return;
      const startIdx = PHASE_ORDER.indexOf(fromPhase);
      const phasesToRun = requestedRef.current.filter((p) => PHASE_ORDER.indexOf(p) >= startIdx);
      if (phasesToRun.length === 0) return;

      // Reset UI state for phases we're about to (re-)run.
      setPhases((p) => {
        const next = { ...p };
        for (const ph of phasesToRun) next[ph] = 'pending';
        return next;
      });
      setError(null);
      setFailedPhase(null);
      setRetrying(true);

      host.bootstrap
        .run(input, { phases: phasesToRun, prior: priorRef.current }, handleEvent)
        .then((r) => setResult(r))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setRetrying(false));
    },
    [host.bootstrap, handleEvent]
  );

  React.useEffect(() => {
    if (!values || !host.bootstrap || startedRef.current) return;
    startedRef.current = true;

    inputRef.current = {
      base: {
        name: values.name,
        config: {
          type: ApplianceBaseType.ApplianceAwsPublic,
          name: values.name,
          region: values.region,
          dns: {
            domainName: values.domain,
            createZone: values.createZone,
            attachZone: !values.createZone,
          },
        },
      },
      apiServerImageUri: values.apiServerImageUri,
      aws: values.awsProfile ? { profile: values.awsProfile } : undefined,
    };
    const phases: BootstrapPhase[] = ['phase1'];
    if (values.deployApiServer) phases.push('phase2');
    if (values.promoteState) phases.push('phase3');
    requestedRef.current = phases;

    runFrom('phase1');
  }, [values, host.bootstrap, runFrom]);

  // Handoff: once bootstrap returns a reachable api-server + fresh
  // API key, persist them to the host (OS keychain in Tauri,
  // sessionStorage in the web shell) and invalidate the cached
  // config query so Dashboard/Settings re-read the connected state.
  // Phase 1–only results have no apiKey/apiServerUrl — nothing to
  // save, handoff marks itself `skipped`.
  React.useEffect(() => {
    if (!result || handoffStartedRef.current) return;
    handoffStartedRef.current = true;

    if (!result.apiServerUrl || !result.apiKey) {
      setHandoff('skipped');
      return;
    }

    const apiServerUrl = result.apiServerUrl;
    const apiKey = result.apiKey;
    const clusterName = values?.name ?? deriveNameFromUrl(apiServerUrl);
    // Persist stateBackendUrl onto the cluster only if phase 3
    // didn't already promote it. After promotion the local state
    // is gone, so a Settings-page promote action would have nothing
    // to do — and the cluster doesn't need to track the backend URL
    // for any other reason. Stash the BootstrapInput regardless,
    // since baseline updates need it to preserve dns/vpc choices.
    const stateBackendUrl = result.statePromoted ? undefined : result.stateBackendUrl || undefined;
    const bootstrapInput = inputRef.current ?? undefined;
    setHandoff('saving');
    (async () => {
      try {
        await host.addCluster({
          name: clusterName,
          apiServerUrl,
          apiKey,
          stateBackendUrl,
          lastBootstrapInput: result.installGeneration ? undefined : bootstrapInput,
          installGeneration: result.installGeneration,
          cloudFormationStackName: result.cloudFormationStackName,
          awsAccountId: result.awsAccountId,
          awsRegion: result.awsRegion,
        });
        await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
        setHandoff('saved');
      } catch (err) {
        setHandoff('failed');
        setHandoffError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [result, host, queryClient, values?.name]);

  if (!values) {
    return <Navigate to="/cloud/bootstrap" replace />;
  }

  const scheduled = requestedRef.current;
  const phaseNames: Record<BootstrapPhase, string> = {
    phase1: 'Cloud foundation',
    phase2: 'Control plane',
    phase3: 'Handover',
  };
  const steps = scheduled.map((phase) => ({
    key: phase,
    label:
      phase === 'phase1'
        ? 'Cloud foundation — network, compute, and DNS'
        : phase === 'phase2'
          ? 'Control plane — the Appliance service'
          : 'Handover — installation records available in the cloud',
    runningLabel:
      phase === 'phase1'
        ? 'Building the cloud foundation'
        : phase === 'phase2'
          ? 'Installing the Appliance service'
          : 'Moving installation records',
  }));
  const active = Math.max(
    0,
    scheduled.findIndex((phase) => phases[phase] === 'running' || phases[phase] === 'failed')
  );
  const operationStatus = result ? 'success' : error ? 'error' : 'running';
  return (
    <PageShell rail="focused" className="space-y-6 pt-8">
      <PageHeader
        focused
        title={`Creating ${values.name} in AWS`}
        description={`${values.region} · ${values.domain}`}
      />
      <SectionCard>
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {logAnnouncement}
        </div>
        <LongOperation
          title={result ? 'Cloud installation ready' : 'Creating your cloud installation'}
          status={operationStatus}
          steps={steps}
          activeStep={active}
          nowLine={logs.at(-1)?.message ?? 'Waiting for AWS…'}
          timeClass="long"
          estimate={durationEstimates.cloudCreate}
          leaveSafety="keep-page"
          lastActivityAt={lastActivityAt}
          stallMessage="AWS is building real infrastructure — long quiet stretches are normal. The event log shows the last resource created."
          failure={error ?? undefined}
          retry={
            failedPhase ? (
              <Button size="sm" onClick={() => runFrom(failedPhase)} disabled={retrying}>
                {retrying ? 'Retrying…' : `Retry ${phaseNames[failedPhase].toLowerCase()}`}
              </Button>
            ) : undefined
          }
          primaryAction={
            result ? (
              <Button onClick={() => navigate('/projects')} disabled={handoff === 'saving'}>
                {handoff === 'saving' ? 'Saving…' : 'Open Apps'}
              </Button>
            ) : undefined
          }
          log={logs.map((line) => (
            <div
              key={line.id}
              className={cn(
                line.level === 'warn' && 'text-[var(--color-warning-foreground)]',
                line.level === 'error' && 'text-[var(--color-destructive-foreground)]'
              )}
            >
              {line.message}
            </div>
          ))}
          logProps={{ live: 'off', copyText: logs.map((line) => line.message).join('\n') }}
        />
      </SectionCard>
      {result ? (
        <SectionCard title="Technical details">
          <KeyValueList
            items={[
              ...(result.apiServerUrl
                ? [{ key: 'server', label: 'Server address', value: result.apiServerUrl, mono: true }]
                : []),
              ...(result.apiKey ? [{ key: 'key', label: 'Key id', value: result.apiKey.id, mono: true }] : []),
              { key: 'records', label: 'Installation records', value: result.stateBackendUrl, mono: true },
            ]}
          />
          {result.statePromoted ? (
            <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
              Installation records were moved to cloud storage.
            </p>
          ) : null}
        </SectionCard>
      ) : null}
      {handoff === 'failed' && handoffError ? (
        <Banner tone="error">{handoffError} — connect manually from Cloud → Pair a cloud.</Banner>
      ) : null}
    </PageShell>
  );
}

// ============================================================
// Dev Machine (microVM) bootstrap
//
// One "Get started" press lands here and boots the default VM — DEV-
// CAPABLE (devUp) when the host supports it, so the freshly-booted
// machine can run agents and dev shells without a second detour through
// the Machine page. The engine already publishes structured bring-up
// phases (media → booting → network → ready / failed, plus cluster phases
// for explicit provisioning, mirrored by MicroVmStatus.phase), so instead
// of a single opaque node we render a ladder driven by status().phase. Each rung goes
// pending → running (spinner) → completed (check). The streamed boot
// lines live underneath as a collapsible detail, and a `failed` phase
// fails fast — the in-flight rung turns red and the error is surfaced
// with a Retry. Lands on a clean "ready" state with ONE primary CTA into
// the first deploy ("Deploy your first app" → /projects/deploy) and a
// secondary "Run an agent" → /agents.
// ============================================================

// The bring-up ladder, mirroring Phase in packages/vm/src/bringup.rs.
// `failed` is terminal but isn't a rung — it paints whichever rung was
// in flight red rather than adding a sixth step.
type MicroVmRung = {
  phase: Exclude<MicroVmPhase, 'failed'>;
  label: string;
  // Shown while the rung is in flight, when the resting `label` would
  // read as a contradiction (e.g. "Cluster ready" next to a spinner).
  runningLabel?: string;
  detail: string;
};

const CORE_MICROVM_LADDER: MicroVmRung[] = [
  {
    phase: 'media',
    label: 'Sandbox files ready',
    runningLabel: 'Preparing Sandbox files',
    detail: 'Preparing the private machine image.',
  },
  {
    phase: 'booting',
    label: 'Sandbox started',
    runningLabel: 'Starting the Sandbox',
    detail: 'Starting the private machine.',
  },
  {
    phase: 'network',
    label: 'Guarded internet ready',
    runningLabel: 'Connecting guarded internet',
    detail: 'Connecting the Sandbox to the network.',
  },
  {
    phase: 'ready',
    label: 'Sandbox ready',
    detail: 'Agents and shells can now use the isolated workspace.',
  },
];

const CLUSTER_MICROVM_LADDER: MicroVmRung[] = [
  ...CORE_MICROVM_LADDER.slice(0, 3),
  {
    phase: 'cluster',
    label: 'App platform started',
    runningLabel: 'Starting the app platform',
    detail: 'First-time setup downloads the hosting components.',
  },
  {
    phase: 'ready',
    label: 'Ready for deploys',
    runningLabel: 'Checking hosting readiness',
    detail: 'Turning on App hosting.',
  },
];

// Live sub-phases newer engines publish INSIDE the long cluster rung
// (cluster-node → cluster-images → cluster-api → ingress). They map onto
// the cluster rung — the ladder keeps its five steps — and swap its
// resting detail line for what is actually happening right now. Phases
// outside the ladder AND this map still fall through applyPhase
// untouched, so unknown-phase tolerance is preserved in both directions.
const CLUSTER_SUB_PHASES: Partial<Record<MicroVmPhase, string>> = {
  'cluster-node': 'Preparing the app platform.',
  'cluster-images': 'Downloading App hosting components.',
  'cluster-api': 'Starting Appliance services.',
  ingress: 'Preparing live local URLs.',
};

type MicroVmOutcome = 'running' | 'ready' | 'failed';

function MicroVmProgress({ values }: { values: MicroVmWizardValues }) {
  const host = useHost();
  const terminals = useTerminalSessions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const name = values.name?.trim() || 'appliance';
  const vmHost = host.vm;
  // Today's express wizard is core-only. Keep the full provision ladder
  // for callers that explicitly request a cluster boot in router state.
  const clusterRequested =
    values.intent === 'host' || (values as MicroVmWizardValues & { cluster?: boolean }).cluster === true;
  const ladder = clusterRequested ? CLUSTER_MICROVM_LADDER : CORE_MICROVM_LADDER;

  // `reached` is the high-water rung index the engine has reported;
  // `outcome` is the terminal verdict. The two together derive every
  // rung's state, so a stale/late status poll can never rewind the UI.
  const [reached, setReached] = React.useState(-1);
  // The live cluster sub-phase line (label + engine detail), shown as the
  // cluster rung's detail while that rung is in flight.
  const [clusterDetail, setClusterDetail] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<MicroVmOutcome>('running');
  const [logs, setLogs] = React.useState<LogLine[]>([]);
  const logAnnouncement = useBatchedLogAnnouncement(logs.length);
  const [error, setError] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  // True when the boot has produced NO new log line or phase change for
  // a while — the "is this thing wedged?" moment. Drives a reassurance
  // notice; flips back as soon as anything happens.
  const [stalled, setStalled] = React.useState(false);
  const lastActivityRef = React.useRef(Date.now());
  const startedRef = React.useRef(false);
  const logIdRef = React.useRef(0);
  // The poll loop's liveness flag and interval handle, hoisted to refs so
  // an unmount (navigating away mid-boot) can tear the interval down — and
  // so an in-flight poll can re-check liveness after its await. Without
  // this the 1.5s interval outlives the component and fires
  // setReached/setOutcome post-unmount.
  const liveRef = React.useRef(false);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const appendLog = React.useCallback((level: LogLine['level'], message: string) => {
    logIdRef.current += 1;
    lastActivityRef.current = Date.now();
    setStalled(false);
    setLogs((prev) => [...prev, { id: logIdRef.current, level, message }]);
  }, []);

  // Fold a polled engine phase into the ladder. Forward rungs only
  // advance the high-water mark; `failed` flips the outcome without
  // choosing a rung — the rung in flight stays the one painted red.
  // Cluster sub-phases pin the cluster rung and update its live detail;
  // anything else unknown is ignored (older/newer engine tolerance).
  const applyPhase = React.useCallback(
    (phase: MicroVmPhase, detail?: string) => {
      const sub = CLUSTER_SUB_PHASES[phase];
      if (sub) {
        if (!clusterRequested) return;
        const clusterIdx = ladder.findIndex((r) => r.phase === 'cluster');
        setReached((prev) => Math.max(prev, clusterIdx));
        // Only a CHANGED sub-phase line counts as progress — the poll
        // re-reports the same phase every 1.5s, which must not keep
        // resetting the stall clock.
        setClusterDetail((prev) => {
          const next = detail ? `${sub} (${detail})` : sub;
          if (next !== prev) {
            lastActivityRef.current = Date.now();
            setStalled(false);
          }
          return next;
        });
        return;
      }
      const idx = ladder.findIndex((r) => r.phase === phase);
      if (idx >= 0) {
        setReached((prev) => {
          if (idx > prev) {
            lastActivityRef.current = Date.now();
            setStalled(false);
          }
          return Math.max(prev, idx);
        });
      } else if (phase === 'failed') setOutcome((prev) => (prev === 'running' ? 'failed' : prev));
    },
    [clusterRequested, ladder]
  );

  // Watch for a quiet patch: no log line and no phase movement for a
  // couple of minutes. Real first boots go quiet during big image pulls,
  // so this is a reassurance ("waiting is normal, here's how long"), not
  // an error — the engine's own timeout is the failure authority.
  const STALL_AFTER_MS = 120_000;
  React.useEffect(() => {
    if (outcome !== 'running') {
      setStalled(false);
      return;
    }
    const t = setInterval(() => {
      if (Date.now() - lastActivityRef.current > STALL_AFTER_MS) setStalled(true);
    }, 15_000);
    return () => clearInterval(t);
  }, [outcome]);

  const start = React.useCallback(async () => {
    if (!vmHost) {
      setError('The Dev Machine is only available in the desktop app.');
      setOutcome('failed');
      return;
    }
    setError(null);
    setOutcome('running');
    setReached(-1);
    setClusterDetail(null);
    setLogs([]);
    setRetrying(true);
    lastActivityRef.current = Date.now();
    setStalled(false);
    const instance = vmHost.instance(name);

    // Poll the structured phase alongside the streamed log: the engine
    // publishes media→…→ready via status().phase, so the ladder advances
    // even though up() itself only yields free-text lines. Transient
    // errors (binary installing, VM not up yet) are swallowed — the
    // up() promise is the source of truth for success/failure.
    //
    // Liveness/handle live in refs so unmount cleanup can tear this down.
    // Clear any prior interval first so a Retry can never leave two poll
    // loops racing.
    liveRef.current = true;
    clearInterval(timerRef.current);
    const poll = async () => {
      try {
        const s = await instance.status();
        // Re-check liveness after the await: a poll already in flight when
        // the run settles (or the page unmounts) must not apply a phase.
        if (liveRef.current && s.phase) applyPhase(s.phase, s.phaseDetail);
      } catch {
        // keep polling
      }
    };
    timerRef.current = setInterval(() => {
      if (liveRef.current) void poll();
    }, 1500);
    void poll();

    try {
      appendLog('info', `Starting the "${name}" Sandbox…`);
      // The express boot provisions the VM DEV-CAPABLE (devUp: dev
      // toolchain + persistent workspace) so agents and dev shells work
      // right after onboarding — no second detour through the Machine
      // page. Falls back to a plain up() on hosts without devUp.
      const onLog = (e: { message: string }) => appendLog('info', e.message);
      // Streams the same lines the CLI prints and installs the engine
      // binary if missing. Express setup stops at the core sandbox.
      if (typeof instance.devUp === 'function') {
        await instance.devUp(onLog);
      } else {
        await instance.up(onLog);
      }
      if (clusterRequested) {
        setReached(ladder.findIndex((r) => r.phase === 'cluster'));
        await instance.clusterUp(onLog);
      }
      appendLog(
        'info',
        clusterRequested
          ? `The "${name}" Sandbox is ready with App hosting on.`
          : `The "${name}" Sandbox is ready for agents and shells.`
      );
      setReached(ladder.length - 1);
      setOutcome('ready');
      await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      await queryClient.invalidateQueries({ queryKey: ['microvm'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendLog('error', message);
      setError(message);
      setOutcome('failed');
    } finally {
      liveRef.current = false;
      clearInterval(timerRef.current);
      timerRef.current = undefined;
      setRetrying(false);
    }
  }, [vmHost, name, clusterRequested, ladder, appendLog, applyPhase, queryClient]);

  React.useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  // Tear the poll loop down if the user navigates away mid-boot. Killing
  // liveRef also neutralises any poll already awaiting status(), so the
  // ladder can't be advanced after unmount.
  React.useEffect(
    () => () => {
      liveRef.current = false;
      clearInterval(timerRef.current);
    },
    []
  );

  if (!vmHost) {
    return <Navigate to="/cloud/bootstrap" replace />;
  }

  // The rung currently in focus: the high-water mark, defaulting to the
  // first rung before any phase has been reported so the ladder never
  // looks stalled (engines predating phase reporting just spin rung 0
  // until up() resolves, then every rung checks).
  const cur = reached < 0 ? 0 : reached;
  const ready = outcome === 'ready';
  const title = ready
    ? clusterRequested
      ? 'Ready to host apps'
      : 'Sandbox ready'
    : clusterRequested
      ? 'Starting the Sandbox and App hosting'
      : 'Starting the Sandbox';
  const openShell = () => terminals.openSession({ target: name, engine: 'microvm', clusterName: name, mode: 'dev' });
  return (
    <PageShell rail="focused" className="space-y-6 pt-8">
      <PageHeader focused title={title} description={`Sandbox · ${name}`} />
      <SectionCard>
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {logAnnouncement}
        </div>
        <LongOperation
          title={title}
          status={outcome === 'running' ? 'running' : ready ? 'success' : 'error'}
          steps={ladder.map((rung) => ({
            key: rung.phase,
            label: rung.label,
            runningLabel: rung.runningLabel,
            detail: rung.detail,
          }))}
          activeStep={cur}
          nowLine={clusterDetail ?? logs.at(-1)?.message ?? 'Starting the Sandbox…'}
          timeClass={clusterRequested ? 'minutes' : 'seconds'}
          estimate={clusterRequested ? durationEstimates.hostingSetup : ''}
          leaveSafety="resumable"
          lastActivityAt={lastActivityRef.current}
          stalled={stalled}
          stallMessage={
            clusterRequested
              ? "First-time setup downloads the app platform's images — a quiet couple of minutes is normal."
              : durationEstimates.coreBootFirst
          }
          failure={error ? (reached < 0 ? error : `${ladder[cur].label}: ${error}`) : undefined}
          retry={
            <Button size="sm" onClick={() => void start()} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
          }
          primaryAction={
            ready ? (
              <Button onClick={() => navigate(clusterRequested ? '/projects/deploy' : '/agents')}>
                {clusterRequested ? 'Deploy your first app' : 'Run your first agent'}
              </Button>
            ) : undefined
          }
          secondaryAction={
            ready ? (
              clusterRequested ? (
                <Button variant="outline" onClick={() => navigate('/agents')}>
                  Run an agent instead
                </Button>
              ) : host.terminal ? (
                <Button variant="outline" onClick={openShell}>
                  Open a shell
                </Button>
              ) : undefined
            ) : undefined
          }
          successTone={clusterRequested ? 'success' : 'sandbox'}
          log={logs.map((line) => (
            <div
              key={line.id}
              className={cn(
                line.level === 'warn' && 'text-[var(--color-warning-foreground)]',
                line.level === 'error' && 'text-[var(--color-destructive-foreground)]'
              )}
            >
              {line.message}
            </div>
          ))}
          logProps={{ live: 'off', copyText: logs.map((line) => line.message).join('\n') }}
        />
      </SectionCard>
      {ready ? (
        <SectionCard title="Technical details">
          <KeyValueList
            items={[
              { key: 'sandbox', label: 'Sandbox', value: name, mono: true },
              ...(clusterRequested
                ? [{ key: 'target', label: 'Target profile', value: microVmClusterId(name), mono: true }]
                : []),
            ]}
          />
          <p className="mt-3 text-xs leading-4 text-[var(--color-muted-foreground)]">
            {clusterRequested
              ? 'Your machine is running with App hosting on. Deploys get a live local URL.'
              : "An isolated machine is running on this computer. Agents use its shared workspace; internet access is guarded and sign-in details stay outside the Sandbox. App hosting isn't set up yet — add it any time from Machine or on your first deploy."}
          </p>
        </SectionCard>
      ) : null}
    </PageShell>
  );
}

function deriveNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^api\./, '');
  } catch {
    return url;
  }
}
