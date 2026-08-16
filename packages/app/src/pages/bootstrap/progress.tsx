import * as React from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApplianceBaseType } from '@appliance.sh/sdk/models';
import { Check, Circle, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FriendlyError } from '@/components/friendly-error';
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
import { useTailAutoscroll } from '@/hooks/use-tail-autoscroll';
import { cn } from '@/lib/utils';

type PhaseState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

const PHASE_ORDER: BootstrapPhase[] = ['phase1', 'phase2', 'phase3'];

interface LogLine {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

type HandoffState = 'idle' | 'saving' | 'saved' | 'failed' | 'skipped';

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
  const { ref: logBoxRef, onScroll: onLogScroll } = useTailAutoscroll<HTMLDivElement>([logs]);

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
          appendLog(e.level, e.message);
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

  return (
    <div className="mx-auto max-w-3xl space-y-6 pt-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Bootstrapping {values.name}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {values.region} · {values.domain}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <PhaseCard
          phase="phase1"
          label="Base infrastructure"
          state={phases.phase1}
          canRetry={failedPhase === 'phase1' && !retrying}
          onRetry={() => runFrom('phase1')}
        />
        <PhaseCard
          phase="phase2"
          label="API server"
          state={phases.phase2}
          canRetry={failedPhase === 'phase2' && !retrying}
          onRetry={() => runFrom('phase2')}
        />
        <PhaseCard
          phase="phase3"
          label="Promote state"
          state={phases.phase3}
          canRetry={failedPhase === 'phase3' && !retrying}
          onRetry={() => runFrom('phase3')}
        />
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-black/30">
        <div className="border-b border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
          Event log
        </div>
        <div ref={logBoxRef} onScroll={onLogScroll} className="h-80 overflow-auto font-mono text-xs leading-relaxed">
          {logs.length === 0 ? (
            <div className="px-3 py-4 text-[var(--color-muted-foreground)]">Waiting…</div>
          ) : (
            logs.map((l) => (
              <div
                key={l.id}
                className={cn(
                  'whitespace-pre-wrap px-3 py-0.5',
                  l.level === 'warn' && 'text-yellow-400',
                  l.level === 'error' && 'text-red-400'
                )}
              >
                {l.message}
              </div>
            ))
          )}
        </div>
      </div>

      {result ? (
        <div className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-green-400">
            ✓ Bootstrap complete
            {handoff === 'saving' ? (
              <span className="text-[var(--color-muted-foreground)]">· saving credentials…</span>
            ) : handoff === 'saved' ? (
              <span className="text-[var(--color-muted-foreground)]">· credentials saved</span>
            ) : handoff === 'failed' ? (
              <span className="text-red-400">· save failed</span>
            ) : null}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--color-muted-foreground)]">State backend</dt>
            <dd className="font-mono">{result.stateBackendUrl}</dd>
            {result.apiServerUrl ? (
              <>
                <dt className="text-[var(--color-muted-foreground)]">API server</dt>
                <dd className="font-mono">{result.apiServerUrl}</dd>
              </>
            ) : null}
            {result.apiKey ? (
              <>
                <dt className="text-[var(--color-muted-foreground)]">API key</dt>
                <dd className="font-mono">{result.apiKey.id}</dd>
              </>
            ) : null}
            {result.statePromoted ? (
              <>
                <dt className="text-[var(--color-muted-foreground)]">State</dt>
                <dd>promoted to S3</dd>
              </>
            ) : null}
          </dl>
          {handoff === 'failed' && handoffError ? (
            <div className="rounded-md border border-red-500/50 bg-red-500/5 p-2 text-xs text-red-400">
              {handoffError} — connect manually under Cloud → Add cloud.
            </div>
          ) : null}
          <Button onClick={() => navigate('/projects')} disabled={handoff === 'saving'}>
            {handoff === 'saving' ? 'Saving…' : 'Open Apps'}
          </Button>
        </div>
      ) : null}

      {error ? (
        <FriendlyError
          error={error}
          fallbackHeadline="The cloud setup couldn't finish"
          actions={
            <>
              {failedPhase ? (
                <Button onClick={() => runFrom(failedPhase)} disabled={retrying}>
                  {retrying ? 'Retrying…' : `Retry ${failedPhase}`}
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => navigate('/cloud/bootstrap')} disabled={retrying}>
                Start over
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

// ============================================================
// Dev Machine (microVM) bootstrap
//
// One "Get started" press lands here and boots the default VM — DEV-
// CAPABLE (devUp) when the host supports it, so the freshly-booted
// machine can run agents and dev shells without a second detour through
// the Machine page. The engine already publishes structured bring-up
// phases (media → booting → network → cluster → ready / failed, mirrored
// by MicroVmStatus.phase), so instead of a single opaque node we render a
// five-rung ladder driven by polled status().phase: each rung goes
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
const MICROVM_LADDER: {
  phase: Exclude<MicroVmPhase, 'failed'>;
  label: string;
  // Shown while the rung is in flight, when the resting `label` would
  // read as a contradiction (e.g. "Cluster ready" next to a spinner).
  runningLabel?: string;
  detail: string;
}[] = [
  { phase: 'media', label: 'Boot media', detail: 'Preparing the VM kernel and disk image.' },
  { phase: 'booting', label: 'Booting guest', detail: 'Starting the virtual machine.' },
  { phase: 'network', label: 'Guest network', detail: 'Connecting the VM to the network.' },
  {
    phase: 'cluster',
    label: 'Starting the app platform',
    detail: 'First boot downloads a few components — this can take a few minutes.',
  },
  {
    phase: 'ready',
    label: 'Ready',
    runningLabel: 'Registering with the console',
    detail: 'Delivering the api-server and registering the machine as a deploy target.',
  },
];

// Live sub-phases newer engines publish INSIDE the long cluster rung
// (cluster-node → cluster-images → cluster-api → ingress). They map onto
// the cluster rung — the ladder keeps its five steps — and swap its
// resting detail line for what is actually happening right now. Phases
// outside the ladder AND this map still fall through applyPhase
// untouched, so unknown-phase tolerance is preserved in both directions.
const CLUSTER_SUB_PHASES: Partial<Record<MicroVmPhase, string>> = {
  'cluster-node': 'Base system up — starting Kubernetes.',
  'cluster-images': 'Platform images staged — importing.',
  'cluster-api': 'Kubernetes API up — starting platform services.',
  ingress: 'Wiring the registry and API routes.',
};

type MicroVmOutcome = 'running' | 'ready' | 'failed';

function MicroVmProgress({ values }: { values: MicroVmWizardValues }) {
  const host = useHost();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const name = values.name?.trim() || 'appliance';
  const vmHost = host.vm;

  // `reached` is the high-water rung index the engine has reported;
  // `outcome` is the terminal verdict. The two together derive every
  // rung's state, so a stale/late status poll can never rewind the UI.
  const [reached, setReached] = React.useState(-1);
  // The live cluster sub-phase line (label + engine detail), shown as the
  // cluster rung's detail while that rung is in flight.
  const [clusterDetail, setClusterDetail] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<MicroVmOutcome>('running');
  const [logs, setLogs] = React.useState<LogLine[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const [showLog, setShowLog] = React.useState(true);
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
  // Tail the stream (the longest rung streams for minutes) without
  // fighting a user who scrolled up to read an earlier line. `showLog`
  // is a dep so re-expanding the pane also lands on the tail.
  const { ref: logBoxRef, onScroll: onLogScroll } = useTailAutoscroll<HTMLDivElement>([logs, showLog]);

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
  const applyPhase = React.useCallback((phase: MicroVmPhase, detail?: string) => {
    const sub = CLUSTER_SUB_PHASES[phase];
    if (sub) {
      const clusterIdx = MICROVM_LADDER.findIndex((r) => r.phase === 'cluster');
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
    const idx = MICROVM_LADDER.findIndex((r) => r.phase === phase);
    if (idx >= 0) {
      setReached((prev) => {
        if (idx > prev) {
          lastActivityRef.current = Date.now();
          setStalled(false);
        }
        return Math.max(prev, idx);
      });
    } else if (phase === 'failed') setOutcome((prev) => (prev === 'running' ? 'failed' : prev));
  }, []);

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
    setShowLog(true);
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
      appendLog('info', `Booting the "${name}" VM and bootstrapping its api-server…`);
      // The express boot provisions the VM DEV-CAPABLE (devUp: dev
      // toolchain + persistent workspace) so agents and dev shells work
      // right after onboarding — no second detour through the Machine
      // page. Falls back to a plain up() on hosts without devUp.
      const onLog = (e: { message: string }) => appendLog('info', e.message);
      // Streams the same lines the CLI prints, installs the engine
      // binary if missing, and registers the VM as a deploy target on
      // success.
      if (typeof instance.devUp === 'function') {
        await instance.devUp(onLog);
      } else {
        await instance.up(onLog);
      }
      appendLog('info', `The "${name}" VM is up and registered as a deploy target.`);
      setReached(MICROVM_LADDER.length - 1);
      setOutcome('ready');
      // Collapse the bring-up log once we're green — the ladder tells the
      // success story, the raw lines are just there for failures.
      setShowLog(false);
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
  }, [vmHost, name, appendLog, applyPhase, queryClient]);

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
  const rungState = (i: number): PhaseState => {
    if (outcome === 'ready') return 'completed';
    if (outcome === 'failed') {
      if (i < cur) return 'completed';
      if (i === cur) return 'failed';
      return 'pending';
    }
    if (i < cur) return 'completed';
    if (i === cur) return 'running';
    return 'pending';
  };

  // A single spoken sentence for the visually-hidden live region, so screen
  // readers hear the ladder advance / settle without parsing the rungs.
  const announce = (() => {
    if (outcome === 'ready') return 'Dev Machine ready.';
    if (outcome === 'failed') {
      // Mirror the visible header: don't name a stage we never reached.
      return reached < 0 ? 'Start failed.' : `Start failed at the ${MICROVM_LADDER[cur].label} step.`;
    }
    if (reached < 0) return 'Starting the Dev Machine…';
    const rung = MICROVM_LADDER[cur];
    return `${rung.runningLabel ?? rung.label} in progress…`;
  })();

  return (
    <div className="mx-auto max-w-3xl space-y-6 pt-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Starting your Dev Machine</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Isolated virtual machine · {name}</p>
      </div>

      {/* Visually-hidden running commentary for assistive tech. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>

      <div className="space-y-2">
        {MICROVM_LADDER.map((rung, i) => {
          const st = rungState(i);
          // While a rung is in flight its resting label can read as a
          // contradiction next to a spinner — swap in the action-oriented
          // one. The failed rung keeps the strong-border highlight too.
          const label = st === 'running' && rung.runningLabel ? rung.runningLabel : rung.label;
          // The cluster rung narrates its live sub-phase (engine-published)
          // instead of the static "can take a few minutes" while running.
          const detail = rung.phase === 'cluster' && st === 'running' && clusterDetail ? clusterDetail : rung.detail;
          return (
            <MicroVmPhaseStep
              key={rung.phase}
              label={label}
              detail={detail}
              state={st}
              active={st === 'running' || st === 'failed'}
            />
          );
        })}
      </div>

      {/* Quiet-patch reassurance: nothing new for a while is NORMAL on a
          first boot (multi-GB image pulls emit no lines), but a bare
          spinner reads as a hang. Say what's happening, how long is
          normal, and where the truth lives. The engine's own timeout
          remains the failure authority — this never aborts anything. */}
      {stalled && outcome === 'running' ? (
        <div
          role="status"
          className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-3 text-sm text-yellow-200/90"
        >
          <div className="font-medium text-yellow-300">Still working — this step can be slow</div>
          <div className="mt-1 text-xs">
            Nothing new for a couple of minutes. A first start downloads several GB of images, which can take 10–15
            minutes on a slower connection — waiting is safe. The bring-up log below shows the last activity; if it
            never moves again, this page will report the failure and offer a Retry.
          </div>
          {!showLog ? (
            <button
              type="button"
              onClick={() => setShowLog(true)}
              className="mt-2 text-xs underline hover:text-yellow-100"
            >
              Show the bring-up log
            </button>
          ) : null}
        </div>
      ) : null}

      {/* The raw streamed boot lines, collapsible underneath the ladder. */}
      <div className="rounded-md border border-[var(--color-border)] bg-black/30">
        <button
          type="button"
          onClick={() => setShowLog((s) => !s)}
          aria-expanded={showLog}
          className="flex w-full items-center justify-between px-3 py-2 text-xs uppercase tracking-wide text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
        >
          <span>Bring-up log</span>
          <span>{showLog ? 'Hide' : 'Show'}</span>
        </button>
        {showLog ? (
          <div
            ref={logBoxRef}
            onScroll={onLogScroll}
            className="h-72 overflow-auto border-t border-[var(--color-border)] font-mono text-xs leading-relaxed"
          >
            {logs.length === 0 ? (
              <div className="px-3 py-4 text-[var(--color-muted-foreground)]">Waiting…</div>
            ) : (
              logs.map((l) => (
                <div
                  key={l.id}
                  className={cn(
                    'whitespace-pre-wrap px-3 py-0.5',
                    l.level === 'warn' && 'text-yellow-400',
                    l.level === 'error' && 'text-red-400'
                  )}
                >
                  {l.message}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>

      {outcome === 'ready' ? (
        <div className="space-y-3 rounded-md border border-[var(--color-border)] p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-green-400">
            <Check className="h-4 w-4" /> Dev Machine ready
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[var(--color-muted-foreground)]">Virtual machine</dt>
            <dd>{name}</dd>
          </dl>
          {/* Engine jargon (profile id, deploy-target registration) demoted
              behind a disclosure — the default success view stays plain. */}
          <details>
            <summary className="cursor-pointer select-none text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]">
              Technical details
            </summary>
            <div className="mt-1 space-y-1 text-xs text-[var(--color-muted-foreground)]">
              <div>
                Profile: <code className="font-mono">{microVmClusterId(name)}</code>
              </div>
              <div>
                The machine registers as <code className="font-mono">{microVmClusterId(name)}</code> and appears as a
                deploy target in the target switcher.
              </div>
            </div>
          </details>
          {/* The machine being up is the middle, not the end — lead straight
              into the first deploy. The wizard find-or-creates the app +
              environment and writes the link itself, so there's no separate
              setup step to discover first. ONE primary CTA; "Run an agent"
              is the secondary path (the express boot is dev-capable, so
              agents work right away). */}
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Next, deploy your first app. The wizard creates the app and environment for you — no separate setup step
            needed.
          </p>
          <div className="flex gap-2">
            <Button onClick={() => navigate('/projects/deploy')}>Deploy your first app</Button>
            <Button variant="outline" onClick={() => navigate('/agents')}>
              Run an agent
            </Button>
          </div>
        </div>
      ) : null}

      {outcome === 'failed' ? (
        <FriendlyError
          error={error}
          // Only blame a stage once one has actually been observed — an
          // up() failure before any phase publishes (binary install,
          // handshake, missing engine) isn't the "Boot media" step.
          fallbackHeadline={
            reached < 0
              ? "The local machine couldn't start"
              : `The local machine couldn't start — stopped at "${MICROVM_LADDER[cur].label}"`
          }
          actions={
            <>
              <Button onClick={() => void start()} disabled={retrying}>
                {retrying ? 'Retrying…' : 'Retry'}
              </Button>
              <Button variant="outline" onClick={() => navigate('/setup')} disabled={retrying}>
                Start over
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

// One rung of the microVM bring-up ladder: a status glyph (spinner while
// active, check when done, ✗ on failure), the stage label, and a one-line
// description. The active rung gets a stronger border so the eye lands on
// what's happening now.
function MicroVmPhaseStep({
  label,
  detail,
  state,
  active,
}: {
  label: string;
  detail: string;
  state: PhaseState;
  active: boolean;
}) {
  const tone =
    state === 'completed'
      ? 'text-green-400'
      : state === 'running'
        ? 'text-cyan-400'
        : state === 'failed'
          ? 'text-red-400'
          : 'text-[var(--color-muted-foreground)]';
  // A plain-language state for assistive tech — the raw enum word and the
  // glyph below are both decorative as far as screen readers are concerned.
  const stateLabel =
    state === 'completed' ? 'done' : state === 'running' ? 'in progress' : state === 'failed' ? 'failed' : 'pending';
  // The glyphs carry no text, so they're hidden from AT — except the spinner,
  // which is a live status. State is conveyed by the sr-only text instead.
  const icon =
    state === 'completed' ? (
      <Check className="h-4 w-4" aria-hidden="true" />
    ) : state === 'running' ? (
      <Loader2 className="h-4 w-4 animate-spin" role="status" aria-label={`${label}: in progress`} />
    ) : state === 'failed' ? (
      <X className="h-4 w-4" aria-hidden="true" />
    ) : (
      <Circle className="h-3 w-3" aria-hidden="true" />
    );
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border p-3 transition-colors',
        active ? 'border-[var(--color-border-strong)] bg-[var(--color-surface)]' : 'border-[var(--color-border)]'
      )}
    >
      <div className={cn('mt-0.5 flex h-4 w-4 items-center justify-center', tone)}>{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">{detail}</div>
      </div>
      <div className={cn('text-xs uppercase tracking-wide', tone)} aria-hidden="true">
        {state}
      </div>
      {/* AT-readable state for non-spinner rungs (the spinner self-announces). */}
      {state !== 'running' ? <span className="sr-only">{`${label}: ${stateLabel}`}</span> : null}
    </div>
  );
}

function deriveNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^api\./, '');
  } catch {
    return url;
  }
}

function PhaseCard({
  phase,
  label,
  state,
  canRetry,
  onRetry,
}: {
  phase: BootstrapPhase;
  label: string;
  state: PhaseState;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const color =
    state === 'completed'
      ? 'text-green-400'
      : state === 'running'
        ? 'text-cyan-400'
        : state === 'failed'
          ? 'text-red-400'
          : state === 'skipped'
            ? 'text-[var(--color-muted-foreground)]'
            : 'text-[var(--color-muted-foreground)]';
  const glyph =
    state === 'completed'
      ? '✓'
      : state === 'running'
        ? '•'
        : state === 'failed'
          ? '✗'
          : state === 'skipped'
            ? '⚬'
            : '○';
  return (
    <div className="rounded-md border border-[var(--color-border)] p-3">
      <div className={cn('text-xs uppercase tracking-wide', color)}>
        {glyph} {phase}
      </div>
      <div className="mt-1 text-sm">{label}</div>
      <div className="mt-1 text-xs text-[var(--color-muted-foreground)]">{state}</div>
      {canRetry ? (
        <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
