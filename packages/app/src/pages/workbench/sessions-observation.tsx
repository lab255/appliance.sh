import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useHost } from '@/providers/host-provider';
import { useTerminalSessions, agentBadgeStatus, agentSessionKey } from '@/providers/terminal-sessions-provider';
import { paintPending } from '@/lib/paint-pending';
import type { WorkbenchWorkspace, WorkbenchSession } from '@/lib/host';
import { AgentInputMode } from './agent-input-mode';

/** F3 has no structured event bridge. This presentation-only fixture never authorizes input. */
export interface AcceptanceFixture {
  kind: 'fixture-only';
  sessionId: string;
  text: string;
}
export function SessionsObservation({
  workspace,
  acceptanceFixture,
}: {
  workspace: WorkbenchWorkspace;
  acceptanceFixture?: AcceptanceFixture;
}) {
  return (
    <section aria-label="Sessions" className="min-h-64 min-w-0 rounded-lg border border-border p-4">
      <h2 className="mb-3 font-semibold">Sessions</h2>
      <p className="text-sm">One editing agent per folder is advisory. Observing does not constrain the agent.</p>
      {!workspace.sessions.length && <p>No recorded agent sessions. Launch is available in Agents.</p>}
      {workspace.sessions.map((run) => (
        <SessionRow key={`${run.vm}:${run.sessionId}`} run={run} workspace={workspace} />
      ))}
      {/* Reserve the arrival region; structured acceptance remains explicitly fixture-only (F3). */}
      {acceptanceFixture && (
        <div
          aria-label="Acceptance fixture"
          className="mt-3 h-32 overflow-auto rounded-md border border-border p-3 text-sm"
        >
          <p>Fixture-only · simulated acceptance feed · {acceptanceFixture.sessionId}</p>
          <p role="status">{acceptanceFixture.text || 'Waiting for simulated acceptance…'}</p>
          <p>Simulated launch acceptance only. No agent is launched or authorized by this fixture.</p>
        </div>
      )}
    </section>
  );
}
function SessionRow({ run, workspace }: { run: WorkbenchSession; workspace: WorkbenchWorkspace }) {
  const host = useHost();
  const terminals = useTerminalSessions();
  const confirm = useConfirm();
  const vm = run.vm || workspace.machine;
  const [busy, setBusy] = React.useState(false);
  const [opening, setOpening] = React.useState(false);
  const openingRef = React.useRef(false);
  const lock = React.useRef(false);
  const [error, setError] = React.useState('');
  const query = useQuery({
    queryKey: ['workbench-session', workspace.directory, vm, run.sessionId],
    enabled: !!host.vm && !!vm,
    queryFn: async () => {
      const machines = await host.vm!.list();
      if (!machines.some((machine) => machine.name === vm && machine.running))
        throw new Error('Development VM unavailable');
      const records = await host.vm!.instance(vm!).agent.list();
      const record = records.find((record) => record.sessionId === run.sessionId);
      if (!record) throw new Error('Session is not present in the current machine registry');
      return record;
    },
    retry: false,
    refetchInterval: 5_000,
  });
  const record = query.data;
  const observable =
    !!host.terminal &&
    !!record &&
    !query.isError &&
    record.live === true &&
    record.status === 'running' &&
    workspace.mount === workspace.directory;
  const session = terminals.sessions.find((item) => item.sessionId === run.sessionId && item.clusterName === vm);
  const reason =
    workspace.mount !== workspace.directory
      ? 'The development machine is not mounted to this folder.'
      : query.isError
        ? String(query.error)
        : !host.terminal
          ? 'Terminal transport unavailable.'
          : !observable
            ? 'A confirmed live agent session is required.'
            : '';
  async function stop() {
    if (!observable || lock.current) return;
    lock.current = true;
    try {
      if (
        !(await confirm({
          title: 'Stop this agent session?',
          description: 'Changes already made remain. Stopping does not undo actions or contain hostile code.',
          confirmLabel: 'Stop agent',
        }))
      )
        return;
      await paintPending(() => {
        setBusy(true);
        setError('');
      });
      await host.vm!.instance(vm!).agent.stop(run.sessionId);
      await query.refetch();
    } catch (e) {
      setError(`Could not confirm stop: ${String(e)}`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <article className="mt-4 space-y-2 border-t border-border pt-3">
      <p className="break-all font-mono text-sm">
        {run.sessionId} · {vm || 'No machine assigned'}
      </p>
      <p>
        Registry: {record?.status ?? run.status}
        {query.isError ? ' · stale' : ''}
      </p>
      <p className="text-sm">
        {query.dataUpdatedAt
          ? `Last status check: ${new Date(query.dataUpdatedAt).toISOString()}`
          : 'Status has not been checked.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          aria-disabled={!observable || busy || opening}
          onClick={() => {
            if (!observable || busy || !record || openingRef.current) return;
            openingRef.current = true;
            void paintPending(() => setOpening(true))
              .then(() => {
                terminals.openSession({
                  target: vm!,
                  clusterName: vm,
                  engine: 'microvm',
                  mode: 'host',
                  sessionId: run.sessionId,
                  sessionKey: agentSessionKey(run.sessionId),
                  inputMode: 'observe',
                  agent: { type: record.type, status: agentBadgeStatus(record.status), mode: record.mode },
                });
              })
              .finally(() => {
                openingRef.current = false;
                setOpening(false);
              });
          }}
        >
          {opening ? 'Opening observation…' : 'Observe'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-disabled={!session || terminals.activeId !== session.id}
          onClick={() => {
            if (session && terminals.activeId === session.id) terminals.hide();
          }}
        >
          Hide observation
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-disabled={!observable || busy}
          aria-busy={busy}
          onClick={() => void stop()}
        >
          {busy ? 'Stopping…' : 'Stop agent'}
        </Button>
      </div>
      <div className="min-h-12 text-sm">
        <p>{reason || 'Hide keeps the agent running. Stop does not undo its changes.'}</p>
        {error && <p role="alert">{error}</p>}
      </div>
      <AgentInputMode session={session} type={record?.type} />
      {run.summary && <p className="max-h-32 overflow-auto text-sm">{run.summary}</p>}
    </article>
  );
}
