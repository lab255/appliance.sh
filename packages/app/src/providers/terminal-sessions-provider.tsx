import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useHost } from '@/providers/host-provider';
import { agentLabel } from '@/lib/agents';
import type { TerminalSession } from '@/lib/host';

// App-root store for live terminal sessions (E3.2).
//
// The xterm `Terminal`, its `FitAddon`, the DOM node it is bound to, and
// the host `TerminalSession` (the PTY handle) all live *here*, in a
// provider mounted above the router — not in any route component. That is
// what lets a shell survive in-app navigation: route changes swap the
// `<Outlet/>` underneath, but these objects (and the guest process behind
// the PTY) are never unmounted, so nothing calls `session.close()`.
//
// A session is created/focused by `openSession` and only ever torn down by
// the explicit `closeSession` action — closing is now a deliberate user
// action, not a route-unmount side effect.
//
// The provider keeps two parallel views of each session:
//   - the heavy, non-serializable objects (term/fit/container/session) in a
//     ref-held `Map`, so re-renders never recreate them;
//   - a light `TerminalSessionMeta` in React state, so the chrome (title,
//     status pill) re-renders when status changes.

export type TerminalStatus = 'connecting' | 'open' | 'closed' | 'error';

/** Plain-language label for a session status. Shared by the dock tab
 *  (E3.3) and the drawer pill (E3.2) so the four-way status semantics
 *  ('open' = Live, 'connecting', 'error', 'closed' = Ended) can't drift
 *  between the two copies. */
export function statusLabel(status: TerminalStatus): string {
  return status === 'open' ? 'Live' : status === 'connecting' ? 'Connecting…' : status === 'error' ? 'Error' : 'Ended';
}

/** Tailwind classes for the small status dot, keyed by status — also shared
 *  by both surfaces so the colour semantics (green pulse = Live, red =
 *  Error, muted pulse = Connecting, muted = Ended) stay in lock-step. */
export function statusDotClass(status: TerminalStatus): string {
  return status === 'open'
    ? 'animate-pulse bg-[var(--color-success)]'
    : status === 'error'
      ? 'bg-[var(--color-destructive)]'
      : status === 'connecting'
        ? 'animate-pulse bg-[var(--color-muted-foreground)]'
        : 'bg-[var(--color-muted-foreground)]';
}

/** Agent-tab metadata (Phase 5, A5). When present on a session it is a
 *  coding agent rather than a plain shell: the dock tab renders an agent
 *  icon + status, and rehydrate brings the session back as an agent tab.
 *  The transport is still the reattachable host shell, attached to the
 *  agent's `agent-<id>` tmux session. */
export interface AgentTabMeta {
  /** Adapter key, e.g. `claude-code`. */
  type: string;
  /** Lifecycle for the badge. Interactive observe stays `running`;
   *  `done`/`error` are autonomous-result states (A6). */
  status: 'running' | 'done' | 'error';
  /** How the agent runs. Drives the `running` badge glyph: an interactive
   *  agent is an attached live TTY (steady glyph), while an autonomous run
   *  is genuinely working (spinner). Absent → treated as autonomous so the
   *  spinner is the conservative default. */
  mode?: 'interactive' | 'autonomous';
}

/** Args to open or focus a terminal session. */
export interface OpenTerminalOptions {
  /** kubectl/shell target — a pod name, or the VM name for a host shell. */
  target: string;
  /** 'microvm' routes through the microVM's kubeconfig / vsock shell. */
  engine?: 'microvm';
  /** For the microVM engine, the VM name (routes to its kubeconfig). */
  clusterName?: string;
  /** 'dev'/'host' open a shell into the microVM host itself instead of a
   *  `kubectl exec` into a pod. */
  mode?: 'dev' | 'host';
  /** Header label. Defaults to a label derived from engine/mode. */
  title?: string;
  /** Stable de-dupe key: reopening with the same key focuses the existing
   *  live session instead of spawning a second PTY. Defaults to a
   *  composite of engine/clusterName/mode/target.
   *
   *  NOTE: this is a *host-side* identity for the desktop tab. It is
   *  distinct from the guest tmux session id (`sessionId` below) that E3.4
   *  threads through the transport (`vm shell --session <id>`). */
  sessionKey?: string;
  /** Reattachable guest tmux session id (E3.4). Supplied by the rehydrate
   *  path to *reattach* a specific still-running guest session; for a fresh
   *  reattachable shell (microVM host/dev) one is minted automatically.
   *  Absent for pod-exec shells — they have no tmux behind them. */
  sessionId?: string;
  /** Open without stealing focus (no modal): the tab appears in the dock
   *  but the view stays hidden. Used by rehydrate so reconnecting N shells
   *  on launch doesn't flash N modals — the user clicks a tab to view it. */
  background?: boolean;
  /** Mark this session as a coding agent (Phase 5, A5). The launcher
   *  pre-mints the `agent-<id>` (passed as `sessionId`) and spawns the
   *  agent before calling here; this only types the resulting tab. */
  agent?: AgentTabMeta;
}

/** Light, render-safe projection of a session for the chrome. */
export interface TerminalSessionMeta {
  id: string;
  status: TerminalStatus;
  error: string | null;
  title: string;
  /** The target line shown under the title (pod / VM name). */
  subtitle: string;
  mode?: 'dev' | 'host';
  engine?: 'microvm';
  /** Set when this tab is a coding agent (Phase 5, A5) — the tab bar
   *  renders an agent icon + status badge distinct from a plain shell. */
  agent?: AgentTabMeta;
}

// The heavy, route-independent objects. Held in a ref Map, never in React
// state, so renders never recreate xterm instances or reopen PTYs.
interface LiveSession {
  id: string;
  key: string;
  term: Terminal;
  fit: FitAddon;
  /** Detached DOM node xterm is bound to. Reparented into whichever view
   *  is showing it; parked in the off-screen holder otherwise. Owned here
   *  so it (and its rendered scrollback) survives route changes. */
  container: HTMLDivElement;
  /** The live host PTY handle. Null until `host.terminal.open` resolves. */
  session: TerminalSession | null;
  /** Disposes the `term.onData` keystroke binding. */
  disposeInput?: () => void;
  /** Open args retained so close can sweep host/dev debugger pods. */
  target: string;
  engine?: 'microvm';
  clusterName?: string;
  mode?: 'dev' | 'host';
  /** The reattachable guest tmux session id (`<mode>-<uuid>`), when this is
   *  a microVM host/dev shell. Threaded into the PTY as `--session <id>`;
   *  used to (a) de-dupe a rehydrated tab against its live session and (b)
   *  destroy the guest session on an explicit close. Absent for pod-exec. */
  sessionId?: string;
  /** Agent-tab metadata (Phase 5, A5), when this session is a coding
   *  agent rather than a plain shell. */
  agent?: AgentTabMeta;
}

interface TerminalSessionsContextValue {
  sessions: TerminalSessionMeta[];
  /** The session whose view is currently shown, or null when hidden. */
  activeId: string | null;
  /** Open a new session, or focus an existing one with the same key.
   *  Returns the session id. */
  openSession(opts: OpenTerminalOptions): string;
  /** Open another concurrent session against the same target as `id` (a
   *  fresh, independent PTY — not a focus of the source). Powers the dock's
   *  "+" / new-shell affordance, which has no VM context of its own and so
   *  forks from an existing tab. Returns the new id, or null if `id` is
   *  unknown. */
  duplicateSession(id: string): string | null;
  /** Explicitly destroy a session: kill the PTY, dispose xterm, and sweep
   *  any debugger pod a host/dev shell left behind. The only path that
   *  closes a PTY. */
  closeSession(id: string): void;
  /** Rename a tab's title (local chrome only in E3.3; E3.4 backs this with
   *  tmux `rename-session`). A blank title is ignored. */
  renameSession(id: string, title: string): void;
  /** Show a session's view (set it active). */
  focusSession(id: string): void;
  /** Hide the active view without closing the session — the PTY stays
   *  live, the scrollback is retained. */
  hide(): void;
  /** Mount a session's xterm node into `host` and keep its size in step.
   *  Returns a cleanup that parks the node back in the holder (it does NOT
   *  close the session). Used by the view; not for general callers. */
  attachView(id: string, host: HTMLElement): () => void;
  /** Whether a session's xterm currently holds keyboard focus. The modal
   *  uses this to decide whether to hijack Esc (E3.4 / Devon): when the
   *  terminal is focused, Esc is left to xterm's custom key handler — so a
   *  focused full-screen TUI (vim/less) gets raw Esc — and only dismisses
   *  the modal when focus is elsewhere (e.g. on the Hide button). */
  isFocused(id: string): boolean;
}

const TerminalSessionsContext = React.createContext<TerminalSessionsContextValue | null>(null);

function deriveTitle(opts: OpenTerminalOptions): string {
  if (opts.title) return opts.title;
  // An agent tab reads as the agent, not the host shell it rides on — use the
  // human label ("Claude Code"), not the raw `--type` key, for parity with the
  // launcher + the tab tooltip.
  if (opts.agent) return `Agent · ${agentLabel(opts.agent.type)}`;
  const base = opts.engine === 'microvm' ? 'Terminal · microVM' : 'Terminal';
  if (opts.mode === 'dev') return `${base} · dev workspace`;
  if (opts.mode === 'host') return `${base} · host`;
  return base;
}

/** Only the microVM host/dev (vsock) shell is reattachable — pod-exec has
 *  no tmux behind it (E3.0 design), so it never gets a guest session id. */
function isReattachable(opts: { engine?: 'microvm'; mode?: 'dev' | 'host' }): boolean {
  return opts.engine === 'microvm' && (opts.mode === 'dev' || opts.mode === 'host');
}

/** Mint a stable guest tmux session id for a reattachable shell. The mode
 *  is encoded as a prefix so the rehydrate path can recover it (the vsock
 *  argv is identical for dev/host, so the id is the only carrier of which
 *  it was) for the dock title. The charset stays within the CLI's
 *  `validate_session_id` (letters, digits, '-'). */
function mintSessionId(mode: 'dev' | 'host'): string {
  return `${mode}-${crypto.randomUUID()}`;
}

/** Recover the mode a reattached session was opened in from its id prefix.
 *  Unknown / legacy ids fall back to 'host' (a raw shell). An `agent-`
 *  session rides the 'host' transport (see isAgentSessionId). */
function modeFromSessionId(id: string): 'dev' | 'host' {
  return id.startsWith('dev-') ? 'dev' : 'host';
}

/** Whether a guest session id belongs to a coding agent (Phase 5, A5).
 *  The CLI/desktop mint agent sessions as `agent-<uuid>` (utils/agent.ts
 *  mintAgentSessionId), so the prefix is how rehydrate tells an agent tab
 *  from a plain shell — the registry only enriches its type/task/status. */
export function isAgentSessionId(id: string): boolean {
  return id.startsWith('agent-');
}

/** Mint an `agent-<uuid>` guest session id (mirrors the CLI's
 *  mintAgentSessionId + satisfies validate_session_id in shell.rs). The
 *  launcher pre-mints this, hands it to `agent.start`, then opens the
 *  observe tab against it. */
export function mintAgentSessionId(): string {
  return `agent-${crypto.randomUUID()}`;
}

/** De-dupe namespace for an agent tab. An agent rides the `mode:'host'`
 *  transport with no caller `sessionKey`, so its derived host-side key
 *  would collide with a plain "Open shell" on the same VM and let one
 *  steal/focus the other. Pin agents to their own `agent:<sessionId>`
 *  key — used by BOTH the launcher and the rehydrate path. */
export function agentSessionKey(sessionId: string): string {
  return `agent:${sessionId}`;
}

/** Project the registry's agent status (which carries a 4th `exited`
 *  state) onto the three-way badge status. `exited` (the run was stopped)
 *  folds into `done` — it is no longer active — so the badge never spins
 *  for a finished agent. Shared by rehydrate enrichment and the live
 *  status poll so the mapping can't drift. */
export function agentBadgeStatus(status: string | undefined): AgentTabMeta['status'] {
  return status === 'done' || status === 'exited' ? 'done' : status === 'error' ? 'error' : 'running';
}

let nextSessionSeq = 0;

export function TerminalSessionsProvider({ children }: { children: React.ReactNode }) {
  const host = useHost();
  const liveRef = React.useRef<Map<string, LiveSession>>(new Map());
  const holderRef = React.useRef<HTMLDivElement | null>(null);
  const [sessions, setSessions] = React.useState<TerminalSessionMeta[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const patchMeta = React.useCallback((id: string, patch: Partial<TerminalSessionMeta>) => {
    setSessions((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  // Park a session's container in the off-screen holder (keeps it in the
  // DOM so xterm stays measurable, but invisible). Never removes it.
  const park = React.useCallback((live: LiveSession) => {
    // A closed session has already been pulled from the registry and its
    // container detached + disposed; re-parking it would re-append an
    // orphaned node into the holder, leaking one <div> per Close. The
    // attach cleanup still fires on that unmount, so no-op once it's gone.
    if (!liveRef.current.has(live.id)) return;
    const holder = holderRef.current;
    if (holder && live.container.parentNode !== holder) {
      holder.appendChild(live.container);
    }
  }, []);

  const focusSession = React.useCallback((id: string) => {
    if (liveRef.current.has(id)) setActiveId(id);
  }, []);

  const renameSession = React.useCallback(
    (id: string, title: string) => {
      const next = title.trim();
      if (!next) return; // a blank rename keeps the existing title
      patchMeta(id, { title: next });
    },
    [patchMeta]
  );

  const hide = React.useCallback(() => setActiveId(null), []);

  // xterm's custom key handler (set per-term in openSession) reaches for the
  // *current* hide via this ref, so the handler closure never goes stale and
  // terms never need re-creating when hide's identity changes.
  const hideRef = React.useRef(hide);
  hideRef.current = hide;

  const isFocused = React.useCallback((id: string): boolean => {
    const live = liveRef.current.get(id);
    const el = live?.term.element;
    return !!el && el.contains(document.activeElement);
  }, []);

  const openSession = React.useCallback(
    (opts: OpenTerminalOptions): string => {
      const key =
        opts.sessionKey ?? [opts.engine ?? '', opts.clusterName ?? '', opts.mode ?? '', opts.target].join('|');

      // De-dupe. A rehydrate / explicit guest id focuses the tab already
      // bound to that in-guest session (so two distinct guest sessions on
      // one target stay two distinct tabs); a fresh open focuses by the
      // derived/explicit host-side key (so clicking "Open shell" twice
      // reuses the one tab).
      for (const [id, live] of liveRef.current) {
        const match = opts.sessionId ? live.sessionId === opts.sessionId : live.key === key;
        if (match) {
          if (!opts.background) setActiveId(id);
          return id;
        }
      }

      // Mint a stable guest tmux session id for a reattachable (microVM
      // host/dev) shell, unless the caller supplied one (rehydrate). The id
      // rides the transport as `--session <id>`; attach + reattach reuse it.
      // Pod-exec shells get none — they stay non-reattachable.
      const sessionId = opts.sessionId ?? (isReattachable(opts) && opts.mode ? mintSessionId(opts.mode) : undefined);

      const id = `term-${++nextSessionSeq}`;
      const subtitle = opts.target;
      const meta: TerminalSessionMeta = {
        id,
        status: 'connecting',
        error: null,
        title: deriveTitle(opts),
        subtitle,
        mode: opts.mode,
        engine: opts.engine,
        agent: opts.agent,
      };
      setSessions((prev) => [...prev, meta]);
      if (!opts.background) setActiveId(id);

      if (!host.terminal) {
        // Web shell has no PTY transport — surface the same error the old
        // route drawer did, but keep the (inert) session registered so the
        // view can render the message.
        patchMeta(id, { status: 'error', error: 'Interactive terminals are only available in the desktop app.' });
        return id;
      }

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
        theme: { background: getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim() },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      // Raw Esc for full-screen TUIs (E3.4 / Devon). With reattachable
      // shells, users live in vim/less far more — and the dock view's modal
      // used to swallow Esc to Hide. Hand Esc to the running app whenever the
      // shell is in tmux's alternate screen (a TUI is up); at a normal prompt
      // Esc still Hides the view (reversible — the tab and PTY stay live).
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && e.key === 'Escape') {
          if (term.buffer.active.type === 'alternate') {
            return true; // alt-screen TUI: forward raw Esc to the shell
          }
          hideRef.current(); // normal prompt: Hide the dock view…
          return false; // …and don't also send Esc to the shell
        }
        return true;
      });
      const container = document.createElement('div');
      container.style.height = '100%';
      container.style.width = '100%';
      // Open while parked in the holder so xterm has a laid-out element to
      // bind to; the view fits it to real dimensions on attach.
      if (holderRef.current) holderRef.current.appendChild(container);
      term.open(container);

      const live: LiveSession = {
        id,
        key,
        term,
        fit,
        container,
        session: null,
        target: opts.target,
        engine: opts.engine,
        clusterName: opts.clusterName,
        mode: opts.mode,
        sessionId,
        agent: opts.agent,
      };
      liveRef.current.set(id, live);

      host.terminal
        .open(
          {
            target: opts.target,
            engine: opts.engine,
            clusterName: opts.clusterName,
            mode: opts.mode,
            sessionId,
            cols: term.cols,
            rows: term.rows,
          },
          (event) => {
            if (event.type === 'data') {
              term.write(event.data);
            } else if (event.type === 'exit') {
              const code = event.code ?? 0;
              term.write(`\r\n\x1b[90m[process exited${code ? ` (${code})` : ''}]\x1b[0m\r\n`);
              patchMeta(id, { status: 'closed' });
            }
          }
        )
        .then((s) => {
          // The session may have been closed before open resolved.
          if (!liveRef.current.has(id)) {
            void s.close();
            return;
          }
          live.session = s;
          const sub = term.onData((d) => void live.session?.write(d));
          live.disposeInput = () => sub.dispose();
          patchMeta(id, { status: 'open' });
          // A background (rehydrated) session is parked off-screen — don't
          // pull keyboard focus into an invisible terminal on launch. The
          // user's click → attachView focuses it when they open the tab.
          if (!opts.background) term.focus();
        })
        .catch((e) => {
          patchMeta(id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
        });

      return id;
    },
    [host, patchMeta]
  );

  // Fork a sibling session from an existing tab. The dock's "+" has no VM
  // of its own to target, so a new shell is always opened "like" a live
  // one — same target/engine/mode, but a unique key so it's a genuinely
  // separate concurrent PTY rather than a focus of the source tab.
  const duplicateSession = React.useCallback(
    (id: string): string | null => {
      const live = liveRef.current.get(id);
      if (!live) return null;
      const opts: OpenTerminalOptions = {
        target: live.target,
        engine: live.engine,
        clusterName: live.clusterName,
        mode: live.mode,
      };
      // Without a disambiguator a fork is byte-identical to its source
      // (same derived title + subtitle) and, once nothing is active
      // (activeId null after nav), the two tabs can't be told apart. Suffix
      // the clone with its index among shells already on this target so
      // concurrent shells read distinctly ("… 2", "… 3", …).
      const onSameTarget = Array.from(liveRef.current.values()).filter((s) => s.target === live.target).length;
      return openSession({
        ...opts,
        title: `${deriveTitle(opts)} ${onSameTarget + 1}`,
        sessionKey: `dup:${++nextSessionSeq}`,
      });
    },
    [openSession]
  );

  const closeSession = React.useCallback(
    (id: string) => {
      const live = liveRef.current.get(id);
      if (!live) {
        // An inert web session (no PTY transport) has meta but never got a
        // live handle, so the teardown below doesn't apply — still drop its
        // meta so a closed/error session can't linger in the list.
        setSessions((prev) => prev.filter((m) => m.id !== id));
        setActiveId((cur) => (cur === id ? null : cur));
        return;
      }
      liveRef.current.delete(id);
      live.disposeInput?.();
      // Closing the host PTY only *detaches* from the guest tmux session, so
      // an explicit tab-close must also destroy that session — otherwise it
      // would linger and silently rehydrate on the next launch.
      void live.session?.close();
      if (live.agent && live.sessionId && live.engine === 'microvm') {
        // An agent owns a registry row alongside its tmux session. The
        // desktop's agent-stop path kills the session AND flips the row to
        // `exited` in one shot — so route the agent's close through it
        // rather than a bare `terminal.kill` (which would leave a stale
        // `running` row behind). Best-effort, like the shell kill below.
        void host.vm
          ?.instance(live.clusterName)
          .agent.stop(live.sessionId)
          .catch(() => {});
      } else if (live.sessionId && live.engine === 'microvm') {
        void host.terminal?.kill?.(live.clusterName, live.sessionId).catch(() => {});
      }
      live.term.dispose();
      live.container.remove();
      // A host/dev shell can ride `kubectl debug node/`, which leaves a
      // debugger pod behind. Forking a shell opens a *second* such session on
      // the same VM, and `cleanupShell()` sweeps by VM — so sweeping on every
      // close would tear down a still-open sibling's debugger pod (Quinn).
      // Only sweep once the LAST host/dev shell on this VM closes.
      if (live.mode && live.engine === 'microvm') {
        const siblingOnSameTarget = Array.from(liveRef.current.values()).some(
          (s) => s.engine === 'microvm' && s.mode && s.clusterName === live.clusterName
        );
        if (!siblingOnSameTarget) {
          void host.vm
            ?.instance(live.clusterName)
            .cleanupShell()
            .catch(() => {});
        }
      }
      setSessions((prev) => prev.filter((m) => m.id !== id));
      setActiveId((cur) => (cur === id ? null : cur));
    },
    [host]
  );

  const attachView = React.useCallback(
    (id: string, hostEl: HTMLElement) => {
      const live = liveRef.current.get(id);
      if (!live) return () => {};
      hostEl.appendChild(live.container);
      const refit = () => {
        try {
          live.fit.fit();
        } catch {
          // container not laid out yet
        }
        void live.session?.resize(live.term.cols, live.term.rows);
      };
      // Fit after the browser has laid the container out, then redraw so a
      // reparented xterm repaints its retained buffer.
      const raf = requestAnimationFrame(() => {
        refit();
        live.term.refresh(0, live.term.rows - 1);
        live.term.focus();
      });
      const ro = new ResizeObserver(refit);
      ro.observe(hostEl);
      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        park(live);
      };
    },
    [park]
  );

  // Reconnect on app restart (E3.4 / spec §4.3). Closing the desktop only
  // detached from the guest tmux sessions — they keep running while the VM
  // is up. On launch, enumerate each running VM's live sessions and re-open
  // a (background) dock tab for every one, attaching by its guest id; tmux
  // replays the screen, so the user lands back in each still-running shell.
  // Reached via a ref so this effect can run exactly once without taking
  // openSession (whose identity changes as state updates) as a dependency.
  const openSessionRef = React.useRef(openSession);
  openSessionRef.current = openSession;
  React.useEffect(() => {
    const listSessions = host.terminal?.list;
    const vmHost = host.vm;
    if (!listSessions || !vmHost) return; // web shell / no reattach support
    let cancelled = false;
    void (async () => {
      const vms = await vmHost.list().catch(() => []);
      for (const vm of vms) {
        if (cancelled) return;
        if (!vm.running) continue;
        const found = await listSessions(vm.name).catch(() => []);
        if (cancelled) return;
        // Enrich any reattached agent sessions with their registry
        // type/task/status (best-effort — an `agent-` session still comes
        // back as an agent tab even when the registry read yields nothing).
        const agents = found.some((s) => isAgentSessionId(s.id))
          ? await vmHost
              .instance(vm.name)
              .agent.list()
              .catch(() => [])
          : [];
        if (cancelled) return;
        const agentBySession = new Map(agents.map((a) => [a.sessionId, a]));
        for (const s of found) {
          if (isAgentSessionId(s.id)) {
            const info = agentBySession.get(s.id);
            const type = info?.type ?? 'claude-code';
            const status = agentBadgeStatus(info?.status);
            openSessionRef.current({
              target: vm.name,
              engine: 'microvm',
              clusterName: vm.name,
              // Agents ride the reattachable host-shell transport, but get
              // their own de-dupe namespace so a plain "Open shell" on the
              // same VM can't focus/steal this reattached agent tab.
              mode: 'host',
              sessionKey: agentSessionKey(s.id),
              sessionId: s.id,
              agent: { type, status, mode: info?.mode },
              // Use the human label ("GitHub Copilot"), not the raw `--type`
              // key, for parity with the launcher's `Agent · <label>`.
              title: info?.task ? `Agent · ${info.task}` : `Agent · ${agentLabel(type)} (reattached)`,
              background: true,
            });
            continue;
          }
          const mode = modeFromSessionId(s.id);
          openSessionRef.current({
            target: vm.name,
            engine: 'microvm',
            clusterName: vm.name,
            mode,
            sessionId: s.id,
            title: `${deriveTitle({ target: vm.name, engine: 'microvm', mode })} (reattached)`,
            background: true,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only: `host` is stable for the app's lifetime, and the latest
    // `openSession` is reached through `openSessionRef`, so reconnect runs
    // exactly once on launch.
  }, [host]);

  // Live agent-status poll (Phase 5, A5/A6). The rehydrate path enriches a
  // reattached agent tab's status once, but an autonomous run can finish
  // (running → done/error) while its tab is open and detached. Re-read each
  // VM's registry (`agent.list`) on a light interval and flip the badge, so
  // a completed/failed run is reflected without a relaunch. Only runs while
  // ≥1 agent tab is still `running` (done/error/exited are terminal), and
  // patches only on an actual change to avoid render churn.
  // Narrow signal for the poll effect: the SET of still-running agent tabs
  // (their ids), not the whole `sessions` array. `sessions`' identity
  // changes on every unrelated tab open/close/rename/focus, which would tear
  // down + re-subscribe the 5s interval each time (Quinn/Devon). This
  // primitive changes only when an agent tab enters/leaves the running set,
  // so the poll re-subscribes exactly when the thing it watches changes.
  const runningAgentKey = React.useMemo(
    () =>
      sessions
        .filter((m) => m.agent?.status === 'running')
        .map((m) => m.id)
        .sort()
        .join('|'),
    [sessions]
  );
  // The poll effect reads the live `sessions` through a ref so it can key off
  // the narrow signal above without taking `sessions` as a dependency.
  const sessionsRef = React.useRef(sessions);
  sessionsRef.current = sessions;
  React.useEffect(() => {
    const vmHost = host.vm;
    if (!vmHost) return;
    const runningAgents = sessionsRef.current.filter((m) => m.agent && m.agent.status === 'running');
    if (runningAgents.length === 0) return;
    // VMs (clusterName) hosting a still-running agent tab — read each once
    // per tick and fan the result back out to its tabs by guest session id.
    const vmNames = new Set<string>();
    for (const m of runningAgents) {
      const live = liveRef.current.get(m.id);
      if (live?.clusterName) vmNames.add(live.clusterName);
    }
    if (vmNames.size === 0) return;

    let cancelled = false;
    const tick = async () => {
      for (const vmName of vmNames) {
        const agents = await vmHost
          .instance(vmName)
          .agent.list()
          .catch(() => []);
        if (cancelled) return;
        const bySession = new Map(agents.map((a) => [a.sessionId, a]));
        for (const m of runningAgents) {
          const live = liveRef.current.get(m.id);
          if (!live || live.clusterName !== vmName || !live.sessionId) continue;
          const info = bySession.get(live.sessionId);
          if (!info) continue;
          const next = agentBadgeStatus(info.status);
          if (next !== 'running' && m.agent?.status !== next) {
            // Keep the heavy LiveSession copy in step with the meta so a
            // later read (e.g. another tick) sees the settled status too.
            live.agent = { ...(live.agent ?? { type: info.type }), status: next };
            patchMeta(m.id, {
              agent: { type: m.agent?.type ?? info.type, status: next, mode: m.agent?.mode ?? info.mode },
            });
          }
        }
      }
    };
    const interval = window.setInterval(() => void tick(), 5_000);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // Keyed on the running-agent SET (not `sessions`) so an unrelated tab
    // change doesn't churn the interval. `sessions` is read via `sessionsRef`.
  }, [runningAgentKey, host, patchMeta]);

  const value = React.useMemo<TerminalSessionsContextValue>(
    () => ({
      sessions,
      activeId,
      openSession,
      duplicateSession,
      closeSession,
      renameSession,
      focusSession,
      hide,
      attachView,
      isFocused,
    }),
    [
      sessions,
      activeId,
      openSession,
      duplicateSession,
      closeSession,
      renameSession,
      focusSession,
      hide,
      attachView,
      isFocused,
    ]
  );

  return (
    <TerminalSessionsContext.Provider value={value}>
      {children}
      {/* Off-screen holder: parks live terminal nodes (and their scrollback)
          while no view is showing them, keeping them mounted across nav. */}
      <div
        ref={holderRef}
        aria-hidden
        style={{ position: 'fixed', left: '-99999px', top: 0, width: '800px', height: '600px', overflow: 'hidden' }}
      />
    </TerminalSessionsContext.Provider>
  );
}

export function useTerminalSessions(): TerminalSessionsContextValue {
  const ctx = React.useContext(TerminalSessionsContext);
  if (!ctx) {
    throw new Error('useTerminalSessions called outside TerminalSessionsProvider');
  }
  return ctx;
}
