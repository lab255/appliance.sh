import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { password, select } from '@inquirer/prompts';
import { ensureHelperBinOnPath } from '@appliance.sh/helper';

import {
  type AgentAdapter,
  type AutonomousResult,
  type RunAgentResult,
  GITHUB_FINE_GRAINED_PAT_PREFIX,
  adapterForType,
  extractOAuthToken,
  forgetAgentKey,
  hostHasClaude,
  looksLikeOpenAiKey,
  readAgentKey,
  resolveAuthMode,
  runAgent,
  runSetupTokenInteractive,
  supportedAgentTypes,
  targetVm,
  validateCopilotPat,
  wireValueForCred,
  writeAgentKey,
} from './utils/agent.js';
import { printCliError } from './utils/errors.js';
import { runVm } from './utils/sandbox.js';
import {
  type AgentStatus,
  agentIdFromSession,
  findAgent,
  projectRootFor,
  readRegistry,
  reconcileRegistry,
  updateAgentStatus,
  upsertAgent,
} from './utils/agents-registry.js';

// `appliance agent` — run a coding agent (Claude Code first) inside the
// Phase-4 microVM sandbox, with the Anthropic key brokered host-side and
// never entering the VM (docs/agent-sandbox.md).
//
// This file is the A1 runner surface + the A2 host key store / `print-key`
// helper + the A3 command group (start/list/stop/attach) backed by the A4
// registry (.appliance/agents.json, utils/agents-registry.ts) + the A6
// autonomous result capture/surfacing (start --autonomous [--wait]).

ensureHelperBinOnPath();

const program = new Command();
program.name('appliance agent').description('run a coding agent inside the microVM sandbox (Claude Code)');

program
  .command('start [project]')
  .alias('run')
  .description('launch a coding agent in a reattachable session (broker-wired) and record it in the registry')
  .option('--vm <name>', 'sandbox VM to run in (defaults to the linked/shared sandbox VM)')
  .option('--dir <path>', 'project directory to mount at /persist/workspace (defaults to [project] or cwd)')
  .option('--type <type>', 'agent adapter type', 'claude-code')
  .option('--autonomous', 'run one prompt headless to completion (claude -p) instead of an interactive TTY', false)
  .option('--task <prompt>', 'the task prompt (required for --autonomous; optional label otherwise)')
  .option(
    '--wait',
    'autonomous: block until the run completes, capturing + printing the result (default: detached)',
    false
  )
  .option('--session <id>', 'use this session id instead of minting one (normalized to the agent- prefix)')
  .option('--no-attach', 'launch + record without attaching the interactive session afterwards')
  .option(
    '--docker',
    'provision the in-guest Docker engine for this task (lazy re-up, one reboot); off by default',
    false
  )
  .action(
    async (
      project: string | undefined,
      opts: {
        vm?: string;
        dir?: string;
        type: string;
        autonomous: boolean;
        task?: string;
        wait: boolean;
        session?: string;
        attach: boolean;
        docker: boolean;
      }
    ) => {
      if (opts.autonomous && !opts.task) {
        console.error(chalk.red('--autonomous requires --task "<prompt>".'));
        process.exit(1);
      }
      if (opts.wait && !opts.autonomous) {
        console.error(chalk.yellow('--wait only applies to --autonomous; ignoring it.'));
      }
      const adapter = adapterForType(opts.type);
      if (!adapter) {
        console.error(
          chalk.red(`unsupported agent type '${opts.type}' (supported: ${supportedAgentTypes().join(', ')}).`)
        );
        process.exit(1);
      }
      // Keyless guard: warn + point to `appliance agent login --type <agent>`
      // rather than silently launching a keyless agent — the proxy fails
      // closed, so it would only hit a 502 (docs/agent-sandbox.md §3 step 5).
      // Read from the agent's OWN provider store (docs/multi-agent §4).
      if (!readAgentKey(adapter.provider)) {
        console.error(
          chalk.yellow(`No ${adapter.provider} credential configured. `) +
            `Run ${chalk.bold(`appliance agent login --type ${adapter.type}`)} to store it host-side ` +
            '(it is brokered into the agent and never enters the VM).'
        );
        process.exit(1);
      }

      const projectDir = path.resolve(project ?? opts.dir ?? process.cwd());
      // Record into the project's walk-up `.appliance/` root (beside
      // link.json) so running `start` from a subdirectory doesn't drop a
      // stray agents.json in the subdir (A3 nit).
      const root = projectRootFor(projectDir);
      const vm = opts.vm ?? targetVm();
      const mode: 'interactive' | 'autonomous' = opts.autonomous ? 'autonomous' : 'interactive';
      const wait = opts.autonomous && opts.wait;

      // runAgent (A1) ensures the VM is booted, configures the broker, and
      // either launches the detached `agent-<id>` tmux session or, for
      // autonomous --wait, runs the task to completion and returns the
      // captured result. A clean message (not a stack) on any failure.
      let run: RunAgentResult;
      try {
        run = await runAgent({
          vm,
          projectDir,
          adapter,
          mode,
          task: opts.task,
          sessionId: opts.session,
          wait,
          docker: opts.docker,
        });
      } catch (err) {
        console.error(chalk.red('agent launch failed:'));
        printCliError(err);
        process.exit(1);
      }

      const base = {
        id: agentIdFromSession(run.sessionId),
        type: adapter.type,
        task: opts.task,
        sessionId: run.sessionId,
        launchedAt: new Date().toISOString(),
        vm,
        mode,
      };

      // Autonomous --wait: the blocking run already completed — record the
      // terminal result + surface the summary, and exit non-zero on error
      // so scripts can gate on it (A6).
      if (mode === 'autonomous' && wait && run.result) {
        const r = run.result;
        upsertAgent(
          {
            ...base,
            status: r.status,
            summary: r.summary,
            exitCode: r.exitCode ?? null,
            endedAt: new Date().toISOString(),
            resultPath: run.resultPath,
          },
          root
        );
        printAutonomousSummary(base.id, r, projectDir);
        process.exit(r.status === 'done' ? 0 : 1);
      }

      // Record `running`. A detached autonomous run carries `resultPath` so
      // `appliance agent list` can finalize done/error by reading the
      // captured result off the shared workspace once the session ends.
      upsertAgent({ ...base, status: 'running', resultPath: run.resultPath }, root);

      // Autonomous detached default → leave it running; `agent list` flips
      // it to done/error on completion.
      if (mode === 'autonomous') {
        console.log(
          chalk.dim(`Run \`appliance agent list\` to watch ${chalk.bold(base.id)} flip to done/error on completion.`)
        );
        return;
      }

      // Interactive default → attach the just-launched session so the user
      // lands in the agent.
      if (opts.attach) {
        process.exit(runVm(['shell', vm, '--session', run.sessionId]));
      }
    }
  );

program
  .command('list')
  .alias('ls')
  .description('list agents from the registry, cross-checked against live tmux sessions')
  .option('--json', 'print the reconciled registry as JSON', false)
  .action((opts: { json: boolean }) => {
    const { agents, live } = reconcileRegistry();
    if (opts.json) {
      console.log(
        JSON.stringify(
          agents.map((a) => ({ ...a, live: live[a.sessionId] ?? null })),
          null,
          2
        )
      );
      return;
    }
    if (agents.length === 0) {
      console.log(chalk.dim('No agents. Launch one with `appliance agent start`.'));
      return;
    }
    const idW = Math.max(2, ...agents.map((a) => a.id.length));
    const typeW = Math.max(4, ...agents.map((a) => a.type.length));
    const statusW = Math.max(6, ...agents.map((a) => a.status.length));
    console.log(chalk.dim(`${'ID'.padEnd(idW)}  ${'TYPE'.padEnd(typeW)}  ${'STATUS'.padEnd(statusW)}  TASK / RESULT`));
    for (const a of agents) {
      const status = colorStatus(a.status.padEnd(statusW), a.status, live[a.sessionId]);
      // For a finished autonomous run, surface the captured result summary
      // in place of the prompt (A6); otherwise show the task/label.
      const terminal = a.status === 'done' || a.status === 'error';
      const label = terminal && a.summary ? a.summary : a.task;
      const cell = label ? truncate(label.replace(/\s+/g, ' ').trim(), 56) : chalk.dim('—');
      console.log(`${a.id.padEnd(idW)}  ${a.type.padEnd(typeW)}  ${status}  ${cell}`);
    }
  });

program
  .command('stop <id>')
  .description("kill the agent's tmux session and mark it exited in the registry")
  .action((id: string) => {
    const agent = findAgent(id, readRegistry());
    if (!agent) {
      console.error(chalk.red(`no agent matching '${id}' (see \`appliance agent list\`).`));
      process.exit(1);
    }
    const vm = agent.vm ?? targetVm();
    const code = runVm(['sessions', 'kill', agent.sessionId, '--name', vm]);
    updateAgentStatus(agent.id, 'exited');
    if (code !== 0) {
      console.error(
        chalk.yellow(`session kill for '${agent.sessionId}' exited ${code}; marked exited in the registry anyway.`)
      );
      process.exit(code);
    }
    console.log(`${chalk.green('✓')} stopped agent ${chalk.bold(agent.id)} (session ${agent.sessionId}).`);
  });

program
  .command('attach <id>')
  .description("reattach to the agent's tmux session")
  .action((id: string) => {
    const agent = findAgent(id, readRegistry());
    if (!agent) {
      console.error(chalk.red(`no agent matching '${id}' (see \`appliance agent list\`).`));
      process.exit(1);
    }
    const vm = agent.vm ?? targetVm();
    process.exit(runVm(['shell', vm, '--session', agent.sessionId]));
  });

program
  .command('login')
  .description(
    'store an agent credential host-side, per provider (Keychain on macOS, Credential Manager on Windows, owner-only file on Linux). ' +
      'claude-code: API key OR "Sign in with Claude" (OAuth); copilot: fine-grained GitHub PAT; ' +
      'codex: OpenAI API key. Never enters the VM.'
  )
  .option('--type <type>', 'agent adapter type', 'claude-code')
  .option('--key <value>', 'paste the secret non-interactively (argv-visible; prefer the prompt or stdin)')
  .option('--oauth', 'claude-code only: sign in with your Claude subscription via `claude setup-token`', false)
  .action(async (opts: { type: string; key?: string; oauth: boolean }) => {
    const adapter = adapterForType(opts.type);
    if (!adapter) {
      console.error(
        chalk.red(`unsupported agent type '${opts.type}' (supported: ${supportedAgentTypes().join(', ')}).`)
      );
      process.exit(1);
    }
    const stdinPiped = !process.stdin.isTTY;
    // Dispatch by the adapter's login UX. claude-code keeps its api-key/OAuth
    // picker; copilot pastes a fine-grained PAT (Sasha's guard); codex pastes
    // an OpenAI key (docs/multi-agent-adapters.md §4).
    switch (adapter.type) {
      case 'copilot':
        await copilotLogin(adapter, opts.key, stdinPiped);
        return;
      case 'codex':
        await codexLogin(adapter, opts.key, stdinPiped);
        return;
      default:
        await claudeLogin(adapter, opts, stdinPiped);
        return;
    }
  });

program
  .command('logout')
  .description("forget a provider's stored host-side credential (--type selects the agent)")
  .option('--type <type>', 'agent adapter type', 'claude-code')
  .action((opts: { type: string }) => {
    const adapter = adapterForType(opts.type);
    if (!adapter) {
      console.error(
        chalk.red(`unsupported agent type '${opts.type}' (supported: ${supportedAgentTypes().join(', ')}).`)
      );
      process.exit(1);
    }
    forgetAgentKey(adapter.provider);
    console.log(`${chalk.green('✓')} forgot the stored ${adapter.provider} credential.`);
  });

program
  .command('print-key')
  .description('HOST helper: print the resolved credential to stdout for the egress proxy (do not call directly)')
  .option('--type <type>', 'agent adapter type', 'claude-code')
  .action((opts: { type: string }) => {
    const adapter = adapterForType(opts.type);
    if (!adapter) {
      // Unknown type → no stdout, exit non-zero so the proxy fails CLOSED.
      process.exit(1);
    }
    const cred = readAgentKey(adapter.provider);
    if (!cred) {
      // Exit non-zero with NO stdout so the proxy helper resolves to
      // nothing and fails CLOSED (it never forwards the placeholder). This
      // also fires on an unparseable/truncated envelope (readAgentKey →
      // null), so a corrupt store fails closed rather than leaking bytes.
      process.exit(1);
    }
    // The wire-ready header value: `<scheme> <secret>` from the resolved mode
    // (claude api-key → bare; claude oauth/codex → `Bearer …`; copilot →
    // `token …`). An unsupported stored kind throws → non-zero exit → fails
    // CLOSED. Nothing else on stdout; the proxy trims it. NEVER logged.
    let scheme;
    try {
      scheme = resolveAuthMode(adapter, cred.kind).scheme;
    } catch {
      process.exit(1);
    }
    process.stdout.write(wireValueForCred(cred, scheme));
  });

/** Colorize a (pre-padded) status cell by status + reconciled liveness:
 *  green = running + live, cyan = running but the VM was unreachable
 *  (liveness unknown), yellow = running yet the session is gone (a
 *  pre-reconcile race), red = error, dim = exited/done. */
function colorStatus(text: string, status: AgentStatus, live: boolean | null | undefined): string {
  if (status === 'running') {
    if (live === false) return chalk.yellow(text);
    if (live == null) return chalk.cyan(text);
    return chalk.green(text);
  }
  if (status === 'error') return chalk.red(text);
  if (status === 'exited' || status === 'done') return chalk.dim(text);
  return text;
}

/** Truncate a label with an ellipsis for single-line table display. */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Surface a completed autonomous run (A6): a done/error headline, the
 *  captured result text, and a pointer to review the changes the agent made
 *  to the shared workspace. */
function printAutonomousSummary(id: string, result: AutonomousResult, workspaceDir: string): void {
  if (result.status === 'done') {
    console.log(`${chalk.green('✓')} agent ${chalk.bold(id)} ${chalk.green('done')}`);
  } else {
    const code = result.exitCode != null ? chalk.dim(` (exit ${result.exitCode})`) : '';
    console.log(`${chalk.red('✗')} agent ${chalk.bold(id)} ${chalk.red('error')}${code}`);
  }
  if (result.summary) {
    console.log();
    console.log(result.summary);
  }
  console.log();
  console.log(chalk.dim(`Review the changes in ${workspaceDir}  (e.g. \`git -C ${workspaceDir} diff\`).`));
}

/**
 * claude-code login (unchanged UX): an API-key/"Sign in with Claude" picker.
 * Stored under the `anthropic` provider. An explicit flag wins; a piped/`--key`
 * invocation is api-key; an interactive TTY gets the picker.
 */
async function claudeLogin(
  adapter: AgentAdapter,
  opts: { key?: string; oauth: boolean },
  stdinPiped: boolean
): Promise<void> {
  let useOauth = opts.oauth;
  if (!useOauth && !opts.key && !stdinPiped) {
    useOauth =
      (await select({
        message: 'How should the agent authenticate to Anthropic?',
        choices: [
          { name: 'API key (paste an Anthropic API key)', value: 'api-key' },
          { name: 'Sign in with Claude (subscription OAuth via `claude setup-token`)', value: 'oauth' },
        ],
      })) === 'oauth';
  }

  if (useOauth) {
    // `--key` is an API-key-mode flag; in OAuth mode the token comes from
    // `claude setup-token`, so a stray `--key` is silently dropped. Say so.
    if (opts.key) {
      console.error(chalk.yellow('--key is ignored in OAuth mode (the token comes from `claude setup-token`).'));
    }
    await oauthLogin(adapter);
    return;
  }

  // API-key path.
  let key = opts.key;
  if (!key) {
    // Read from a pipe when stdin isn't a TTY (`… | appliance agent login`),
    // else prompt with a hidden input — neither puts the key on argv.
    key = stdinPiped ? await readStdin() : await password({ message: 'Paste your Anthropic API key:', mask: '*' });
  }
  key = (key ?? '').trim();
  if (!key) {
    console.error(chalk.red('no key provided.'));
    process.exit(1);
  }
  writeAgentKey(adapter.provider, key, 'api-key');
  // NEVER echo the key.
  console.log(
    `${chalk.green('✓')} Anthropic key stored host-side. It is brokered into agents and never enters the VM.`
  );
  console.log(chalk.dim('  Re-run `appliance agent run` to apply this to an existing session.'));
}

/**
 * copilot login — paste a fine-grained GitHub PAT (Sasha's HARD pre-ship
 * guard, docs/multi-agent-adapters.md §4/§7). The login layer REJECTS classic
 * `ghp_` PATs and accepts ONLY `github_pat_` fine-grained tokens, and
 * prominently instructs the user to grant ONLY the `Copilot Requests`
 * permission — that narrow scope is the entire security bound on host-keyed
 * injection. Stored under the `github-copilot` provider, tagged `pat`. Same
 * hidden-prompt / stdin handling as the api-key path (never on argv).
 */
async function copilotLogin(
  adapter: AgentAdapter,
  providedKey: string | undefined,
  stdinPiped: boolean
): Promise<void> {
  // Prominent scope instruction — shown BEFORE the prompt so the user mints the
  // right token. The fine-grained PAT's `Copilot Requests`-only scope is the
  // security bound: the broker injects this PAT on ALL guest→api.github.com
  // traffic (host-keyed, not path-keyed), so a broader scope would let a
  // jailbroken guest act beyond Copilot requests (§7).
  console.log(chalk.cyan('» GitHub Copilot login — paste a fine-grained GitHub PAT.'));
  console.log(
    chalk.yellow.bold('  Grant ONLY the "Copilot Requests" permission on the token.') +
      chalk.dim(
        '\n  Create it at GitHub → Settings → Developer settings → Fine-grained tokens.\n' +
          '  That single scope is the security bound on host-keyed injection: the PAT is\n' +
          "  brokered onto the official copilot CLI's api.github.com leg and never enters\n" +
          '  the VM, but it is injected on ALL guest→api.github.com traffic — a broader\n' +
          '  scope would let the sandbox act beyond Copilot requests (docs/multi-agent §7).\n' +
          '  Classic ghp_ tokens are REJECTED — they carry your full account scope.'
      )
  );

  let raw = providedKey;
  if (!raw) {
    raw = stdinPiped
      ? await readStdin()
      : await password({ message: 'Paste your fine-grained GitHub PAT (github_pat_…):', mask: '*' });
  }
  const v = validateCopilotPat(raw ?? '');
  if (!v.ok) {
    if (v.reason === 'classic') {
      console.error(
        chalk.red('Classic ghp_ PAT rejected. ') +
          `Copilot requires a fine-grained token (${chalk.bold(GITHUB_FINE_GRAINED_PAT_PREFIX)}…) scoped to ` +
          chalk.bold('Copilot Requests') +
          ' only. A classic PAT carries your full account scope, which a host-keyed inject must not.'
      );
    } else if (v.reason === 'empty') {
      console.error(chalk.red('no token provided.'));
    } else {
      console.error(
        chalk.red(`expected a fine-grained GitHub PAT starting with ${chalk.bold(GITHUB_FINE_GRAINED_PAT_PREFIX)}. `) +
          'Mint one scoped to `Copilot Requests` and paste it.'
      );
    }
    process.exit(1);
  }
  writeAgentKey(adapter.provider, v.value, 'pat');
  // NEVER echo the PAT.
  console.log(
    `${chalk.green('✓')} GitHub PAT stored host-side. It is brokered onto Copilot's api.github.com leg and never enters the VM.`
  );
  console.log(chalk.dim('  Re-run `appliance agent run --type copilot` to apply this to an existing session.'));
}

/**
 * codex login — paste an OpenAI API key (docs/multi-agent-adapters.md §4).
 * Soft `sk-` shape warning (no hard guard, mirroring Claude's api-key path).
 * Stored under the `openai` provider, tagged `api-key`. ChatGPT-subscription
 * login is DEFERRED (it writes a durable refresh_token into the guest — §7).
 */
async function codexLogin(adapter: AgentAdapter, providedKey: string | undefined, stdinPiped: boolean): Promise<void> {
  let raw = providedKey;
  if (!raw) {
    raw = stdinPiped ? await readStdin() : await password({ message: 'Paste your OpenAI API key (sk-…):', mask: '*' });
  }
  const key = (raw ?? '').trim();
  if (!key) {
    console.error(chalk.red('no key provided.'));
    process.exit(1);
  }
  if (!looksLikeOpenAiKey(key)) {
    // Soft warning only — store anyway (no local format pre-validation).
    console.error(chalk.yellow('warning: that does not look like an `sk-` OpenAI key; storing it anyway.'));
  }
  writeAgentKey(adapter.provider, key, 'api-key');
  // NEVER echo the key.
  console.log(
    `${chalk.green('✓')} OpenAI key stored host-side. It is brokered onto Codex's api.openai.com calls and never enters the VM.`
  );
  console.log(chalk.dim('  Re-run `appliance agent run --type codex` to apply this to an existing session.'));
}

/**
 * "Sign in with Claude" — the host-side subscription OAuth login (L1).
 *
 * Runs `claude setup-token` on the HOST with the TTY inherited (browser opens,
 * the sign-in URL + the minted one-year token are shown inline), then captures
 * the token via a HIDDEN paste prompt and stores it tagged `oauth`.
 *
 * Why a paste prompt and not a stdout grep: `claude setup-token` is an Ink TUI
 * that REVEALS the token on-screen only — it prints no clean stdout line and
 * (verified, docs/agent-login.md §7) persists no copy of its own. So the robust
 * capture inherits the TTY for the native flow, then reads the token back
 * in-process. Per Sasha §7.1 the token is NEVER echoed, NEVER logged, and NEVER
 * written to a temp file — it goes straight from the paste prompt to the
 * Keychain.
 */
async function oauthLogin(adapter: AgentAdapter): Promise<void> {
  // Host `claude` is a hard precondition for `setup-token`; detect + guide
  // rather than crash (docs §2, §7).
  if (!hostHasClaude()) {
    console.error(
      chalk.red('Claude Code is not installed on this host. ') +
        'Install it to sign in with your subscription ' +
        `(${chalk.bold('npm install -g @anthropic-ai/claude-code')}), ` +
        `or use an API key: ${chalk.bold('appliance agent login --key <key>')}.`
    );
    process.exit(1);
  }

  console.log(chalk.cyan('» Signing in with Claude (subscription OAuth).'));
  console.log(
    chalk.dim(
      '  This runs `claude setup-token` on this host; a browser opens for sign-in.\n' +
        "  The one-year token is brokered onto Claude Code's own api.anthropic.com\n" +
        '  calls and never enters the VM. Use only in a single-purpose Claude sandbox\n' +
        '  (the broker injects on ALL guest→api.anthropic.com traffic — see docs/agent-login.md §4).'
    )
  );

  const code = runSetupTokenInteractive();
  if (code !== 0) {
    console.error(chalk.red(`\`claude setup-token\` exited ${code}; not signed in.`));
    process.exit(1);
  }

  // Capture the token shown above via a hidden paste — accepts the bare token
  // or the whole `export CLAUDE_CODE_OAUTH_TOKEN=…` line (extractOAuthToken
  // pulls the sk-ant-oat01- token out). NEVER echoed.
  const pasted = await password({ message: 'Paste the token shown above (sk-ant-oat01-…):', mask: '*' });
  const token = extractOAuthToken(pasted ?? '');
  if (!token) {
    console.error(
      chalk.red('could not find an sk-ant-oat01- token in what you pasted. ') +
        'Re-run `appliance agent login --oauth` and paste the token shown by setup-token.'
    );
    process.exit(1);
  }
  writeAgentKey(adapter.provider, token, 'oauth');
  // NEVER echo the token.
  console.log(
    `${chalk.green('✓')} Signed in with Claude. The subscription token is stored host-side and never enters the VM.`
  );
  // Switching modes only rewrites the broker cred-rule on the next `agent
  // run`; an already-launched session keeps the old rule until then.
  console.log(chalk.dim('  Re-run `appliance agent run` to apply this to an existing session.'));
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

program.parse(process.argv);
