// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { HostProvider } from './host-provider';
import { AgentInputMode } from '@/pages/workbench/agent-input-mode';
import { TerminalSessionsProvider, useTerminalSessions } from './terminal-sessions-provider';
import type { ConsoleHost } from '@/lib/host';
const terminals = vi.hoisted(
  () => [] as { input: (data: string) => void; options: { disableStdin?: boolean }; focusCalls: number }[]
);
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options;
    input = (_: string) => {};
    cols = 80;
    rows = 24;
    buffer = { active: { type: 'normal' } };
    constructor(options: { disableStdin?: boolean }) {
      this.options = options;
      terminals.push(this);
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    open() {}
    focusCalls = 0;
    focus() {
      this.focusCalls++;
    }
    write() {}
    dispose() {}
    onData(fn: (data: string) => void) {
      this.input = fn;
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
let api: ReturnType<typeof useTerminalSessions>;
function Probe() {
  api = useTerminalSessions();
  return (
    <>
      {api.sessions.map((session) => (
        <div key={session.id}>
          <AgentInputMode session={session} />
          <AgentInputMode session={session} />
        </div>
      ))}
    </>
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  terminals.length = 0;
});
afterEach(() => vi.unstubAllGlobals());
it('guards every onData write, preserves shared mode, and Hide keeps the PTY alive', async () => {
  const write = vi.fn();
  const close = vi.fn();
  const open = vi.fn().mockResolvedValue({ write, close, resize: vi.fn() });
  const host = { terminal: { open } } as unknown as ConsoleHost;
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <HostProvider host={host}>
        <TerminalSessionsProvider>
          <Probe />
        </TerminalSessionsProvider>
      </HostProvider>
    )
  );
  try {
    const opts = {
      target: 'vm',
      clusterName: 'vm',
      engine: 'microvm' as const,
      mode: 'host' as const,
      sessionId: 'agent-test',
      agent: { type: 'codex', status: 'running' as const },
    };
    let id = '';
    await act(async () => {
      id = api.openSession({ ...opts, inputMode: 'observe' });
    });
    expect(api.sessions[0].inputMode).toBe('observe');
    expect(container.textContent?.match(/Observing · read-only/g)).toHaveLength(2);
    expect(terminals[0].options.disableStdin).toBe(true);
    expect(terminals[0].focusCalls).toBe(0); // drawer must capture opener before attachView focuses

    for (const data of ['typing', '\u001b[200~pasted\u001b[201~', '\r', '\u0003', '\u001b[A']) terminals[0].input(data);
    expect(write).not.toHaveBeenCalled();
    await act(async () => api.setInputMode(id, 'interactive'));
    terminals[0].input('negative control: deliberate input');
    expect(write).toHaveBeenCalledExactlyOnceWith('negative control: deliberate input');
    await act(async () => {
      expect(api.openSession({ ...opts, inputMode: 'observe' })).toBe(id);
    });
    expect(api.sessions[0].inputMode).toBe('interactive');
    expect(container.textContent?.match(/Interactive terminal. Input is sent to the agent./g)).toHaveLength(2); // existing interactive tab is never falsely relabeled
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => api.setInputMode(id, 'observe'));
    terminals[0].input('blocked again');
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => api.hide());
    expect(api.activeId).toBeNull();
    expect(api.sessions).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    await act(async () => api.focusSession(id));
    expect(api.activeId).toBe(id);
    // Negative control: ordinary Agents callers remain interactive.
    await act(async () => {
      api.openSession({ ...opts, sessionId: 'agent-existing' });
    });
    expect(terminals[1].focusCalls).toBe(1); // negative control: ordinary caller retains focus behavior
    terminals[1].input('ordinary input');
    expect(write).toHaveBeenLastCalledWith('ordinary input');
    // Same guest id on another machine must not inherit this tab's authorization.
    await act(async () => {
      api.openSession({ ...opts, target: 'other', clusterName: 'other', inputMode: 'observe' });
    });
    expect(open).toHaveBeenCalledTimes(3);
    terminals[2].input('wrong machine');
    expect(write).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});

it('keeps Interact focusable but guards activation while connecting', async () => {
  let resolve!: (value: unknown) => void;
  const open = vi.fn(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <HostProvider host={{ terminal: { open } } as unknown as ConsoleHost}>
        <TerminalSessionsProvider>
          <Probe />
        </TerminalSessionsProvider>
      </HostProvider>
    )
  );
  try {
    await act(async () => {
      api.openSession({ target: 'vm', inputMode: 'observe', agent: { type: 'codex', status: 'running' } });
    });
    const button = container.querySelector('button')!;
    button.focus();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await act(async () => button.click());
    expect(api.sessions[0].inputMode).toBe('observe');
    expect(document.activeElement).toBe(button);
    await act(async () => resolve({ write: vi.fn(), close: vi.fn(), resize: vi.fn() }));
    expect(button.getAttribute('aria-disabled')).toBe('false');
    await act(async () => button.click()); // negative control: same action works once live
    expect(api.sessions[0].inputMode).toBe('interactive');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
