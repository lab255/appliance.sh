import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

import {
  DEFAULT_SANDBOX_VM,
  GUEST_WORKSPACE,
  ensureSandboxVm,
  runVm,
  runVmCapture,
  vmBinary,
  vmRunScript,
} from './sandbox.js';
import { readSandboxVm } from './link.js';
import { ensurePrivateDirectory, restrictWindowsAcl } from './fs-acl.js';

// Agent runner + the pluggable agent-type adapter seam (Phase 5, A1).
//
// An agent is NOT a new transport — it's the Phase-4 reattachable tmux
// shell (`appliance-vm shell <vm> --session agent-<id>`) launched as the
// non-root `appliance` user in /persist/workspace, with three things in
// front of the launch command:
//   (a) the host egress proxy wired into HTTP(S)_PROXY (so the agent's
//       outbound TLS flows through the broker),
//   (b) the agent CLI's CA / cert-store env (the egress CA is already
//       trusted guest-wide — guest.rs update-ca-certificates), and
//   (c) an INERT placeholder credential so the CLI starts and emits its
//       auth header, which the proxy then overwrites host-side with the
//       real key (see docs/agent-sandbox.md §3; the key never enters the
//       VM).
//
// The credential broker itself (key store, fail-closed injection, MITM
// scoping, peer-gate) is A2 — the host key store / `print-key` helper
// lives in this file; the proxy-side enforcement is in packages/vm
// (egress.rs / creds.rs / mitm.rs).

// ---- adapter seam (docs/agent-sandbox.md §8b) --------------------------

export interface AgentLaunchOpts {
  /** Interactive TTY (`claude`) or one-shot autonomous (`claude -p …`). */
  mode: 'interactive' | 'autonomous';
  /** Autonomous: the prompt. Interactive: the initial prompt the user lands
   *  on (passed as `claude "<task>"`), or just a tab label when omitted. */
  task?: string;
}

/** The kind of credential the user stored host-side. The per-agent store tags
 *  every secret with its kind; the runner matches that tag to an AuthMode
 *  (docs/agent-login.md §1, §5; docs/multi-agent-adapters.md §1). `pat` is
 *  Copilot's fine-grained GitHub PAT. */
export type AgentAuthKind = 'api-key' | 'oauth' | 'pat';

/** How `appliance agent login` OBTAINS the credential (login-UX dispatch,
 *  docs/multi-agent-adapters.md §4): paste a key, paste a fine-grained PAT, or
 *  run a host-side `setup-token` browser flow. Distinct from `kind` (what is
 *  stored) because two agents can store the same `kind` with different wire
 *  shapes (Claude vs Codex api-key). */
export type LoginKind = 'api-key' | 'pat' | 'setup-token';

/** How the autonomous runner captures + classifies a one-shot run
 *  (docs/multi-agent-adapters.md §3). `json` parses stdout via `parseResult`;
 *  `text` captures stdout + classifies by exit code only (Copilot has no JSON
 *  output mode). */
export type CaptureMode = 'json' | 'text';

/** Auth-scheme prefix for the credential header value. `undefined` → bare
 *  (Claude api-key); `Bearer` → Claude OAuth / Codex api-key; `token` →
 *  Copilot's `Authorization: token <PAT>` token-exchange leg. */
export type AuthScheme = 'Bearer' | 'token';

/** Pinned install descriptor (docs/multi-agent-adapters.md §6). The runner
 *  derives the install-on-first-use command from it:
 *  `command -v <bin> || npm install -g <pkg>@<version>`. Copilot + Codex move
 *  fast and have shipped breaking CLI changes, so the version is PINNED. */
export interface AgentInstall {
  /** npm package. */
  pkg: string;
  /** PINNED version. Empty string ⇒ unpinned (tracks `@latest`) — used only by
   *  claude-code, whose install stays the pre-multi-agent unpinned behaviour. */
  version: string;
  /** The binary on PATH. */
  bin: string;
  /** Minimum Node (provisioning note; the guest toolchain ships Node ≥22). */
  node: string;
}

/** A stored host-side credential: its kind + the opaque secret value. The
 *  Keychain/0600 item is a small JSON envelope so the kind travels with the
 *  value atomically in one item (docs/agent-login.md §5). */
export interface StoredCred {
  kind: AgentAuthKind;
  value: string;
}

/** One way an agent authenticates (docs/agent-login.md §1) — the agent-agnostic
 *  seam. The runner selects a mode by the kind of credential the user stored
 *  host-side, then derives the broker cred-rule header, the in-guest
 *  placeholder env, and the host login command from it. So dropping in another
 *  CLI agent is just a new `authModes` array — no transport/broker/runner
 *  change. */
export interface AuthMode {
  /** Which stored credential kind this mode consumes. */
  kind: AgentAuthKind;
  /** The wire header the agent CLI emits its credential on, and the header the
   *  broker rewrites host-side. */
  header: 'x-api-key' | 'authorization';
  /** Auth-scheme prefix for the header value. When set, the host `print-key`
   *  helper emits `"<scheme> <secret>"`; when unset it emits the bare secret —
   *  so the proxy's set_header stays a literal value-replace (docs §3).
   *    • undefined → bare    (Claude api-key: `x-api-key: <key>`)
   *    • 'Bearer'  → OAuth/key (Claude OAuth, Codex api-key: `Authorization: Bearer <secret>`)
   *    • 'token'   → Copilot   (`Authorization: token <PAT>` on the api.github.com leg) */
  scheme?: AuthScheme;
  /** The single in-guest env var that carries the (placeholder) credential so
   *  the CLI starts + emits `header`. Exactly ONE auth env is set per launch —
   *  the selected mode's — to keep the CLI's credential-precedence chain from
   *  picking a different header (docs §1). */
  env: string;
  /** How the user supplies this credential at login (docs/multi-agent-adapters.md §4). */
  login: LoginKind;
  /** Host-side interactive login that yields this credential (`setup-token`
   *  only). Run on the HOST; absent for api-key/pat (the user pastes/pipes). */
  loginCmd?: string;
  /** Inert, syntactically-shaped placeholder put in `env` in-guest. The CLI
   *  needs *a* credential present to start + emit the header; the proxy
   *  overwrites it host-side. Capturing it buys an attacker nothing. */
  placeholder: string;
}

/** An agent-type adapter. claude-code / copilot / codex are concrete objects;
 *  another CLI agent is a new object — no transport/broker/runner change
 *  (docs/agent-sandbox.md §8b, docs/multi-agent-adapters.md §1). */
export interface AgentAdapter {
  type: string;
  /** The per-agent host cred-store key (Keychain account / 0600 filename) —
   *  docs/multi-agent-adapters.md §4. Distinct stores so three agents'
   *  credentials never collide. */
  provider: string;
  /** Pinned install-on-first-use descriptor (docs §6). */
  install: AgentInstall;
  /** The launch argv inside the session (docs §6). */
  launchArgv(opts: AgentLaunchOpts): string[];
  /** The single host the broker injects the auth header on. NOTE Copilot: this
   *  is the token-EXCHANGE host (api.github.com), NOT the model host
   *  (api.githubcopilot.com) — docs §2/§7. */
  apiHost: string;
  /** Hosts this agent needs reachable; baked into NETSTACK_ALLOWLIST (docs §5). */
  egressHosts: string[];
  /** The auth modes this agent supports. The runner picks the one whose `kind`
   *  matches the stored credential; an unsupported stored kind errors
   *  actionably (docs §1, §2). */
  authModes: AuthMode[];
  /** Autonomous result capture: 'json' → parse with `parseResult`; 'text' →
   *  capture stdout, classify by exit code only (docs §3). */
  captureMode: CaptureMode;
  /** Agent-specific runtime env (e.g. CLAUDE_CODE_CERT_STORE). */
  runtimeEnv?: Record<string, string>;
  /** Extract a result from autonomous stdout. Required for `captureMode:'json'`,
   *  absent for `'text'` (A6, docs §3). */
  parseResult?(stdout: string): { ok: boolean; summary?: string };
}

/** Derive the install-on-first-use command from a pinned install descriptor:
 *  `command -v <bin> >/dev/null 2>&1 || npm install -g <pkg>@<version> >/dev/null`.
 *
 *  With the prebuilt agent image (docs/fast-spin-up.md §2.6) the three CLIs
 *  are on PATH from the read-only squashfs, so `command -v <bin>` succeeds and
 *  the `|| npm install` NEVER runs — the runtime install is a no-op on the hot
 *  path. The `|| npm install` is retained as a SELF-HEAL: if no image was
 *  attached (e.g. the artifact isn't published yet), it still installs — now
 *  into `/persist/npm-global` (the guest's `NPM_CONFIG_PREFIX`, off the
 *  workspace mount), not the repo.
 *
 *  Only stdout is suppressed (`>/dev/null`), so a failed `npm install` surfaces
 *  its stderr rather than silently producing a dead session — runAgent joins
 *  this with `&&` so a failure aborts before the tmux session is created. An
 *  empty `version` ⇒ unpinned (`@latest`); all three adapters are now pinned. */
export function installCommandFor(install: AgentInstall): string {
  const spec = install.version ? `${install.pkg}@${install.version}` : install.pkg;
  return `command -v ${install.bin} >/dev/null 2>&1 || npm install -g ${spec} >/dev/null`;
}

/** The Anthropic host the broker injects the key on. */
export const ANTHROPIC_HOST = 'api.anthropic.com';

/** The INERT placeholder put in the guest's `ANTHROPIC_API_KEY`. Claude
 *  Code won't start without auth in its precedence chain, so a credential
 *  MUST be present for the CLI to run + emit `x-api-key`; the proxy
 *  overwrites this value host-side before it leaves (docs §3 step 4).
 *  Verified (A0 STEP 0): `claude` accepts this shape without local
 *  pre-validation and emits the request — a 401 comes from upstream, not
 *  a local check. Capturing it buys an attacker nothing. */
export const ANTHROPIC_PLACEHOLDER_KEY = 'sk-ant-appliance-proxy';

/** The INERT placeholder put in the guest's `CLAUDE_CODE_OAUTH_TOKEN` in OAuth
 *  mode — oauth-shaped (`sk-ant-oat01-…`) so `claude` starts and emits
 *  `Authorization: Bearer <placeholder>`, which the proxy overwrites host-side
 *  with the real Bearer token before it leaves (docs/agent-login.md §3, §5).
 *  Inert; capturing it buys an attacker nothing. */
export const ANTHROPIC_OAUTH_PLACEHOLDER = 'sk-ant-oat01-appliance-proxy';

/** The host-side interactive sign-in that mints the one-year OAuth token
 *  (docs/agent-login.md §2). The `claude` binary on the HOST runs this; it
 *  never runs in the VM. */
export const CLAUDE_OAUTH_LOGIN_CMD = 'claude setup-token';

// ---- Copilot (PAT-broker) constants (docs/multi-agent-adapters.md §1/§7) ----

/** Copilot's token-EXCHANGE host — the broker rewrites the `token <placeholder>`
 *  header on the `api.github.com/copilot_internal/v2/token` leg → the real PAT.
 *  NOT the model host (api.githubcopilot.com), which is a blind tunnel (§7). */
export const COPILOT_TOKEN_EXCHANGE_HOST = 'api.github.com';

/** The INERT placeholder put in the guest's `COPILOT_GITHUB_TOKEN` — shaped like
 *  a fine-grained GitHub PAT so `copilot` starts + emits `Authorization: token
 *  <placeholder>`, which the proxy overwrites host-side with the real PAT before
 *  it leaves. Inert; capturing it buys an attacker nothing. */
export const COPILOT_PLACEHOLDER_PAT = 'github_pat_appliance_proxy';

// ---- Codex (API-key path) constants (docs/multi-agent-adapters.md §1) -------

/** Codex's API host — `OPENAI_API_KEY` → `Authorization: Bearer` →
 *  api.openai.com/v1 (honors OPENAI_BASE_URL). Same shape as Claude api-key. */
export const OPENAI_HOST = 'api.openai.com';

/** The INERT placeholder put in the guest's `OPENAI_API_KEY` — `sk-`-shaped so
 *  `codex` starts + emits `Authorization: Bearer <placeholder>`, which the proxy
 *  overwrites host-side. Inert; capturing it buys an attacker nothing. */
export const OPENAI_PLACEHOLDER_KEY = 'sk-appliance-proxy';

/** The guest path the egress CA is trusted at (guest.rs:105). Used only
 *  as a NODE_EXTRA_CA_CERTS belt-and-suspenders; CLAUDE_CODE_CERT_STORE's
 *  default `system` source already covers it (docs §4b). */
const GUEST_EGRESS_CA = '/usr/local/share/ca-certificates/appliance-egress.crt';

/** NO_PROXY for the agent: bypass the proxy for loopback + cluster-
 *  internal destinations only (mirrors egress.rs default_no_proxy). */
const AGENT_NO_PROXY =
  'localhost,127.0.0.1,::1,.svc,.svc.cluster.local,.cluster.local,10.42.0.0/16,10.43.0.0/16,kubernetes.default';

export const claudeCodeAdapter: AgentAdapter = {
  type: 'claude-code',
  provider: 'anthropic',
  // PINNED to the version baked into the prebuilt agent image (squashfs).
  // Was unpinned (`version: ''`) so the runtime install tracked `@latest`;
  // the fast-spin-up prebuilt image (docs/fast-spin-up.md §2.6) bakes one
  // reviewed version, so the adapter pin MUST equal the baked manifest — CI
  // asserts `install.version == npm ls @anthropic-ai/claude-code` and fails
  // on drift (§2.2/§2.7). Bumping the pin is one coordinated commit with
  // AGENT_IMAGE_VERSION + the per-arch sha256 (images.rs). Node ≥22: the
  // squashfs bakes Node ≥22, ahead of Alpine v3.21's apk `nodejs`.
  install: { pkg: '@anthropic-ai/claude-code', version: '2.1.196', bin: 'claude', node: '>=22' },
  egressHosts: ['api.anthropic.com'],
  captureMode: 'json',
  launchArgv(opts: AgentLaunchOpts): string[] {
    if (opts.mode === 'autonomous') {
      // --dangerously-skip-permissions is why the non-root user exists
      // (agents refuse it as root, docs/rootless-guest.md §0).
      return ['claude', '-p', opts.task ?? '', '--output-format', 'json', '--dangerously-skip-permissions'];
    }
    // Interactive: `claude "<prompt>"` starts the interactive TTY seeded
    // with the user's task as the first prompt (verified against `claude
    // --help`: the positional `[prompt]` arg with no `-p` stays
    // interactive). Without a task it's a bare interactive session. The
    // token is shQuoted by composeLaunchLine, so a multi-word task is safe.
    return opts.task ? ['claude', opts.task] : ['claude'];
  },
  apiHost: ANTHROPIC_HOST,
  // Claude Code declares BOTH modes. The runner sets exactly one in-guest auth
  // env per launch (the selected mode's) so the CLI's credential-precedence
  // chain — ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY > apiKeyHelper >
  // CLAUDE_CODE_OAUTH_TOKEN > interactive /login — deterministically emits the
  // header the broker rewrites (docs/agent-login.md §1).
  authModes: [
    {
      kind: 'api-key',
      header: 'x-api-key',
      env: 'ANTHROPIC_API_KEY',
      login: 'api-key',
      placeholder: ANTHROPIC_PLACEHOLDER_KEY,
    },
    {
      kind: 'oauth',
      header: 'authorization',
      scheme: 'Bearer',
      env: 'CLAUDE_CODE_OAUTH_TOKEN',
      login: 'setup-token',
      loginCmd: CLAUDE_OAUTH_LOGIN_CMD, // host-side; one-year token, shown once
      placeholder: ANTHROPIC_OAUTH_PLACEHOLDER,
    },
  ],
  runtimeEnv: { CLAUDE_CODE_CERT_STORE: 'bundled,system' },
  parseResult(stdout: string): { ok: boolean; summary?: string } {
    // Claude Code's --output-format json prints one result object.
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('{')) continue;
      try {
        const obj = JSON.parse(line) as { is_error?: boolean; result?: unknown };
        if ('result' in obj || 'is_error' in obj) {
          return { ok: obj.is_error !== true, summary: typeof obj.result === 'string' ? obj.result : undefined };
        }
      } catch {
        // not the result line
      }
    }
    return { ok: false };
  },
};

/**
 * GitHub Copilot CLI (`@github/copilot`) — the PAT-broker adapter
 * (docs/multi-agent-adapters.md §1/§7).
 *
 * Copilot is a TWO-leg flow: the CLI sends `Authorization: token
 * <COPILOT_GITHUB_TOKEN>` to `api.github.com/copilot_internal/v2/token` to mint
 * a short-lived Copilot session bearer, then calls `api.githubcopilot.com` with
 * `Authorization: Bearer <session>`. The broker MITMs `api.github.com` (the
 * token-EXCHANGE host, NOT the model host) and rewrites the placeholder `token`
 * header → the real fine-grained PAT — so the durable PAT never enters the VM.
 * The model leg (api.githubcopilot.com) is an allowed-but-blind tunnel (§7).
 *
 * Capture is TEXT: the Copilot CLI has no JSON output mode, so the autonomous
 * runner captures stdout verbatim and classifies by exit code only (§3).
 */
export const copilotAdapter: AgentAdapter = {
  type: 'copilot',
  provider: 'github-copilot',
  install: { pkg: '@github/copilot', version: '1.0.65', bin: 'copilot', node: '>=22' },
  apiHost: COPILOT_TOKEN_EXCHANGE_HOST, // api.github.com — the PAT-broker leg, not the model host
  // github.com (suffix) covers api.github.com (the PAT-broker leg);
  // githubusercontent.com covers copilot-proxy./origin-tracker.; the NEW bake is
  // the model leg githubcopilot.com (api.githubcopilot.com + *.) — §5.
  egressHosts: ['github.com', 'githubcopilot.com', 'githubusercontent.com'],
  captureMode: 'text', // NO JSON output mode — capture stdout, classify by exit code (§3)
  launchArgv(opts: AgentLaunchOpts): string[] {
    if (opts.mode === 'autonomous') {
      // autonomous: one task to completion, all tools allowed, no interactive
      // prompts. Flag spellings owed-live re-verify on 1.0.65 (§6/§8).
      return ['copilot', '-p', opts.task ?? '', '-s', '--allow-all-tools', '--no-ask-user'];
    }
    // Interactive TTY. Seeding the first prompt via a positional arg is
    // unverified on 1.0.65, so interactive is a bare TTY (§8 open question 1).
    return ['copilot'];
  },
  authModes: [
    {
      kind: 'pat',
      header: 'authorization',
      scheme: 'token', // `Authorization: token <PAT>` on the api.github.com leg
      env: 'COPILOT_GITHUB_TOKEN', // > GH_TOKEN > GITHUB_TOKEN; classic ghp_ PATs are ignored by the CLI
      login: 'pat',
      placeholder: COPILOT_PLACEHOLDER_PAT,
    },
  ],
  // Honors HTTPS_PROXY + NODE_EXTRA_CA_CERTS, both already set by the launch env.
  runtimeEnv: {},
  // captureMode:'text' → no parseResult (classifyAutonomousResult tails stdout).
};

/**
 * OpenAI Codex CLI (`@openai/codex`) — the API-key path adapter
 * (docs/multi-agent-adapters.md §1). Mirrors Claude's api-key mode: a durable
 * `OPENAI_API_KEY` lives host-side, brokered as `Authorization: Bearer` onto
 * api.openai.com, never in the VM. ChatGPT-subscription login is DEFERRED (it
 * writes a durable refresh_token into the guest — §7).
 *
 * Capture is JSON(L): `codex exec --json` emits one event per line; a
 * `turn.completed` event marks a clean turn and the last assistant message item
 * carries the summary (§3). The exact event schema is owed-live re-verify on
 * 0.142.0 (`--output-schema`/`-o <file>` is the fallback — §6/§8).
 */
export const codexAdapter: AgentAdapter = {
  type: 'codex',
  provider: 'openai',
  install: { pkg: '@openai/codex', version: '0.142.0', bin: 'codex', node: '>=22' },
  apiHost: OPENAI_HOST,
  egressHosts: ['api.openai.com'], // NEW bake — §5
  captureMode: 'json',
  launchArgv(opts: AgentLaunchOpts): string[] {
    if (opts.mode === 'autonomous') {
      // The microVM IS the sandbox → disable Codex's own sandbox + approvals.
      // --skip-git-repo-check so a non-git workspace still runs. Flag spelling
      // owed-live re-verify on 0.142.0 (§6/§8).
      return [
        'codex',
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        opts.task ?? '',
      ];
    }
    // Interactive: `codex "<prompt>"` starts the TUI seeded with the user's
    // task as the first prompt (per the recon — the positional arg with no
    // `exec` subcommand stays interactive), mirroring `claude "<task>"`. The
    // token is shQuoted by composeLaunchLine, so a multi-word task is safe.
    // Without a task it's a bare interactive session.
    return opts.task ? ['codex', opts.task] : ['codex'];
  },
  authModes: [
    // SAME kind as Claude api-key, DIFFERENT wire shape (Bearer, not bare) —
    // exactly why header/scheme live on the mode, not derived from `kind`.
    {
      kind: 'api-key',
      header: 'authorization',
      scheme: 'Bearer',
      env: 'OPENAI_API_KEY',
      login: 'api-key',
      placeholder: OPENAI_PLACEHOLDER_KEY,
    },
  ],
  runtimeEnv: {},
  parseResult(stdout: string): { ok: boolean; summary?: string } {
    // `codex exec --json` emits JSONL events, one per line. A `turn.completed`
    // event marks a clean turn (⇒ ok); the final assistant text comes from the
    // last assistant-message item. A fatal error event ⇒ not ok. Tolerant of
    // both the newer `{type:'item.completed',item:{...}}` and older
    // `{msg:{type:'agent_message',message}}` shapes (owed-live re-verify §8).
    let sawTurnCompleted = false;
    let sawError = false;
    let summary: string | undefined;
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('{')) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // not an event line
      }
      const type = typeof ev.type === 'string' ? ev.type : '';
      if (type === 'turn.completed') sawTurnCompleted = true;
      if (type === 'error' || type === 'turn.failed' || type === 'stream.error' || type === 'thread.error')
        sawError = true;
      // Newer event shape: { type:'item.completed', item:{ type|item_type:'assistant_message'|'agent_message', text } }
      const item = ev.item as Record<string, unknown> | undefined;
      if (item) {
        const it = typeof item.type === 'string' ? item.type : typeof item.item_type === 'string' ? item.item_type : '';
        if ((it === 'assistant_message' || it === 'agent_message') && typeof item.text === 'string') {
          summary = item.text;
        }
      }
      // Older event shape: { msg:{ type:'agent_message', message } }
      const msg = ev.msg as Record<string, unknown> | undefined;
      if (msg && msg.type === 'agent_message' && typeof msg.message === 'string') {
        summary = msg.message;
      }
    }
    return { ok: sawTurnCompleted && !sawError, summary };
  },
};

/** Map an agent-type to its adapter (the registry/`--type` key). claude-code /
 *  copilot / codex are concrete objects; another CLI agent is a new object —
 *  no transport/broker/runner change (docs §1/§8b). Shared by the CLI command
 *  group and the registry's autonomous-result finalizer. */
export function adapterForType(type: string): AgentAdapter | null {
  return [claudeCodeAdapter, copilotAdapter, codexAdapter].find((a) => a.type === type) ?? null;
}

/** The agent types with a registered adapter, for `--type` help + errors. */
export function supportedAgentTypes(): string[] {
  return [claudeCodeAdapter, copilotAdapter, codexAdapter].map((a) => a.type);
}

// ---- host key store (A2 — the broker's host side) ----------------------
//
// Each agent's credential lives host-side ONLY, in a PER-PROVIDER store so
// three agents' credentials never collide (docs/multi-agent-adapters.md §4):
// macOS Keychain (`sh.appliance.agent` / account = the adapter's `provider`),
// or a 0600 file off-macOS (`~/.appliance/agent/<provider>-cred`). It is never
// written into any per-VM file and never into the VM. The proxy fetches it via
// the `print-key --type <agent>` helper (a HOST process) at inject time.

const AGENT_KEYCHAIN_SERVICE = 'sh.appliance.agent';
const SECURITY_BIN = '/usr/bin/security';

function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/** The 0600 cred file for a provider (off-macOS store). */
function agentKeyFile(provider: string): string {
  return path.join(os.homedir(), '.appliance', 'agent', `${provider}-cred`);
}

/** The legacy pre-multi-agent Anthropic 0600 file (`anthropic-key`). Read as a
 *  fallback so a non-macOS user who logged in before the per-provider rename
 *  keeps working until they next `agent login`. */
function legacyAnthropicKeyFile(): string {
  return path.join(os.homedir(), '.appliance', 'agent', 'anthropic-key');
}

/**
 * Parse a stored host secret into a tagged credential, or null (fail-closed).
 *
 * The store holds either the current JSON envelope `{"kind","value"}` or — for
 * back-compat — a legacy BARE api-key string. Rules (Sasha nit):
 *   • A valid bare (non-`{`) string  ⇒ `{ kind: 'api-key', value }`.
 *   • A well-formed envelope         ⇒ that `{ kind, value }`.
 *   • Anything that LOOKS like an envelope (starts with `{`) but is
 *     unparseable / truncated / missing a known kind or value ⇒ `null`.
 *     We must NEVER hand the raw bytes of a broken envelope to the proxy as
 *     an api-key value — a `null` makes `print-key` exit 1 → the proxy fails
 *     CLOSED (docs/agent-login.md §5).
 */
export function parseStoredCred(raw: string): StoredCred | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s) as { kind?: unknown; value?: unknown };
      const kind = o.kind;
      const value = typeof o.value === 'string' ? o.value.trim() : '';
      if ((kind === 'api-key' || kind === 'oauth' || kind === 'pat') && value) return { kind, value };
      return null; // truncated/unknown-kind/empty-value envelope → fail closed
    } catch {
      return null; // unparseable envelope → fail closed (never treat as a key)
    }
  }
  // Legacy bare string → api-key, so pre-envelope logins keep working.
  return { kind: 'api-key', value: s };
}

/**
 * Read the host credential for a provider, Keychain-first on macOS (account =
 * provider), 0600-file elsewhere (`<provider>-cred`, with the legacy
 * `anthropic-key` as a read fallback), decoding the kind-tagged envelope
 * (back-compat: a bare string is an api-key). Returns null when
 * unset/locked/denied/unparseable. NEVER logs the secret. This is the
 * resolution the `print-key --type <agent>` helper renders for the proxy.
 */
export function readAgentKey(provider: string): StoredCred | null {
  let raw: string;
  if (isMacOS()) {
    try {
      raw = execFileSync(SECURITY_BIN, ['find-generic-password', '-s', AGENT_KEYCHAIN_SERVICE, '-a', provider, '-w'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  } else {
    try {
      raw = fs.readFileSync(agentKeyFile(provider), 'utf-8');
    } catch {
      // Legacy anthropic file fallback (pre per-provider rename).
      if (provider === 'anthropic') {
        try {
          raw = fs.readFileSync(legacyAnthropicKeyFile(), 'utf-8');
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }
  }
  return parseStoredCred(raw);
}

/**
 * Store a provider's host credential as a kind-tagged JSON envelope. macOS
 * Keychain `-U` upsert (account = provider); 0600 file elsewhere
 * (`<provider>-cred`). On macOS the secret is briefly on argv to `security` (no
 * stdin option for add-generic-password) — the documented, accepted tradeoff
 * (same as utils/keychain.ts writeKeychainApiKey), gated to this rare login
 * path. NEVER logs the secret.
 */
export function writeAgentKey(provider: string, value: string, kind: AgentAuthKind): void {
  const secret = value.trim();
  if (!secret) throw new Error(`refusing to store an empty ${provider} credential`);
  const envelope = JSON.stringify({ kind, value: secret } satisfies StoredCred);
  if (isMacOS()) {
    execFileSync(
      SECURITY_BIN,
      ['add-generic-password', '-U', '-s', AGENT_KEYCHAIN_SERVICE, '-a', provider, '-w', envelope],
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );
    return;
  }
  const file = agentKeyFile(provider);
  const applianceDir = path.dirname(path.dirname(file));
  ensurePrivateDirectory(applianceDir);
  ensurePrivateDirectory(path.dirname(file));
  fs.writeFileSync(file, envelope, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  try {
    restrictWindowsAcl(file);
  } catch (cause) {
    fs.rmSync(file, { force: true });
    throw cause;
  }
}

/** The wire-ready header VALUE the proxy injects: `<scheme> <secret>` when the
 *  selected AuthMode declares a scheme, else the bare secret. Generalizes the
 *  old hard-coded `oauth → Bearer`, which would mis-handle Codex (api-key but
 *  Bearer) and Copilot (pat but `token`). The scheme mirrors the resolved
 *  AuthMode.scheme so the proxy's set_header stays a literal value-replace
 *  (docs/multi-agent-adapters.md §2). NEVER logged. */
export function wireValueForCred(cred: StoredCred, scheme?: AuthScheme): string {
  return scheme ? `${scheme} ${cred.value}` : cred.value;
}

/** Select the AuthMode whose kind matches the stored credential. Throws an
 *  actionable error if the agent doesn't declare that kind (e.g. an api-key
 *  stored for an OAuth-only agent) — docs/agent-login.md §1, §2. */
export function resolveAuthMode(adapter: AgentAdapter, kind: AgentAuthKind): AuthMode {
  const mode = adapter.authModes.find((m) => m.kind === kind);
  if (!mode) {
    const supported = adapter.authModes.map((m) => m.kind).join(', ');
    throw new Error(
      `the stored credential kind '${kind}' is not supported by agent '${adapter.type}' ` +
        `(supported: ${supported}). Re-run \`appliance agent login\` to store a compatible credential.`
    );
  }
  return mode;
}

/** Pull the first `sk-ant-oat01-…` OAuth token out of an arbitrary blob,
 *  stripping ANSI escapes first. Robust to the user pasting the bare token OR
 *  the whole `export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…` line `setup-token`
 *  prints, with surrounding whitespace/colour codes. Returns null when no token
 *  is present (docs/agent-login.md §2, §7). Pure + unit-tested. */
export function extractOAuthToken(raw: string): string | null {
  // Strip ANSI/CSI escapes, INCLUDING the `\x1b` (ESC) introducer. The ESC
  // is written explicitly (not as an invisible raw byte) and made optional so
  // both a real `\x1b[…m` sequence AND a bare `[…m` strip cleanly. Leaving a
  // raw ESC wedged mid-token would truncate the capture: the `sk-ant-oat01-…`
  // char class stops at the ESC.
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/\x1b?\[[0-9;?]*[ -/]*[@-~]/g, '');
  const m = clean.match(/sk-ant-oat01-[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

/** The fine-grained GitHub PAT prefix Copilot's host-keyed injection is bound
 *  to. Sasha's hard pre-ship guard (docs/multi-agent-adapters.md §4): the
 *  login layer accepts ONLY `github_pat_`-prefixed tokens and REJECTS classic
 *  `ghp_` PATs — the fine-grained PAT's narrow `Copilot Requests` scope is the
 *  entire security bound on host-keyed PAT injection (§7). */
export const GITHUB_FINE_GRAINED_PAT_PREFIX = 'github_pat_';
const GITHUB_CLASSIC_PAT_PREFIX = 'ghp_';

/** Result of validating a pasted Copilot credential at login. */
export type CopilotPatValidation = { ok: true; value: string } | { ok: false; reason: 'empty' | 'classic' | 'shape' };

/** Validate a Copilot login credential — Sasha's HARD pre-ship guard
 *  (docs/multi-agent-adapters.md §4/§7). REJECTS classic `ghp_` PATs and
 *  anything that is not a fine-grained `github_pat_` token. The fine-grained
 *  PAT (scoped to `Copilot Requests` only) is the security bound on host-keyed
 *  injection — a classic PAT carries the user's full account scope, so a
 *  jailbroken guest abusing the host-keyed `api.github.com` rule could act far
 *  beyond Copilot requests. Pure + unit-tested. */
export function validateCopilotPat(raw: string): CopilotPatValidation {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (value.startsWith(GITHUB_CLASSIC_PAT_PREFIX)) return { ok: false, reason: 'classic' };
  if (!value.startsWith(GITHUB_FINE_GRAINED_PAT_PREFIX)) return { ok: false, reason: 'shape' };
  return { ok: true, value };
}

/** Soft shape check for an OpenAI API key (`sk-…`). Codex login WARNS but still
 *  stores on a mismatch — there's no hard format guard, mirroring Claude's
 *  api-key path (docs/multi-agent-adapters.md §4). Pure + unit-tested. */
export function looksLikeOpenAiKey(raw: string): boolean {
  return raw.trim().startsWith('sk-');
}

/** Is the `claude` binary present + runnable on this HOST? OAuth login shells
 *  `claude setup-token` host-side, so a missing host `claude` is a precondition
 *  with an actionable error rather than a crash (docs/agent-login.md §2, §7). */
export function hostHasClaude(): boolean {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Run `claude setup-token` on the HOST with the TTY inherited so the user sees
 *  the sign-in URL, the browser opens, and they paste the auth code — the
 *  native flow. Returns the exit code. The token is NOT captured here:
 *  `setup-token` is an Ink TUI that REVEALS the one-year token on-screen only
 *  (it prints no clean stdout line and persists no copy — docs/agent-login.md
 *  §7), so the caller captures it via a hidden in-process paste prompt. This
 *  helper NEVER writes a tmp file and NEVER logs the token (Sasha §7.1). */
export function runSetupTokenInteractive(): number {
  const r = spawnSync('claude', ['setup-token'], { stdio: 'inherit' });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 127; // host `claude` vanished between checks
    throw r.error;
  }
  return r.status ?? 1;
}

/** Forget a provider's stored host credential (`appliance agent logout
 *  --type <agent>`). */
export function forgetAgentKey(provider: string): void {
  if (isMacOS()) {
    try {
      execFileSync(SECURITY_BIN, ['delete-generic-password', '-s', AGENT_KEYCHAIN_SERVICE, '-a', provider], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      // not present — nothing to forget
    }
    return;
  }
  try {
    fs.rmSync(agentKeyFile(provider), { force: true });
    if (provider === 'anthropic') fs.rmSync(legacyAnthropicKeyFile(), { force: true });
  } catch {
    // ignore
  }
}

// ---- runner ------------------------------------------------------------

/** Mint an `agent-<uuid>` session id (mirrors the desktop `${mode}-${uuid}`
 *  convention; satisfies validate_session_id in shell.rs). */
export function mintAgentSessionId(): string {
  return `agent-${globalThis.crypto.randomUUID()}`;
}

/** Normalize a caller-supplied session id to the `agent-<…>` convention
 *  the rehydrate path + registry key off (so `--session <id>` accepts the
 *  bare or prefixed form). Mints nothing — just ensures the prefix. */
export function ensureAgentSessionId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('agent-') ? trimmed : `agent-${trimmed}`;
}

/** The sandbox VM the cwd project targets: the linked VM, else the shared
 *  default sandbox VM. */
export function targetVm(): string {
  return readSandboxVm() ?? DEFAULT_SANDBOX_VM;
}

/** POSIX-single-quote a token for safe embedding in an `sh -c` command.
 *  Wraps in single quotes and rewrites any embedded single quote as the
 *  classic `'\''` sequence (close-quote, escaped quote, reopen) so the
 *  token can neither be split on whitespace nor break out of the quoting
 *  — and so a wrapper that itself single-quotes the whole line (runAgent →
 *  `tmux new-session`) nests correctly. */
function shQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** The runnable agent subcommand entry (`appliance-agent.js`), resolved
 *  relative to THIS module so it's stable no matter how the process was
 *  launched. The umbrella dispatcher (appliance.ts) rewrites
 *  `process.argv[1]` to the literal `appliance-agent` before importing
 *  this module, so the helper path must NOT be derived from argv[1] (that
 *  yields a bogus cwd-relative path → `print-key` exits non-zero → every
 *  brokered request fail-closes to 502 under a node invocation). */
function nodeAgentEntry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'appliance-agent.js');
}

/** Resolve the host argv the proxy spawns directly to fetch the key, pinning
 *  the executable and development entry paths (never PATH-relative).
 *
 *  Shipping path: the CLI runs as the Bun-compiled single binary
 *  (`bin/appliance.js` exec's `appliance-bin` / `dist/appliance`), so
 *  `execPath` IS the umbrella binary and `<exe> agent print-key` works.
 *
 *  Dev/test (node or bun-as-interpreter): `execPath` is the interpreter,
 *  so we run the agent subcommand entry DIRECTLY from a module-relative
 *  path — independent of the dispatcher-clobbered `process.argv[1]`.
 *
 *  `--type <agent>` is one literal argv element, so no shell quoting or
 *  interpolation is involved. */
export function printKeyHelperCommand(type: string): string[] {
  const exe = process.execPath;
  if (!path.isAbsolute(exe)) {
    throw new Error(`credential helper executable must be absolute (got '${exe}')`);
  }
  const base = path.basename(exe).toLowerCase();
  if (base.startsWith('appliance')) {
    return [exe, 'agent', 'print-key', '--type', type];
  }
  // `<interpreter> <appliance-agent.js> print-key --type <agent>` — the entry's
  // own program (`appliance agent`) dispatches `print-key`.
  const entry = nodeAgentEntry();
  if (!path.isAbsolute(entry)) {
    throw new Error(`credential helper entry must be absolute (got '${entry}')`);
  }
  return [exe, entry, 'print-key', '--type', type];
}

/** The proxy/CA/placeholder env, rendered as `K=V` assignments for an
 *  `env …` prefix. Values are fixed/metachar-free (URLs, constant paths,
 *  inert placeholders), so they're left unquoted. Exactly ONE auth env is
 *  set — the selected mode's `env=placeholder` — so the CLI's
 *  credential-precedence chain emits the header the broker rewrites
 *  (docs/agent-login.md §1). */
function launchEnvAssigns(adapter: AgentAdapter, mode: AuthMode, proxyUrl: string): string {
  const env: Record<string, string> = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: AGENT_NO_PROXY,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    no_proxy: AGENT_NO_PROXY,
    NODE_EXTRA_CA_CERTS: GUEST_EGRESS_CA,
    ...(adapter.runtimeEnv ?? {}),
    [mode.env]: mode.placeholder,
  };
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

/** Compose the in-session launch line: cd to the workspace then run the
 *  agent under the proxy/CA/placeholder env.
 *
 *  The agent argv — including the user-controlled autonomous `--task`
 *  prompt — is shell-quoted PER TOKEN, and `runAgent` then wraps the whole
 *  line with the POSIX `'\''` trick before handing it to
 *  `tmux new-session`. So a multi-word task no longer mis-parses
 *  (`claude -p fix the test` would otherwise take only `fix`) and a single
 *  quote in the task can't break out of the wrapper into arbitrary
 *  in-guest exec.
 *
 *  `exec` (default) hands the session straight to the agent — right for the
 *  detached tmux launch (interactive TTY). The one-shot capture path
 *  (`--wait`, §6) passes `exec=false` so the login shell OUTLIVES the agent
 *  and the trailing exit-code sentinel (shell.rs) can still fire to carry
 *  the agent's real exit code back over the status-less byte pipe. */
export function composeLaunchLine(
  adapter: AgentAdapter,
  mode: AuthMode,
  proxyUrl: string,
  opts: AgentLaunchOpts,
  exec = true
): string {
  const argv = adapter.launchArgv(opts).map(shQuote).join(' ');
  return `cd ${GUEST_WORKSPACE}; ${exec ? 'exec ' : ''}env ${launchEnvAssigns(adapter, mode, proxyUrl)} ${argv}`;
}

// ---- autonomous result capture (A6) ------------------------------------
//
// The autonomous run (`claude -p … --output-format json`) is captured one
// of two ways, both feeding `classifyAutonomousResult`:
//   • `--wait` (blocking): runs the headless argv as a captured one-shot
//     over the vsock sentinel path (shell.rs) — stdout + the real exit code
//     come back in-band; no result file is needed.
//   • detached (default): the launch line redirects the JSON result to a
//     file on the VirtioFS-shared workspace and records the exit code, so
//     the host can collect the outcome AFTER the tmux session ends —
//     `reconcileRegistry` reads it to flip the status to done/error.

/** The host + guest paths an autonomous run's result/exit-code are
 *  captured to. The workspace is VirtioFS-shared, so the guest writes under
 *  `/persist/workspace/.appliance/agent-results` and the host reads the
 *  SAME tree at `<projectDir>/.appliance/agent-results` — no VM round-trip
 *  to collect a detached run's result (docs/agent-sandbox.md §6). */
export interface AgentResultPaths {
  hostJson: string;
  hostRc: string;
  guestJson: string;
  guestRc: string;
  guestDir: string;
}

const AGENT_RESULTS_REL = '.appliance/agent-results';

export function agentResultPaths(projectDir: string, sessionId: string): AgentResultPaths {
  const root = path.resolve(projectDir);
  return {
    hostJson: path.join(root, '.appliance', 'agent-results', `${sessionId}.json`),
    hostRc: path.join(root, '.appliance', 'agent-results', `${sessionId}.rc`),
    guestJson: `${GUEST_WORKSPACE}/${AGENT_RESULTS_REL}/${sessionId}.json`,
    guestRc: `${GUEST_WORKSPACE}/${AGENT_RESULTS_REL}/${sessionId}.rc`,
    guestDir: `${GUEST_WORKSPACE}/${AGENT_RESULTS_REL}`,
  };
}

/** The detached-autonomous launch line: like `composeLaunchLine` but it
 *  runs the headless argv NON-exec'd, redirecting the `--output-format
 *  json` result (stdout) to the shared-workspace result file and recording
 *  the exit code in a sibling `.rc` file — so a detached run's outcome is
 *  collectable host-side once its tmux session ends. stderr (Claude's
 *  progress) stays on the pane so an attached tab can watch the run live. */
export function composeAutonomousCaptureLine(
  adapter: AgentAdapter,
  mode: AuthMode,
  proxyUrl: string,
  opts: AgentLaunchOpts,
  paths: Pick<AgentResultPaths, 'guestJson' | 'guestRc' | 'guestDir'>
): string {
  const assigns = launchEnvAssigns(adapter, mode, proxyUrl);
  const argv = adapter
    .launchArgv({ ...opts, mode: 'autonomous' })
    .map(shQuote)
    .join(' ');
  return (
    `cd ${GUEST_WORKSPACE}; mkdir -p ${shQuote(paths.guestDir)}; ` +
    `env ${assigns} ${argv} > ${shQuote(paths.guestJson)}; ` +
    `echo $? > ${shQuote(paths.guestRc)}`
  );
}

/** The classified outcome of an autonomous run. `done` only when the agent
 *  exited 0 AND the adapter parsed a non-error result; a non-zero exit, an
 *  unparseable stream, or an `is_error` result is `error` (docs §6). */
export interface AutonomousResult {
  status: 'done' | 'error';
  exitCode: number | null;
  summary?: string;
}

/** The last `n` non-empty-trailing lines of a captured stdout, for a text-mode
 *  (Copilot) run's summary — the agent's final textual answer (docs §3). */
export function tailLines(s: string, n: number): string {
  const lines = s.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-n).join('\n');
}

/** Classify an autonomous run from its exit code + captured stdout, branching
 *  on the adapter's `captureMode` (docs/multi-agent-adapters.md §3). Pure
 *  (unit-tested): the single source of truth both the `--wait` path and the
 *  detached reconcile finalizer run through.
 *    • `text` (Copilot): no JSON to parse — `done` iff exit 0; the summary is a
 *      trailing slice of stdout (the agent's final answer).
 *    • `json` (claude-code, codex): parse stdout with `adapter.parseResult`;
 *      `done` iff exit 0 AND the parse is non-error. */
export function classifyAutonomousResult(
  exitCode: number | null,
  stdout: string,
  adapter: AgentAdapter
): AutonomousResult {
  if (adapter.captureMode === 'text') {
    const ok = exitCode === 0;
    const tail = tailLines(stdout, 20);
    const summary = tail || (ok ? 'completed' : `no output captured (exit ${exitCode ?? 'unknown'})`);
    return { status: ok ? 'done' : 'error', exitCode, summary };
  }
  const parsed = adapter.parseResult?.(stdout);
  const ok = exitCode === 0 && parsed?.ok === true;
  const summary = parsed?.summary ?? (ok ? 'completed' : `no result captured (exit ${exitCode ?? 'unknown'})`);
  return { status: ok ? 'done' : 'error', exitCode, summary };
}

/** Read + classify a detached autonomous run's captured result from the
 *  shared workspace. Returns null when the JSON result file isn't present
 *  yet (the run produced nothing) so the caller can fall back to `exited`
 *  rather than inventing an outcome. NEVER throws on a missing/corrupt
 *  file. */
export function readAutonomousResultFromFiles(
  hostJson: string,
  hostRc: string,
  adapter: AgentAdapter
): AutonomousResult | null {
  let stdout: string;
  try {
    stdout = fs.readFileSync(hostJson, 'utf-8');
  } catch {
    return null; // no result file → not finalized; caller treats as exited
  }
  let exitCode: number | null = null;
  try {
    const n = Number.parseInt(fs.readFileSync(hostRc, 'utf-8').trim(), 10);
    if (Number.isInteger(n)) exitCode = n;
  } catch {
    // rc missing — leave null; classify maps a missing code to `error`
  }
  return classifyAutonomousResult(exitCode, stdout, adapter);
}

/** Read the proxy URL the guest should use from `appliance-vm egress
 *  gateway` (which prints `HTTPS_PROXY=<url>`), derived from the VM's
 *  subnet gateway + egress port (egress.rs guest_proxy_url). */
function resolveProxyUrl(vm: string): string {
  const r = runVmCapture(['egress', 'gateway', vm]);
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^HTTPS_PROXY=(.+)$/);
    if (m) return m[1].trim();
  }
  throw new Error(`could not resolve the egress proxy URL for VM '${vm}' (egress gateway gave no HTTPS_PROXY)`);
}

/** Apply the broker's cred rule for the selected auth mode + turn MITM on for
 *  this VM (A2). Idempotent. The single `apiHost` rule is inject + capture:false
 *  with the pinned-absolute `print-key` helper, on the mode's header
 *  (`x-api-key` for api-key, `authorization` for oauth). The write is an upsert
 *  keyed on host, so switching modes REPLACES the rule (never a dual rule, so
 *  `first_matching(inject)` stays unambiguous — docs/agent-login.md §2). The
 *  placeholder never enters egress-secrets.json (capture:false). */
export function configureBroker(vm: string, adapter: AgentAdapter, mode: AuthMode): void {
  // `--helper` crosses one process argv boundary, so encode the helper array as
  // JSON. appliance-vm parses it back into CredentialHelper::Argv and persists
  // the array itself (not this transport string) in egress-credentials.json.
  // Upserting the host also migrates a persisted legacy helper on next login or
  // agent start.
  const helper = JSON.stringify(printKeyHelperCommand(adapter.type));
  const args = ['creds', 'add', adapter.apiHost, '--name', vm, '--header', mode.header, '--inject', '--helper', helper];
  const code = runVm(args);
  if (code !== 0) throw new Error(`failed to write the credential rule for ${adapter.apiHost} (exit ${code})`);
  const mitm = runVm(['egress', 'mitm', 'on', '--name', vm]);
  if (mitm !== 0) throw new Error(`failed to enable TLS interception on VM '${vm}' (exit ${mitm})`);
}

export interface RunAgentOpts {
  /** Target VM; defaults to the linked/shared sandbox VM. */
  vm?: string;
  /** Project dir to mount at /persist/workspace; defaults to cwd. */
  projectDir?: string;
  adapter?: AgentAdapter;
  mode?: 'interactive' | 'autonomous';
  task?: string;
  /** Use this session id (normalized to the `agent-` prefix) instead of
   *  minting one — lets a caller (the CLI `--session`, the desktop tab)
   *  pre-allocate the agent's session id. */
  sessionId?: string;
  /** Autonomous: block until the run completes, capturing the result
   *  in-band over the one-shot sentinel path, instead of detaching. */
  wait?: boolean;
  /** Provision the in-guest Docker engine for this sandbox (lazy re-up,
   *  one reboot). Off by default — the agent sandbox boots with no
   *  dockerd; opt in via `appliance agent start --docker` for a task that
   *  needs `docker build`/compose (docs/fast-spin-up.md §1.5). */
  docker?: boolean;
}

/** What a launch produced. `result` is set only for a blocking (`--wait`)
 *  autonomous run; `resultPath` is the host path a DETACHED autonomous run
 *  writes its captured JSON result to (read later by reconcile). */
export interface RunAgentResult {
  sessionId: string;
  vm: string;
  mode: 'interactive' | 'autonomous';
  resultPath?: string;
  result?: AutonomousResult;
}

/**
 * Launch a coding agent as the appliance user, wired through the host
 * credential broker. Boots/ensures the sandbox VM, requires the host key,
 * configures the broker, and installs the agent on first use. Then either:
 *
 *   • interactive / detached-autonomous (default): spawns the reattachable
 *     `agent-<id>` tmux session and returns immediately (attach with
 *     `appliance vm shell <vm> --session <id>`). Autonomous redirects its
 *     result to the shared workspace so reconcile can finalize it.
 *   • autonomous + `wait`: runs the headless task to completion over the
 *     vsock one-shot sentinel path, capturing stdout + the exit code, and
 *     returns the classified `result`.
 */
export async function runAgent(opts: RunAgentOpts = {}): Promise<RunAgentResult> {
  const adapter = opts.adapter ?? claudeCodeAdapter;
  const mode = opts.mode ?? 'interactive';
  const vm = opts.vm ?? targetVm();
  const projectDir = path.resolve(opts.projectDir ?? process.cwd());
  const wait = mode === 'autonomous' && opts.wait === true;

  // Fail fast before booting anything if the host credential isn't configured —
  // the proxy fails closed, so the agent would only hit a 502 otherwise. The
  // stored kind also selects the auth mode (header/env/placeholder). Read from
  // the agent's OWN provider store so three agents' creds never collide.
  const cred = readAgentKey(adapter.provider);
  if (!cred) {
    throw new Error(
      `${adapter.provider} credential not configured. Run \`appliance agent login --type ${adapter.type}\` ` +
        'to store it host-side (it is brokered into the agent and never enters the VM).'
    );
  }
  // Pick the broker header + in-guest env/placeholder from the stored kind. An
  // unsupported kind (e.g. an api-key for an OAuth-only agent) errors here.
  const authMode = resolveAuthMode(adapter, cred.kind);

  console.log(chalk.cyan(`» ensuring sandbox VM '${vm}' with the workspace mounted`));
  // Agent-only by construction; docker is opt-in (--docker → lazy re-up).
  await ensureSandboxVm(vm, projectDir, { docker: opts.docker ?? false });

  console.log(
    chalk.cyan(`» configuring the host credential broker (${cred.kind} injected at the proxy on ${authMode.header})`)
  );
  configureBroker(vm, adapter, authMode);

  const proxyUrl = resolveProxyUrl(vm);
  const sessionId = opts.sessionId ? ensureAgentSessionId(opts.sessionId) : mintAgentSessionId();
  const paths = agentResultPaths(projectDir, sessionId);

  // --wait: run the headless task to completion as a captured one-shot over
  // the vsock sentinel path (shell.rs) — stdout (the JSON result) and the
  // agent's real exit code come back in-band. Non-exec so the sentinel can
  // fire after claude; install joined with `&&` so a failed install aborts.
  if (wait) {
    const line = composeLaunchLine(adapter, authMode, proxyUrl, { mode, task: opts.task }, false);
    const script = `(${installCommandFor(adapter.install)}) && (${line})`;
    console.log(chalk.cyan(`» running ${adapter.type} headless to completion (--wait) — capturing the result`));
    const r = vmRunScript(vm, script);
    const result = classifyAutonomousResult(r.status, r.stdout, adapter);
    return { sessionId, vm, mode, result };
  }

  const tmuxSession = `appliance-${sessionId}`;
  const launchLine =
    mode === 'autonomous'
      ? composeAutonomousCaptureLine(adapter, authMode, proxyUrl, { mode, task: opts.task }, paths)
      : composeLaunchLine(adapter, authMode, proxyUrl, { mode, task: opts.task });

  // One in-guest invocation (runs as the appliance user via the vsock
  // one-shot path): install-on-first-use, then create the DETACHED tmux
  // session running the launch line directly. The install is joined with
  // `&&` (in a subshell, so its own internal `||` is contained) so a
  // failed install ABORTS instead of leaving a dead session; `has-session
  // ||` keeps the launch idempotent; tmux daemonizes, so the session
  // survives this client. The launch line is shQuote-wrapped (POSIX
  // `'\''`) so its already-per-token-quoted argv nests safely as a single
  // `tmux new-session` argument.
  const tmux = `tmux -L appliance -f /etc/appliance/tmux.conf`;
  const script =
    `(${installCommandFor(adapter.install)}) && ` +
    `(${tmux} has-session -t ${tmuxSession} 2>/dev/null || ` +
    `${tmux} new-session -d -s ${tmuxSession} ${shQuote(launchLine)})`;

  console.log(chalk.cyan(`» launching ${adapter.type} in session ${chalk.bold(sessionId)} (${mode})`));
  const r = vmRunScript(vm, script);
  if (r.status !== 0) {
    throw new Error(`failed to launch the agent session in VM '${vm}' (exit ${r.status}).\n${r.stdout}`);
  }

  console.log(`${chalk.green('✓')} agent ${chalk.bold(sessionId)} running in VM '${vm}'`);
  // Honest-limits caveat (Parker): the key is brokered, but the workspace
  // is not. The sandbox is a throwaway VM, not a security jail — surface
  // that where the user launches so the blast radius isn't a surprise.
  console.log(chalk.yellow('  ⚠ Sandbox is throwaway, not a jail — the agent can read/write your mounted workspace.'));
  const bin = path.basename(vmBinary());
  console.log(`  Attach:  appliance vm shell --name ${vm} --session ${sessionId}`);
  console.log(chalk.dim(`           (or ${bin} shell ${vm} --session ${sessionId})`));
  if (mode === 'autonomous') {
    console.log(chalk.dim('  Result:  appliance agent list   (status flips to done/error on completion)'));
  }
  return { sessionId, vm, mode, resultPath: mode === 'autonomous' ? paths.hostJson : undefined };
}
