// @vitest-environment jsdom
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionsObservation } from '@/pages/workbench/sessions-observation';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { HostProvider } from './host-provider';
import { AgentInputMode } from '@/pages/workbench/agent-input-mode';
import { TerminalSessionsProvider, useTerminalSessions } from './terminal-sessions-provider';
import type { ConsoleHost } from '@/lib/host';
vi.mock('@/components/ui/confirm-dialog', () => ({ useConfirm: () => async () => false }));
const terminals = vi.hoisted(
  () =>
    [] as {
      input: (data: string) => void;
      options: { disableStdin?: boolean; cursorBlink?: boolean };
      focusCalls: number;
      element: HTMLElement;
    }[]
);
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options;
    input = (_: string) => {};
    cols = 80;
    rows = 24;
    buffer = { active: { type: 'normal' } };
    constructor(options: { disableStdin?: boolean; cursorBlink?: boolean }) {
      this.options = options;
      terminals.push(this);
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    element!: HTMLElement;
    open(element: HTMLElement) {
      this.element = element;
    }
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
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
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
    expect(terminals[0].options.disableStdin).toBe(false); // input must reach the refusal guard
    expect(terminals[0].options.cursorBlink).toBe(false);
    expect(terminals[0].focusCalls).toBe(0); // drawer must capture opener before attachView focuses

    vi.useFakeTimers();
    const refusal = 'Input not sent — observing read-only. Choose Interact with agent.';
    await act(async () => terminals[0].input('\u001b[1;1R'));
    expect(container.textContent).not.toContain(refusal);
    expect(write).not.toHaveBeenCalled();
    terminals[0].element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    await act(async () => {
      for (const data of [
        'typing',
        '\u001b[200~pasted\u001b[201~',
        '\r',
        '\u0003',
        '\u0004',
        '\u001b[A',
        '\u001b[B',
        '\u001b[C',
        '\u001b[D',
      ])
        terminals[0].input(data);
    });
    expect([...container.querySelectorAll('[role=status]')].some((node) => node.textContent === refusal)).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(container.textContent).not.toContain(refusal);
    await act(async () => terminals[0].input('\u001b[?1;2c'));
    expect(container.textContent).not.toContain(refusal);
    terminals[0].element.dispatchEvent(new Event('paste', { bubbles: true }));
    await act(async () => terminals[0].input('another refused write'));
    expect(container.textContent).toContain(refusal);
    vi.useRealTimers();
    expect(write).not.toHaveBeenCalled();
    await act(async () => api.setInputMode(id, 'interactive'));
    expect(container.textContent).not.toContain(refusal);
    expect(terminals[0].options.cursorBlink).toBe(true);
    terminals[0].input('negative control: deliberate input');
    expect(write).toHaveBeenCalledExactlyOnceWith('negative control: deliberate input');
    await act(async () => {
      expect(api.openSession({ ...opts, inputMode: 'observe' })).toBe(id);
    });
    expect(api.sessions[0].inputMode).toBe('interactive');
    expect(container.textContent?.match(/Interactive terminal. Input is sent to the agent./g)).toHaveLength(2); // existing interactive tab is never falsely relabeled
    terminals[0].input('after dedupe');
    expect(write).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => api.setInputMode(id, 'observe'));
    expect(container.textContent).not.toContain(refusal); // old refusals do not reappear on mode changes
    await act(async () => terminals[0].input('blocked again'));
    expect(write).toHaveBeenCalledTimes(2);
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
    await act(async () => terminals[2].input('wrong machine'));
    expect(write).toHaveBeenCalledTimes(3);
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

it('Workbench Observe defaults to read-only through the real component and provider', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const write = vi.fn();
  const open = vi.fn().mockResolvedValue({ write, close: vi.fn(), resize: vi.fn() });
  const instance = {
    shell: { list: vi.fn().mockResolvedValue([]) },
    agent: {
      list: vi.fn().mockResolvedValue([{ sessionId: 'agent-workbench', type: 'codex', status: 'running', live: true }]),
    },
  };
  const host = {
    terminal: { open },
    vm: { list: vi.fn().mockResolvedValue([{ name: 'vm', running: true }]), instance: () => instance },
  } as unknown as ConsoleHost;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <HostProvider host={host}>
          <QueryClientProvider client={client}>
            <TerminalSessionsProvider>
              <SessionsObservation
                workspace={{
                  directory: '/project',
                  mount: '/project',
                  machine: 'vm',
                  binding: { version: 1 },
                  sessions: [{ sessionId: 'agent-workbench', vm: 'vm', status: 'running' }],
                }}
              />
            </TerminalSessionsProvider>
          </QueryClientProvider>
        </HostProvider>
      )
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const observe = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Observe')!;
    expect(observe.getAttribute('aria-disabled')).toBe('false');
    await act(async () => {
      observe.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(open).toHaveBeenCalledOnce();
    await act(async () => terminals[0].input('Workbench must not forward this'));
    expect(write).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Observing · read-only');
    const interact = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Interact with agent'
    )!;
    await act(async () => interact.click());
    terminals[0].input('deliberate interaction negative control');
    expect(write).toHaveBeenCalledExactlyOnceWith('deliberate interaction negative control');
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});
