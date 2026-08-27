# Live-test runbook — agent stack validation before the egress default-flip

**Audience:** the owner, on a real macOS machine with the `VzBackend`.
**Goal:** copy-paste-run the live validations the three merged epics owe before
the egress firewall default is flipped from default-**allow** to
default-**deny** (the "Fflip" / F4 default-flip, `docs/egress-firewall.md` §7).

This is a **checklist**, not a tutorial. Each section is: the exact command(s),
the **PASS** result, and how to capture/verify it. Where a command's exact form
could not be confirmed from the code it is flagged **`<verify flag>`** with the
closest real command and the intent — confirm it live rather than trusting it
blind.

**Sources this runbook is built from (read if a step is unclear):**
`docs/agent-sandbox.md` (Phase-5 broker), `docs/agent-login.md` §7
(interactive OAuth), `docs/egress-firewall.md` §9.3 (the live-test matrix).

**Conventions used below:**

- `SBX=appliance` — the ONE managed VM. The separate agent sandbox VM
  (`appliance-sbx`) is retired: agents, `appliance dev`, and `appliance up`
  all ride the single default `appliance` VM (booted dev-capable with the
  workspace mounted). `appliance vm` commands already default to it, but the
  runbook keeps the explicit `--name "$SBX"` so every command is
  copy-paste-unambiguous.
- The egress subcommands live under **`appliance vm egress …`** (there is no
  top-level `appliance egress`; `packages/cli/src/appliance-vm.ts:559`). The
  egress-firewall doc's shorthand `egress allow`/`egress denied` = `appliance
vm egress allow`/`appliance vm egress denied`.
- The egress proxy gateway is the netstack subnet `.1`, i.e.
  `192.168.127.1:<egressPort>` (`docs/egress-firewall.md` §3); the default
  sandbox VM's egress port is allocated per-VM — read it with `appliance vm
egress gateway --name "$SBX"`.

```sh
# Run once at the top of every shell you use for this runbook:
export SBX=appliance
cd ~/Workspaces/appliance.sh      # repo root
```

---

## §0 Prereqs

### 0.1 Build + sign the `appliance-vm` engine binary

Creating VMs via Virtualization.framework is entitlement-gated and `cargo`
does not sign, so the locally built engine must be ad-hoc signed with the
`vz.entitlements` (`packages/vm/README.md:21`,
`packages/vm/scripts/sign-dev.sh`).

```sh
cd ~/Workspaces/appliance.sh/packages/vm
cargo build && ./scripts/sign-dev.sh
#   release build instead:  cargo build --release && ./scripts/sign-dev.sh --release
cd ~/Workspaces/appliance.sh
```

**PASS:** `sign-dev.sh` prints `signed target/debug/appliance-vm with
com.apple.security.virtualization`. Verify the signature + entitlement:

```sh
codesign -d --entitlements - packages/vm/target/debug/appliance-vm 2>&1 \
  | grep -i virtualization
```

> Note: `appliance start`/`doctor --fix` will _offer_ to run `sign-dev.sh` when
> it detects a repo-built unsigned binary (`docs/onboarding.md` §4) — but for a
> live test, sign it explicitly up front so nothing prompts mid-run.

### 0.2 Make the CLI resolve to this repo's build

Confirm `appliance` resolves to the workspace CLI (not a globally-installed
published one) and that it shells the engine binary you just signed.

```sh
appliance --help        # should list `agent`, `vm`, `up`
appliance vm list       # JSON; engine reachable (signed binary OK)
```

**PASS:** `appliance vm list` returns JSON (an empty `[]` is fine) and does
**not** error on an unsigned/missing engine.

### 0.3 Credentials for both auth paths

You need BOTH to exercise §1 (api-key broker) and §2 (OAuth):

- **A real Anthropic API key** (`sk-ant-api03-…`) for §1.
- **A Pro/Max/Team/Enterprise Claude account** + **`claude` installed on the
  host** for §2's `claude setup-token` OAuth path
  (`docs/agent-login.md` §7 item 5; `hostHasClaude()`):

```sh
claude --version        # host claude present → OAuth path is usable
# if absent:  npm install -g @anthropic-ai/claude-code
```

**PASS:** you have the key in hand and `claude --version` prints a version.

### 0.4 Boot the managed VM on the `net_link=Netstack` link (the enforced boundary)

The egress firewall only enforces on a `net_link=Netstack` VM. There is **no
CLI flag** for `net_link` — the persisted per-VM default is `Nat`, and the
**only** supported test override is the global env `APPLIANCE_NETSTACK=1`,
which forces the netstack link on at engine runtime
(`packages/vm/src/spec.rs:180-183`; `docs/egress-firewall.md` §7). The override
only ever forces netstack **on**.

**`<verify flag>`** — the override is read when the engine resolves the link,
so a VM must be **created fresh under the override** (a VM already running on
NAT is not rewired by setting the env on a later command). Delete any stale
VM first, then export the override for **every** `appliance` command in
this runbook:

```sh
appliance vm delete --name "$SBX" 2>/dev/null || true   # drop any stale NAT VM
export APPLIANCE_NETSTACK=1                              # force the netstack link
# Boot the managed VM fresh (dev-capable, workspace mounted). Run from the repo:
appliance vm up --name "$SBX" --mount "$PWD"
#   (or `appliance dev`, which brings the same VM up and deploys the cwd app;
#    `appliance up` also boots this same VM for in-guest docker runs)
```

> `appliance agent start` (§1.2) will itself boot/ensure the VM on first use —
> but you still must have `APPLIANCE_NETSTACK=1` exported **before** that
> first boot. There is **no Docker prerequisite anywhere** in this runbook:
> deploy builds run server-side inside the VM.

**PASS — the link is actually Netstack (behavior-neutral boot, §9.3 must-WORK):**

```sh
appliance vm egress list --name "$SBX"
```

A `net_link=Netstack` VM shows **default-deny + the baked allowlist**
(`api.anthropic.com`, `dl-cdn.alpinelinux.org`, `registry.npmjs.org`,
`pypi.org`, `crates.io`, `github.com`, the docker registries — `egress
firewall` §5). A NAT VM would show the permissive default instead. Also confirm
the boot itself is behavior-neutral — DHCP/DNS/k3s/published ports == NAT:

```sh
appliance vm status --name "$SBX"                 # running
appliance vm kubeconfig --name "$SBX" > /tmp/sbx.kubeconfig
kubectl --kubeconfig /tmp/sbx.kubeconfig get nodes   # Ready
appliance vm shell --name "$SBX" -- sh -c 'getent hosts github.com'   # DNS resolves
```

**PASS:** node `Ready`, DNS resolves, kubeconfig handoff works — identical to
NAT (this is the §9.3 baseline; the matrix in §3 below stresses it).

### 0.5 No-docker deploy smoke (server-side builds end-to-end)

Prove the docker-free pipeline: with **no docker on PATH at all**, deploy the
three-tier demo stack and curl its frontend. The CLI uploads source zips; the
in-VM api-server builds every image with the guest BuildKit and pushes to the
in-VM registry.

```sh
# A shell where docker genuinely cannot be found:
alias docker=false; hash -r
command -v docker || echo "no docker on PATH — good"

cd examples/demo-stack-3tier
appliance deploy                    # bare deploy in a stack folder fans out to all members
curl -sS http://demo-frontend-dev.appliance.localhost:8081/ | head -5
```

**PASS:** all three members (backend → bff → frontend) deploy — the summary
table shows each built server-side — and the frontend curl returns its page.
No step invoked docker, buildctl, or crane on the host.

---

## §1 Phase-5 broker wire-confirms (api-key path)

Source: `docs/agent-sandbox.md` §3 (the broker spine) + §9 (what holds). The
contract: the **Anthropic key never enters the VM** — it is injected host-side
at the egress proxy and the guest only ever holds an inert placeholder
(`sk-ant-appliance-proxy`, `utils/agent.ts:124`).

### 1.1 Store the key host-side (Keychain), confirm it never lands in a VM file

```sh
# Hidden prompt (preferred) — or pipe it; neither puts the key on argv:
appliance agent login                 # choose "API key", paste the key
#   non-interactive:  printf '%s' "$ANTHROPIC_KEY" | appliance agent login
```

**PASS:** prints `✓ Anthropic key stored host-side …`. Confirm the host store
resolves the wire value, and that nothing real reached any per-VM file:

```sh
appliance agent print-key | head -c 12 ; echo …     # HOST helper: prints sk-ant-api03-… (the real wire value)
# Real key is NOT in the per-VM secret store (capture:false):
cat ~/.appliance/vm/$SBX/egress-secrets.json 2>/dev/null || echo "(no secrets file — expected)"
```

### 1.2 Launch the agent (broker auto-wired) and confirm it auths through the proxy

`appliance agent start` writes the `api.anthropic.com` cred rule
(`inject`, `capture:false`, `header=x-api-key`, the absolute `print-key`
helper), turns MITM on (`configureBroker`, `utils/agent.ts:655`), and launches
`claude` in the `agent-<id>` tmux session with the placeholder env.

```sh
# Autonomous one-shot is the cleanest end-to-end auth proof (real completion ⇒ real key injected):
appliance agent start --vm "$SBX" --autonomous --wait \
  --task "Reply with exactly: BROKER_OK"
```

**PASS (WC4 — the proxy CONNECT+MITM path engaged, the load-bearing
`HTTPS_PROXY` assumption of `docs/agent-sandbox.md` §4a):** the run finishes
`done` and the result text contains `BROKER_OK`. A real model completion is
only possible if `claude` tunnelled `api.anthropic.com` through the egress
proxy **and** the proxy injected the real key. Capture the proxy's view:

```sh
appliance vm egress log --name "$SBX" --tail 50   # JSON; an api.anthropic.com entry appears (request line only — never headers)
```

> Surgical variant of WC4 (no agent, just the wire): drive the broker with a
> placeholder header from inside the guest and confirm the proxy upgrades it to
> a real-auth `200`:
>
> ```sh
> PROXY=$(appliance vm egress gateway --name "$SBX" | sed -n 's/^HTTPS_PROXY=//p')
> appliance vm shell --name "$SBX" -- sh -c "
>   HTTPS_PROXY='$PROXY' curl -sS -o /dev/null -w '%{http_code}\n' \
>     https://api.anthropic.com/v1/models \
>     -H 'x-api-key: sk-ant-appliance-proxy' -H 'anthropic-version: 2023-06-01'"
> ```
>
> **PASS:** `200` — the proxy replaced the placeholder `x-api-key` with the
> real key on the outbound copy. (Without injection the placeholder alone is a
> `401`.)

### 1.3 WC2 — the real key is never returned to / present in the guest

```sh
# (a) The guest env carries only the inert placeholder:
SID=$(appliance agent list --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["sessionId"])')
appliance vm shell --name "$SBX" --session "$SID" -- sh -c 'printf "%s\n" "$ANTHROPIC_API_KEY"'
#   → sk-ant-appliance-proxy   (the placeholder, NOT a real key)

# (b) The real key's tail never appears anywhere in the guest workspace/tmp:
TAIL=$(appliance agent print-key | tail -c 9)        # last 8 chars of the REAL key, host-side
appliance vm shell --name "$SBX" -- sh -c "grep -rIl '$TAIL' /persist /tmp /home 2>/dev/null || echo NONE"
#   → NONE
```

**PASS:** (a) shows the placeholder; (b) prints `NONE`. The key crosses the
host↔guest boundary zero times (`docs/agent-sandbox.md` §3 "Net key flow").

### 1.4 WC3 + WC1 — fail-closed `502` on logout; placeholder never forwarded upstream

`appliance agent logout` clears the host key → `print-key` exits non-zero →
`mitm::intercept` refuses **before dialing upstream** and returns a `502`,
forwarding the placeholder **zero times** (`docs/agent-sandbox.md` §3 step 5).

```sh
# Watch the host's upstream leg in a second terminal to prove ZERO dial on the fail-closed path:
#   sudo tcpdump -i any -n host api.anthropic.com
appliance agent logout
PROXY=$(appliance vm egress gateway --name "$SBX" | sed -n 's/^HTTPS_PROXY=//p')
appliance vm shell --name "$SBX" -- sh -c "
  HTTPS_PROXY='$PROXY' curl -sS -o /dev/null -w '%{http_code}\n' \
    https://api.anthropic.com/v1/models \
    -H 'x-api-key: sk-ant-appliance-proxy' -H 'anthropic-version: 2023-06-01'"
```

**PASS (WC3):** the curl returns **`502`** (the proxy's
`502 — Anthropic key not configured (run \`appliance agent login\`)`).
**PASS (WC1):** the `tcpdump`shows **no** SYN/TLS to`api.anthropic.com`during that attempt — the placeholder never left the host. Re-login afterward:`appliance agent login`.

### 1.5 WC5 — cross-VM key isolation (peer-pin / per-VM netstack)

A sibling VM must not be able to drive **this** VM's proxy to spend its
brokered key. The netstack design closes this structurally — each VM has its
own netstack + link, no host route between VM subnets
(`docs/egress-firewall.md` §8.2); the pre-netstack guard is `peer_allowed`
pinned to the exact guest IP (`egress.rs`).

**`<verify flag>`** — intent: from a _second_ VM, try to reach VM-1's
egress proxy gateway and confirm it is refused. Closest real commands (confirm
the exact reach path live — under Netstack the sibling has no route at all):

```sh
SBX2=appliance-two
appliance vm up --name "$SBX2"                       # second netstack VM
GW1=$(appliance vm egress gateway --name "$SBX" | sed -n 's/^HTTPS_PROXY=//p')
appliance vm shell --name "$SBX2" -- sh -c "
  HTTPS_PROXY='$GW1' curl -sS -m 5 -o /dev/null -w '%{http_code}\n' \
    https://api.anthropic.com/v1/models \
    -H 'x-api-key: sk-ant-appliance-proxy' -H 'anthropic-version: 2023-06-01' \
    || echo REFUSED"
appliance vm delete --name "$SBX2"
```

**PASS (WC5):** the sibling's attempt is **refused / unroutable** (connection
refused, timeout, or `REFUSED`) — it cannot ride VM-1's broker. VM-1's key is
never disclosed.

---

## §2 Interactive OAuth login (`Sign in with Claude`)

Source: `docs/agent-login.md` §7. Brokers a one-year subscription OAuth token
(`sk-ant-oat01-…`) as `Authorization: Bearer …` instead of the api key — same
broker, same guarantees, **values-only** change. The token, like the key,
never enters the VM (in-guest placeholder `sk-ant-oat01-appliance-proxy`,
`utils/agent.ts:131`).

### 2.0 Capture the host credential footprint BEFORE login (for the no-second-copy diff)

`claude setup-token` is display-only and must leave **no at-rest copy of its
own** — only our host store should hold the token afterward
(`docs/agent-login.md` §7 item 2). Snapshot first:

```sh
# Keychain items + ~/.claude, before:
security find-generic-password -s 'Claude Code-credentials' 2>&1 | tee /tmp/cc-cred.before
security find-generic-password -s 'sh.appliance.agent'      2>&1 | tee /tmp/appliance-cred.before
ls -la ~/.claude 2>/dev/null | tee /tmp/dotclaude.before
```

### 2.1 Run the OAuth login

```sh
appliance agent login --oauth
#   (or `appliance agent login` → pick "Sign in with Claude")
```

This runs `claude setup-token` on the **host** with the TTY inherited: a
browser opens, you sign in + paste the authorization code, and `setup-token`
prints the one-year token inline. The CLI then shows a **hidden paste prompt**
("Paste the token shown above (sk-ant-oat01-…)") — paste it; it goes straight
to the Keychain, never echoed/logged/temp-filed.

**PASS:** prints `✓ Signed in with Claude. The subscription token is stored
host-side and never enters the VM.` Confirm the kind-aware wire value:

```sh
appliance agent print-key | head -c 14 ; echo …     # → "Bearer sk-ant-…" (scheme prefix proves oauth kind)
```

### 2.2 Confirm `setup-token` left NO second host-side copy (before/after diff)

```sh
security find-generic-password -s 'Claude Code-credentials' 2>&1 | tee /tmp/cc-cred.after
security find-generic-password -s 'sh.appliance.agent'      2>&1 | tee /tmp/appliance-cred.after
ls -la ~/.claude 2>/dev/null | tee /tmp/dotclaude.after
diff /tmp/cc-cred.before  /tmp/cc-cred.after   ; echo "cc-cred diff rc=$?"
diff /tmp/dotclaude.before /tmp/dotclaude.after ; echo "dotclaude diff rc=$?"
```

**PASS:** the `Claude Code-credentials` Keychain item and `~/.claude` are
**unchanged** by `setup-token` (empty diffs) — only `sh.appliance.agent` now
holds the token. (If you have _also_ run plain `claude /login` on this host at
some point, a pre-existing `Claude Code-credentials` item may be present from
_that_ flow; the diff must still show `setup-token` did not add/modify it —
`docs/agent-login.md` §7 item 2.)

### 2.3 Bearer auth works end-to-end + placeholder-only-in-guest + precedence

```sh
# End-to-end OAuth completion through the broker:
appliance agent start --vm "$SBX" --autonomous --wait \
  --task "Reply with exactly: OAUTH_OK"
```

**PASS (Bearer E2E):** finishes `done` with `OAUTH_OK` in the result — the
proxy injected `Authorization: Bearer <real oat token>`.

```sh
# Placeholder-only in guest + the single-auth-env precedence guarantee
# (docs/agent-login.md §1, §7 item 4): exactly CLAUDE_CODE_OAUTH_TOKEN is set,
# and ANTHROPIC_API_KEY is NOT (which would outrank it and emit x-api-key):
SID=$(appliance agent list --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["sessionId"])')
appliance vm shell --name "$SBX" --session "$SID" -- sh -c \
  'echo "OAUTH=[$CLAUDE_CODE_OAUTH_TOKEN]"; echo "APIKEY=[$ANTHROPIC_API_KEY]"'
#   → OAUTH=[sk-ant-oat01-appliance-proxy]   (the inert placeholder)
#   → APIKEY=[]                              (UNSET — precedence holds)
```

**PASS:** `CLAUDE_CODE_OAUTH_TOKEN` = the inert placeholder, `ANTHROPIC_API_KEY`
empty. Optionally re-run §1.3(b) with the oauth token's tail to confirm the
real token never appears in the guest.

---

## §3 Egress firewall (`net_link=Netstack`, default-deny) — §9.3 matrix

Source: `docs/egress-firewall.md` §9.3. Run on the **Netstack** `$SBX` from §0.4
(default-deny + the §5 baked allowlist active — confirmed via `appliance vm
egress list --name "$SBX"`). All in-guest commands run via `appliance vm shell
--name "$SBX" -- …`.

### 3.A Must still WORK under default-deny + the baked allowlist

| #                  | Command                                                                                                                                                     | PASS                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1 broker           | (§1.2 / §2.3 already proved it) `appliance agent start --vm "$SBX" --autonomous --wait --task "Reply OK"`                                                   | `done`, real completion round-trips the accept-path interceptor                                       |
| 2 apk              | `appliance vm shell --name "$SBX" --root -- sh -c 'apk update && apk add --no-cache jq'`                                                                    | installs (`dl-cdn.alpinelinux.org` allowed)                                                           |
| 3 npm              | `appliance vm shell --name "$SBX" -- sh -c 'npm install -g --silent left-pad >/dev/null && echo NPM_OK'`                                                    | `NPM_OK` (`registry.npmjs.org`)                                                                       |
| 4 pip              | `appliance vm shell --name "$SBX" -- sh -c 'python3 -m pip install --quiet requests && echo PIP_OK'`                                                        | `PIP_OK` (`pypi.org` + `files.pythonhosted.org`)                                                      |
| 5 cargo            | `appliance vm shell --name "$SBX" -- sh -c 'cd /tmp && cargo new c -q && cd c && cargo add anyhow -q && cargo fetch -q && echo CARGO_OK'`                   | `CARGO_OK` (`crates.io` + `static.crates.io`)                                                         |
| 6 git              | `appliance vm shell --name "$SBX" -- sh -c 'git clone --depth 1 https://github.com/octocat/Hello-World /tmp/hw && echo GIT_OK'`                             | `GIT_OK` (github + codeload + raw CDNs)                                                               |
| 7 docker pulls     | `appliance vm shell --name "$SBX" -- sh -c 'docker pull --quiet alpine:3.19 && docker pull --quiet ghcr.io/cli/cli:latest && echo DOCKER_OK'`               | `DOCKER_OK` (docker.io + ghcr.io through the boundary)                                                |
| 8 k3s multi-pod    | `kubectl --kubeconfig /tmp/sbx.kubeconfig apply -f - <<'EOF'` (two pods + a Service; then `kubectl … exec` pod-A `wget -qO- http://svc-b`)                  | pod→pod (`10.42/16`) and pod→svc (`10.43/16`) work — intra-guest traffic never crosses `host_fd` (§5) |
| 9 cluster names    | `kubectl --kubeconfig /tmp/sbx.kubeconfig run t --image=alpine --restart=Never -it --rm -- sh -c 'getent hosts kubernetes.default.svc.cluster.local'`       | resolves — excluded names not policed                                                                 |
| 10 published ports | host-side round-trips: `curl -sS http://localhost:<ingress>`; `kubectl --kubeconfig /tmp/sbx.kubeconfig get nodes` (api `:6443`); the dev `published` ports | each returns — the re-homed `netstack.connect` inbound leg works under filtering (§6)                 |
| 11 BYO-k8s + cloud | run any existing BYO-k8s / cloud deploy flow you have                                                                                                       | **untouched** — never starts the vz link, never gets default-deny (§7)                                |

For #8, a minimal two-pod manifest:

```sh
kubectl --kubeconfig /tmp/sbx.kubeconfig apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: svc-b-pod, labels: { app: svc-b } }
spec: { containers: [{ name: web, image: nginx:alpine, ports: [{ containerPort: 80 }] }] }
---
apiVersion: v1
kind: Service
metadata: { name: svc-b }
spec: { selector: { app: svc-b }, ports: [{ port: 80, targetPort: 80 }] }
EOF
sleep 8
kubectl --kubeconfig /tmp/sbx.kubeconfig run pod-a --image=alpine --restart=Never -it --rm -- \
  sh -c 'wget -qO- http://svc-b | head -1 && echo K3S_OK'
```

**Watch the caps during 1–10:** the live pass should complete a heavy
`npm`/`docker`/multi-pod run **without** the SYN-flood refusal log firing or
flows stalling (concurrent-flow cap 1024, per-flow backpressure 256 KiB are
sized well above dev workloads — `docs/egress-firewall.md` §9.3 caps note).

### 3.B Must be DENIED (adversarial)

Each attempt must be blocked AND appear in the deny feed.

```sh
# --- A: rooted guest dials a RAW PUBLIC IP (no allowlisted name) to exfiltrate ---
appliance vm shell --name "$SBX" --root -- sh -c \
  'curl -sS -m 6 -o /dev/null -w "%{http_code}\n" https://1.1.1.1/ || echo BLOCKED'
#   PASS: BLOCKED (timeout/refused) — dropped at default-deny (§4 raw-IP path); no upstream originated

# --- B: brokered host whose DNS REBINDS to a private/host-LAN addr ---
appliance vm shell --name "$SBX" -- sh -c \
  'curl -sS -m 6 --resolve api.anthropic.com:443:192.168.1.1 \
     -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/models || echo REFUSED'
#   PASS: REFUSED — the resolver/public-range check rejects the private target (§8.1 #1);
#         the brokered credential is never disclosed to a private rebind

# --- C: a process that DROPS the proxy env and egresses directly ---
appliance vm shell --name "$SBX" --root -- sh -c \
  'env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
     curl -sS -m 6 -o /dev/null -w "%{http_code}\n" https://example.org/ || echo CONFINED'
#   PASS: CONFINED — every frame still hits the netstack default-deny; the
#         cooperative proxy env was never the boundary (§8)
```

Confirm each denial landed in the deny log (the `appliance vm egress denied`
blocked→allow loop):

```sh
appliance vm egress denied --name "$SBX"
```

**PASS:** the raw-IP, the private-rebind, and the proxy-dropped attempts are
listed as blocked, each with the `appliance vm egress allow <host>` command to
permit it. **`<verify flag>`** — confirm the exact deny-row format / that the
proxy-dropped raw-IP attempt (C: a literal IP, not a name) surfaces in
`egress denied`'s aggregation live; the deny records are written by
`netstack::guard::log_deny` and surfaced via `egress log`/`egress denied`.

---

## §4 Result capture

### 4.1 PASS/FAIL checklist — fill this in

| §   | Check                   | PASS criterion                                                               | Result |
| --- | ----------------------- | ---------------------------------------------------------------------------- | ------ |
| 0.1 | engine built + signed   | `signed … com.apple.security.virtualization`                                 | ☐      |
| 0.4 | Netstack link active    | `egress list` shows default-deny + baked allowlist                           | ☐      |
| 0.4 | behavior-neutral boot   | node Ready + DNS + kubeconfig == NAT                                         | ☐      |
| 1.1 | key stored host-side    | `✓ stored`, not in `egress-secrets.json`                                     | ☐      |
| 1.2 | WC4 proxy+MITM path     | autonomous run `done` w/ `BROKER_OK`; api.anthropic.com in `egress log`      | ☐      |
| 1.3 | WC2 key never in guest  | placeholder in env; key tail = `NONE` in guest                               | ☐      |
| 1.4 | WC3 fail-closed 502     | logout → `502`; WC1 tcpdump shows no upstream dial                           | ☐      |
| 1.5 | WC5 cross-VM isolation  | sibling VM refused/unroutable                                                | ☐      |
| 2.1 | OAuth login             | `✓ Signed in`; `print-key` → `Bearer sk-ant-…`                               | ☐      |
| 2.2 | no second host copy     | `Claude Code-credentials` + `~/.claude` unchanged                            | ☐      |
| 2.3 | Bearer E2E + precedence | `OAUTH_OK`; `CLAUDE_CODE_OAUTH_TOKEN`=placeholder, `ANTHROPIC_API_KEY` unset | ☐      |
| 3.A | must-WORK matrix 1–11   | each row PASS; caps don't throttle                                           | ☐      |
| 3.B | must-DENY A/B/C         | BLOCKED/REFUSED/CONFINED + in `egress denied`                                | ☐      |

### 4.2 What to do if X fails

- **A must-WORK row (§3.A) is wrongly DENIED.** Read the host suffix in
  `appliance vm egress denied --name "$SBX"`, then permit it incrementally:
  `appliance vm egress allow <host> --name "$SBX"` (re-run the row). If a host
  that _should_ be baked-in is missing, the §5 default allowlist in
  `docs/egress-firewall.md` needs widening — that's an egress-firewall
  follow-up, not a per-run `allow`.
- **A must-DENY row (§3.B) is wrongly ALLOWED.** This is a **boundary breach** —
  do **NOT** flip the default. File against the F2 SSRF/private-range filter
  (§8.1 #1) for B, or the raw-IP default-deny path (§4) for A/C; the netstack
  classifier let something through.
- **WC1–WC5 (broker) fails.** A 502 that should be 200 (or vice-versa) is a
  broker regression — check `configureBroker` wrote the rule
  (`appliance vm creds list --name "$SBX"` shows `api.anthropic.com` inject +
  the `print-key` helper) and MITM is on (`appliance vm egress mitm on --name
"$SBX"`). A real key leaking into the guest (§1.3) is a **stop-ship**.
- **OAuth `setup-token` capture fails / no token.** Re-run `appliance agent
login --oauth` and paste the `sk-ant-oat01-…` token shown by `setup-token`
  (the hidden prompt accepts the bare token or the whole `export
CLAUDE_CODE_OAUTH_TOKEN=…` line). Missing host `claude` → install it
  (§0.3).
- **k3s row #8 fails** under default-deny. This is the §7 risk-2 silent break
  (intra-cluster traffic mistakenly crossing the boundary). Block the flip and
  investigate the netstack exclusions (§5 cluster CIDRs).

---

## After all green → the default-flip (Fflip) is safe

When every box in §4.1 is ✓ — the broker wire-confirms (§1), the OAuth path
(§2), and the **full** §9.3 matrix (§3.A must-WORK + §3.B must-DENY) all pass
on a real `net_link=Netstack` VM under default-deny — the owed-live validation
is satisfied and the **F4 default-flip** (`net_link` default `Nat → Netstack`,
`EgressPolicy::default()` already `Deny`) is safe to land. A red box in §3.B, or
any sign of the brokered credential reaching the guest, **blocks the flip**.

---

## Runtime pooled-VM proof (AP-163 / AP-164 / AP-167)

This proof uses the repository engine and CLI, creates a tiny OCI bundle, and
records each phase. The Runtime pool is separate from `$SBX`: its fixed name is
`appliance-runtime`, it is 2 vCPU / 4096 MiB, and it reaches core supervisor
readiness without k3s, Docker, BuildKit, Node, or the dev toolchain.

```sh
cd ~/Workspaces/appliance.sh
pnpm --filter @appliance.sh/cli run build

cd packages/vm
cargo build --release
./scripts/sign-dev.sh --release
cd ../..
export APPLIANCE_VM="$PWD/packages/vm/target/release/appliance-vm"

# The script commits only source; the OCI tar and zip stay generated/ignored.
examples/runtime/journal/build-bundle.sh

# Serialize the engine restart: `vm stop` requests shutdown asynchronously,
# so wait for `running: false` before booting the rebuilt binary.
packages/cli/dist/appliance vm stop --name appliance-runtime
packages/vm/target/release/appliance-vm status appliance-runtime
time packages/cli/dist/appliance vm up --name appliance-runtime

# Terminal A: validates, unpacks, reconciles the already-booted pool, starts
# journal, and follows logs.
time packages/cli/dist/appliance runtime run \
  examples/runtime/journal/journal.appliance.zip

# Terminal B, while Terminal A follows logs:
curl -fsS -D /tmp/journal.headers -o /tmp/journal.body \
  -w 'status=%{http_code} total=%{time_total}s\n' http://127.0.0.1:20000/
grep -q '200 OK' /tmp/journal.headers
grep -q 'journal runtime proof' /tmp/journal.body
time packages/cli/dist/appliance runtime ps
time packages/cli/dist/appliance runtime logs journal
time packages/cli/dist/appliance runtime stop journal
packages/cli/dist/appliance runtime ps
packages/vm/target/debug/appliance-vm status appliance-runtime
packages/vm/target/debug/appliance-vm timings appliance-runtime
```

**PASS:** curl returns HTTP 200; `runtime ps` shows `journal`, its
`192.168.127.x` principal and `127.0.0.1:20000 -> 3000`; logs contain the
request; stop removes the app row; the final VM status remains `running: true`.
Record validation/unpack, cold/warm pool boot, supervisor start, curl, ps, and
stop timings from `time` plus `appliance-vm timings`.

Ctrl-C in Terminal A is an equivalent stop proof: it stops `journal`, exits
130, and deliberately leaves the pooled VM running.

Observed on the final macOS VZ proof (2026-08-28): serialized cold pool boot
`10.33s`; warm Runtime reconciliation/start reached the published-port line in
`<=1.01s`; `runtime ps` `0.29s`; host curl `status=200 total=0.035827s`
(repeat `0.040435s`); explicit app teardown `12.7s`. The explicit-stop and
Ctrl-C cycles both left the same pool PID running and core-ready.

### Binary payload, entrypoint, and exit-code proof (AP-164)

The dashboard fixture commits no executable. Its build script uses
`docker run --rm ... golang:1.22-alpine go build` to generate static amd64 and
arm64 ELF files in a temporary directory, then packages that directory with
`appliance builder package`. This optional proof is CI-skippable when Docker is
unavailable.

Rebuild the engine and stop/up the Runtime pool before testing: the running VZ
engine and its guest boot media do not pick up `guest.rs` changes in place.

```sh
cd ~/Workspaces/appliance.sh
pnpm --filter @appliance.sh/cli run build

cd packages/vm
cargo build --release
./scripts/sign-dev.sh --release
cd ../..
export APPLIANCE_VM="$PWD/packages/vm/target/release/appliance-vm"

examples/runtime/dashboard/build-bundle.sh serve \
  examples/runtime/dashboard/dashboard.appliance.zip
examples/runtime/dashboard/build-bundle.sh exit7 \
  examples/runtime/dashboard/dashboard-exit7.appliance.zip

packages/cli/dist/appliance vm stop --name appliance-runtime
packages/vm/target/release/appliance-vm status appliance-runtime
time packages/cli/dist/appliance vm up --name appliance-runtime
```

In Terminal A, run the HTTP server and follow its shared Runtime log pipeline:

```sh
time packages/cli/dist/appliance runtime run \
  examples/runtime/dashboard/dashboard.appliance.zip
```

In Terminal B, discover the allocated host port, curl it, inspect state/logs,
and stop only the app:

```sh
PORT=$(packages/cli/dist/appliance runtime ps --json | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(x=>x.appId==="dashboard").hostPorts[0].host))')
curl -fsS -D /tmp/dashboard.headers -o /tmp/dashboard.body \
  -w 'status=%{http_code} total=%{time_total}s\n' "http://127.0.0.1:$PORT/"
grep -q '200 OK' /tmp/dashboard.headers
grep -q 'dashboard binary runtime proof' /tmp/dashboard.body
time packages/cli/dist/appliance runtime ps
time packages/cli/dist/appliance runtime logs dashboard
time packages/cli/dist/appliance runtime stop dashboard
```

Finally prove that the declared arguments reach the binary and status 7 flows
through the supervisor, CLI process, registry, and `runtime ps` rendering:

```sh
set +e
time packages/cli/dist/appliance runtime run \
  examples/runtime/dashboard/dashboard-exit7.appliance.zip
RUN_STATUS=$?
set -e
test "$RUN_STATUS" -eq 7
packages/cli/dist/appliance runtime ps | grep 'dashboard-exit7.*exited (7)'
packages/vm/target/release/appliance-vm status appliance-runtime
```

**PASS:** curl returns 200 with the dashboard proof body; `runtime ps` shows the
binary app's principal, relay, and then `exited (7)` for the exit fixture;
stdout/stderr appear through `runtime logs`; stopping an app leaves the pooled
VM running. Record Docker/package, cold/warm boot, supervisor start, curl, ps,
stop, and exit-propagation timings. The binary runner uses containerd's custom
rootfs mode so UID/GID, cgroup, seccomp, empty capability sets, network
namespace, relays, and policy stay identical to the container runner.

Observed on macOS VZ (2026-08-28): serialized rebuilt-media pool boot `10.36s`;
host curl `status=200 total=0.035151s`; `runtime ps` `0.49s`; app stop `1.07s`;
exit fixture cold reconcile/run `11.14s`, with CLI status `7`, `runtime ps`
rendering `exited (7)`, and the pool remaining core-ready.
