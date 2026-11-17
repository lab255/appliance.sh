/** Development-only fixture. Not imported by the application entry point. */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionProvider } from '@appliance.sh/ui';
import { ConfirmProvider, useConfirm } from '@/components/ui/confirm-dialog';
import { HostProvider } from '@/providers/host-provider';
import { TerminalSessionsProvider } from '@/providers/terminal-sessions-provider';
import { TerminalLayer } from '@/pages/local-runtime/terminal-drawer';
import type { ConsoleHost } from '@/lib/host';
import { SessionsObservation } from './sessions-observation';
import '@/styles.css';
const params = new URLSearchParams(location.search);
const trace: string[] = [];
Object.assign(window, { w4Trace: trace });
let stopped = false;
const host = {
  terminal: {
    async open(_opts: unknown, event: (event: { type: string; data: string }) => void) {
      trace.push('attach');
      event({ type: 'data', data: 'Fixture-only agent output. Select and copy this text.\r\n' });
      return {
        write(data: string) {
          trace.push(`write:${data}`);
        },
        resize() {},
        close() {
          trace.push('close');
        },
      };
    },
  },
  vm: {
    async list() {
      return [{ name: 'fixture-vm', running: true }];
    },
    instance() {
      return {
        shell: {
          async list() {
            return [];
          },
        },
        agent: {
          async list() {
            return [
              {
                sessionId: 'agent-fixture',
                type: 'codex',
                status: stopped ? 'exited' : 'running',
                live: !stopped,
                mode: 'interactive',
              },
            ];
          },
          async stop() {
            trace.push('stop');
            await new Promise((resolve) => setTimeout(resolve, 300));
            if (params.has('fail-stop')) throw new Error('fixture delivery failed');
            stopped = true;
          },
        },
      };
    },
  },
} as unknown as ConsoleHost;
function ConfirmOnly() {
  const confirm = useConfirm();
  return (
    <button
      onClick={() =>
        void confirm({ title: 'Standalone confirmation', confirmLabel: 'Confirm probe' }).then((ok) =>
          trace.push(`confirmed:${ok}`)
        )
      }
    >
      Open standalone confirmation
    </button>
  );
}
function Audit() {
  const [text, setText] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => setText('Session accepted · agent-fixture · Observing · read-only'), 65_000);
    Object.assign(window, { w4Accept: () => setText('Session accepted · agent-fixture · Observing · read-only') });
    return () => clearTimeout(timer);
  }, []);
  const acceptanceFixture = { kind: 'fixture-only' as const, sessionId: 'agent-fixture', text };
  return (
    <main className="mx-auto max-w-5xl p-6">
      {params.has('negative') && <style>{'[aria-label="Sessions"] { min-height: 0 !important; }'}</style>}
      <h1 className="mb-4 text-xl">F2 / S3 · fixture-only transport and acceptance</h1>
      <SessionsObservation
        workspace={{
          directory: '/fixture',
          mount: '/fixture',
          machine: 'fixture-vm',
          binding: { version: 1 },
          sessions: params.has('acceptance')
            ? []
            : [{ sessionId: 'agent-fixture', vm: 'fixture-vm', status: 'running' }],
        }}
        acceptanceFixture={params.has('negative') && !text ? undefined : acceptanceFixture}
      />
      <p className="mt-4">Inspection and human Package remain separate from agent acceptance.</p>
      <TerminalLayer />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <MotionProvider>
    <MemoryRouter>
      <HostProvider host={host}>
        <QueryClientProvider client={new QueryClient()}>
          <TerminalSessionsProvider>
            <ConfirmProvider>{params.has('confirm-only') ? <ConfirmOnly /> : <Audit />}</ConfirmProvider>
          </TerminalSessionsProvider>
        </QueryClientProvider>
      </HostProvider>
    </MemoryRouter>
  </MotionProvider>
);
