# Agent sandboxes — running coding agents inside the microVM (Phase 5)

**Status:** Design. **Scope:** the architecture and security design for agent
sandboxes.

**Goal.** Run a coding agent — **Claude Code first**, with a pluggable
adapter seam for other CLI agents later — inside the Phase-4 microVM
sandbox, against a linked project's workspace, observed and steered from
the desktop tab dock. The **Anthropic API key is brokered host-side**: it
is injected into the agent's TLS traffic at the egress proxy and **never
enters the VM**.

**Design decisions.** Claude Code first (adapter seam later);
host-side credential broker (key never in VM); **interactive + autonomous**
modes both; **MVP** = one agent per project/VM, observed via a tab
(fleet / history / approvals deferred).

## 0. Headline

> **Security caveat (read first).** The **microVM is the only real
> isolation boundary** here. The agent sandbox is **NOT containment for
> hostile code** — do not market it as such. The non-root `appliance`
> user, the docker-group footgun-prevention, and the cooperative egress
> proxy are convenience + a key-injection point, not a jail. Two
> corollaries follow directly and must stay in view:
>
> 1. **A rooted/jailbroken guest can still spend the user's Anthropic
>    billing.** It can't read the key (it's brokered host-side, §3/§9),
>    but it can drive the proxy to make billed calls on the user's behalf
>    for as long as it routes through the proxy.
> 2. **Under the default-allow policy, a prompt-injected agent can
>    exfiltrate the mounted `/persist/workspace`** to any host. Egress is
>    cooperative (`HTTP(S)_PROXY` env), so even tightening it is
>    bypassable while routing stays cooperative — the firewall follow-up
>    (§9 fork 2) is the real mitigation.
>
> What the broker _does_ guarantee: the **Anthropic API key never enters
> the VM** (§3), and the proxy **fails closed** — it never forwards the
> in-guest placeholder upstream (§3, A2).

The agent is a process in a **reattachable tmux session `agent-<id>`**,
launched as the non-root `appliance` user in `/persist/workspace` — the
exact Phase-4 vsock shell transport (`appliance-vm shell <vm> --session
agent-<id>`), just with a different first command and a different tab type.
The **credential broker already exists** (egress proxy + `creds.rs` +
`mitm.rs`): we add one credential rule for `api.anthropic.com` whose value
comes from a host-side helper, turn MITM on, and the proxy rewrites the
auth header on the agent's outbound TLS. **The only genuinely new wiring is
getting `HTTP(S)_PROXY` into the tmux session's environment** — today that
proxy env is injected only into k8s pods, not shell sessions. CA trust is
mostly free: Claude Code's cert store defaults to `bundled,system` and the
guest _system_ store already trusts the egress CA.

```
desktop "Run agent" / `appliance agent run`
  → appliance-vm shell <vm> --session agent-<id>          (vsock, Phase 4)
      → su -l appliance in /persist/workspace             (guest.rs SHELL_AGENT)
        → env HTTPS_PROXY=http://<gw>:<egress> CLAUDE_CODE_CERT_STORE=bundled,system \
              ANTHROPIC_API_KEY=<placeholder> claude [-p "<task>"]   (NEW: A1)
            → TLS to api.anthropic.com via the egress proxy
                → MITM: proxy replaces X-Api-Key with the REAL key      (A2)
                    → upstream Anthropic   (key sourced host-side, never in VM)
```

## 1. What's already built (the reuse map)

Everything below ships today; Phase 5 composes it. Verify these anchors
before building — line numbers drift.

| Capability                                                                                                                                                | Where                                                                                                                                                                                                                                                                 | Notes                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Boot the managed VM with docker + workspace (agents ride the ONE `appliance` VM, booted dev-capable — the separate `appliance-sbx` sandbox VM is retired) | `packages/cli/src/utils/sandbox.ts:482` `ensureSandboxVm` (used by `appliance-up.ts:14`)                                                                                                                                                                              | `runVm(['up', vm, '--docker', '--mount', dir])` (`sandbox.ts:500`); waits for dockerd                          |
| VirtioFS workspace                                                                                                                                        | `GUEST_WORKSPACE = '/persist/workspace'` (`sandbox.ts:22`); mount in `guest.rs` `DEV_MOUNT` (`guest.rs:404`)                                                                                                                                                          | host folder ↔ guest, same tree                                                                                |
| Non-root `appliance` user + npm prefix                                                                                                                    | `guest.rs` user block (`guest.rs:269`); `NPM_CONFIG_PREFIX="$HOME/.local"`, PATH (`guest.rs:316`); `nodejs npm` in dev toolchain (`guest.rs:390`); `addgroup appliance docker` (`guest.rs:477`)                                                                       | HOME = `/persist/workspace`; agents refuse to run as root — this is why E2 exists                              |
| Reattachable tmux session transport                                                                                                                       | `guest.rs` `SHELL_AGENT` (`guest.rs:535`); verb routing (`guest.rs:562`), `new-session -A -s appliance-$__SID` (`guest.rs:578`), `su -s "$__SH" -l appliance` (`guest.rs:594`)                                                                                        | `tmux -L appliance` socket; survives disconnect                                                                |
| Shell client `--session`                                                                                                                                  | `packages/vm/src/shell.rs` `run_client` (`shell.rs:38`); `validate_session_id` (`shell.rs:182`); `list_sessions` (`shell.rs:121`) / `kill_session` (`shell.rs:139`)                                                                                                   | one-shot vs interactive paths                                                                                  |
| CLI surface                                                                                                                                               | `appliance-vm.ts`: `shell --session <id>` (`appliance-vm.ts:340`), `up --mount` (`appliance-vm.ts:415`), `creds add` (`appliance-vm.ts:672`)                                                                                                                          |                                                                                                                |
| Desktop tab dock + rehydrate                                                                                                                              | `packages/app/src/providers/terminal-sessions-provider.tsx` (`openSession`, `mintSessionId` = `${mode}-${uuid}` `:179`, rehydrate effect `:493`); tab bar `components/layout/terminal-tab-bar.tsx`; "Open shell" call `pages/local-runtime/index.tsx:629`             |                                                                                                                |
| Desktop → vsock argv                                                                                                                                      | `packages/desktop/src-tauri/src/lib.rs` `microvm_host_shell_argv` (`:3421`, appends `--session` `:3443`), `terminal_open` (`:3514`)                                                                                                                                   |                                                                                                                |
| Project ↔ VM link                                                                                                                                        | `packages/cli/src/utils/link.ts` `SandboxLink` (`:46`), `readSandboxLink`/`writeSandboxLink`                                                                                                                                                                          | `.appliance/link.json`                                                                                         |
| **Egress forward proxy**                                                                                                                                  | `packages/vm/src/egress.rs`: `spawn` (`:161`) / `run_proxy` (`:140`), `handle_conn` (`:225`), `guest_proxy_url` (`:408`), `peer_allowed` (`:379`), `DEFAULT_EGRESS_PORT 5053` (`:431`)                                                                                | spawned by `vm run` binding `0.0.0.0:<egress_port>` (`main.rs:581`); peer-gated to the guest subnet + loopback |
| **Credential capture / inject**                                                                                                                           | [`packages/vm/src/creds.rs`](../packages/vm/src/creds.rs): `CredentialRule`, direct argv helper execution, case-insensitive replacement, capture, and Windows ACL tests                                                                                               | ACL-reset config `egress-credentials.json`; opt-in cleartext capture in ACL-reset `egress-secrets.json`        |
| **TLS interception (MITM)**                                                                                                                               | `packages/vm/src/mitm.rs`: `ensure_ca` (`:46`), `ca_cert_path` = `egress-ca.pem` (`:30`), `intercept` (`:193`, calls `capture_from_head` `:228` then `injection_for`+`set_header` `:240`), minting `server_config` (`:154`), webpki `client_config` upstream (`:165`) | per-VM CA, leaf-per-host                                                                                       |
| **Egress CA trusted guest-wide at boot**                                                                                                                  | `guest.rs` `update-ca-certificates` on `/usr/local/share/ca-certificates/appliance-egress.crt` (`:105`); apkovl placement (`:701`, present even when MITM off); build wiring `ensure_ca`+read PEM (`:755`)                                                            | **already done** — non-Node tools (curl/git/openssl) trust the CA                                              |
| CLI creds + mitm                                                                                                                                          | `appliance-vm.ts` `creds add --inject --helper` (`:672`); `main.rs` `run_creds` (`:755`), `egress mitm on` (`:869`)                                                                                                                                                   |                                                                                                                |
| **The pod-only gap**                                                                                                                                      | `packages/infra/.../LocalContainerDeploymentService.ts` `egressEnv` (`:965`), `NODE_EXTRA_CA_CERTS` (`:982`), `renderManifest` env merge (`:1010`); `appliance-egress` ConfigMap published by `egress.rs publish_configmap` (`:489`)                                  | proxy env reaches **k8s pods only** — never a tmux process                                                     |

Host state for a VM lives under `~/.appliance/vm/<name>/`
(`VmPaths::for_name`, `spec.rs:256`): `egress-policy.json`,
`egress-credentials.json`, `egress-secrets.json` (owner-only mode on Unix,
current-user ACL on Windows), `egress-ca.pem`,
`shell.sock`, `guest-ip`.

## 2. Agent runner (A1)

An agent is **not** a new transport — it is the Phase-4 reattachable shell
with (a) an `agent-` session id, (b) the proxy/CA/placeholder env in front
of the launch command, and (c) the agent CLI as that command.

**Session id.** `agent-<uuid>` (mirrors the desktop `${mode}-${uuid}`
convention, `terminal-sessions-provider.tsx:179`; satisfies
`validate_session_id`, `shell.rs:182`). The `agent-` prefix is how the
rehydrate path and the registry tell agent tabs from plain shells.

**Launch (interactive).** The desktop / CLI opens the reattachable session
and, inside it, runs the adapter's launch script. Concretely the in-guest
command the tmux session runs is:

```sh
cd /persist/workspace
exec env \
  HTTP_PROXY="$AP" HTTPS_PROXY="$AP" NO_PROXY="$ANP" \
  http_proxy="$AP" https_proxy="$AP" no_proxy="$ANP" \
  CLAUDE_CODE_CERT_STORE=bundled,system \
  ANTHROPIC_API_KEY="$PLACEHOLDER" \
  claude            # interactive TTY; `claude -p "<task>"` for autonomous
```

where `$AP` = `guest_proxy_url(name, egress_port)` (the subnet `.1`
gateway, `egress.rs:408`) and `$ANP` mirrors the pod `NO_PROXY`
(`egress.rs:451`). `CLAUDE_CODE_CERT_STORE=bundled,system` makes Claude
Code consult the guest system trust store, which already holds the egress
CA (§4b). See §3 for `$PLACEHOLDER`, and §4 for the one unverified
assumption (does Claude Code honor `HTTPS_PROXY`) that gates this snippet.

**Why reuse, not rebuild.** The session already lands as `appliance` in the
workspace with docker on the `docker` group; tmux already makes it
reattach-survivable; the desktop already rehydrates running sessions on
launch (`terminal-sessions-provider.tsx:493`). A1 only adds the env prefix,
the `claude` command, and the agent-typed registry/tab.

## 3. Cred-broker wiring for `api.anthropic.com` (A2)

This is the security spine. The key flow, end to end:

1. **Where the host key lives.** `appliance agent login` stores the Anthropic
   credential in macOS Keychain, Windows Credential Manager, or an owner-only
   Linux file. On Windows the CLI reaches Credential Manager through the
   digest-verified sibling helper. **The key is never written into a per-VM
   file or the VM by the default rule.** The store and migration paths are
   covered by [`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts).

2. **The credential rule.** `appliance agent run` (or `appliance-vm creds
add`) writes one rule to the VM's `egress-credentials.json`
   (`creds.rs:54`):

   ```json
   {
     "host": "api.anthropic.com",
     "inject": true,
     "capture": false,
     "header": "x-api-key",
     "helper": ["<abs appliance exe>", "agent", "print-key", "--type", "claude-code"]
   }
   ```

   - `inject: true` → on each intercepted request to `api.anthropic.com`,
     `injection_for` (`creds.rs:204`) runs the **helper** host-side
     (`run_helper`, `creds.rs:215`). It is spawned directly (argv); legacy strings
     via `sh -c` on Unix only; rejected on Windows. Its stdout is trimmed, and
     `set_header` (`creds.rs:226`) replaces the header on the **outbound
     copy only**.
   - `helper` resolves the key fresh from the platform host store each call — so
     nothing persists the key, not even `egress-secrets.json`. (Stored
     secrets remain available as a fallback, but the helper is preferred,
     `creds.rs:207`.)
   - `header: "x-api-key"` because Claude Code sends `ANTHROPIC_API_KEY` as
     the **`X-Api-Key`** header (confirmed via the claude-code-guide check),
     which is also how the Anthropic API authenticates (+ `anthropic-version`)
     — **not** `Authorization: Bearer`. The `creds.rs` default is
     `authorization`; this rule overrides it to `x-api-key`. _(If instead an
     `ANTHROPIC_AUTH_TOKEN` / gateway-bearer flow is chosen, the header flips
     to `authorization` and the placeholder var changes accordingly — §11.)_

3. **MITM on.** `appliance-vm egress mitm on` (`main.rs:869`) sets
   `policy.mitm = true` and ensures the CA. With MITM on, the proxy
   terminates the agent's TLS to `api.anthropic.com` with a minted leaf
   (`mitm.rs:154`), reads the decrypted head, injects the real key, and
   re-originates a fresh validated TLS connection upstream
   (`mitm.rs:231`,`:240`). The agent's TLS endpoint is the proxy; the
   proxy's TLS endpoint is Anthropic.

4. **The placeholder key (the broker trick).** Claude Code **will not start
   without auth present in its precedence chain** (confirmed via the
   claude-code-guide check) — so a credential _must_ be in the VM env for
   the CLI to run and emit the header at all. We give the VM a **placeholder**
   `ANTHROPIC_API_KEY` (e.g. `sk-ant-appliance-proxy`) so the CLI proceeds
   and sends `X-Api-Key: sk-ant-appliance-proxy`. The proxy's `set_header`
   **overwrites** that placeholder with the real key before it leaves the
   host (`creds.rs:226` replaces case-insensitively). **A real key never
   exists inside the VM** — the placeholder is inert if exfiltrated.
   _(One untested point, §11: confirm Claude Code accepts a
   syntactically-shaped placeholder without local pre-validation. We do NOT
   use Claude Code's own in-guest `apiKeyHelper` setting — that would resolve
   the key inside the VM, defeating the broker; host-side proxy injection is
   the whole point.)_

5. **Fail closed (A2 — implemented).** If the host helper yields nothing
   for `api.anthropic.com` (platform store denied, not logged in, helper
   non-zero), the proxy must **never** forward the in-guest placeholder
   upstream. `mitm::intercept` now resolves `injection_for` **before
   dialing upstream**; when it's empty but the host has an inject rule
   (`creds::has_inject_rule`), the proxy **refuses** with a clear
   `502 — Anthropic key not configured (run \`appliance agent login\`)`and
dials no upstream. The placeholder therefore crosses the host boundary
**zero times**, even on the error path. The Anthropic rule is`capture:false`, so the placeholder is never lifted into
`egress-secrets.json` either.

6. **Helper TTL cache (A2 — implemented).** `run_helper`
   (`creds.rs`) caches the resolved key for a short TTL (~15s) keyed on
   the helper command, so streaming/keep-alive traffic doesn't fork
   the argv helper (`["<abs appliance exe>","agent","print-key","--type","claude-code"]`)
   per request. Helpers are spawned directly (argv); legacy strings via `sh -c`
   on Unix only; rejected on Windows. The cached value is
   a secret and is never logged. The cred rule pins the helper's
   **absolute** binary path (not a PATH-relative `appliance`).

**Net key flow:** platform host store → `appliance agent print-key --type
<agent>` → helper stdout (host, TTL-cached) →
proxy `set_header` on the outbound TLS (host) → Anthropic. The key
crosses the host↔guest boundary **zero times**. The proxy logs the
request **line only** (never headers), so a brokered key never reaches a
log.

The broker rule stores the helper as argv, not a shell string:
`["<absolute appliance executable>", "agent", "print-key", "--type",
"<agent>"]`. The TypeScript `print-key` command reads the platform store; on
Windows that reaches Credential Manager through `appliance-credhelper.exe`.
The VM engine requires an absolute Windows executable, spawns argv directly,
and rejects legacy shell strings. This contract is asserted in
[`agent.spec.ts`](../packages/cli/src/utils/agent.spec.ts),
[`lib.rs`](../packages/desktop/src-tauri/src/lib.rs), and
[`creds.rs`](../packages/vm/src/creds.rs).

Capture is a separate, explicit opt-in and keeps the same default as macOS:
normal generated agent rules set `capture:false`. If a user enables capture,
the selected header is cleartext in per-VM `egress-secrets.json`; Windows
resets that file to the current-user ACL, but backups, same-user code,
Administrator/SYSTEM, and WSL file access remain residuals. The capture and
`capture:false` cases are tested in [`creds.rs`](../packages/vm/src/creds.rs).
On Windows, `appliance doctor` warns for every enabled capture rule, naming
the VM and host while restating those residual risks; the fixture coverage is
in [`runtime-doctor.spec.ts`](../packages/cli/src/utils/runtime-doctor.spec.ts).
The managed Appliance WSL2 distro also disables Windows interop and drive
automount in [`wsl.rs`](../packages/vm/src/backend/wsl.rs).

Brokered injection is intended to be disabled on WSL v1, where exact-lease
re-attribution cannot survive SNAT. This baseline does not yet contain the
backend gate attributed to #109, so WSL v1 refusal is not a shipped guarantee
in this document; [`agent.ts`](../packages/cli/src/utils/agent.ts) is the
current broker path and the
[Windows runbook](live-test-runbook-windows.md) requires WSL2.

## 4. Proxy-into-the-shell — the gap, and how A2 closes it

Today `HTTP(S)_PROXY` + CA trust reach **k8s pods** via the
`appliance-egress` ConfigMap + `egressEnv`
(`LocalContainerDeploymentService.ts:965`). A tmux process gets none of it.
Two halves:

### 4a. Proxy env into the session

Inject `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (both casings) into the
agent's launch env (§2). Values come straight from the existing helpers:
`guest_proxy_url(name, vm_egress_port(name))` (`egress.rs:408`,`:436`) and
the pod `NO_PROXY` string (`egress.rs:451`). **Recommended mechanism:** the
host builds the `env …` prefix and passes it as the session's launch
command — the env lives only in the agent process, not guest-wide, so plain
`appliance vm shell` sessions are unaffected. (Alternative considered and
rejected for MVP: a guest-wide `/etc/profile.d/appliance-agent-egress.sh` —
simpler but leaks proxy env into every shell and can't be scoped per
agent.)

> **Load-bearing assumption to verify first (A2).** Claude Code's docs
> route via `ANTHROPIC_BASE_URL`; standard `HTTP_PROXY`/`HTTPS_PROXY`
> honoring is **not explicitly documented** (it's a Node process so it
> _likely_ honors them, but unconfirmed). A2's first task is an empirical
> check that `claude` actually tunnels `api.anthropic.com` through
> `HTTPS_PROXY` (so the egress proxy's CONNECT+MITM path engages). **If it
> does not**, the fallback is to point `ANTHROPIC_BASE_URL` at a host-side
> listener that authenticates + forwards — a small new component rather
> than reusing `egress.rs`/`mitm.rs` untouched. The whole §3/§4 broker
> reuse hinges on this; resolve it before A2 proper.

### 4b. CA trust — mostly already done

The per-VM egress CA is **already trusted guest-wide** at boot
(`update-ca-certificates`, `guest.rs:105`; CA placed in the apkovl even
when MITM is off, `guest.rs:701`). So system-trust-store consumers — curl,
git, openssl, dockerd — already validate the interception proxy.

**Claude Code specifically** uses its own cert-store control,
`CLAUDE_CODE_CERT_STORE`, which **defaults to `bundled,system`** (confirmed
via the claude-code-guide check) — i.e. it _already_ consults the guest
system store, which _already_ holds the egress CA. So in the common case
**no extra CA wiring is needed**: setting (or relying on the default)
`CLAUDE_CODE_CERT_STORE=bundled,system` is sufficient. Set it explicitly in
the launch-env prefix (4a) so the behavior is pinned regardless of future
default changes. The in-guest CA path, if a tool ever needs it directly, is
`/usr/local/share/ca-certificates/appliance-egress.crt`.

> Two corrections to the original recon:
>
> 1. "A shell agent gets no MITM CA automatically" — the **guest system
>    trust store already has the CA** (`guest.rs:105`), so it covers Claude
>    Code via the default `system` cert source. The proxy env (4a) is the
>    real gap; CA trust is effectively free here.
> 2. The recon's suggested `NODE_EXTRA_CA_CERTS` is **not documented as
>    supported by Claude Code** — prefer `CLAUDE_CODE_CERT_STORE`. Keep
>    `NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/appliance-egress.crt`
>    only as a belt-and-suspenders fallback (it's harmless and additive,
>    `LocalContainerDeploymentService.ts:982`).

### 4c. MITM scope + cross-VM key isolation (A2 — `egress.rs` DOES change)

> **Correction to the original design.** §3/§10 previously claimed A2
> needs **no `egress.rs`/`mitm.rs` change** ("they already inject"). That
> is **no longer true** — two security-driven changes land in A2:
>
> 1. **MITM scope (`egress.rs`).** `intercept = allowed && policy.mitm`
>    was VM-global: it decrypted **all** allowed HTTPS and forced one
>    request per `CONNECT` (`Connection: close`), breaking keep-alive +
>    streaming for Anthropic SSE **and** the npm registry. A2 narrows it
>    to `allowed && policy.mitm && creds::has_cred_rule(host)` — only
>    hosts with a credential rule are decrypted; every other allowed host
>    stays a blind, streaming-preserving tunnel.
> 2. **Cross-VM key isolation (`egress.rs` `peer_allowed`).** The gate
>    matched the whole vz `/24`, so a sibling VM on the same NAT could
>    drive this VM's proxy and spend its brokered key. A2 pins it to this
>    VM's **exact leased guest IP** once known (subnet match only in the
>    pre-lease boot window).
>
> Plus the §3 fail-closed + helper-TTL changes in `mitm.rs`/`creds.rs`.
> Net: A2 is **not** a pure config-over-existing-mechanics change.

## 5. In-guest agent provisioning (A1)

**Install-on-first-use**, mirroring the devcontainer-CLI pattern already in
the tree (`appliance-up.ts:277`: `command -v X || npm install -g X`):

```sh
command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code
```

- Package **`@anthropic-ai/claude-code`**, binary **`claude`** (Node 18+),
  confirmed via the claude-code-guide check.
- `node`/`npm` ship in the dev toolchain (`guest.rs:390`); the user's
  `NPM_CONFIG_PREFIX=$HOME/.local` (`guest.rs:316`) makes `npm i -g`
  succeed unprivileged — the same reason `appliance up` can install
  `@devcontainers/cli`.
- The install hits the network, which the egress policy must allow
  (`registry.npmjs.org`); with default-allow it just works, with
  default-deny the adapter's allowlist must include it.

**Modes the agent CLI must support:**

- **Interactive TTY:** bare `claude` in the tmux session → the desktop
  attaches it as a tab (§7).
- **Headless / autonomous:** `claude -p "<task>"` / `--print` runs one
  prompt to completion and prints the result; `--output-format json`
  (result + `session_id` + `total_cost_usd`) or `stream-json` for a
  structured result to capture, and `--json-schema '{…}'` for a validated
  result object; bypass tool prompts with `--dangerously-skip-permissions`
  (= `--permission-mode bypassPermissions`) — which is _why_ the non-root
  user exists, since agents refuse that flag as root (`docs/rootless-guest.md`
  §0). All flags confirmed via the claude-code-guide check.

## 6. Interactive vs autonomous execution model

|                | Interactive                                                                                          | Autonomous                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch         | `claude` (TTY) in `agent-<id>`                                                                       | `claude -p "<task>" --output-format json [--dangerously-skip-permissions]` in `agent-<id>`                                                                            |
| Observe        | desktop **attaches the tmux session as an agent tab** — same `openSession`/rehydrate path as a shell | a tab can still attach to **watch** the run live; tmux retains scrollback                                                                                             |
| Steering       | full keyboard — the user converses/approves in the tab                                               | none mid-run (MVP); approvals deferred                                                                                                                                |
| Completion     | session lives until closed (detach ≠ kill, `terminal-sessions-provider.tsx:422`)                     | run ends → capture stdout/result + exit code; registry marks `done`/`error`; tmux session lingers for inspection until reaped                                         |
| Result capture | n/a (live)                                                                                           | the one-shot sentinel path already carries an exit code in-band (`shell.rs:63`,`:209`); the structured `--output-format json` result is read from the captured stream |

Both share one transport and one session namespace; the only difference is
the first command and whether a human is attached.

**Autonomous lifecycle (A6 — chosen default: detached; `--wait` to block).**
`appliance agent start --task "<prompt>" --autonomous` **detaches by
default**: it launches the headless run into the `agent-<id>` tmux session
and returns immediately with the registry entry `running`, so a desktop tab
can attach to watch and the terminal is freed. The detached launch line
redirects Claude's `--output-format json` result to
`/persist/workspace/.appliance/agent-results/<id>.json` (+ a sibling `.rc`
holding the exit code) on the **VirtioFS-shared** workspace; because that is
the same tree host-side, `appliance agent list` reconcile reads it once the
tmux session ends and flips the entry to `done`/`error` with a short
`summary` — no VM round-trip to collect the outcome.

`--wait` instead **blocks**: it runs the headless task to completion as a
captured one-shot over the vsock exit-code sentinel (`shell.rs:63`,`:209`),
collecting stdout + the real exit code in-band, then classifies the result
(`done` iff exit 0 AND a non-error parsed result, else `error`), records the
terminal state, prints the result text + a "review the changes" pointer, and
exits non-zero on error so scripts can gate on it. The shared classifier is
`classifyAutonomousResult` (`utils/agent.ts`); the per-adapter result
extraction is `parseResult` (§8b).

## 7. Agent registry — `.appliance/agents.json`

Per-project, alongside `link.json` (same `.appliance/` dir,
`utils/link.ts`), additive and project-local so it commits/ignores with the
repo according to the project's version-control policy. MVP shape (one agent per project/VM, but modeled
as a list for forward-compat):

```jsonc
{
  "agents": [
    {
      "id": "agent-7f3c…", // = tmux session id (drop the `agent-` prefix is the host id)
      "type": "claude-code", // adapter key (§8)
      "vm": "appliance", // the SandboxLink.vm it runs in (the one managed VM)
      "mode": "interactive", // | "autonomous"
      "task": "fix the failing test", // autonomous: the prompt; interactive: optional label
      "status": "running", // running | done | error | exited
      "startedAt": "2026-06-29T…Z",
      "endedAt": null,
      "exitCode": null, // autonomous result
      "resultPath": null, // optional: captured JSON result on the workspace
    },
  ],
}
```

The registry is the desktop's source of truth for the agent-tab badge and
the CLI's `appliance agent ls/attach/stop`. Liveness reconciles against
`appliance-vm shell <vm> --session` listing
(`shell.rs:121`) — a registry entry whose tmux session is gone is `exited`.
_(Open question: commit `agents.json` or gitignore it — §11.)_

## 8. Desktop surface + the pluggable-adapter seam

### 8a. Desktop (A5)

An **agent-typed tab**, reusing the dock. Concretely:

- Extend `TerminalSessionMeta`/`LiveSession`
  (`terminal-sessions-provider.tsx:83`,`:96`) with an optional
  `agent?: { type: string; status: 'running'|'done'|'error' }` so the tab
  bar (`terminal-tab-bar.tsx`) can render an agent badge + status dot
  distinct from a plain shell.
- A **"Run agent"** entry on the linked-project / local-runtime view
  (beside the existing "Open shell" call, `pages/local-runtime/index.tsx:629`)
  opens a session with `sessionId = agent-<uuid>` and the agent launch
  command; rehydrate already reattaches it on relaunch
  (`terminal-sessions-provider.tsx:493` keys off the session id — extend
  `modeFromSessionId`/`mintSessionId` `:179`–`:186` to recognize the
  `agent-` prefix).
- Autonomous runs surface status from `agents.json`; the tab can attach to
  watch.

### 8b. Adapter seam (Claude Code first, others later)

A single in-repo interface (TS, consumed by the CLI + desktop; the per-host
cred rule is the only Rust-side input). An **agent-type adapter** provides:

```ts
interface AgentAdapter {
  type: string; // "claude-code"
  installCmd: string; // 'command -v claude || npm i -g @anthropic-ai/claude-code'
  launchArgv(opts): string[]; // interactive: ['claude']; autonomous: ['claude','-p',task,'--output-format','json', …]
  credHosts: CredentialRule[]; // [{ host:'api.anthropic.com', inject:true, header:'x-api-key', helper:['<abs appliance exe>','agent','print-key','--type','claude-code'] }]
  placeholderEnv?: Record<string, string>; // { ANTHROPIC_API_KEY: 'sk-ant-appliance-proxy' }  (required if the CLI won't start without auth)
  runtimeEnv?: Record<string, string>; // agent-specific, e.g. { CLAUDE_CODE_CERT_STORE: 'bundled,system' }
  parseResult?(stdout): { ok: boolean; summary?: string }; // autonomous result extraction
}
```

The runner is adapter-agnostic: it composes `installCmd` →
proxy/CA/placeholder env (§2/§4) → `launchArgv` in the `agent-<id>`
session; A2 applies `credHosts` + MITM. Adding "codex"/"aider"/etc. later
is a new adapter object — no transport, no broker change.

## 9. Security analysis

**What holds.**

- **The Anthropic key never enters the VM.** It lives in the platform host store,
  is fetched host-side by the helper (`run_helper`, `creds.rs:215`), and is
  written onto the request only at the proxy, on the outbound copy
  (`mitm.rs:240`, `creds.rs:226`). The VM holds at most an inert
  placeholder. Capturing the placeholder buys an attacker nothing.
- **MITM scope is the broker, and acceptable.** Trusting the egress CA lets
  the proxy read the agent's TLS to `api.anthropic.com` — that _is_ the
  broker. The CA is per-VM (`mitm.rs:46`) and host-private
  (`egress-ca.pem`, owner-only on Unix and ACL-reset on Windows).

**What does NOT hold — state it plainly.**

- **Egress is cooperative, not enforced.** Routing is `HTTP(S)_PROXY` env,
  which a hostile/jailbroken agent can drop, use `--network host`, or dial
  a raw IP to bypass (same posture as dockerd egress, `docs/sandbox.md` §6,
  `guest.rs:430`). **Consequence:** a bypassing agent gets **no key** (the
  injection only happens _at the proxy_), so the broker's secret stays
  safe — but **all other egress is wide open** under the default-allow
  policy. The proxy is a key-injection point, not a containment boundary.
- **The microVM is the only real isolation boundary** (`docs/sandbox.md`
  §6, `docs/rootless-guest.md` §5). Non-root `appliance` + docker-group is
  footgun-prevention, not a sandbox: `sudo`, the `docker` group, or
  `vm shell --root` all regain root-in-VM, and the VirtioFS share reaches
  the host tree the user mounted. An agent with
  `--dangerously-skip-permissions` runs arbitrary code in that blast
  radius. Acceptable _because the VM is throwaway and the only secret of
  value (the key) is brokered out of reach_ — but do not market the agent
  sandbox as containment for hostile code.

**Open questions.**

1. **Should the egress firewall gate shipping agents?** Today an agent can
   exfiltrate workspace contents to any host (default-allow). For an agent
   that runs untrusted code, the natural hardening is **default-deny +
   allowlist** (`api.anthropic.com`, the npm registry, the project's git
   remote) — but that requires follow-up firewall work,
   and even default-deny is bypassable while routing stays cooperative.
   Decision: ship MVP default-allow with the broker, and track the firewall
   as the security follow-up? (Recommended.)
2. **CA-trust scope.** The egress CA is trusted **guest-wide** today
   (`guest.rs:105`) — every guest process trusts the interceptor, not just
   the agent. Tightening to **agent-process-only** (drop the guest-wide
   `update-ca-certificates`; rely solely on per-process
   `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`) would shrink the interceptor's
   reach but breaks dockerd's MITM'd pulls and host curl/git, which depend
   on the system store. Recommended: keep guest-wide (it's a throwaway VM
   and the CA is per-VM + host-private); flag the trade explicitly.

## 10. A1–A6 file-set mapping

Implementation order: A0 → **A1 + A2** → **A3** → **A4 / A6**;
**A3 + A4** → **A5**.

- **A1 — Agent runner.** The runner that opens `agent-<id>`,
  composes install + proxy/CA/placeholder env + launch argv.

  - `packages/cli/src/utils/sandbox.ts` (reuse `ensureSandboxVm`, add an
    agent-launch helper alongside `vmShell`);
  - new `packages/cli/src/utils/agent.ts` (adapter type + claude-code
    adapter, §8b; install-on-first-use, §5);
  - `packages/cli/src/utils/link.ts` (read the linked VM/project for the
    target).
  - _Touches no transport — `shell.rs`/`guest.rs` are reused as-is._

- **A2 — Cred broker wiring + the proxy-into-shell gap.** The env prefix (§4) +
  the Anthropic cred rule/MITM (§3) + the
  host key store/helper (§9 fork 1).

  - launch-env composition in `packages/cli/src/utils/agent.ts` (proxy URL
    from `egress.rs:408` via `appliance-vm`; `NODE_EXTRA_CA_CERTS` path);
  - cred rule application reuses `creds.rs` (`upsert_rule`) +
    `egress mitm on` — driven via `appliance-vm creds add` / `egress mitm`
    (`appliance-vm.ts:672`,`main.rs:869`);
  - new host key store + `appliance agent login` / `print-key`
    (`packages/cli/src/appliance-agent.ts`; Keychain on macOS, mirroring
    `desktop/src-tauri/src/lib.rs` profile-store handling).
  - **`egress.rs` + `mitm.rs` + `creds.rs` DO change** (superseding the
    earlier "no change" note, see §4c): MITM scoped to cred-rule hosts +
    `peer_allowed` pinned to the exact guest IP (`egress.rs`); fail-closed
    refusal that never forwards the placeholder (`mitm.rs`); helper TTL
    cache + `has_cred_rule`/`has_inject_rule` (`creds.rs`).

- **A3 — CLI surface.** `appliance agent` command group.

  - new `packages/cli/src/appliance-agent.ts`: `run [--task] [--autonomous]`,
    `ls`, `attach <id>`, `stop <id>`, `login` (wraps A1/A2);
  - register in the CLI entry (mirror `appliance-vm.ts`/`appliance-up.ts`
    command wiring).

- **A4 — Agent registry.** `.appliance/agents.json` (§7).

  - new `packages/cli/src/utils/agents-registry.ts` (read/write/reconcile,
    sibling to `utils/link.ts`); liveness via `shell.rs:121` session list.

- **A5 — Desktop surface.** Agent-typed tab.

  - `packages/app/src/providers/terminal-sessions-provider.tsx` (agent meta;
    `agent-` prefix in `mintSessionId`/`modeFromSessionId`/rehydrate,
    `:179`–`:186`,`:493`);
  - `packages/app/src/components/layout/terminal-tab-bar.tsx` (agent badge +
    status dot);
  - `packages/app/src/pages/local-runtime/index.tsx` ("Run agent" entry near
    `:629`);
  - `packages/desktop/src-tauri/src/lib.rs` (`microvm_host_shell_argv`
    `:3421` already forwards `--session`; add agent launch argv / a
    `microvm_agent_*` command for registry + autonomous runs);
  - `packages/app/src/lib/host.ts` + `packages/desktop/src/host.ts` (host
    bridge methods for run/list/attach/stop, mirroring `terminal.*`/`creds.*`).

- **A6 — Autonomous mode.** Headless run + result capture (§6).
  - autonomous `launchArgv` + `parseResult` in the claude-code adapter
    (`utils/agent.ts`);
  - result/exit-code capture reuses the one-shot sentinel
    (`shell.rs:63`,`:209`) and `--output-format json`;
  - registry status transitions in `utils/agents-registry.ts`.

## 11. Open forks / confirmations

**Confirmed via the claude-code-guide check (no longer open):** package
`@anthropic-ai/claude-code` + binary `claude`; headless `-p`/`--print` with
`--output-format json`/`stream-json` and `--json-schema`; permission bypass
`--dangerously-skip-permissions`; `ANTHROPIC_API_KEY` is sent as the
**`X-Api-Key`** header; **Claude Code will not start without auth in its
precedence chain** (so the §3 placeholder is mandatory); CA via
**`CLAUDE_CODE_CERT_STORE`** default `bundled,system`.

**Still genuinely open — gate A2/A6, verify empirically:**

- **Does Claude Code honor `HTTPS_PROXY`?** _Undocumented_ — the docs route
  via `ANTHROPIC_BASE_URL`. The §3/§4 broker reuse assumes it tunnels
  `api.anthropic.com` through the proxy. **A2's first task** is to test
  this; the `ANTHROPIC_BASE_URL`→host-listener fallback (§4a) applies if
  not. **Highest-leverage unknown in the whole design.**
- **Placeholder accepted without local pre-validation?** Confirm `claude`
  starts + emits the header with a syntactically-shaped dummy
  `ANTHROPIC_API_KEY` (vs hitting a local format/validity check). If it
  pre-validates, switch the broker to the `ANTHROPIC_AUTH_TOKEN`
  (gateway-bearer) shape — which flips the §3 header to `authorization`.
- **Auth-header-only (no local key)?** Whether `claude` would run with
  _all_ local auth unset and only the proxy injecting auth is undocumented
  → we don't rely on it; the placeholder sidesteps it.
- **Security questions (§9):** host key store; egress-firewall gating; CA-trust
  scope.
- **Registry placement:** commit `.appliance/agents.json` or gitignore it.
- **`uid` on `--mount` VMs** already resolved in E2 (`docs/rootless-guest.md`
  §6) — agents writing the shared workspace inherit that behavior; no new
  decision.
