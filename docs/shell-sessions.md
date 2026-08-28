# Reattachable shell sessions + desktop tabs (E3.0 spike)

**Status:** Decided (spike). **Scope:** the in-guest shell multiplexer
(`packages/vm` — the vsock shell relay + guest agent) and the desktop terminal
(`packages/app` + `packages/desktop/src-tauri`). The `packages/api-server` work
is out of scope. This doc is the design **E3.1–E3.4** implement.

## 0. Headline

```
Guest multiplexer: tmux, run as the non-root `appliance` user on a per-VM
server socket (a separate root-owned socket for --root). Each desktop tab =
one named tmux session `appliance-<id>`. Reattach = `tmux new-session -A`
(attach-or-create); list = `tmux list-sessions`. tmux replays the screen on
attach, which is the "navigate away / restart the app and come back to your
live shell" UX.

Protocol: extend the existing size-line handshake with a session token, so
the vsock relay stays a dumb per-connect byte pipe and the durable state is
the tmux server inside the guest. Sessions survive client disconnect + desktop
app restart while the VM runs; they die on VM reboot (diskless — acceptable).

Desktop: lift xterm + host TerminalSession instances out of the route into an
app-root store so navigation never unmounts/kills them (E3.2); a tab strip in
a bottom terminal dock in app-shell.tsx (E3.3); rehydrate tabs on app start by
listing live sessions and re-attaching (E3.4).

One-shots (`vm shell -- <cmd>`, devcontainer exec, `appliance up`) and the host
clock-sync KEEP the current direct, non-tmux path with its exit-code sentinel —
they carry no session token, so nothing about them changes.
```

## 1. Current state (verified)

- **The vsock shell is per-invocation.** The relay's `incoming()` loop opens a
  **fresh** vsock connection — and therefore a fresh `appliance-shell-agent`
  process — for every client connect (`backend/vz/shell.rs:45-53`,
  `connect_vsock` at `:177`). There is no server-side session: when the client
  socket closes, both pump threads end (`spawn_session` at `:227-246`) and the
  guest PTY's login shell exits.
- **The guest agent drops to the `appliance` user.** `SHELL_AGENT`
  (`guest.rs:496-515`) reads one `rows R cols C [root]` line, sets the PTY size,
  then `exec su -s "$__SH" -l appliance` by default; a trailing `root` token on
  the size line keeps a root login shell instead (`guest.rs:503,507-514`). The
  socat agent is launched unconditionally on every VM (`guest.rs:137-144`) on
  `SHELL_VSOCK_PORT = 1024` (`guest.rs:48`).
- **One-shots ride an in-band sentinel.** With `-- <cmd>` the client appends
  `…; printf '\n__APPLIANCE_VM_RC__%d__END__\n' "$?"\nexit`
  (`shell.rs:36-44`, `RC_MARK` at `:79`) and parses the code back out
  (`pump_until_sentinel` at `:86`). Clock-sync reuses the same channel with the
  `root` token (`backend/vz/shell.rs:102` `CLOCK_SYNC_SIZE_LINE`).
- **tmux is already pulled for dev VMs** — `apk add … tmux …` in the
  backgrounded `DEV_PROVISION` block (`guest.rs:362`), cached on
  `/persist/apk-cache`. It is **not** in the base world set
  (`guest.rs:560`: `alpine-base e2fsprogs ca-certificates busybox-extras socat
sudo`), so it isn't present on plain/non-dev VMs.
- **CLI.** `Cmd::Shell { name, root, command }` (`main.rs:122-131`) →
  `shell::run_client` (`main.rs:650-652`).
- **Desktop transport.** `TerminalDrawer` (xterm.js) lives inside the
  `local-runtime` route (`pages/local-runtime/index.tsx:627`, `:1443`); its
  `useEffect` opens a host terminal session (`terminal-drawer.tsx:33-108`) and
  its cleanup calls `session.close()` on unmount (`:94-107`). The route is a
  child of `AppShell`'s single `<Outlet/>` (`router/routes.tsx:23-34`,
  `app-shell.tsx:80-82`), so navigating unmounts the drawer and kills the PTY.
  Transport: `host.terminal.open` over a Tauri `Channel`
  (`desktop/src/host.ts:294-305`) → `terminal_open` builds the argv
  (`lib.rs:3663-3679`; vsock branch `microvm_host_shell_argv` at
  `:3589-3597` returns `["appliance-vm","shell",vm]`) → `terminal.rs`
  (`portable_pty`, sessions in a `Mutex<HashMap>` at `:31-44`, `open` at `:48`,
  `close`=`child.kill()` at `:156-161`).

## 2. Multiplexer: tmux vs dtach/abduco

All three are installable on diskless Alpine v3.21 (the apkovl already lists
`main` + `community`, `guest.rs:565-566`): `tmux` from `main`, `dtach`/`abduco`
from `community`.

|                             | tmux                                                                   | dtach / abduco                                                                                |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Installed size              | ~1 MB (tmux + libevent + ncurses-terminfo-base)                        | ~25 KB single static binary, no runtime deps                                                  |
| Already on the VM           | **yes, for dev VMs** (`guest.rs:362`)                                  | no                                                                                            |
| Reattach replays the screen | **yes** — redraws the visible pane + scrollback on attach              | no — a plain shell reattaches to a blank screen; only full-screen apps redraw via SIGWINCH/^L |
| Enumerate sessions          | **`tmux list-sessions`**                                               | none — the host must track ids itself                                                         |
| Attach-or-create primitive  | **`new-session -A -s <name>`**                                         | `dtach -A <socket>` (create on first attach)                                                  |
| Per-client resize           | **yes** (`refresh-client -C`)                                          | the attached program just gets the new winsize                                                |
| Key interception            | a prefix (`C-b`) + status bar — must be turned off to stay transparent | none — fully transparent passthrough                                                          |

**Recommendation: tmux.** The decisive factors are (a) **replay on attach** —
the goal is to navigate away, or restart the app, and come back to the
_same shell as you left it_; tmux redraws the screen, dtach shows a blank line
until you press Enter; (b) **`list-sessions`** gives E3.4's reconnect a clean
enumeration primitive with zero host-side bookkeeping; (c) **`new-session -A`**
is the exact attach-or-create primitive reattach needs; (d) it's **already in
the dev image**. The cost — ~1 MB and a small transparency config — is minor.

**Make tmux transparent** so the relay still looks like a raw shell. Ship a
config the agent points `-f` at (write it from `guest.rs` alongside the agent
script):

```tmux
set -g status off            # no status bar — the desktop owns the chrome
set -g default-terminal "tmux-256color"
set -g escape-time 10
set -g history-limit 50000   # scrollback survives a detach/reattach
set -g destroy-unattached off  # keep the session alive while detached (default)
```

**Add `tmux` to the base world set** (`guest.rs:560`, next to `socat`/`sudo`)
so reattachable sessions work on _every_ VM, not just dev VMs — matching the
"shell agent is unconditional" precedent (`guest.rs:137`). See fork (4).

## 3. Session protocol over vsock

**Design principle: the relay stays a dumb per-connect byte pipe.** No change
to `backend/vz/shell.rs` — the durable state is the tmux server inside the
guest, not the relay or the agent process. Every reconnect is a brand-new
socat→agent→`tmux attach`, and tmux is what survives.

### 3.1 Handshake extension

Today the first line is `rows R cols C [root]\n` (`shell.rs:34-35`,
`guest.rs:501-503`). Extend the trailing tokens with an optional session verb,
parsed by the agent _after_ `cols C` and the `root` token:

```
rows R cols C [root] [attach <id> | new <id> | list | kill <id>]
```

- **No session token** → today's behavior exactly (fresh, non-reattachable
  login shell; or, with a command, the sentinel one-shot). This keeps clock-sync
  (`CLOCK_SYNC_SIZE_LINE`, no session token) and `vm shell -- <cmd>` byte-for-byte
  unchanged.
- **`attach <id>` / `new <id>`** → the agent execs, as the appliance user, the
  attach-or-create:
  `su -s /bin/sh -l appliance -c 'exec tmux -L appliance -f <conf> new-session -A -s appliance-<id>'`.
  Both `new` and `attach` are attach-or-create (`new-session -A`): the impl
  collapsed them onto the safer primitive so a stale id never errors out.
  `--root` swaps the socket to `-L appliance-root` and skips
  the `su` drop (root-owned socket, mode 0600, so a non-root client can never
  attach a root session and vice-versa).
- **`list`** → `tmux -L appliance list-sessions -F '#{session_name}\t#{session_activity}'`,
  printed once, then the connection closes (a one-shot like the sentinel path).
- **`kill <id>`** → `tmux -L appliance kill-session -t appliance-<id>`, then close.

Reattach finds an existing session purely by the **deterministic name**
`appliance-<id>`: `new-session -A` attaches if it exists, else creates. The
host therefore needs no guest-side registry — it only remembers which `<id>`s
it has tabs for. `<id>` is a host-minted stable string (the desktop tab's uuid;
the CLI accepts a user-facing name).

### 3.2 CLI surface (`appliance vm shell`)

`Cmd::Shell` (`main.rs:122-131`) gains a `--session <id>` / `-s <id>` flag;
`shell::run_client` (`shell.rs:22`) appends the `attach <id>` token to its size
line (`shell.rs:35`). A new `Cmd::Sessions` subcommand group covers the rest:

```
appliance vm shell [<name>] [--root] [--session <id>] [-- <cmd>]
appliance vm sessions list [<name>]          # tmux list-sessions
appliance vm sessions kill [<name>] <id>     # tmux kill-session
```

`list`/`kill` are short-lived connections that send the `list`/`kill` verb and
print/close (no raw mode, no sentinel). Detach is **not** a command — the client
simply closing the socket detaches; tmux keeps the session running.

### 3.3 Lifecycle vs VM reboot

The tmux server is an in-tmpfs process; the VM is diskless, so a **reboot kills
every session** — acceptable per the locked decision. The guarantee the model
provides:

- **survive client disconnect** — closing `appliance vm shell` (or the desktop
  PTY) detaches; the tmux session and its processes keep running.
- **survive desktop app restart** — on restart the desktop lists sessions and
  re-attaches each `appliance-<id>`; tmux replays the screen.

What does _not_ persist: the VM rebooting, `vm stop`, or deleting the VM. The
relay/agent processes themselves are stateless — they're re-spawned per connect.

## 4. Desktop persistence + tabs

### 4.1 E3.2 — lift session state out of the route

Today the xterm + host `TerminalSession` are created in `TerminalDrawer`'s route
effect and torn down on unmount (`terminal-drawer.tsx:33-108`, `:94-107`). Lift
them to an **app-root store** that outlives navigation:

- **New `packages/app/src/providers/terminal-sessions-provider.tsx`** — a React
  context backed by a module-level `Map<id, { term: Terminal, fit: FitAddon,
session: TerminalSession, title, vmName, mode }>`. The `Terminal` objects and
  their host sessions live here, _not_ in any route component.
- **New persistent terminal layer** rendered once in `app-shell.tsx`
  (outside `<main><Outlet/></main>`, `app-shell.tsx:80-82`) holding each
  session's xterm container `<div>`. Route changes **hide** the active terminal
  (CSS / `display`), they never unmount it — so the PTY and scrollback stay live.
- **`terminal-drawer.tsx` refactor:** it stops owning the xterm lifecycle. The
  call sites (`pages/local-runtime/index.tsx:627`, `:1443`) call a store action
  (`openSession({ vmName, mode })`) that creates-or-focuses a tab. Crucially,
  **navigation no longer triggers `session.close()`** — only an explicit tab
  close does. `mount` the `TerminalSessionsProvider` in `App.tsx` (above the
  `RouterProvider`) or at the top of `AppShell`.

### 4.2 E3.3 — tab bar in the window chrome

Add a collapsible **terminal dock** to `app-shell.tsx`. Its grid is
`grid-rows-[auto_1fr]` (`app-shell.tsx:40`); add a third row spanning
`col-start-2` for the dock, with a tab strip on top of the persistent terminal
layer:

- **New `packages/app/src/components/layout/terminal-tab-bar.tsx`** (+ a
  `terminal-dock.tsx` wrapper) — renders one tab per store session: **open**
  (`+` → `openSession`), **close** (`×` → detach + destroy the guest session),
  **switch** (click → set active), **rename** (double-click the label →
  `renameSession`, backed by tmux `rename-session`). Active-tab state lives in
  the store (E3.2).
- It slots between the `<header>` and `<main>` (or as a bottom dock under
  `<main>`); a toggle in the header collapses it. Pod-`exec` terminals can live
  in the same dock as _non-reattachable_ tabs (see fork 5).

### 4.3 E3.4 — reconnect on app restart

Thread the guest session id through the existing transport and rehydrate on
start:

1. **Carry the id through transport.** `TerminalOpenOptions`
   (`app/src/lib/host.ts:255-272`) gains `sessionId?: string` and optionally
   `sessionAction?: 'attach' | 'new'`. `desktop/src/host.ts:295-305` passes it
   into `terminal_open`. `TerminalOpenInput` (`lib.rs:3540-3564`) gains
   `session_id`; `microvm_host_shell_argv` (`lib.rs:3589-3597`) appends
   `--session <id>` to the vsock argv. `terminal.rs` is unchanged — it still
   spawns the argv and streams (the durable state is in the guest, not the host
   PTY map).
2. **List + rehydrate.** New host method `terminal.list(vmName)` →
   `terminal_sessions` Tauri command → `appliance vm sessions list` →
   `[{ id, title, lastActivity }]`. On store mount, call it and, for each id,
   open a host session with `sessionId` set to **attach** — tmux replays the
   screen, so the user lands back in each live shell. New `terminal.kill(vmName,
id)` → `terminal_kill_session` → `appliance vm sessions kill` for explicit
   tab close.
3. **Detach vs destroy.** `terminal.rs::close` already `child.kill()`s the local
   `appliance vm shell` (`terminal.rs:156-161`) — that _detaches_ (the guest
   tmux session lives on). App restart / closing the window = detach only (do
   **not** kill the guest session). The tab's `×` = detach **plus**
   `terminal.kill(...)` to destroy the guest session.

## 5. Composition with the non-root user / `--root` and the Channel transport

- **Non-root by default.** The agent runs tmux as `appliance` via
  `su -s /bin/sh -l appliance -c 'exec tmux …'`, so the session — like today's
  shell (`guest.rs:514`) — is non-root. `--root` keeps a root session on a
  **separate** socket (`-L appliance-root`), the existing escape hatch
  (`shell.rs:35`, `guest.rs:507-514`). Two user-isolated sockets mean a
  privilege level can never cross-attach.
- **One-shots + clock-sync unchanged.** They send no session token, so they keep
  the direct, non-tmux path and its exit-code sentinel
  (`shell.rs:36-44,86`; `backend/vz/shell.rs:102`). Reattachable sessions are an
  **interactive-only** addition — `appliance up` / devcontainer exec / clock-sync
  must stay fire-and-forget with a real exit code, which tmux would obscure.
- **Channel transport — what stays vs changes.**
  - **Stays:** the Tauri `Channel<TermEvent>` streaming,
    `terminal_write`/`terminal_resize`/`terminal_close`, the `portable_pty`
    PTY in `terminal.rs`, the `appliance vm shell` client, the vsock relay
    byte-pipe (`backend/vz/shell.rs`), the size-line handshake, the one-shot
    sentinel.
  - **Changes:** `TerminalOpenOptions`/`TerminalOpenInput` gain `sessionId`;
    `terminal.open` threads it; `terminal_open`/`microvm_host_shell_argv` append
    `--session`; new `terminal_sessions` + `terminal_kill_session` commands +
    host methods; the CLI gains `--session` + `sessions list|kill`; the agent
    gains the tmux attach/list/kill branches; `tmux` joins the base world set.
- **Resize caveat (follow-up).** Post-connect resize is currently **not**
  forwarded to the guest — the size line is sent once at connect (`shell.rs:34`)
  and the relay is a raw byte pipe, so resizing the xterm only resizes the
  _host_ `portable_pty` PTY, not the guest. tmux makes the fix a one-liner once
  there's a channel for it (`refresh-client -C cols,rows`); pick an in-band
  control escape on the size/relay channel, or accept initial-size-only. Flagged
  as a fork, not blocking E3.1–E3.4.

## 6. File-set mapping

### E3.1 — guest session manager (`packages/vm`)

- `src/guest.rs` — `SHELL_AGENT` (`:496-515`): parse the session token, branch
  to `tmux new-session -A` (appliance `su`, or root socket for `--root`),
  `list-sessions`, `kill-session`. Add `tmux` to the base world set (`:560`).
  Add a transparent `tmux.conf` written into the apkovl + referenced with `-f`.
  Extend `#[cfg(test)] mod tests`.
- `src/shell.rs` — `run_client` (`:22`): append the `attach <id>` token to the
  size line (`:35`); add `list`/`kill` helpers (short-lived, no raw mode).
- `src/main.rs` — `Cmd::Shell` (`:122-131`) gains `--session`; new
  `Cmd::Sessions { list, kill }`; dispatch near `:650-652`.
- `src/backend/vz/shell.rs` — **unchanged** (per-connect byte pipe). Stated
  explicitly so a builder doesn't try to add session state to the relay.

### E3.2 — desktop lift (`packages/app`)

- **new** `src/providers/terminal-sessions-provider.tsx` — app-root store of
  live `{ term, fit, session, title, … }`, keyed by id; open/focus/close/rename
  actions + active-tab state.
- `src/components/layout/app-shell.tsx` — mount the provider + a persistent
  terminal layer outside `<main><Outlet/></main>` (`:80-82`).
- `src/pages/local-runtime/terminal-drawer.tsx` — refactor: register/focus a
  store session instead of owning the xterm in a route effect; drop the
  `session.close()`-on-unmount (`:94-107`).
- `src/pages/local-runtime/index.tsx` — call sites (`:627`, `:1443`) open a
  store tab instead of the modal drawer.
- `src/App.tsx` — wrap `RouterProvider` in the provider (or do it in AppShell).

### E3.3 — tab bar (`packages/app`)

- **new** `src/components/layout/terminal-tab-bar.tsx` (+ `terminal-dock.tsx`).
- `src/components/layout/app-shell.tsx` — add the dock row to the grid (`:40`)
  and a header toggle (`:75-78`).
- `src/providers/terminal-sessions-provider.tsx` — open/close/switch/rename.

### E3.4 — reconnect (`packages/app` + `packages/desktop`)

- `packages/app/src/lib/host.ts` — `TerminalOpenOptions.sessionId`
  (`:255-272`); `TerminalHost.list(vmName)` + `kill(vmName, id)` (`:283-285`).
- `packages/desktop/src/host.ts` — thread `sessionId` in `terminal.open`
  (`:295-305`); add `terminal.list`/`terminal.kill` invoking the new commands.
- `packages/desktop/src-tauri/src/lib.rs` — `TerminalOpenInput.session_id`
  (`:3540-3564`); append `--session` in `microvm_host_shell_argv`
  (`:3589-3597`); new `terminal_sessions` + `terminal_kill_session` commands;
  register both in the `invoke_handler!` list (`:4363-4366`).
- `packages/desktop/src-tauri/src/terminal.rs` — mostly unchanged; document
  `close`=detach (`:156-161`); the explicit destroy goes through the new kill
  command, not here.
- `packages/app/src/providers/terminal-sessions-provider.tsx` — on mount,
  `terminal.list()` → re-attach each id into a tab.

## 7. Open questions

1. **Multiplexer: tmux (recommended) vs dtach/abduco.** tmux = replay on
   attach + `list-sessions` + already-in-dev, ~1 MB; dtach = ~25 KB and fully
   transparent but **no screen replay and no session list**.
2. **Privilege model: tmux as the `appliance` user (recommended), `--root` on a
   separate root-owned socket.** Compare two user-isolated sockets
   rather than one.
3. **Scope: sessions per-VM (recommended; tmux server in the guest, ids
   host-minted)** vs a global cross-VM session registry.
4. **tmux in the base apk world set — every VM, ~1 MB (recommended)** vs dev-only
   / lazy first-use install (keeps plain VMs lean but makes the feature
   conditional).
5. **Tab UX: a bottom terminal dock with a tab strip in app-shell (recommended)**
   vs tabs in the top header vs a dedicated route. Plus: do **pod-`exec`**
   terminals migrate into the dock as _non-reattachable_ tabs, or stay modal?
   (Only the microVM host/dev **vsock** shell is reattachable — `kubectl exec`
   has no tmux behind it.)
6. **One-shots + clock-sync stay on the non-tmux direct path (recommended).**
   Confirm we are NOT making `vm shell -- <cmd>` / devcontainer exec
   reattachable.
7. **Post-connect resize propagation** — add an in-band control message
   (tmux `refresh-client -C`) or accept initial-size-only. Follow-up, not
   blocking.
