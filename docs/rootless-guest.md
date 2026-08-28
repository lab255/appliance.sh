# Rootless guest user model (E2.0 spike)

**Status:** Decided (spike). **Scope:** GUEST-ONLY. The macOS host already
runs non-root — Virtualization.framework needs only the
`com.apple.security.virtualization` entitlement, not root — so nothing on the
host side changes here. This doc is the design E2.1–E2.3 implement.

**Problem.** Coding agents (Claude Code launched with
`--dangerously-skip-permissions`) refuse to run as root. Today every in-guest
entry point lands as **root**: the vsock interactive shell, one-shot
`appliance-vm shell <vm> -- …` commands, and therefore `appliance up` and
`devcontainer exec` (which all ride that same channel). We add a non-root
`appliance` user and land those entry points as that user.

**Design decision.** Add a non-root `appliance` user (uid/gid 1000 by
default — see §6 fork). Land shells / agents / devcontainer exec as that user.
**dockerd stays a root daemon** — rootless dockerd on diskless Alpine needs
subuid/subgid + fuse-overlayfs plumbing that buys little when the blast radius
is already a throwaway microVM (consistent with `docs/sandbox.md` §6). The user
is in the `docker` group so `docker` works without sudo; passwordless sudo
(`wheel` + `/etc/sudoers.d`) provides escalation; `vm shell --root` is a
first-class root escape hatch.

## 0. Headline

```
appliance (uid/gid 1000, groups: wheel,docker) — login shell, HOME=/persist/workspace,
passwordless sudo. The vsock shell agent execs `su -l appliance` by default;
`--root` (and the host clock-sync) keep a root shell. dockerd stays root; appliance
reaches it via the docker group. No host-side change.
```

## 1. Provisioning the `appliance` user (Alpine openrc, diskless, at boot)

### 1.1 Why it runs every boot

The microVM is **diskless** Alpine: the netboot initramfs rebuilds the root
filesystem into tmpfs every boot and applies the apkovl, then openrc's `local`
service runs `/etc/local.d/appliance.start` (`packages/vm/src/guest.rs:97`, the
`APPLIANCE_START` script). That means `/etc/passwd`, `/etc/group`,
`/etc/shadow`, `/etc/sudoers.d` are **re-created from scratch on every boot** —
so user creation is part of the bootstrap, not a one-time step.

**Idempotency story = pinned ids.** Because the passwd entry is regenerated
each boot, what must stay stable is the **uid/gid** (so files the user owns on
the persistent disk `/persist` keep consistent ownership across reboots). We
pin uid/gid; re-running `adduser`/`addgroup` is then harmless and guarded with
`|| true`.

### 1.2 Where it goes in the bootstrap

A new block inserted **after the `/persist` mount and before the vsock shell
agent launch** (`guest.rs:113-138`). It must precede the socat agent so the
first shell connection can already `su` to a real user. It is **unconditional**
(present on every VM, like the shell agent itself,
`guest.rs:744` `vsock_shell_agent_is_baked_into_every_vm`), not gated behind
`dev`/`docker`.

Prerequisites:

- Add `sudo` to `etc/apk/world` (`guest.rs:449-453`). World packages are
  installed by the diskless init **before** `appliance.start` runs, so `sudo`
  is present when the block executes. `adduser`/`addgroup` are busybox builtins
  (always present).

Proposed block (substituted markers `__APP_UID__`/`__APP_GID__` — see §6):

```sh
# --- non-root appliance user (E2.x) ---------------------------------
# Re-run every boot (diskless rootfs rebuilds /etc/passwd into tmpfs);
# uid/gid are PINNED so /persist ownership is stable across reboots —
# that pinning IS the idempotency story. Guards make re-runs harmless.
APP_USER=appliance
APP_UID=__APP_UID__        # 1000 by default; host uid on --mount VMs (§6)
APP_GID=__APP_GID__
APP_HOME=/persist/workspace

mkdir -p "$APP_HOME"
addgroup -g "$APP_GID" "$APP_USER" 2>/dev/null || true
# busybox adduser: -D no password, -H don't create home (it's on /persist,
# made above), -h home, -s login shell, -G primary group, -u uid.
adduser -D -H -u "$APP_UID" -G "$APP_USER" -h "$APP_HOME" -s /bin/sh "$APP_USER" 2>/dev/null || true
addgroup "$APP_USER" wheel 2>/dev/null || true        # sudo
# `docker` group is created by the docker apk package, so membership is
# added in DOCKER_PROVISION (see §4), not here.
chown "$APP_UID:$APP_GID" "$APP_HOME" 2>/dev/null || true   # best-effort (§6)
chmod 0755 "$APP_HOME" 2>/dev/null || true

mkdir -p /etc/sudoers.d
printf '%s\n' "$APP_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/appliance
chmod 0440 /etc/sudoers.d/appliance

# Login env: npm global prefix under HOME so `npm i -g @devcontainers/cli`
# (appliance up) installs unprivileged. /etc/profile.d/*.sh is sourced by
# the login shell su -l starts.
mkdir -p /etc/profile.d
cat > /etc/profile.d/appliance-user.sh <<'PROFILE'
export NPM_CONFIG_PREFIX="$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
PROFILE
```

| Property                   | Value                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| user / primary group       | `appliance` / `appliance`                                                                |
| uid / gid                  | `1000` default; host uid/gid on `--mount` VMs (§6 fork)                                  |
| supplementary groups       | `wheel` (sudo), `docker` (added once dockerd's group exists, §4)                         |
| login shell (passwd)       | `/bin/sh` — the agent overrides to bash at connect time (§2)                             |
| HOME / workspace           | `/persist/workspace` (consolidates today's split `/persist/home` + `/persist/workspace`) |
| sudo                       | passwordless, `/etc/sudoers.d/appliance` (`0440`)                                        |
| `/persist/workspace` perms | `0755`, owned `appliance:appliance` (best-effort; shadowed by a virtiofs share, §6)      |

### 1.3 Interaction with the existing dev block

`DEV_PROVISION` (`guest.rs:260-293`) currently writes
`/etc/profile.d/appliance-dev.sh` exporting `HOME=/persist/home` and the agent
exports the same (`guest.rs:407`). With `su -l` deriving HOME from passwd
(=`/persist/workspace`), E2.x must **drop the `HOME=/persist/home` export** from
both `DEV_PROVISION` and `SHELL_AGENT` (otherwise it overrides the user's HOME
and breaks ownership). Keep `APPLIANCE_DEV=1` and the PATH addition. The
`mkdir -p /persist/workspace` in `DEV_PROVISION` stays (idempotent with §1.2).

## 2. Dropping the vsock shell agent to `appliance`

### 2.1 The drop, and why the exit-code sentinel survives

The agent (`SHELL_AGENT`, `guest.rs:401-410`) is the socat `EXEC` target,
launched root with `pty,setsid,ctty` (`guest.rs:131-134`). It reads one leading
`rows R cols C` line, applies it as the PTY size, then today `exec bash -l`.

The host carries a command's exit code **in-band** because the relay is a raw
byte pipe with no status channel (`packages/vm/src/shell.rs:33-41`): for a
one-shot it writes, after the size line,
`"{cmd}; printf '\n__APPLIANCE_VM_RC__%d__END__\n' \"$?\"\nexit"`, and the
client parses `__APPLIANCE_VM_RC__<n>__END__` back out
(`shell.rs:76,119-124`). Those bytes are read by the **login shell**, not the
agent.

Drop strategy: size the PTY as root (it owns the tty), then `exec su` to the
shell. Because `su` (root→user, no password) does not touch the byte stream and
the login shell it execs inherits the same PTY stdin/stdout, the host's
`…; printf '\n__APPLIANCE_VM_RC__%d__END__\n' "$?"` runs in that shell with the
command's real `$?`. **The uid switch is invisible to the sentinel protocol.**

Proposed agent:

```sh
#!/bin/sh
# appliance-vm shell agent — one login shell per vsock connection.
# Runs as root (socat EXEC), sizes the PTY, then drops to `appliance`
# unless the caller appended a `root` token to the size line.
stty -echo 2>/dev/null
IFS= read -r __SZ
__ROOT=0
case "$__SZ" in *" root") __ROOT=1; __SZ="${__SZ% root}";; esac   # strip token
[ -n "$__SZ" ] && stty $__SZ 2>/dev/null
stty echo 2>/dev/null
if command -v bash >/dev/null 2>&1; then __SH=/bin/bash; else __SH=/bin/sh; fi
if [ "$__ROOT" = 1 ]; then
  cd /persist/workspace 2>/dev/null || cd /root 2>/dev/null || cd /
  exec "$__SH" -l
fi
# su -l: sets HOME/USER/SHELL from passwd, login-shell, cd's to HOME
# (=/persist/workspace). Same PTY stdin/stdout → the one-shot sentinel
# still runs here with the command's real $?. (busybox su supports -s/-l.)
exec su -s "$__SH" -l appliance
```

### 2.2 Host clock-sync MUST stay root (critical interaction)

`spawn_clock_sync`/`push_clock` (`shell.rs:68-122`) reuse this exact channel to
push the host wall-clock into the guest with `date -u -s @EPOCH`
(`clock_set_command`, `shell.rs:129-136`). **Setting the system clock needs
root** — if that push lands as `appliance` it fails silently (the command ends
`|| true`) and the clock-skew 401 bug this thread fixes returns.

**Recommendation:** clock-sync sends the **`--root` token** — change the size
line it writes (`shell.rs:108`) from `b"rows 24 cols 80\n"` to
`b"rows 24 cols 80 root\n"`, so the whole shell is root and `date -s` works with
no sudo dependency. This also works from the first moment the agent is up, even
before the `appliance` user is fully provisioned (the root path doesn't depend
on it). Fallback if the root token is undesirable: prefix the command with
`sudo` in `clock_set_command` (appliance has passwordless sudo). Either way the
push drains to EOF and does **not** use the RC sentinel, so the sentinel is
unaffected. **Implementer note:** an E2.x test must cover that clock-sync still
sets the guest clock after the drop.

## 3. `--root` escape hatch

Signaling rides the existing one-line size handshake (no new vsock port, no new
relay): a trailing `root` token on the size line requests a root shell; the
agent strips it (§2.1) and `exec "$__SH" -l` as root instead of `su`.

- `packages/vm/src/main.rs:121-127` `Cmd::Shell` gains `#[arg(long)] root: bool`;
  dispatch (`main.rs:646-650`) passes it to `run_client`.
- `packages/vm/src/shell.rs:21,30-32` `run_client(name, command, root)` writes
  `writeln!(stream, "rows {rows} cols {cols}{}", if root {" root"} else {""})`.
- `appliance vm shell --root` → root shell; default → `appliance`.
- Manual alternative inside any `appliance` shell: `sudo -i` / `sudo <cmd>`
  (passwordless). `vm shell --root` is the first-class path; clock-sync uses the
  token form (§2.2).

## 4. `appliance up` / devcontainer exec land as the user — for free

Every in-guest command from the TS CLI flows through
`vmShell(vm, cmd) = appliance-vm shell <vm> -- <cmd…>`
(`packages/cli/src/utils/sandbox.ts:70-71`). Once the agent defaults to
`appliance` (§2), **all of these run as `appliance` with no CLI change**:

- `docker build` / `docker run` / `docker compose up` (`appliance-up.ts`) — work
  because `appliance` is in the `docker` group, so the CLI reaches root dockerd's
  `/var/run/docker.sock` (default perms `root:docker 0660`) without sudo.
- `devcontainer up` / `devcontainer exec --workspace-folder /persist/workspace …`
  (`appliance-up.ts`, `appliance-shell.ts:40-58`) — run as `appliance`; they
  shell out to `docker` (docker group). The container's **internal** user is
  still governed by the image / `devcontainer.json` `remoteUser`, untouched by
  this change.
- Readiness probes `test -f /persist/.docker-ready`, `docker version`
  (`sandbox.ts:510-533`) — fine as `appliance`.

Two things E2.x must wire so this actually works as `appliance`:

1. **docker group membership.** The `docker` group only exists after
   `apk add docker`. Add `addgroup appliance docker 2>/dev/null || true` to
   `DOCKER_PROVISION` (`guest.rs:337-394`), right after the install. Docker
   commands run only after `waitForDocker` (`sandbox.ts:510`) sees
   `.docker-ready`, which is written after dockerd starts — so any fresh one-shot
   shell after that picks up the group. No daemon restart needed.
2. **npm global prefix.** `appliance up` runs `npm install -g @devcontainers/cli`
   (`appliance-up.ts`). As non-root that fails EACCES against a root-owned npm
   prefix. The `NPM_CONFIG_PREFIX="$HOME/.local"` export in §1.2 redirects global
   installs under HOME so it succeeds unprivileged.

## 5. Security analysis

**`docker` group membership is root-equivalent — state it honestly.** A member
of `docker` can `docker run --privileged -v /:/host …` and obtain full root in
the guest, and — given **root dockerd + the host-folder share** mounted
read-write at `/persist/workspace` (`guest.rs:300-308`, `docs/sandbox.md` §6) —
read/write the user's host files under that share. So the `appliance` user can
**trivially regain root-in-VM**, and (via the share) reach the host's shared
tree.

**Consequence:** the non-root user model is **footgun-prevention /
defense-in-depth, NOT a privilege boundary.** Its actual value:

- lets `--dangerously-skip-permissions` coding agents run at all (they refuse as
  uid 0) — the concrete goal of this change;
- removes casual "everything is root" mistakes in the interactive shell.

It does **not** sandbox a hostile process: docker access (or `sudo`, or
`vm shell --root`) is one step back to root. **The real isolation boundary
remains the throwaway microVM**, exactly as `docs/sandbox.md` §6 already states
for root dockerd. Do not market non-root as containment.

**Acceptable?** Yes — it is consistent with the already-accepted posture
(`docs/sandbox.md` §6: root dockerd, "the VM is the primary isolation
boundary"). We are adding a porous non-root layer on top of an all-root guest;
we weaken nothing.

**`shell.sock` peer / permissions — unchanged.** The relay still binds the
per-VM socket `0600` owner-only (`packages/vm/src/backend/vz/shell.rs:43-44`).
Its comment "direct line to a root shell" becomes "direct line to a shell with
passwordless sudo + `--root`" — i.e. **the same effective authority**
(root-in-VM). So the host→guest trust gate is not regressed: whoever could open
`shell.sock` before could get a root shell, and still can. Keep `0600`, and
adopt `docs/sandbox.md` §6's hardening (per-VM state dir `0700`,
`store.rs:43`; optional `SO_PEERCRED` owner-uid check in the relay) — those are
orthogonal to this change but reinforce the only real host-side gate.

**Net:** no change weakens the existing boundary. The clock-sync root token
(§2.2) rides the same `0600` channel — no new surface. Adding `sudo` to every
VM's package set is a trivial attack-surface delta given the guest is already
all-root and throwaway.

## 6. Open questions

1. **uid/gid on `--mount` VMs.** The
   decision says uid/gid `1000`. But on a `--mount` / dev VM the host folder is
   shared over VirtioFS at `/persist/workspace` (the user's HOME) and presents
   **host-side ownership** (the Mac user's uid, e.g. `501`). A non-root
   `appliance` (uid 1000) then cannot write host-owned files that **root writes
   freely today** — a regression for `appliance up` workflows that write the
   workspace (git, build scratch, devcontainer state).
   - **Recommended:** for VMs with a host-folder share, provision `appliance`
     with **uid/gid = the host user's** (`libc::getuid()/getgid()` in the
     resident host process, substituted as `__APP_UID__/__APP_GID__` at
     boot-media build time, like the other `__…__` markers in
     `guest.rs:471-480`); default to `1000` only when there is no share. Matching
     the host uid lines guest ownership up with the host so `appliance` reads
     and writes the shared tree exactly as the host user does. Security-neutral
     (root already writes that tree; matching uid only affects the share the
     host user fully controls) — but it deviates from the flat "uid 1000".
   - **Alternative (lower-effort, worse UX):** keep uid 1000 and accept a
     read-only / partially-writable shared workspace, or mount it `--mount`
     read-only (which `docs/sandbox.md` §6 already floats as a docker-escape
     mitigation). E2.x **must** verify actual write behavior of `appliance` on a
     `--mount` VM before committing — VZ virtiofs uid mapping/DAC behavior should
     be tested, not assumed.
2. **Value despite docker-group being root-equivalent.** Non-root buys little
   _isolation_ (§5), but provides agent compatibility; do not oversell it. The
   "not a boundary" framing and `0700` state-dir hardening do not block the
   implementation.

## 7. Downstream tasks (E2.1–E2.3)

- **E2.1 — Provision the user.** Add `sudo` to `etc/apk/world`; insert the §1.2
  block into `APPLIANCE_START` after the `/persist` mount and before the socat
  agent; resolve uid/gid per §6 (markers + host-uid on `--mount`); drop the
  `HOME=/persist/home` exports (§1.3). **Accept:** `id appliance` shows
  uid/gid + `wheel`; `sudo -n true` works; survives reboot with stable
  ownership of `/persist/workspace`.
- **E2.2 — Drop the shell + escape hatch.** Rewrite `SHELL_AGENT` to
  `exec su -s "$__SH" -l appliance` with the `root`-token branch (§2.1); add
  `--root` to `Cmd::Shell` + `run_client` (§3); switch clock-sync to the root
  token (§2.2). Update the `vsock_shell_agent_is_baked_into_every_vm` test
  (`guest.rs:744`, asserts literal `exec bash -l`/`exec sh -l`). **Accept:**
  `vm shell` → `whoami` = `appliance`; `vm shell --root` → `root`; `vm shell --
false` propagates exit `1` (sentinel intact); guest clock is corrected.
- **E2.3 — docker/devcontainer as the user.** Add `addgroup appliance docker`
  to `DOCKER_PROVISION`; confirm `NPM_CONFIG_PREFIX` lets
  `npm i -g @devcontainers/cli` run unprivileged (§4). **Accept:** on the warm
  managed VM, `appliance up` (Dockerfile / compose / devcontainer) builds + runs
  end-to-end as `appliance`; `appliance shell` lands in the devcontainer; k3s
  still reaches `Ready`.
