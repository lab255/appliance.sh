import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Banner,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  Field,
  Input,
  LogPane,
  LongOperation,
  PageHeader,
  PageShell,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  WeightLabel,
  useConfirm,
} from '@appliance.sh/ui';
import { useHost } from '@/providers/host-provider';
import { useTerminalSessions, agentSessionKey, agentBadgeStatus } from '@/providers/terminal-sessions-provider';
import { AgentSignIn } from '@/pages/agents';
import { LaunchAgentButton } from '@/pages/agents/launch-agent-button';
import { useAgentSignedIn } from '@/components/agent-login';
import { AGENT_ADAPTERS, agentLabel } from '@/lib/agents';
import type { AgentInfo } from '@/lib/host';
import {
  capturedAt,
  credentialCopy,
  files,
  fixtureDirectory,
  fixtureRuns,
  fixtureScenario,
  scenarios,
  stopCopy,
  wslCopy,
} from './fixtures';
import { packageEvidence } from './package-evidence';
import './workbench.css';

type Workspace = { id: string; name: string; directory: string; blank?: boolean };
const initialWorkspace: Workspace = { id: 'journal', name: 'Journal', directory: fixtureDirectory };
const storageKey = 'workbench:fixture:bindings';
function readWorkspaces(): Workspace[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? [initialWorkspace];
  } catch {
    return [initialWorkspace];
  }
}
function Fixture({ children }: { children: React.ReactNode }) {
  return <span className="wb-muted">fixture · {children}</span>;
}
function Panel({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section className="wb-panel wb-stack" data-surface={id} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function WorkbenchPage() {
  const host = useHost();
  const scenario = fixtureScenario();
  const { workspaceId } = useParams();
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = React.useState(readWorkspaces);
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState('existing');
  const [name, setName] = React.useState('');
  const [parent, setParent] = React.useState('/Users/you/projects');
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const adding = React.useRef(false);
  const createOpener = React.useRef<HTMLElement | null>(null);
  function showCreate() {
    createOpener.current = document.activeElement as HTMLElement;
    setOpen(true);
  }
  const preview = kind === 'blank' ? `${parent.replace(/\/$/, '')}/${name}` : parent;
  const active = workspaces.find((w) => w.id === workspaceId);
  async function add() {
    if (adding.current) return;
    if (!name.trim() || !preview.startsWith('/') || name.includes('/') || name === '..') {
      setMessage('Enter a name and an absolute local folder path.');
      return;
    }
    if (workspaces.some((w) => w.directory === preview) || preview.includes('existing')) {
      setMessage('This folder already exists. Choose another path; existing files will not be overwritten.');
      return;
    }
    if (preview.includes('readonly')) {
      setMessage('This folder is not writable. Choose another parent directory.');
      return;
    }
    adding.current = true;
    setBusy(true);
    setMessage('Adding workspace…');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const next = [...workspaces, { id: `workspace-${Date.now()}`, name, directory: preview, blank: kind === 'blank' }];
    localStorage.setItem(storageKey, JSON.stringify(next));
    setWorkspaces(next);
    adding.current = false;
    setBusy(false);
    setOpen(false);
    setMessage('Workspace added · fixture binding; no directory was written.');
  }
  if (!scenario)
    return (
      <PageShell>
        <PageHeader title="Workbench" description="Design prototype" />
        <Banner title="Prototype fixtures unavailable">
          Open the mock-host Workbench scenario to explore this branch-only prototype.{' '}
          {host.vm ? '' : 'Agent execution requires the desktop app.'}
        </Banner>
      </PageShell>
    );
  return (
    <PageShell rail="browse" className="workbench wb-stack">
      <div className="wb-row wb-between">
        <Fixture>GLA-331 · design prototype · no live authority</Fixture>
        <label className="wb-muted">
          Scenario{' '}
          <select
            aria-label="Prototype scenario"
            className="wb-select"
            value={scenario.replace('workbench-', '')}
            onChange={(e) => {
              window.location.href = `/workbench?mock-host&scenario=workbench-${e.target.value}`;
            }}
          >
            {scenarios.map(([id, title]) => (
              <option key={id} value={id}>
                {id} · {title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {workspaceId && active ? (
        <WorkspaceDetail key={active.id} workspace={active} scenario={scenario} />
      ) : (
        <section data-surface="S1" className="wb-stack">
          <PageHeader
            title="Workbench"
            description="Your authoring folders, agents and next steps."
            action={
              <Button
                onClick={() => {
                  showCreate();
                  setMessage('');
                }}
              >
                Create workspace
              </Button>
            }
          />
          <div className="wb-row wb-between">
            <p className="wb-muted">Workspaces · fixture persistence in this browser</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setWorkspaces(workspaces.length ? [] : [initialWorkspace])}
            >
              Toggle empty fixture
            </Button>
          </div>
          <div className="wb-panel" style={{ minHeight: 240 }}>
            {workspaces.length ? (
              workspaces.map((w) => (
                <button key={w.id} className="wb-file wb-stack" onClick={() => navigate(`/workbench/${w.id}`)}>
                  <div className="wb-row wb-between">
                    <WeightLabel active={false}>{w.name}</WeightLabel>
                    <span className="wb-muted">{w.blank ? '0' : '4'} sessions · Agent machine: appliance</span>
                  </div>
                  <span className="wb-code">{w.directory}</span>
                  <span className="wb-muted">
                    Last activity: {capturedAt} · Last operation: {w.blank ? 'None' : 'Inspection ready'} · fixture
                  </span>
                </button>
              ))
            ) : (
              <div className="wb-stack">
                <p>No workspaces yet. Open a project folder or start with a blank folder.</p>
                <div className="wb-row">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setKind('existing');
                      showCreate();
                    }}
                  >
                    Open existing project
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setKind('blank');
                      showCreate();
                    }}
                  >
                    Create blank workspace
                  </Button>
                </div>
              </div>
            )}
          </div>
          <p className="wb-status" role="status">
            {message}
          </p>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
              className="wb-create-dialog"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                createOpener.current?.focus();
              }}
            >
              <DialogTitle>Create workspace</DialogTitle>
              <DialogDescription>fixture · directory selection and creation. Cancel creates nothing.</DialogDescription>
              <div className="wb-stack mt-4">
                <label>
                  Folder choice{' '}
                  <select className="wb-select" value={kind} onChange={(e) => setKind(e.target.value)}>
                    <option value="existing">Open existing project</option>
                    <option value="blank">Create blank workspace</option>
                  </select>
                </label>
                <Field label="Name" htmlFor="workspace-name">
                  <Input id="workspace-name" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field
                  label={kind === 'blank' ? 'Parent directory' : 'Choose its local folder'}
                  htmlFor="workspace-parent"
                >
                  <Input id="workspace-parent" value={parent} onChange={(e) => setParent(e.target.value)} />
                </Field>
                <Button
                  variant="outline"
                  onClick={async () => {
                    setMessage('Opening folder picker…');
                    const picked = await host.local?.pickDirectory();
                    if (picked) setParent(picked);
                    setMessage(picked ? 'Folder selected · fixture picker' : 'Folder selection canceled');
                  }}
                >
                  Choose local folder
                </Button>
                <p className="wb-code">{preview}</p>
                <p className="wb-muted">Validation fixtures: “existing” conflicts; “readonly” is not writable.</p>
                <p className="wb-status" role="status">
                  {message}
                </p>
                <div className="wb-row">
                  <Button disabled={busy} onClick={() => void add()}>
                    {busy ? 'Adding workspace…' : 'Add workspace'}
                  </Button>
                  <Button variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </section>
      )}
    </PageShell>
  );
}

function WorkspaceDetail({ workspace, scenario }: { workspace: Workspace; scenario: string }) {
  const [target, setTarget] = React.useState(
    () => localStorage.getItem(`workbench:target:${workspace.directory}`) ?? 'local'
  );
  const [targetMessage, setTargetMessage] = React.useState('Binding target only · global target unchanged');
  const [vmDown, setVmDown] = React.useState(scenario === 'workbench-11');
  const [mountMismatch, setMountMismatch] = React.useState(workspace.directory !== fixtureDirectory);
  const [adapter, setAdapter] = React.useState('claude-code');
  const [count, setCount] = React.useState(workspace.blank ? 0 : 4);
  const [runs, setRuns] = React.useState(() => fixtureRuns(count));
  const wsl = scenario === 'workbench-12';
  return (
    <>
      <section data-surface="S2" className="wb-stack">
        <Link className="wb-link wb-muted" to="/workbench">
          Workbench / Workspaces
        </Link>
        <PageHeader title={workspace.name} description={<span className="wb-code">{workspace.directory}</span>} />
        <div className="wb-panel wb-row wb-between">
          <div>
            <h2>Agent machine</h2>
            <p className="wb-code">appliance · {vmDown ? 'Unavailable · stale' : 'Development VM · local'}</p>
          </div>
          <div>
            <label className="wb-muted" htmlFor="deployment-target">
              Deployment target
            </label>
            <select
              id="deployment-target"
              className="wb-select block"
              value={target}
              onChange={(e) => {
                if (e.target.value === 'missing') {
                  setTargetMessage('Could not select target. Previous target retained · fixture');
                  return;
                }
                setTarget(e.target.value);
                localStorage.setItem(`workbench:target:${workspace.directory}`, e.target.value);
                setTargetMessage('Target saved · fixture of .appliance/workbench.json');
              }}
            >
              <option value="local">Deployment target: Local · This computer</option>
              <option value="cloud">Deployment target: Cloud · Studio</option>
              <option value="missing">Unavailable target · failure fixture</option>
            </select>
          </div>
        </div>
        <p className="wb-status" role="status">
          {targetMessage}
        </p>
        <p className="wb-muted">
          Selecting cloud does not move the authoring directory, relocate the agent, or upload an installed bundle.
        </p>
        <div className="wb-row">
          <Button size="sm" variant="ghost" onClick={() => setVmDown(!vmDown)}>
            Toggle VM loss fixture
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMountMismatch(!mountMismatch)}>
            Toggle mount mismatch fixture
          </Button>
        </div>
        {vmDown && (
          <Banner tone="warning" title="Development VM unavailable">
            Last-known sessions retained · {capturedAt}. Cached inspection is stale.{' '}
            <Link className="wb-link" to="/machine">
              Go to Machine
            </Link>
          </Banner>
        )}
        {mountMismatch && (
          <Banner tone="warning" title="This machine is using another folder">
            Affected sessions:{' '}
            {runs
              .filter((r) => r.status === 'running')
              .map((r) => r.sessionId)
              .join(', ') || 'None recorded'}
            . No remount was requested.{' '}
            <Link className="wb-link" to="/machine">
              Machine
            </Link>
          </Banner>
        )}
      </section>
      <div className="wb-grid">
        <Sessions
          adapter={adapter}
          setAdapter={setAdapter}
          runs={runs}
          setRuns={setRuns}
          count={count}
          setCount={setCount}
          directory={workspace.directory}
          unavailable={vmDown || mountMismatch}
          wsl={wsl}
        />
        <Inspector stale={vmDown} directory={workspace.directory} />
      </div>
      <PackagePanel workspace={workspace} />
      <div className="wb-grid">
        <InstallPanel wsl={wsl} />
        <DeployPanel target={target} directory={workspace.directory} />
      </div>
    </>
  );
}

function Sessions({
  adapter,
  setAdapter,
  runs,
  setRuns,
  count,
  setCount,
  directory,
  unavailable,
  wsl,
}: {
  adapter: string;
  setAdapter: (v: string) => void;
  runs: AgentInfo[];
  setRuns: React.Dispatch<React.SetStateAction<AgentInfo[]>>;
  count: number;
  setCount: (v: number) => void;
  directory: string;
  unavailable: boolean;
  wsl: boolean;
}) {
  const host = useHost();
  const terminals = useTerminalSessions();
  const confirm = useConfirm();
  const [authBump, setAuthBump] = React.useState(0);
  const signedIn = useAgentSignedIn(Boolean(host.agentAuth), authBump);
  const resolved = AGENT_ADAPTERS.every((a) => a.type in signedIn);
  const [selected, setSelected] = React.useState('agent-workbench-0');
  const [editing, setEditing] = React.useState(() => localStorage.getItem(`workbench:editing:${directory}`) ?? '');
  const [mode, setMode] = React.useState('hidden');
  const [status, setStatus] = React.useState('Last status check: ' + capturedAt + ' · fixture');
  const [deliveryFail, setDeliveryFail] = React.useState(false);
  const [approval, setApproval] = React.useState('pending');
  const [stopping, setStopping] = React.useState(false);
  const latch = React.useRef(false);
  React.useEffect(() => {
    if (!host.vm || unavailable) return;
    const timer = window.setInterval(() => {
      void host
        .vm!.instance('appliance')
        .agent.list()
        .then((items) => {
          setRuns((previous) => [
            ...previous,
            ...items.filter(
              (item) =>
                !item.sessionId.startsWith('agent-workbench-') &&
                !previous.some((old) => old.sessionId === item.sessionId)
            ),
          ]);
        })
        .catch(() => setStatus('Could not refresh status · previous values marked stale'));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [host.vm, unavailable, setRuns]);
  const run = runs.find((r) => r.sessionId === selected);
  async function stop() {
    if (!run || latch.current) return;
    if (!(await confirm({ title: 'Stop agent', description: stopCopy, confirmLabel: 'Stop agent' }))) return;
    latch.current = true;
    setStopping(true);
    setStatus('Stopping…');
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (deliveryFail) setStatus('Could not confirm stop');
    else {
      setRuns((previous) =>
        previous.map((r) => (r.sessionId === run.sessionId ? { ...r, status: 'exited', live: false } : r))
      );
      setStatus('Ended · fixture acknowledgment');
    }
    setStopping(false);
    latch.current = false;
  }
  function interact() {
    if (!run) return;
    terminals.openSession({
      target: 'appliance',
      engine: 'microvm',
      clusterName: 'appliance',
      mode: 'host',
      sessionKey: agentSessionKey(run.sessionId),
      sessionId: run.sessionId,
      agent: { type: run.type, status: agentBadgeStatus(run.status), mode: run.mode },
      title: `Agent · ${run.task}`,
    });
    setMode('interactive');
    setStatus('Interactive terminal. Input is sent to the agent.');
  }
  return (
    <Panel title="Agent sessions" id="S3">
      <Fixture>registry, steering and workspace aggregation · F2 / F3 / architecture F03</Fixture>
      <div className="wb-status" role="status">
        {!resolved ? 'Checking sign-in…' : !signedIn[adapter] ? 'Sign in to get started' : 'Signed in · fixture'}
      </div>
      <p className="wb-muted wb-credential">Choose an agent and sign in. {credentialCopy[adapter]}</p>
      <div className="wb-auth">
        {resolved && (
          <AgentSignIn
            signedIn={signedIn}
            agentType={adapter}
            onAgentTypeChange={setAdapter}
            onAuthenticated={() => setAuthBump((n) => n + 1)}
          />
        )}
      </div>
      <label className="wb-muted">
        Editing agent{' '}
        <select
          aria-label="Editing agent"
          className="wb-select"
          value={editing}
          onChange={(e) => {
            setEditing(e.target.value);
            localStorage.setItem(`workbench:editing:${directory}`, e.target.value);
          }}
        >
          <option value="">None selected</option>
          {runs.map((r) => (
            <option key={r.sessionId} value={r.sessionId}>
              {r.sessionId}
            </option>
          ))}
        </select>
      </label>
      <p className="wb-muted">
        Advisory selection · fixture persistence. Changing it does not lock files, stop sessions or enforce read-only
        access.
      </p>
      <Banner tone="warning" title="One editing agent at a time is recommended.">
        Multiple agents can change the same files. Wait for the current agent to finish, or continue knowing their edits
        may overlap.
      </Banner>
      <p className="wb-code">{directory} · appliance</p>
      {wsl && (
        <>
          <Banner tone="warning" title="Agent brokering unavailable on this platform">
            {wslCopy}
          </Banner>
          <LogPane
            label="Technical log · fixture"
            copyText="Brokered credential injection is disabled on WSL v1: exact-lease re-attribution cannot survive SNAT; use an in-guest API key; brokered injection returns in WSL v2."
          >
            Brokered credential injection is disabled on WSL v1: exact-lease re-attribution cannot survive SNAT; use an
            in-guest API key; brokered injection returns in WSL v2.
          </LogPane>
        </>
      )}
      <LaunchAgentButton
        workbench
        name="appliance"
        agentType={adapter}
        onAgentTypeChange={setAdapter}
        onAuthenticated={() => setAuthBump((n) => n + 1)}
        disabledReason={wsl ? wslCopy : unavailable ? 'Development VM unavailable or using another folder' : undefined}
      />
      {adapter === 'copilot' && <p className="wb-muted">After launch, enter your request in the agent terminal</p>}
      <label className="wb-muted">
        Session count fixture{' '}
        <select
          aria-label="Session count fixture"
          className="wb-select"
          value={count}
          onChange={(e) => {
            const n = Number(e.target.value);
            setCount(n);
            setRuns(fixtureRuns(n));
          }}
        >
          {[0, 1, 3, 4, 20].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <div className="wb-runs">
        {runs.length === 0 ? (
          <p className="wb-muted">No agent sessions yet. Describe a task to begin.</p>
        ) : (
          runs.map((r) => (
            <div className="wb-run" key={r.sessionId}>
              <div className="wb-row wb-between">
                <button
                  className="wb-link text-sm"
                  onClick={() => {
                    setSelected(r.sessionId);
                    setStatus('Selected ' + r.sessionId);
                  }}
                >
                  <WeightLabel active={selected === r.sessionId}>{r.task ?? r.sessionId}</WeightLabel>
                </button>
                <StatusPill
                  tone={r.status === 'running' ? 'info' : r.status === 'error' ? 'error' : 'neutral'}
                  label={
                    { running: 'Running · Attached', done: 'Finished', error: 'Failed', exited: 'Ended' }[r.status]
                  }
                />
              </div>
              <p className="wb-code">
                {r.sessionId} · {agentLabel(r.type)} · {r.mode}
              </p>
              <p className="wb-muted">appliance · started {capturedAt} · fixture</p>
            </div>
          ))
        )}
      </div>
      <p className="wb-code">
        Selected: {run?.sessionId ?? 'None'} · terminal: {mode}
      </p>
      <p className="wb-muted">
        {run?.status === 'error'
          ? 'Exit code 1 · fixture: validation failed after 2 partial edits. Inspect retained files and captured result.'
          : run?.status === 'done'
            ? 'Result summary · fixture: entry form added. Inspect files; this is not package/test approval.'
            : 'No new output · ' + capturedAt + ' · fixture'}
      </p>
      <div className="wb-posture">
        <h2>Development VM</h2>
        <p>
          The microVM is the isolation boundary. The sandbox is not a jail for hostile code. {credentialCopy[adapter]}{' '}
          Development-VM egress is cooperative and bypassable. Approve, deny and stop steer the agent; they do not
          provide containment. An agent can read anything in this folder and send it out over the network.
        </p>
      </div>
      <div className="wb-row">
        <Button
          size="sm"
          variant="outline"
          disabled={!run}
          onClick={() => {
            setMode('readonly');
            setStatus('Observing · read-only · fixture');
          }}
        >
          Observe
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!run || unavailable || wsl || run.status !== 'running'}
          onClick={interact}
        >
          Interact with agent
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!run || stopping || run.status !== 'running'}
          onClick={() => void stop()}
        >
          Stop
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setMode('hidden');
            setStatus('Observation hidden · agent unchanged');
          }}
        >
          Hide observation
        </Button>
      </div>
      <p className="wb-status" role="status">
        {status}
      </p>
      <div className="wb-observation">
        {mode === 'readonly' && (
          <div className="wb-preview wb-code" tabIndex={0}>
            <Fixture>F2 · isolated static output; no terminal-write routes</Fixture>
            <p>Read-only view. You can copy output; this view sends no input. The agent may still change files.</p>
            <p>
              Observing · read-only · {selected}\nNo new output · {capturedAt}
            </p>
          </div>
        )}
        {mode === 'interactive' && <p className="wb-muted">Interactive terminal. Input is sent to the agent.</p>}
      </div>
      <div className="wb-panel wb-stack">
        <Fixture>F3 · request wb-request-1 · agent-workbench-0</Fixture>
        <h2>Needs your response · fixture</h2>
        <p className="wb-muted">
          Write index.html in {directory}. Approve or deny this request in the agent. Denying does not undo earlier
          changes.
        </p>
        <div className="wb-row">
          {['Approve this request', 'Deny this request'].map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant="outline"
              disabled={approval !== 'pending'}
              onClick={() =>
                setApproval(
                  deliveryFail
                    ? 'Response not delivered'
                    : choice === 'Approve this request'
                      ? 'Approved · fixture acknowledgment'
                      : 'Denied · fixture acknowledgment'
                )
              }
            >
              {choice}
            </Button>
          ))}
        </div>
        <p role="status" className="wb-status">
          {approval}
        </p>
        {approval !== 'pending' && (
          <Button size="sm" variant="ghost" onClick={() => setApproval('pending')}>
            Reconcile request fixture
          </Button>
        )}
        <label className="wb-muted">
          <input type="checkbox" checked={deliveryFail} onChange={(e) => setDeliveryFail(e.target.checked)} /> Delivery
          failure fixture
        </label>
      </div>
    </Panel>
  );
}

function Inspector({ directory, stale }: { directory: string; stale: boolean }) {
  const [tab, setTab] = React.useState('Changes');
  const [file, setFile] = React.useState(0);
  const [failure, setFailure] = React.useState(false);
  const [message, setMessage] = React.useState('Refreshed ' + capturedAt);
  const [baseline, setBaseline] = React.useState(true);
  const [generated, setGenerated] = React.useState(false);
  const [result, setResult] = React.useState('json');
  const [large, setLarge] = React.useState(false);
  return (
    <Panel title="Inspection" id="S4">
      <Fixture>host-side baseline / file reader / diff / result artifacts</Fixture>
      <p className="wb-code">
        Baseline: host-side snapshot · {directory} · captured {capturedAt}
      </p>
      <p className="wb-muted">
        Host desktop app data outside mounted tree · keyed by resolved directory · fixture. Initial dirty changes:
        Dockerfile modified before capture.
      </p>
      <p className="wb-muted">
        Changed since workspace baseline · workspace-wide; no per-agent attribution. Live files may change
      </p>
      <div className="wb-row">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setMessage(
              failure ? 'Could not refresh status · previous snapshot retained · stale' : 'Refreshed just now · fixture'
            )
          }
        >
          Refresh inspection
        </Button>
        <label className="wb-muted">
          <input type="checkbox" checked={failure} onChange={(e) => setFailure(e.target.checked)} /> Failed refresh
          fixture
        </label>
      </div>
      <p className="wb-status" role="status">
        {stale ? 'Cached inspection · stale' : message}
      </p>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Inspector">
          {['Changes', 'Files', 'Logs'].map((t) => (
            <TabsTrigger key={t} value={t}>
              <WeightLabel active={tab === t}>{t}</WeightLabel>
            </TabsTrigger>
          ))}
        </TabsList>
        {['Changes', 'Files'].map((t) => (
          <TabsContent key={t} value={t} className="wb-inspector pt-4">
            <div className="wb-stack">
              <label className="wb-muted">
                <input type="checkbox" checked={baseline} onChange={(e) => setBaseline(e.target.checked)} /> Host
                comparison available · fixture
              </label>
              {t === 'Changes' && !baseline ? (
                <Banner tone="warning">Comparison unavailable</Banner>
              ) : (
                <>
                  <div>
                    {files.map((f, i) => (
                      <button
                        className="wb-file wb-row wb-between"
                        key={f.path}
                        aria-pressed={file === i}
                        onClick={() => setFile(i)}
                      >
                        <WeightLabel active={file === i}>{f.path}</WeightLabel>
                        <span className="wb-muted">{f.kind}</span>
                      </button>
                    ))}
                  </div>
                  <p className="wb-code">
                    {directory}/{files[file].path}
                  </p>
                  <pre className="wb-preview wb-code" tabIndex={0}>
                    {t === 'Changes' ? files[file].diff : files[file].content}
                    {file === 4 && large
                      ? '\n[Fixture expanded preview: 100 retained entries; full live file reader blocked.]'
                      : ''}
                  </pre>
                  {file === 4 && (
                    <Button variant="outline" size="sm" onClick={() => setLarge(true)}>
                      Load large-file preview
                    </Button>
                  )}
                </>
              )}
              <label className="wb-muted">
                <input type="checkbox" checked={generated} onChange={(e) => setGenerated(e.target.checked)} /> Show
                generated .appliance and .git metadata (excluded from app-change count)
              </label>
              {generated && (
                <p className="wb-code">
                  .git/index modified after baseline · .appliance/agents.json modified after baseline · comparison still
                  uses host-side snapshot. Captured results are under Logs. fixture
                </p>
              )}
            </div>
          </TabsContent>
        ))}
        <TabsContent value="Logs" className="wb-inspector pt-4">
          <div className="wb-stack">
            <p className="wb-muted">
              Live output stays in the global terminal dock. Captured results, Package and Deploy have separate scopes.
            </p>
            <label className="wb-muted">
              Captured result fixture{' '}
              <select className="wb-select" value={result} onChange={(e) => setResult(e.target.value)}>
                <option value="json">JSON / error result</option>
                <option value="text">Text result</option>
                <option value="missing">Missing result</option>
                <option value="malformed">Malformed result</option>
              </select>
            </label>
            <p className="wb-code">.appliance/agent-results/agent-workbench-2.json · .rc</p>
            <LogPane label="Captured result · fixture" defaultOpen copyText={result}>
              {result === 'missing'
                ? 'No captured result for this session'
                : result === 'malformed'
                  ? 'Could not parse captured JSON result. Registry state remains Failed.'
                  : result === 'text'
                    ? 'Validation failed after writing index.html. Exit code: 1.'
                    : '{ "status": "error", "summary": "Validation failed after 2 partial edits", "exitCode": 1 }'}
            </LogPane>
          </div>
        </TabsContent>
      </Tabs>
    </Panel>
  );
}

function PackagePanel({ workspace }: { workspace: Workspace }) {
  const [manifest, setManifest] = React.useState(workspace.blank ? 'missing' : 'valid');
  const [ready, setReady] = React.useState(false);
  const [outcome, setOutcome] = React.useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [fail, setFail] = React.useState(false);
  const [attempts, setAttempts] = React.useState(0);
  const latch = React.useRef(false);
  async function packageClick() {
    if (latch.current) return;
    latch.current = true;
    setOutcome('running');
    setAttempts((n) => n + 1);
    // Playback of a real pre-run artifact, not a live packaging service or fabricated build.
    await new Promise((resolve) => setTimeout(resolve, 2600));
    setOutcome(fail ? 'error' : 'success');
    latch.current = false;
  }
  return (
    <Panel title="Package for review" id="S5">
      <p className="text-sm">
        Packaging creates an artifact; it does not install, publish or deploy it. You authorize each next step.
      </p>
      <Fixture>F3 readiness / F5 destination hand-off · real pre-run artifact; no live package bridge</Fixture>
      <div className="wb-row">
        <Button size="sm" variant="outline" onClick={() => setReady(!ready)}>
          Present readiness proposal
        </Button>
        <label className="wb-muted">
          Manifest fixture{' '}
          <select
            aria-label="Manifest fixture"
            className="wb-select"
            value={manifest}
            onChange={(e) => {
              setManifest(e.target.value);
              setOutcome('idle');
            }}
          >
            <option value="valid">Valid v2</option>
            <option value="missing">Missing appliance.json</option>
            <option value="v1">v1 source project</option>
          </select>
        </label>
        <label className="wb-muted">
          <input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} /> Package failure fixture
        </label>
      </div>
      <div className="wb-row wb-between wb-readiness">
        <div className="wb-status" role="status">
          {ready ? (
            <>
              <strong>Agent proposal: Ready to package.</strong> Review the changes. You decide when to package; the
              agent cannot authorize this step. Select <strong>Package</strong> to start packaging.
            </>
          ) : (
            'Manual packaging is available without an agent readiness proposal.'
          )}
        </div>
        <Button disabled={manifest !== 'valid' || outcome === 'running'} onClick={() => void packageClick()}>
          Package
        </Button>
      </div>
      <p className="wb-muted">Files are still changing. Stop editing and review them before packaging.</p>
      <p className="wb-code">Reviewed folder: {workspace.directory}</p>
      <p className="wb-muted">
        Playback source: examples/runtime/journal at {packageEvidence.revision}. The fixture diff is not certified as
        this artifact’s input.
      </p>
      {manifest !== 'valid' && (
        <Banner tone="warning">
          {manifest === 'missing'
            ? 'No appliance.json found. Workspace inspection remains available.'
            : 'This is a manifest v1 source project. Package requires a runnable manifest v2. Use ordinary source deployment.'}
        </Banner>
      )}
      <div className="wb-operation">
        <div className="wb-failure">
          {outcome === 'error' && (
            <Banner tone="error">
              Fixture signing error: signing key file unavailable. Inspect inputs, then click Package again.
            </Banner>
          )}
        </div>
        {outcome === 'idle' ? (
          <p className="wb-muted">
            No package requested. Human clicks: {attempts}. Ready proposals do not start operations.
          </p>
        ) : (
          <LongOperation
            title={
              outcome === 'running'
                ? 'Packaging…'
                : outcome === 'error'
                  ? 'Package failed'
                  : 'Package complete · real pre-run artifact'
            }
            status={outcome}
            timeClass="seconds"
            estimate=""
            leaveSafety="keep-page"
            nowLine={`Attempt ${attempts} · ${workspace.directory} · fixture playback`}
            className="wb-long-operation"
            log={
              outcome === 'error'
                ? 'fixture: signing key file unavailable; no artifact emitted for this attempt.'
                : packageEvidence.output
            }
            logProps={{ label: 'Package log', copyText: packageEvidence.output, open: true }}
          />
        )}
        {outcome === 'success' && (
          <div className="wb-stack mt-4">
            <p className="wb-code">{packageEvidence.name} · version 1.0.0 · Signature: Unsigned</p>
            <p className="wb-muted">Unsigned — publisher prompts will warn</p>
            <p className="wb-code">Digest: {packageEvidence.digest}</p>
            <p className="wb-muted">
              No install, publication or deploy was requested. Unsigned does not mean verified publisher.
            </p>
          </div>
        )}
      </div>
      <div className="wb-destinations">
        {[
          ['File — ruled v1 headline', 'A — hand-off file', 'v2 runtime bundle; a separate install decision.'],
          [
            'Catalogue — roadmapped (later)',
            'B — catalogue publish',
            'Bundle hosting and signed index publication remain unresolved.',
          ],
          [
            'Deploy — separate verb (see Deploy action)',
            'C — direct deploy',
            'Existing v1 source chain from the same folder; does not consume this bundle.',
          ],
        ].map(([label, option, copy]) => (
          <div className="wb-destination wb-stack" key={label}>
            <h2>{label}</h2>
            <p className="wb-muted">{option}</p>
            <p className="wb-muted">{copy}</p>
            <Fixture>equal-weight design-review artifact</Fixture>
          </div>
        ))}
      </div>
      <p className="wb-muted">
        Owner ruling 2026-11-11: one click = signed hand-off file; prototype shows all three for design review.
      </p>
    </Panel>
  );
}

function InstallPanel({ wsl }: { wsl: boolean }) {
  const [capability, setCapability] = React.useState(wsl ? 'cooperative' : 'strict');
  return (
    <Panel title="Install / run hand-off" id="S6">
      <Fixture>runtime capability · F6 / architecture F05; existing installer retained</Fixture>
      <p className="wb-code">{packageEvidence.name} · Local · This computer</p>
      <label className="wb-muted">
        Runtime capability fixture{' '}
        <select className="wb-select" value={capability} onChange={(e) => setCapability(e.target.value)}>
          <option value="strict">Strict</option>
          <option value="cooperative">WSL cooperative</option>
          <option value="unknown">Unknown</option>
        </select>
      </label>
      {capability === 'strict' ? (
        <Banner title="Installed-app runtime">
          Installed apps run in a separate runtime VM. Its network access is default-deny, with access allowed by
          grants. Review the publisher and requested grants before installing.
        </Banner>
      ) : capability === 'cooperative' ? (
        <Banner tone="warning" title="Cooperative runtime networking">
          Network controls on this target are bypassable. This is not enforced default-deny isolation.
        </Banner>
      ) : (
        <Banner tone="warning">
          Runtime network enforcement could not be verified.{' '}
          <Link className="wb-link" to="/setup/doctor">
            Diagnostics
          </Link>
        </Banner>
      )}
      <p className="wb-muted">
        Strict-mode refusal and explicit opt-in remain unchanged. No silent cooperative opt-in. WSL baseline conflict
        remains unresolved · fixture.
      </p>
      <Link className="wb-link" to="/apps">
        Installed Apps → Install from file
      </Link>
      <p className="wb-muted">
        Review Unknown Publisher and requested grants, then install. Open is a separate action. User-mode recipients do
        not need Workbench.
      </p>
      <Link className="wb-link" to="/catalogue">
        Catalogue · only for a genuinely published entry
      </Link>
      <div className="wb-row">
        <a className="wb-link wb-muted" href="/catalogue?mock-host&scenario=catalogue-stale">
          Stale catalogue fixture
        </a>
        <a className="wb-link wb-muted" href="/catalogue?mock-host&scenario=catalogue-unverified">
          Failed verification fixture
        </a>
        <a className="wb-link wb-muted" href="/apps?mock-host&scenario=unknown-publisher">
          Unsigned recipient fixture
        </a>
        <a className="wb-link wb-muted" href="/apps?mock-host&scenario=grant-prompt">
          Grant review fixture
        </a>
      </div>
    </Panel>
  );
}
function DeployPanel({ target, directory }: { target: string; directory: string }) {
  const [review, setReview] = React.useState(false);
  const [outcome, setOutcome] = React.useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [failure, setFailure] = React.useState(false);
  const [reconciled, setReconciled] = React.useState(false);
  const latch = React.useRef(false);
  async function deploy() {
    if (latch.current) return;
    latch.current = true;
    setOutcome('running');
    await new Promise((resolve) => setTimeout(resolve, 2600));
    setOutcome(failure ? 'error' : 'success');
    latch.current = false;
    setReconciled(false);
  }
  return (
    <Panel title="Deploy" id="S7">
      <Fixture>source deployment outcome / F5 package promotion / architecture F03, F05</Fixture>
      <p className="wb-code">
        Target: {target === 'local' ? 'Local · This computer' : 'Cloud · Studio'}
        <br />
        Project: journal · Environment: preview
        <br />
        Source: {directory}
      </p>
      <Banner title="Package promotion is not available yet">
        Bundle / compound promotion remains fixture-only. A cloud target on an installed record does not deploy it
        remotely.
      </Banner>
      <Link className="wb-link" to="/projects/deploy">
        Open ordinary source deployment
      </Link>
      <p className="wb-muted">
        Projects → Deploy works without Workbench, agent sign-in or a package. Review target and source in that flow.
      </p>
      <Button variant="outline" onClick={() => setReview(!review)}>
        {review ? 'Back' : 'Review deploy fixture'}
      </Button>
      <div className="wb-operation">
        {review && (
          <div className="wb-stack">
            <p>Review source deployment · fixture</p>
            <label className="wb-muted">
              <input type="checkbox" checked={failure} onChange={(e) => setFailure(e.target.checked)} /> Timeout failure
              fixture
            </label>
            <Button
              disabled={outcome === 'running' || (outcome === 'error' && !reconciled)}
              onClick={() => void deploy()}
            >
              {outcome === 'error' ? 'Retry deploy' : 'Deploy'}
            </Button>
            <div className="wb-reconcile">
              {outcome === 'error' && (
                <Button variant="outline" onClick={() => setReconciled(true)}>
                  Reconcile deployment fixture
                </Button>
              )}
            </div>
            <div className="wb-failure">
              {outcome === 'error' && (
                <Banner tone="error">
                  Transport timeout. Inspect deployment wb-deploy-1 before retry. No rollback is implied.
                </Banner>
              )}
            </div>
            {outcome !== 'idle' && (
              <LongOperation
                title={
                  outcome === 'running'
                    ? 'Deploying…'
                    : outcome === 'error'
                      ? 'Deploy failed'
                      : 'Deployment completed. No app address was returned.'
                }
                status={outcome}
                timeClass="seconds"
                estimate=""
                leaveSafety="keep-page"
                nowLine={`fixture · ${target} · journal / preview · deployment wb-deploy-1`}
                className="wb-long-operation"
                log="fixture: build wb-build-1; deployment wb-deploy-1; outcome retained. No URL was returned."
                logProps={{ label: 'Deploy log', open: true }}
              />
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
