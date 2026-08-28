# Multi-agent adapters — N-agent generalization (Claude Code + Copilot + Codex)

**Status:** Design. This document defines the adapter contract and writes **no
feature code**. The decisions in **bold** are settled; implementation can refine
the _how_.

**Goal.** Generalize the Phase-5 agent adapter seam
([docs/agent-sandbox.md](agent-sandbox.md) §8b, [docs/agent-login.md](agent-login.md)
§1 — read both first) so that **claude-code**, **GitHub Copilot CLI**, and
**OpenAI Codex CLI** all plug in as adapter objects, and specify the Copilot +
Codex slots precisely. The host-side credential broker, the egress firewall, the
reattachable-session transport, and the autonomous result capture are **reused
wholesale** — the only per-agent inputs are the strings + one enum in the
adapter object. No new transport, no new broker, no new Rust on the inject path.

**Design decisions.**

1. **Copilot = PAT-broker.** The host brokers a fine-grained GitHub **PAT** onto
   Copilot's `api.github.com/copilot_internal/*` token-exchange leg. We **accept
   and document** the bounded tradeoff that a **short-lived Copilot session
   token transits the guest** (the durable PAT never does) — §7.
2. **Codex = API-key path only.** `OPENAI_API_KEY` → `Authorization: Bearer`,
   identical shape to Claude's api-key mode. **ChatGPT-login is DEFERRED** — it
   copies a non-expiring rotating `refresh_token` into the VM, which violates
   "the durable credential never enters the guest" (§7).

## 0. Headline — the seam is data, not code

The Phase-5 runner is already adapter-agnostic: it composes `install` →
proxy/CA/placeholder env → `launchArgv` in the `agent-<id>` session, applies the
adapter's one cred rule, and turns MITM on (`utils/agent.ts` `runAgent`,
`configureBroker`). Adding an agent is **a new adapter object**, plus three
small generalizations the current single-agent (Anthropic-only) shape hard-codes:

| Hard-coded today                                   | Generalized to                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| One host store (`sh.appliance.agent`/`anthropic`)  | **per-agent store key** (`provider`) — §4                                       |
| `print-key` emits `Bearer`-or-bare keyed on `kind` | `print-key --type <agent>` emits `<scheme> <secret>`, scheme from the mode — §2 |
| `parseResult` assumes JSON stdout                  | **`captureMode: 'json' \| 'text'`** branch — §3                                 |
| `scheme?: 'Bearer'`                                | `scheme?: 'Bearer' \| 'token'` (Copilot's `token <PAT>` leg) — §1/§2            |
| `installCmd: string` (unpinned)                    | structured, **version-pinned** `install` — §6                                   |

Everything load-bearing for security is unchanged: the broker still injects a
host-resolved header value onto **one host's** outbound TLS, still fails closed,
still `capture:false`, still scoped + peer-pinned per
[docs/agent-sandbox.md](agent-sandbox.md) §3/§4c. The Rust inject path
(`creds.rs`/`mitm.rs`/`egress.rs`) takes **zero change** — `set_header`
(`creds.rs:296`) already writes whatever `header: value` it's handed, and the
scheme prefix (`Bearer`, `token`) rides in the helper's stdout exactly as the
existing `Bearer from-helper` test does (`creds.rs:400`).

## 1. The generalized `AgentAdapter` / `AuthMode`

The current types (`packages/cli/src/utils/agent.ts`) extend as below. Added
fields: `provider`, structured `install`, `egressHosts`, `captureMode`; `scheme`
gains `'token'`; `kind` gains `'pat'`; a `login` discriminator drives the login
UX (§4).

```ts
/** The kind of credential the user stored host-side. The per-agent store tags
 *  every secret with its kind; the runner matches that tag to an AuthMode. */
export type AgentAuthKind = 'api-key' | 'oauth' | 'pat';

/** How `appliance agent login` OBTAINS the credential (login-UX dispatch, §4):
 *  paste a key, paste a fine-grained PAT, or run a host-side `setup-token`
 *  browser flow. Distinct from `kind` (what is stored) because two agents can
 *  store the same `kind` with different wire shapes (Claude vs Codex api-key). */
export type LoginKind = 'api-key' | 'pat' | 'setup-token';

/** How the autonomous runner captures + classifies a one-shot run (§3). */
export type CaptureMode = 'json' | 'text';

/** Pinned install descriptor (§6). The runner derives the install-on-first-use
 *  command from it: `command -v <bin> || npm install -g <pkg>@<version>`. */
export interface AgentInstall {
  pkg: string; // npm package
  version: string; // PINNED — both CLIs move fast + have shipped breaking changes (§6)
  bin: string; // the binary on PATH
  node: string; // min Node (provisioning note; guest toolchain ships Node ≥22)
}

/** One way an agent authenticates. The runner selects a mode by the stored
 *  credential's kind, then derives the broker cred-rule header + scheme, the
 *  in-guest placeholder env, and the host login command from it. */
export interface AuthMode {
  kind: AgentAuthKind;
  /** Wire header the CLI emits its credential on + the header the broker
   *  rewrites host-side. */
  header: 'x-api-key' | 'authorization';
  /** Auth-scheme prefix for the header value. `print-key` emits
   *  `"<scheme> <secret>"` when set, the bare secret when unset — so the
   *  proxy's set_header stays a literal value-replace (§2).
   *    • undefined → bare      (Claude api-key: `x-api-key: <key>`)
   *    • 'Bearer'   → OAuth/key (Claude OAuth, Codex api-key: `Authorization: Bearer <secret>`)
   *    • 'token'    → Copilot   (`Authorization: token <PAT>` on the api.github.com leg) */
  scheme?: 'Bearer' | 'token';
  /** The SINGLE in-guest env var that carries the (placeholder) credential so
   *  the CLI starts + emits `header`. Exactly ONE auth env is set per launch —
   *  the selected mode's — to keep each CLI's credential-precedence chain from
   *  picking a different header. */
  env: string;
  /** How the user supplies this credential at login (§4). */
  login: LoginKind;
  /** Host-side interactive login that yields this credential (`setup-token`
   *  only). Run on the HOST, never in the VM. */
  loginCmd?: string;
  /** Inert, syntactically-shaped placeholder put in `env` in-guest. The proxy
   *  overwrites it host-side; capturing it buys an attacker nothing. */
  placeholder: string;
}

/** An agent-type adapter. claude-code / copilot / codex are concrete objects;
 *  another CLI agent is a new object — no transport/broker/runner change. */
export interface AgentAdapter {
  type: string; // 'claude-code' | 'copilot' | 'codex'  (the registry/`--type` key)
  /** The per-agent host cred-store key (Keychain account / 0600 filename) — §4.
   *  Distinct stores so three agents' credentials never collide. */
  provider: string; // 'anthropic' | 'github-copilot' | 'openai'
  install: AgentInstall;
  /** The single host the broker injects the auth header on (the cred-rule host).
   *  NOTE Copilot: this is the token-EXCHANGE host (api.github.com), NOT the
   *  model host (api.githubcopilot.com) — §2/§7. */
  apiHost: string;
  /** Hosts this agent needs reachable; baked into NETSTACK_ALLOWLIST (§5). */
  egressHosts: string[];
  /** The auth modes this agent supports; the runner picks by stored cred kind. */
  authModes: AuthMode[];
  /** Autonomous result capture: 'json' → parse with `parseResult`; 'text' →
   *  capture stdout, classify by exit code only (§3). */
  captureMode: CaptureMode;
  launchArgv(opts: AgentLaunchOpts): string[];
  runtimeEnv?: Record<string, string>;
  /** Extract a result from autonomous stdout. Required for `captureMode:'json'`,
   *  absent for `'text'`. */
  parseResult?(stdout: string): { ok: boolean; summary?: string };
}
```

### claude-code (unchanged shape, restated against the generalized type)

```ts
export const claudeCodeAdapter: AgentAdapter = {
  type: 'claude-code',
  provider: 'anthropic',
  install: { pkg: '@anthropic-ai/claude-code', version: '<pin@build>', bin: 'claude', node: '>=18' },
  apiHost: 'api.anthropic.com',
  egressHosts: ['api.anthropic.com'],
  captureMode: 'json',
  authModes: [
    {
      kind: 'api-key',
      header: 'x-api-key',
      env: 'ANTHROPIC_API_KEY',
      login: 'api-key',
      placeholder: 'sk-ant-appliance-proxy',
    },
    {
      kind: 'oauth',
      header: 'authorization',
      scheme: 'Bearer',
      env: 'CLAUDE_CODE_OAUTH_TOKEN',
      login: 'setup-token',
      loginCmd: 'claude setup-token',
      placeholder: 'sk-ant-oat01-appliance-proxy',
    },
  ],
  launchArgv(opts) {
    if (opts.mode === 'autonomous')
      return ['claude', '-p', opts.task ?? '', '--output-format', 'json', '--dangerously-skip-permissions'];
    return opts.task ? ['claude', opts.task] : ['claude'];
  },
  runtimeEnv: { CLAUDE_CODE_CERT_STORE: 'bundled,system' },
  parseResult(stdout) {
    /* …unchanged: one result object on stdout */
  },
};
```

### copilot (PAT-broker) — **`@github/copilot` v1.0.65, bin `copilot`, Node ≥22**

```ts
export const copilotAdapter: AgentAdapter = {
  type: 'copilot',
  provider: 'github-copilot',
  install: { pkg: '@github/copilot', version: '1.0.65', bin: 'copilot', node: '>=22' },
  // BROKER host = the token-exchange leg, NOT the model host. The CLI sends
  // `Authorization: token <PAT>` to api.github.com/copilot_internal/v2/token to
  // mint a short-lived Copilot session bearer, then calls api.githubcopilot.com
  // with `Authorization: Bearer <session>`. We rewrite the `token <placeholder>`
  // header on the api.github.com leg → the real PAT (§7).
  apiHost: 'api.github.com',
  egressHosts: [
    'github.com', // already baked
    'api.github.com', // already covered by the github.com suffix
    'githubcopilot.com', // NEW — covers api.githubcopilot.com + *.githubcopilot.com (the model leg, blind tunnel)
    'copilot-proxy.githubusercontent.com', // already covered by the githubusercontent.com suffix
    'origin-tracker.githubusercontent.com', // already covered by the githubusercontent.com suffix
  ],
  captureMode: 'text', // NO JSON output mode — capture stdout, classify by exit code (§3)
  authModes: [
    {
      kind: 'pat',
      header: 'authorization',
      scheme: 'token',
      env: 'COPILOT_GITHUB_TOKEN', // > GH_TOKEN > GITHUB_TOKEN; classic PATs are silently ignored
      login: 'pat',
      placeholder: 'github_pat_appliance_proxy',
    },
  ],
  launchArgv(opts) {
    if (opts.mode === 'autonomous')
      // autonomous: one task to completion, all tools allowed, no interactive prompts.
      return ['copilot', '-p', opts.task ?? '', '-s', '--allow-all-tools', '--no-ask-user'];
    return ['copilot']; // interactive TTY (seeding via a positional prompt is unverified — §8)
  },
  runtimeEnv: {}, // honors HTTPS_PROXY + NODE_EXTRA_CA_CERTS, both already set by the launch env
};
```

### codex (API-key path) — **`@openai/codex` v0.142.x, bin `codex`, Node ≥22**

```ts
export const codexAdapter: AgentAdapter = {
  type: 'codex',
  provider: 'openai',
  install: { pkg: '@openai/codex', version: '0.142.0', bin: 'codex', node: '>=22' },
  apiHost: 'api.openai.com', // OPENAI_API_KEY → `Authorization: Bearer` → api.openai.com/v1 (honors OPENAI_BASE_URL)
  egressHosts: ['api.openai.com'], // NEW
  captureMode: 'json', // `codex exec --json` → JSONL events (turn.completed w/ usage, item.*) (§3)
  authModes: [
    // SAME kind as Claude api-key, DIFFERENT wire shape — this is exactly why
    // header/scheme live on the mode, not derived from `kind`.
    {
      kind: 'api-key',
      header: 'authorization',
      scheme: 'Bearer',
      env: 'OPENAI_API_KEY',
      login: 'api-key',
      placeholder: 'sk-appliance-proxy',
    },
  ],
  launchArgv(opts) {
    if (opts.mode === 'autonomous')
      // The microVM IS the sandbox → disable Codex's own sandbox + approvals.
      return [
        'codex',
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        opts.task ?? '',
      ];
    return ['codex']; // interactive TTY
  },
  runtimeEnv: {},
  parseResult(stdout) {
    /* JSONL: a `turn.completed` event ⇒ ok; summary = the last assistant `item` text (§3) */
  },
};

export function adapterForType(type: string): AgentAdapter | null {
  return [claudeCodeAdapter, copilotAdapter, codexAdapter].find((a) => a.type === type) ?? null;
}
```

## 2. Broker generalization

The broker stays one host-injection rule per agent, written by `configureBroker`
(`utils/agent.ts`) via `appliance-vm creds add <host> --header <h> --inject
--helper <print-key>` + `egress mitm on`. Three values come from the adapter +
selected mode instead of being Anthropic-hard-coded:

- **host** = `adapter.apiHost` — the cred rule matches by **host suffix**
  (`creds.rs` `has_cred_rule`), so the three agents write three independent
  rules that never collide. For Copilot this is the **token-exchange** host
  `api.github.com`, not the model host (§7).
- **header** = `mode.header` (`creds add --header` already accepts any header;
  `authorization` is the `creds.rs` default — `:25`).
- **scheme** = `mode.scheme`, emitted by the helper. `print-key` is invoked
  per-agent — `appliance agent print-key --type <agent>` — so it reads **that
  agent's** stored cred from **that provider's** store (§4), resolves
  `mode = resolveAuthMode(adapter, cred.kind)`, and writes the wire value:

  ```
  wireValue = mode.scheme ? `${mode.scheme} ${cred.value}` : cred.value
  ```

  This generalizes today's `wireValueForCred` (hard-coded `oauth → Bearer`,
  else bare), which would mis-handle Codex (api-key but `Bearer`). The helper
  command string the runner pins is `<abs-exe> agent print-key --type <agent>`.

The proxy's `set_header` is a literal value-replace, so `token <PAT>`,
`Bearer <key>`, and a bare `<key>` all ride the **same** inject path — **no
`creds.rs`/`mitm.rs`/`egress.rs` change**. Fail-closed, MITM-scope, exact-IP
peer-pin, and `capture:false` all hold unchanged (all header-/scheme-agnostic —
[docs/agent-login.md](agent-login.md) §3 walks each).

### Per-agent broker table

| agent       | stored kind | broker host (cred rule) | header          | scheme   | in-guest env              | `print-key` stdout      | model host (blind tunnel)              |
| ----------- | ----------- | ----------------------- | --------------- | -------- | ------------------------- | ----------------------- | -------------------------------------- |
| claude-code | api-key     | `api.anthropic.com`     | `x-api-key`     | _(bare)_ | `ANTHROPIC_API_KEY`       | `sk-ant-…` (bare)       | _(same host)_                          |
| claude-code | oauth       | `api.anthropic.com`     | `authorization` | `Bearer` | `CLAUDE_CODE_OAUTH_TOKEN` | `Bearer sk-ant-oat01-…` | _(same host)_                          |
| copilot     | pat         | `api.github.com`        | `authorization` | `token`  | `COPILOT_GITHUB_TOKEN`    | `token github_pat_…`    | `api.githubcopilot.com` (not brokered) |
| codex       | api-key     | `api.openai.com`        | `authorization` | `Bearer` | `OPENAI_API_KEY`          | `Bearer sk-…`           | _(same host)_                          |

The placeholders in the guest env are inert and shape-correct
(`sk-ant-appliance-proxy`, `sk-ant-oat01-appliance-proxy`,
`github_pat_appliance_proxy`, `sk-appliance-proxy`); the proxy overwrites each
with the real `print-key` value on the outbound copy before it leaves the host.

## 3. Result capture — branch on `captureMode`

The autonomous runner already captures stdout + the real exit code (the `--wait`
vsock one-shot sentinel, or the detached `> result.json; echo $? > .rc` on the
shared workspace — `composeAutonomousCaptureLine`). The single change is the
classifier `classifyAutonomousResult(exitCode, stdout, adapter)` branches on
`adapter.captureMode`:

- **`json` (claude-code, codex).** Parse stdout with `adapter.parseResult`.
  `done` iff `exitCode === 0` **and** `parsed.ok === true`; summary is the
  parsed result text.
  - **claude-code:** `--output-format json` prints one result object —
    `{ is_error, result }` (today's `parseResult`).
  - **codex:** `codex exec --json` emits **JSONL events**, one per line. A
    `turn.completed` event (carrying `usage`) marks a clean turn; the final
    assistant text comes from the last `item.*` message event. `parseResult`
    scans lines for a `turn.completed` (⇒ `ok`) and lifts the last assistant
    `item` as the summary; a fatal error item or no `turn.completed` ⇒ not ok.
    `--output-schema <file>` / `-o <file>` is the structured-output alternative
    if the event schema proves unstable (re-verify on build — §6, §8).
- **`text` (copilot).** Copilot has **no JSON output mode** → there is nothing
  to parse. Capture stdout verbatim; classify by **exit code only** (`done` iff
  `exitCode === 0`); the summary is a trailing slice of stdout (the agent's
  final textual answer). `parseResult` is absent for text-mode adapters.

```ts
function classifyAutonomousResult(exitCode, stdout, adapter): AutonomousResult {
  if (adapter.captureMode === 'text') {
    const ok = exitCode === 0;
    return { status: ok ? 'done' : 'error', exitCode, summary: tailLines(stdout, 20) };
  }
  const parsed = adapter.parseResult?.(stdout); // json
  const ok = exitCode === 0 && parsed?.ok === true;
  return { status: ok ? 'done' : 'error', exitCode, summary: parsed?.summary ?? `…(exit ${exitCode})` };
}
```

**`agent list` / the registry** are unchanged: every agent still records
`{ type, status, summary, exitCode }` in `.appliance/agents.json`, and the table
shows `summary` for a finished run (`appliance-agent.ts` `list`). The `type`
column already surfaces `claude-code` / `copilot` / `codex`; the registry is
adapter-agnostic, so text-mode and json-mode runs render identically. Liveness
still reconciles against the tmux session list.

## 4. Login UX — `appliance agent login --type <agent>`

`appliance agent login` gains a `--type <agent>` selector (default
`claude-code`). The `--type` resolves the adapter; the adapter's `authModes`
(via each mode's `login` discriminator) drive what the command asks for:

- **claude-code** (existing): a mode picker — **API key** (paste/pipe a key,
  `login:'api-key'`) **or** **Sign in with Claude** (`login:'setup-token'` →
  host `claude setup-token`, [docs/agent-login.md](agent-login.md) §2). Stored
  `kind:'api-key'` / `kind:'oauth'`.
- **copilot** (`login:'pat'`): paste/pipe a **fine-grained GitHub PAT** (a
  personal-account token with the **`Copilot Requests`** permission, ~1-year
  expiry). Stored `kind:'pat'`. Same hidden-prompt / stdin handling as the
  api-key path (never on argv). No host-side `loginCmd` — the user mints the PAT
  in GitHub settings and pastes it.

  **Security bound on host-keyed injection.** The
  fine-grained-only requirement is **not** a CLI-functionality nicety — it is
  the security bound. The broker injects this PAT on **every**
  `api.github.com` request from the guest (host-keyed, not path-keyed —
  `creds.rs` matches by host, §7), so the PAT's scope **is** the blast radius of
  a jailbroken guest abusing that rule. A fine-grained PAT scoped to **only**
  `Copilot Requests` cannot push code, read repos, or act beyond Copilot
  requests; a **classic `ghp_` PAT carries the user's full account scope** and
  would hand a compromised guest that scope on the brokered host. Therefore:

  - **The login layer accepts ONLY `github_pat_`-prefixed tokens and REJECTS
    classic `ghp_` PATs** with a clear error (it does not rely on the CLI's own
    "classic PATs are ignored" behaviour — it is a hard guard at the point the
    durable credential is stored host-side). The `github_pat_` prefix also
    matches the in-guest placeholder shape (`github_pat_appliance_proxy`).
  - **Login prominently instructs the user to grant ONLY the `Copilot
Requests` permission** before the prompt — that single scope is what makes
    host-keyed injection on the broad `api.github.com` host acceptable.

- **codex** (`login:'api-key'`): paste/pipe an **OpenAI API key**. Stored
  `kind:'api-key'`.

**Per-agent host store key.** The single Anthropic store generalizes to one item
**per provider**: Keychain service `sh.appliance.agent`, **account =
`adapter.provider`** (`anthropic` / `github-copilot` / `openai`); off-macOS a
`0600` file `~/.appliance/agent/<provider>-cred`. So `readAgentKey(provider)`,
`writeAgentKey(provider, value, kind)`, `forgetAgentKey(provider)`, and
`print-key --type <agent>` all key off the provider. Three agents' credentials
coexist without collision, and `agent login --type copilot` never clobbers the
Anthropic key. The JSON envelope (`{ "kind", "value" }`) + back-compat
(legacy bare string ⇒ `api-key`) is unchanged per provider.

`appliance agent start --type <agent>` already exists (`appliance-agent.ts`); the
keyless guard becomes `readAgentKey(adapter.provider)` and points the user at
`appliance agent login --type <agent>`.

## 5. Egress allowlist additions

`NETSTACK_ALLOWLIST` (`packages/vm/src/egress.rs:123`) is suffix-matched by
`host_matches`, so several Copilot hosts are **already covered** by the baked git
entries. The **net-new** baked hosts are just two:

```diff
  pub const NETSTACK_ALLOWLIST: &[&str] = &[
      // api / model
      "api.anthropic.com",
+     "api.openai.com",                  // codex (NEW)
+     "githubcopilot.com",               // copilot model leg — api.githubcopilot.com + *.githubcopilot.com (NEW)
      // alpine packages
      "dl-cdn.alpinelinux.org",
      …
      // git  (these ALSO cover Copilot's github hosts)
      "github.com",                      // covers api.github.com (the PAT-broker leg)
      "codeload.github.com",
      "githubusercontent.com",           // covers copilot-proxy. + origin-tracker.githubusercontent.com
      …
  ];
```

Coverage check against the recon's host lists:

| agent host                             | baked entry that matches | status           |
| -------------------------------------- | ------------------------ | ---------------- |
| `api.openai.com` (codex)               | `api.openai.com`         | **add**          |
| `api.githubcopilot.com` / `*.…`        | `githubcopilot.com`      | **add** (suffix) |
| `github.com`                           | `github.com`             | already baked    |
| `api.github.com` (PAT-broker leg)      | `github.com` (suffix)    | already covered  |
| `copilot-proxy.githubusercontent.com`  | `githubusercontent.com`  | already covered  |
| `origin-tracker.githubusercontent.com` | `githubusercontent.com`  | already covered  |

So when `net_link=Netstack` flips default-deny on (egress-firewall F2/F4), the
two added lines keep Copilot + Codex working out of the box; the cooperative
`HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` path (which both honor) is unchanged. **Note
(operator exfil lever, egress-firewall §8.1 #6):** Copilot's broker host
`api.github.com` is GitHub's general REST API and `github.com` is a write-capable
exfil channel (gists) — an operator hardening an untrusted-code Copilot sandbox
can drop `github.com`/`codeload.github.com`/`githubusercontent.com` and keep only
`api.github.com` + `githubcopilot.com` (the minimal Copilot set).

## 6. Version pinning + re-verify

Both `@github/copilot` and `@openai/codex` **move fast and have shipped breaking
CLI changes** (flag renames, output-format changes). The structured `install`
descriptor (§1) **pins the installed version** so a fresh provision is
reproducible and a CLI bump can't silently change argv/output under us:

```sh
command -v copilot >/dev/null 2>&1 || npm install -g @github/copilot@1.0.65 >/dev/null
command -v codex   >/dev/null 2>&1 || npm install -g @openai/codex@0.142.0  >/dev/null
```

(Both need **Node ≥22**; the guest dev toolchain already ships a current Node —
confirm `node --version` ≥22 in the guest image as a G3 gate.) claude-code's
install is pinned the same way at build time.

**Re-verify note (G3, owed-live).** Before G3 lands, re-confirm against the
pinned versions on a booted `net_link=Netstack` VM:

1. **copilot** — `copilot -p "<task>" -s --allow-all-tools --no-ask-user` runs
   headless to completion; `COPILOT_GITHUB_TOKEN` (placeholder) drives the
   `api.github.com/copilot_internal/v2/token` exchange through the proxy
   (CONNECT+MITM engages, header rewritten to the real PAT), the returned
   session bearer hits `api.githubcopilot.com`, exit code is meaningful, stdout
   capture is non-empty. Confirm `-s`/`--no-ask-user` flag spellings on 1.0.65.
2. **codex** — `codex exec --json --skip-git-repo-check
--dangerously-bypass-approvals-and-sandbox "<task>"` emits parseable JSONL
   with a terminal `turn.completed`; `OPENAI_API_KEY` (placeholder) tunnels
   `api.openai.com` through the proxy; the `--dangerously-bypass-…` flag is the
   correct spelling on 0.142.x (else fall back to `--output-schema`/`-o`).
3. **placeholders accepted** — each CLI starts + emits its header with the inert
   placeholder (no local format pre-validation), analogous to the verified
   Anthropic placeholder (`utils/agent.ts` A0 STEP 0).

Pin the exact patch versions confirmed by this pass, and bump deliberately.

## 7. Security

**Per-agent broker model (what's identical to Claude).** Each agent gets **one
host-injection cred rule on one host**, fed by a host-resolved `print-key`,
`capture:false`, fail-closed, MITM-scoped to that host, exact-IP peer-pinned —
the [docs/agent-sandbox.md](agent-sandbox.md) §3/§4c guarantees, header-/scheme-
agnostic, so they extend to `token`/`Bearer` unchanged. The **durable**
credential (Anthropic key/OAuth, GitHub PAT, OpenAI key) lives **host-side only**
(Keychain / `0600`), is written onto the request **only at the proxy on the
outbound copy**, and the guest holds at most an inert placeholder. The microVM
remains the only real isolation boundary; egress is cooperative unless
`net_link=Netstack` (then host-enforced); a jailbroken guest can spend brokered
billing but **cannot read the durable credential** — same posture as Claude.

**Copilot — the bounded session-token-in-guest tradeoff.**
Copilot is a **two-leg** flow:

1. The CLI sends `Authorization: token <COPILOT_GITHUB_TOKEN>` to
   `api.github.com/copilot_internal/v2/token`. The broker MITMs `api.github.com`
   and rewrites the placeholder `token` header → the **real PAT**. **The durable
   PAT never enters the VM** — full Claude-class guarantee on this leg.
2. `api.github.com` returns a **short-lived Copilot session bearer** in its
   response body; the CLI receives it **in-guest** and uses it as
   `Authorization: Bearer <session>` against `api.githubcopilot.com` (an
   allowed-but-blind tunnel, not brokered).

So **a short-lived session token transits the guest** (the durable PAT does
not). Bounded blast radius: a jailbroken guest could lift the in-guest session
bearer and spend Copilot requests until it expires — the **same class** of limit
as "a jailbroken guest can drive the proxy to spend billing," but here it can do
so **without the proxy** for the token's short life. Two properties bound it:
(a) the token is **short-lived** (minutes), and (b) the brokered PAT is
**fine-grained with only the `Copilot Requests` permission**, so even though the
cred rule injects the PAT on **every** `api.github.com` request from the guest
(it matches by host, not by the `/copilot_internal/*` path — `creds.rs` is
host-keyed), the injected PAT **cannot push code, read repos, or act beyond
Copilot requests**. State this plainly: the broker host `api.github.com` is
broader than `api.anthropic.com`, but the fine-grained PAT's narrow scope is what
makes host-keyed injection acceptable.

> **Direct-Bearer follow-up (deferred).** The way to eliminate even the bounded
> session-token-in-guest is to have the **host** perform the token exchange:
> mint the Copilot session bearer host-side from the PAT and broker
> `Authorization: Bearer <session>` directly onto the **model** leg
> (`api.githubcopilot.com`), so neither the PAT nor the session token ever
> enters the guest — a full Claude-class guarantee on both legs. That needs the
> broker to run the OAuth exchange itself (a new host component, not pure
> header-rewrite), so it is a follow-up, not G1–G3.

**Codex — ChatGPT-login deferred (and why).** The API-key path is
**identical** to Claude's api-key mode: a durable key host-side, brokered as
`Authorization: Bearer` onto `api.openai.com`, never in the VM. The **ChatGPT
subscription login is DEFERRED** because it writes a **non-expiring, rotating
`refresh_token`** (plus access token) into the guest's `~/.codex/auth.json` —
putting a **durable** credential **inside the VM**, which violates the locked
"durable credential never enters the guest" invariant and has no clean broker
(the refresh rotates in-guest). Revisit only with a host-side refresh broker.

**ToS per agent (run the official binary directly; don't resell/expose the
brokered token).** The inherited posture from
[docs/agent-login.md](agent-login.md) §0 applies to all three: we run **the
official vendor binary directly** inside a **single-purpose sandbox**, the broker
is a **header-injection point on the agent's own traffic — NOT an API gateway**,
and we must **never** build a listener that accepts arbitrary requests and
forwards them under the brokered credential (that would resell the
subscription/seat). Per agent:

- **claude-code (OAuth):** subscription token is Claude-Code-direct-use only;
  single-purpose Claude sandbox; not broker-enforced (provisioning posture).
- **copilot (PAT):** the user's own personal-account fine-grained PAT
  (`Copilot Requests`); brokered onto the official `copilot` binary's own
  traffic; don't expose/resell the brokered PAT or the session token.
- **codex (API key):** standard OpenAI API usage under the user's key; run the
  official `codex` binary directly; don't proxy arbitrary requests under it.

This generalization adds **no new network listener and no new trust boundary** —
it is three of the same host-injection rule on three hosts, with one extra scheme
(`token`) and a longer-lived at-rest secret blast radius for the PAT (same
host-compromise threat model as the Anthropic OAuth token, §0 of agent-login).

## 8. Open questions

1. **Copilot interactive seeding.** The autonomous argv is verified
   (`-p … -s --allow-all-tools --no-ask-user`); whether interactive `copilot`
   accepts a positional task to seed the first prompt is **unverified** — G3
   leaves interactive as a bare TTY unless the live pass confirms a seed flag.
2. **Codex JSONL stability.** Pin to event-stream parsing
   (`turn.completed` + `item.*`) or to `--output-schema`/`-o <file>`? The
   structured-schema path is more stable across 0.142.x bumps but constrains the
   result shape. Recommend: parse the event stream, fall back to `-o` if the
   schema churns. Confirm on the pinned version.
3. **Copilot broker-host breadth.** Accept host-keyed PAT injection on
   **all** `api.github.com` traffic (bounded by the fine-grained `Copilot
Requests` scope, §7), or add a path-aware inject (`/copilot_internal/*` only)
   to `creds.rs`? Recommend: accept it for G1–G3 (the scope bounds it; a single-
   purpose Copilot sandbox is the posture), track path-aware inject + the
   direct-Bearer follow-up as hardening work.
4. **Direct-Bearer follow-up priority.** Should the host-side
   token-exchange broker (no session token in guest) before shipping Copilot, or
   ship the bounded-tradeoff version first? The current design uses the bounded
   tradeoff.

---

### Build-contract summary

| Phase | Implementation surface                             | One-line contract                                                                                                                                                                                                                   |
| ----- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1    | adapter type + objects (`utils/agent.ts`)          | generalize `AgentAdapter`/`AuthMode` (`provider`, `install`, `egressHosts`, `captureMode`, `scheme:'token'`, `kind:'pat'`, `login`); add copilot + codex adapters; branch `classifyAutonomousResult` on `captureMode`.              |
| G2    | broker + login (`agent.ts` + `appliance-agent.ts`) | per-agent store key (`provider`); `print-key --type <agent>` emits `<scheme> <secret>` from the resolved mode; `configureBroker` writes `apiHost`/`header`/`--type` helper; `agent login --type <agent>` (key / PAT / setup-token). |
| G3    | egress + provision (`egress.rs` + guest)           | bake `api.openai.com` + `githubcopilot.com` into `NETSTACK_ALLOWLIST`; pin install versions; Node ≥22 guest check; live re-verify both CLIs' argv/output/placeholder/broker legs.                                                   |

**Verify:** docs-only; `scripts/verify.sh` green.

_Suggested commit subject:_ `docs(multi-agent): N-agent adapter generalization + Copilot/Codex design`
