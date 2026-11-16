import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@appliance.sh/ui';
import { useHost } from '@/providers/host-provider';
import { paintPending } from '@/lib/paint-pending';
import type { Inspection, InspectionPreview } from '@/lib/inspection';

/** Workspace-wide, read-only inspection; no inferred per-agent attribution. */
export function WorkspaceInspector({ directory }: { directory: string }) {
  return <Inspector key={directory} directory={directory} />;
}
function Inspector({ directory }: { directory: string }) {
  const host = useHost();
  const [snapshot, setSnapshot] = React.useState<Inspection>();
  const [preview, setPreview] = React.useState<InspectionPreview>();
  const [selected, setSelected] = React.useState('');
  const [tab, setTab] = React.useState('changes');
  const [focusedPath, setFocusedPath] = React.useState('');
  const positions = React.useRef<Record<string, { top: number; left: number }>>({});
  const [generated, setGenerated] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [failureKind, setFailureKind] = React.useState('initial refresh');
  const request = React.useRef(0);
  const reader = React.useRef<HTMLPreElement>(null);
  const busyRef = React.useRef(false);
  const loadedLargePaths = React.useRef(new Set<string>());

  React.useEffect(() => {
    let active = true;
    setBusy('Loading inspection…');
    host
      .inspectionRefresh?.(directory)
      .then((value) => {
        if (active) {
          setSnapshot(value);
          setBusy('');
        }
      })
      .catch((e: unknown) => {
        if (active) {
          setError(String(e));
          setBusy('');
        }
      });
    if (!host.inspectionRefresh) {
      setError('Host inspection is unavailable');
      setBusy('');
    }
    return () => {
      active = false;
      request.current++;
    };
  }, [directory, host]);

  function savePosition() {
    if (reader.current)
      positions.current[`${tab}:${selected}`] = { top: reader.current.scrollTop, left: reader.current.scrollLeft };
  }
  React.useLayoutEffect(() => {
    const position = positions.current[`${tab}:${selected}`];
    if (reader.current) {
      reader.current.scrollTop = position?.top ?? 0;
      reader.current.scrollLeft = position?.left ?? 0;
    }
  }, [tab, selected, preview]);
  function changeTab(value: string) {
    savePosition();
    setTab(value);
  }
  async function select(path: string, large = false) {
    savePosition();
    if (large) loadedLargePaths.current.add(path);
    const id = ++request.current;
    await paintPending(() => {
      setSelected(path);
      setBusy('Loading file…');
    });
    try {
      if (!host.inspectionRead || !snapshot) throw new Error('Host inspection is unavailable');
      const value = await host.inspectionRead(directory, path, loadedLargePaths.current.has(path), snapshot.snapshotId);
      if (id === request.current) {
        setPreview(value);
        setBusy('');
      }
    } catch (e) {
      if (id === request.current) {
        setError(String(e));
        setFailureKind('file load');
        setBusy('');
      }
    }
  }
  async function refresh() {
    if (busyRef.current) return;
    busyRef.current = true;
    const id = ++request.current;
    savePosition();
    await paintPending(() => setBusy('Refreshing…'));
    try {
      if (!host.inspectionRefresh) throw new Error('Host inspection is unavailable');
      const value = await host.inspectionRefresh(directory);
      const next =
        selected && host.inspectionRead
          ? await host.inspectionRead(directory, selected, loadedLargePaths.current.has(selected), value.snapshotId)
          : undefined;
      if (id === request.current) {
        setSnapshot(value);
        setPreview(next);
        setError('');
      }
    } catch (e) {
      if (id === request.current) {
        setError(String(e));
        setFailureKind('refresh');
      }
    } finally {
      busyRef.current = false;
      if (id === request.current) setBusy('');
    }
  }
  const hiddenChanges = generated
    ? 0
    : (snapshot?.entries ?? []).filter(
        (entry) => entry.generated && entry.state !== 'unchanged' && !entry.path.endsWith('/')
      ).length;
  const entries = (snapshot?.entries ?? []).filter((entry) => generated || !entry.generated);
  const changes = entries.filter((entry) => entry.state !== 'unchanged' && !entry.path.endsWith('/'));
  const shown = tab === 'changes' ? changes : entries;
  const matching = preview?.path === selected ? preview : undefined;
  const comparisonUnavailable = !snapshot || !!snapshot.comparisonError || !!error;
  const content = tab === 'changes' ? matching?.diff : matching?.text;
  const list = (
    <div className="grid h-96 min-h-0 grid-cols-[minmax(10rem,1fr)_minmax(0,3fr)] overflow-hidden rounded-md border border-border">
      <div
        role="tree"
        aria-label={tab === 'changes' ? 'Changed files' : 'Workspace files'}
        className="overflow-auto border-r border-border"
      >
        {shown.map((entry) => (
          <button
            key={entry.path}
            role="treeitem"
            aria-selected={selected === entry.path}
            aria-level={tab === 'files' ? entry.path.replace(/\/$/, '').split('/').length : 1}
            aria-expanded={entry.path.endsWith('/') ? true : undefined}
            tabIndex={
              entry.path === (shown.some((item) => item.path === focusedPath) ? focusedPath : shown[0]?.path) ? 0 : -1
            }
            onFocus={() => setFocusedPath(entry.path)}
            disabled={busyRef.current}
            className="block w-full break-all px-3 py-2 text-left text-sm hover:bg-[var(--color-hover)] focus-visible:outline focus-visible:outline-ring data-[selected=true]:bg-[var(--color-active)]"
            style={{
              paddingLeft:
                tab === 'files'
                  ? `${Math.min(entry.path.replace(/\/$/, '').split('/').length, 8) * 0.75}rem`
                  : undefined,
            }}
            data-path={entry.path}
            data-selected={selected === entry.path}
            onClick={() => void select(entry.path)}
            onKeyDown={(event) => {
              const siblings = Array.from(
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=treeitem]') ?? []
              );
              const index = siblings.indexOf(event.currentTarget);
              const parentPath = `${entry.path.replace(/\/$/, '').split('/').slice(0, -1).join('/')}/`;
              const next =
                event.key === 'ArrowLeft'
                  ? siblings.findIndex((item) => item.dataset.path === parentPath)
                  : event.key === 'ArrowDown' || (event.key === 'ArrowRight' && entry.path.endsWith('/'))
                    ? index + 1
                    : event.key === 'ArrowUp'
                      ? index - 1
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? siblings.length - 1
                          : -1;
              if (next >= 0 && next < siblings.length) {
                event.preventDefault();
                siblings[next].focus();
              }
            }}
          >
            {entry.path}
            <span className="block text-xs text-muted-foreground">
              {entry.state} · {entry.size} bytes{entry.generated ? ' · generated / Logs' : ''}
            </span>
          </button>
        ))}
        {!shown.length && (
          <p className="p-3 text-sm text-muted-foreground">
            {comparisonUnavailable
              ? 'Comparison unavailable'
              : tab === 'changes'
                ? hiddenChanges
                  ? `No changes to tracked files. ${hiddenChanges} generated paths changed and are not shown (.appliance/agents.json, .appliance/agent-results/*, .appliance/.agents.*). Enable the generated filter to inspect them.`
                  : 'No changes since workspace baseline'
                : 'Empty directory'}
          </p>
        )}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div
          role="region"
          tabIndex={0}
          aria-label="Selected path and preview limits"
          className="h-24 shrink-0 overflow-auto border-b border-border p-3 text-sm"
        >
          <p className="break-all font-medium">{selected || 'Select a file'}</p>
          <p>{matching?.notice ?? (matching ? `${matching.size} bytes · read-only` : 'Read-only snapshot preview')}</p>
          {matching?.needsLoad && (
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void select(selected, true)}>
              Load large file
            </Button>
          )}
        </div>
        <pre
          ref={reader}
          role="region"
          tabIndex={0}
          aria-label={tab === 'changes' ? 'Unified diff' : 'File preview'}
          className="min-h-0 flex-1 overflow-auto p-3 text-xs"
        >
          {content ??
            (tab === 'changes' && comparisonUnavailable
              ? 'Comparison unavailable'
              : (matching?.notice ?? 'Select a file to read its snapshot.'))}
        </pre>
      </div>
    </div>
  );
  return (
    <section aria-label="Workspace inspection" className="space-y-3">
      <div role="region" tabIndex={0} aria-label="Baseline and refresh status" className="h-32 overflow-auto text-sm">
        <p className="break-all">
          Baseline: host-side snapshot · {snapshot?.directory ?? directory} · captured{' '}
          {snapshot?.capturedAt ?? 'unavailable'}
        </p>
        <p className="text-muted-foreground">On a host you do not control, the host-side baseline guarantee weakens.</p>
        <p>Refreshed {snapshot?.refreshedAt ?? 'not yet'} · Live files may change</p>
        <p role="status" className="min-h-5">
          {busy ||
            (error
              ? snapshot
                ? `Previous snapshot is stale — captured ${snapshot.refreshedAt}; ${failureKind} failed`
                : `Comparison unavailable — ${failureKind} failed`
              : snapshot?.comparisonError
                ? 'Comparison unavailable'
                : 'Read-only · workspace-wide')}
        </p>
        {(error || snapshot?.comparisonError) && <p role="alert">{error || snapshot?.comparisonError}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={!!busy} onClick={() => void refresh()}>
          Refresh inspection
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={generated} onChange={(event) => setGenerated(event.target.checked)} />
          Include generated registry/results (results belong to Logs)
        </label>
      </div>
      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList aria-label="Inspector">
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <div className="h-[30rem] overflow-auto">
          <TabsContent value="changes">
            <p className="mb-2 text-sm">
              Changed since workspace baseline
              {!comparisonUnavailable
                ? ` · ${changes.length} files${hiddenChanges ? ` · ${hiddenChanges} generated changes hidden` : ''}`
                : ' · Comparison unavailable'}
            </p>
            {list}
            <details className="mt-3 text-sm">
              <summary>Initial state at workspace open (separate from since-baseline changes)</summary>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap">
                {snapshot?.initialGitStatus ?? 'Initial state unavailable'}
                {snapshot?.initialGitStatus === '' ? 'Git reported a clean working tree at capture.' : ''}
              </pre>
            </details>
          </TabsContent>
          <TabsContent value="files">
            <p className="mb-2 text-sm">Read-only file tree · paths relative to the resolved directory</p>
            {list}
          </TabsContent>
          <TabsContent value="logs">
            <p className="text-sm text-muted-foreground">
              Logs integration is not available yet. Generated result artifacts belong here.
            </p>
          </TabsContent>
        </div>
      </Tabs>
    </section>
  );
}
