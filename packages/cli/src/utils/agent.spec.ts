import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const runVmMock = vi.hoisted(() => vi.fn<(_args: string[]) => number>());
const homeState = vi.hoisted(() => ({ home: undefined as string | undefined }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homeState.home ?? actual.homedir() };
});
vi.mock('./sandbox.js', async () => {
  const actual = await vi.importActual<typeof import('./sandbox.js')>('./sandbox.js');
  return { ...actual, runVm: runVmMock };
});

import {
  ANTHROPIC_HOST,
  ANTHROPIC_OAUTH_PLACEHOLDER,
  ANTHROPIC_PLACEHOLDER_KEY,
  type AuthMode,
  COPILOT_PLACEHOLDER_PAT,
  OPENAI_PLACEHOLDER_KEY,
  adapterForType,
  agentResultPaths,
  assertAgentBrokerBackendSupported,
  classifyAutonomousResult,
  claudeCodeAdapter,
  codexAdapter,
  composeAutonomousCaptureLine,
  composeLaunchLine,
  configureBroker,
  copilotAdapter,
  extractOAuthToken,
  hostClaudeCommand,
  installCommandFor,
  looksLikeOpenAiKey,
  parseStoredCred,
  printKeyHelperCommand,
  readAutonomousResultFromFiles,
  resolveAuthMode,
  supportedAgentTypes,
  tailLines,
  validateCopilotPat,
  wireValueForCred,
  writeAgentKey,
} from './agent.js';
import { restrictWindowsAcl } from './fs-acl.js';

const PROXY = 'http://192.168.64.1:5053';

/** The api-key + oauth modes Claude Code declares, looked up by kind. */
const apiKeyMode: AuthMode = resolveAuthMode(claudeCodeAdapter, 'api-key');
const oauthMode: AuthMode = resolveAuthMode(claudeCodeAdapter, 'oauth');

afterEach(() => {
  homeState.home = undefined;
});

describe('claudeCodeAdapter', () => {
  it('injects on the single Anthropic apiHost and declares BOTH auth modes', () => {
    expect(claudeCodeAdapter.apiHost).toBe(ANTHROPIC_HOST);
    // api-key mode: x-api-key header, ANTHROPIC_API_KEY placeholder, no scheme.
    expect(apiKeyMode).toEqual({
      kind: 'api-key',
      header: 'x-api-key',
      env: 'ANTHROPIC_API_KEY',
      login: 'api-key',
      placeholder: ANTHROPIC_PLACEHOLDER_KEY,
    });
    // oauth mode: authorization + Bearer scheme, CLAUDE_CODE_OAUTH_TOKEN
    // placeholder, host login command.
    expect(oauthMode).toEqual({
      kind: 'oauth',
      header: 'authorization',
      scheme: 'Bearer',
      env: 'CLAUDE_CODE_OAUTH_TOKEN',
      login: 'setup-token',
      loginCmd: 'claude setup-token',
      placeholder: ANTHROPIC_OAUTH_PLACEHOLDER,
    });
    // claude-code stays json-capture with the anthropic provider store.
    expect(claudeCodeAdapter.provider).toBe('anthropic');
    expect(claudeCodeAdapter.captureMode).toBe('json');
    // The oauth placeholder is oauth-shaped and the api-key placeholder is not.
    expect(ANTHROPIC_OAUTH_PLACEHOLDER.startsWith('sk-ant-oat01-')).toBe(true);
    expect(ANTHROPIC_PLACEHOLDER_KEY.startsWith('sk-ant-oat01-')).toBe(false);
  });

  it('launches a bare TTY interactively and `claude -p … json` autonomously', () => {
    expect(claudeCodeAdapter.launchArgv({ mode: 'interactive' })).toEqual(['claude']);
    // Interactive WITH a task seeds the TTY with the prompt as the positional
    // arg (`claude "<task>"`) — guard against regressing to a bare ['claude'].
    expect(claudeCodeAdapter.launchArgv({ mode: 'interactive', task: 'fix it' })).toEqual(['claude', 'fix it']);
    expect(claudeCodeAdapter.launchArgv({ mode: 'autonomous', task: 'fix it' })).toEqual([
      'claude',
      '-p',
      'fix it',
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
    ]);
  });

  it('parses the autonomous JSON result line', () => {
    const ok = claudeCodeAdapter.parseResult?.('{"is_error":false,"result":"done"}');
    expect(ok).toEqual({ ok: true, summary: 'done' });
    const err = claudeCodeAdapter.parseResult?.('{"is_error":true,"result":"Invalid API key"}');
    expect(err).toEqual({ ok: false, summary: 'Invalid API key' });
  });
});

describe('composeLaunchLine', () => {
  const line = composeLaunchLine(claudeCodeAdapter, apiKeyMode, PROXY, { mode: 'interactive' });

  it('cds to the workspace and execs claude under the proxy + placeholder env', () => {
    expect(line.startsWith('cd /persist/workspace; exec env ')).toBe(true);
    // The agent argv is shell-quoted per token (interactive is just
    // `claude`) so it nests safely inside runAgent's tmux wrapper.
    expect(line.endsWith(" 'claude'")).toBe(true);
    expect(line).toContain(`HTTPS_PROXY=${PROXY}`);
    expect(line).toContain(`https_proxy=${PROXY}`);
    expect(line).toContain('CLAUDE_CODE_CERT_STORE=bundled,system');
    expect(line).toContain(`ANTHROPIC_API_KEY=${ANTHROPIC_PLACEHOLDER_KEY}`);
  });

  it('in OAuth mode sets ONLY CLAUDE_CODE_OAUTH_TOKEN, never ANTHROPIC_API_KEY', () => {
    // Claude Code precedence: ANTHROPIC_API_KEY outranks CLAUDE_CODE_OAUTH_TOKEN,
    // so the OAuth-mode launch must NOT set the api-key env or the CLI would
    // emit x-api-key instead of the Bearer the broker rewrites (docs §1).
    const oauth = composeLaunchLine(claudeCodeAdapter, oauthMode, PROXY, { mode: 'interactive' });
    expect(oauth).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${ANTHROPIC_OAUTH_PLACEHOLDER}`);
    expect(oauth).not.toContain('ANTHROPIC_API_KEY=');
    // Same proxy/CA wiring regardless of mode.
    expect(oauth).toContain(`HTTPS_PROXY=${PROXY}`);
    expect(oauth).toContain('CLAUDE_CODE_CERT_STORE=bundled,system');
  });

  it('bypasses the proxy only for loopback + cluster-internal hosts', () => {
    expect(line).toContain('NO_PROXY=localhost,127.0.0.1,::1');
    // api.anthropic.com must NOT be in NO_PROXY — it must traverse the broker.
    expect(line).not.toContain(ANTHROPIC_HOST);
  });

  it('shell-quotes a multi-word + embedded-single-quote autonomous task', () => {
    // Regression: the old code spliced the task unquoted, so a multi-word
    // prompt mis-parsed (`claude -p fix the test` → only `fix`) and a `'`
    // broke out of the tmux wrapper into arbitrary in-guest exec.
    const task = "fix the test; it's broken";
    const auto = composeLaunchLine(claudeCodeAdapter, apiKeyMode, PROXY, { mode: 'autonomous', task });
    // The whole prompt is ONE quoted `-p` argument — not split on spaces,
    // not terminated early by the `;`.
    expect(auto).toContain("'-p' 'fix the test; it'\\''s broken'");
    // The embedded single quote is rendered via the POSIX '\'' trick, so
    // it cannot break out of the wrapper.
    expect(auto).toContain("'\\''");
    // The autonomous flags are present and quoted.
    expect(auto).toContain("'--output-format' 'json'");
    expect(auto).toContain("'--dangerously-skip-permissions'");
  });
});

describe('adapterForType', () => {
  it('resolves claude-code / copilot / codex and rejects unknown types', () => {
    expect(adapterForType('claude-code')).toBe(claudeCodeAdapter);
    expect(adapterForType('copilot')).toBe(copilotAdapter);
    expect(adapterForType('codex')).toBe(codexAdapter);
    expect(adapterForType('aider')).toBeNull();
    expect(supportedAgentTypes()).toEqual(['claude-code', 'copilot', 'codex']);
  });
});

describe('autonomous result capture (A6)', () => {
  it('agentResultPaths puts host + guest results under .appliance/agent-results', () => {
    const p = agentResultPaths('/work/proj', 'agent-7f3c');
    // The impl resolves projectDir first (on Windows that adds the
    // drive letter), so mirror that here rather than assuming POSIX.
    const root = path.resolve('/work/proj');
    expect(p.hostJson).toBe(path.join(root, '.appliance', 'agent-results', 'agent-7f3c.json'));
    expect(p.hostRc).toBe(path.join(root, '.appliance', 'agent-results', 'agent-7f3c.rc'));
    expect(p.guestJson).toBe('/persist/workspace/.appliance/agent-results/agent-7f3c.json');
    expect(p.guestRc).toBe('/persist/workspace/.appliance/agent-results/agent-7f3c.rc');
    expect(p.guestDir).toBe('/persist/workspace/.appliance/agent-results');
  });

  it('composeAutonomousCaptureLine redirects the JSON result + records the exit code (no exec)', () => {
    const paths = agentResultPaths('/work/proj', 'agent-7f3c');
    const line = composeAutonomousCaptureLine(
      claudeCodeAdapter,
      apiKeyMode,
      PROXY,
      { mode: 'autonomous', task: 'fix it' },
      paths
    );
    // Non-exec: the shell must outlive claude to write the rc file.
    expect(line).not.toContain('exec ');
    expect(line.startsWith('cd /persist/workspace; mkdir -p ')).toBe(true);
    // The headless argv is quoted, stdout is redirected to the result file,
    // and `$?` is recorded to the sibling rc file.
    expect(line).toContain("'claude' '-p' 'fix it' '--output-format' 'json' '--dangerously-skip-permissions'");
    expect(line).toContain(`> '${paths.guestJson}'`);
    expect(line).toContain(`echo $? > '${paths.guestRc}'`);
    // Still wired through the broker env.
    expect(line).toContain(`HTTPS_PROXY=${PROXY}`);
    expect(line).toContain(`ANTHROPIC_API_KEY=${ANTHROPIC_PLACEHOLDER_KEY}`);
  });

  it('composeLaunchLine(exec=false) drops the exec so the sentinel can fire after the agent', () => {
    const line = composeLaunchLine(claudeCodeAdapter, apiKeyMode, PROXY, { mode: 'autonomous', task: 'go' }, false);
    expect(line.startsWith('cd /persist/workspace; env ')).toBe(true);
    expect(line).not.toContain('exec env');
    expect(line).toContain("'claude' '-p' 'go'");
  });

  it('classifyAutonomousResult: done only on exit 0 + a non-error parse', () => {
    const done = classifyAutonomousResult(0, '{"is_error":false,"result":"all green"}', claudeCodeAdapter);
    expect(done).toEqual({ status: 'done', exitCode: 0, summary: 'all green' });

    // is_error result → error even on a zero exit.
    const flagged = classifyAutonomousResult(0, '{"is_error":true,"result":"Invalid API key"}', claudeCodeAdapter);
    expect(flagged).toEqual({ status: 'error', exitCode: 0, summary: 'Invalid API key' });

    // Non-zero exit → error, with a synthesized summary when nothing parsed.
    const crashed = classifyAutonomousResult(1, 'boom, not json', claudeCodeAdapter);
    expect(crashed.status).toBe('error');
    expect(crashed.exitCode).toBe(1);
    expect(crashed.summary).toContain('exit 1');

    // Missing exit code (rc file absent) → error.
    expect(classifyAutonomousResult(null, '', claudeCodeAdapter).status).toBe('error');
  });
});

describe('readAutonomousResultFromFiles (A6)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-result-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the captured JSON + rc and classifies done', () => {
    const json = path.join(dir, 'r.json');
    const rc = path.join(dir, 'r.rc');
    fs.writeFileSync(json, '{"is_error":false,"result":"shipped"}\n');
    fs.writeFileSync(rc, '0\n');
    expect(readAutonomousResultFromFiles(json, rc, claudeCodeAdapter)).toEqual({
      status: 'done',
      exitCode: 0,
      summary: 'shipped',
    });
  });

  it('classifies error from a non-zero rc even with a parseable result', () => {
    const json = path.join(dir, 'r.json');
    const rc = path.join(dir, 'r.rc');
    fs.writeFileSync(json, '{"is_error":false,"result":"partial"}');
    fs.writeFileSync(rc, '7');
    const res = readAutonomousResultFromFiles(json, rc, claudeCodeAdapter);
    expect(res?.status).toBe('error');
    expect(res?.exitCode).toBe(7);
  });

  it('returns null when the result file is absent (run produced nothing)', () => {
    expect(
      readAutonomousResultFromFiles(path.join(dir, 'missing.json'), path.join(dir, 'missing.rc'), claudeCodeAdapter)
    ).toBeNull();
  });
});

describe('printKeyHelperCommand', () => {
  it('pins absolute executable/entry paths and returns literal argv on every platform', () => {
    const argv = printKeyHelperCommand('claude-code');
    // The pinned helper carries the agent type so it reads that provider's store.
    expect(argv.slice(-3)).toEqual(['print-key', '--type', 'claude-code']);
    expect(argv[0]).toBe(process.execPath);
    expect(path.isAbsolute(argv[0])).toBe(true);
    // The node/interpreter path targets the runnable agent entry directly.
    expect(path.basename(argv[1])).toBe('appliance-agent.js');
    expect(path.isAbsolute(argv[1])).toBe(true);
    // No token has POSIX wrapper quotes: each is already one argv element.
    expect(argv.every((token) => !(token.startsWith("'") && token.endsWith("'")))).toBe(true);
    // The type rides through per agent.
    expect(printKeyHelperCommand('copilot').slice(-2)).toEqual(['--type', 'copilot']);
    expect(printKeyHelperCommand('codex').slice(-2)).toEqual(['--type', 'codex']);
  });

  it('ignores a dispatcher-clobbered process.argv[1]', () => {
    // appliance.ts rewrites process.argv[1] to the literal 'appliance-agent'
    // before importing the agent module. The helper must resolve a stable
    // module-relative entry, NOT a bogus cwd-relative path from argv[1]
    // (which would exit non-zero → every brokered request 502s under node).
    const saved = process.argv;
    try {
      process.argv = [process.execPath, 'appliance-agent', 'print-key'];
      const argv = printKeyHelperCommand('claude-code');
      // Not the bogus cwd-resolved literal.
      expect(argv).not.toContain(path.resolve('appliance-agent'));
      // The stable, runnable entry instead.
      expect(path.basename(argv[1])).toBe('appliance-agent.js');
      expect(argv.slice(-3)).toEqual(['print-key', '--type', 'claude-code']);
    } finally {
      process.argv = saved;
    }
  });

  it('round-trips the argv array through configureBroker JSON without shell quoting', () => {
    runVmMock.mockReset().mockReturnValue(0);
    configureBroker('ap-194-test', claudeCodeAdapter, apiKeyMode, 'vz');

    expect(runVmMock).toHaveBeenCalledTimes(2);
    const credsArgs = runVmMock.mock.calls[0][0];
    const helperIndex = credsArgs.indexOf('--helper');
    expect(helperIndex).toBeGreaterThan(0);
    const persisted = JSON.parse(credsArgs[helperIndex + 1]) as string[];
    expect(persisted).toEqual(printKeyHelperCommand('claude-code'));
    expect(persisted.slice(-3)).toEqual(['print-key', '--type', 'claude-code']);
    expect(credsArgs[helperIndex + 1].startsWith('[')).toBe(true);
  });
});

describe('resolveAuthMode (per stored kind)', () => {
  it('disables brokered credential injection on WSL v1 before writing a rule', () => {
    expect(() => assertAgentBrokerBackendSupported('wsl')).toThrow(
      'use an in-guest API key; brokered injection returns in WSL v2'
    );
    expect(() => assertAgentBrokerBackendSupported('vz')).not.toThrow();
    runVmMock.mockReset();
    expect(() => configureBroker('wsl-test', claudeCodeAdapter, apiKeyMode, 'wsl')).toThrow(
      'exact-lease re-attribution cannot survive SNAT'
    );
    expect(runVmMock).not.toHaveBeenCalled();
  });

  it('refuses broker rule writes when Windows cannot resolve the VM backend', () => {
    expect(() => assertAgentBrokerBackendSupported(undefined, 'win32')).toThrow(
      'VM backend could not be resolved on Windows; use an in-guest API key; brokered injection returns in WSL v2'
    );
    expect(() => assertAgentBrokerBackendSupported(undefined, 'darwin')).not.toThrow();
    runVmMock.mockReset();
    expect(() => configureBroker('unknown-backend', claudeCodeAdapter, apiKeyMode, undefined, 'win32')).toThrow(
      'VM backend could not be resolved on Windows'
    );
    expect(runVmMock).not.toHaveBeenCalled();
  });

  it('selects the api-key mode for an api-key credential', () => {
    const m = resolveAuthMode(claudeCodeAdapter, 'api-key');
    expect(m.header).toBe('x-api-key');
    expect(m.env).toBe('ANTHROPIC_API_KEY');
    expect(m.scheme).toBeUndefined();
  });

  it('selects the oauth mode (authorization + Bearer) for an oauth credential', () => {
    const m = resolveAuthMode(claudeCodeAdapter, 'oauth');
    expect(m.header).toBe('authorization');
    expect(m.env).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(m.scheme).toBe('Bearer');
  });

  it('throws actionably when the agent does not declare the stored kind', () => {
    const apiKeyOnly = { ...claudeCodeAdapter, authModes: [resolveAuthMode(claudeCodeAdapter, 'api-key')] };
    expect(() => resolveAuthMode(apiKeyOnly, 'oauth')).toThrow(/not supported by agent/);
    expect(() => resolveAuthMode(apiKeyOnly, 'oauth')).toThrow(/appliance agent login/);
  });
});

describe('parseStoredCred (envelope back-compat + fail-closed)', () => {
  it('reads a JSON envelope as its tagged kind + value', () => {
    expect(parseStoredCred('{"kind":"oauth","value":"sk-ant-oat01-abc"}')).toEqual({
      kind: 'oauth',
      value: 'sk-ant-oat01-abc',
    });
    expect(parseStoredCred('{"kind":"api-key","value":"sk-ant-api03-xyz"}')).toEqual({
      kind: 'api-key',
      value: 'sk-ant-api03-xyz',
    });
  });

  it('reads a legacy BARE (non-JSON) string as an api-key (back-compat)', () => {
    expect(parseStoredCred('sk-ant-api03-legacy')).toEqual({ kind: 'api-key', value: 'sk-ant-api03-legacy' });
    // Surrounding whitespace is trimmed.
    expect(parseStoredCred('  sk-ant-api03-legacy\n')).toEqual({ kind: 'api-key', value: 'sk-ant-api03-legacy' });
  });

  it('fails CLOSED (null) on an unparseable / truncated / unknown-kind envelope', () => {
    // A truncated envelope (looks like JSON, won't parse) → null, NOT treated
    // as a bare api-key of the raw bytes (Sasha nit).
    expect(parseStoredCred('{"kind":"oauth","value":"sk-ant-oat01-abc')).toBeNull();
    // Valid JSON but unknown kind → null.
    expect(parseStoredCred('{"kind":"totp","value":"x"}')).toBeNull();
    // Valid JSON, known kind, but empty value → null.
    expect(parseStoredCred('{"kind":"api-key","value":""}')).toBeNull();
    // Empty / whitespace-only → null.
    expect(parseStoredCred('   ')).toBeNull();
  });
});

describe('agent credential file permissions', () => {
  it('restricts writeAgentKey output to the current user and leaves POSIX chmod semantics unchanged', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-agent-key-acl-'));
    try {
      if (process.platform === 'darwin') {
        // writeAgentKey uses Keychain on macOS. Exercise the shared helper's
        // POSIX no-op directly so this cross-platform test is never skipped.
        const file = path.join(home, 'mode-check');
        fs.writeFileSync(file, 'not-a-secret', { mode: 0o640 });
        restrictWindowsAcl(file);
        expect(fs.statSync(file).mode & 0o777).toBe(0o640);
        return;
      }

      homeState.home = home;
      writeAgentKey('acl-test', 'test-secret', 'api-key');
      const file = path.join(home, '.appliance', 'agent', 'acl-test-cred');
      expect(fs.existsSync(file)).toBe(true);

      if (process.platform === 'win32') {
        execFileSync('icacls', [file, '/grant', '*S-1-1-0:(W)'], { windowsHide: true });
        restrictWindowsAcl(file);
        const listing = execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
        const principal = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
        const filePrefix = file.toLocaleLowerCase();
        const actual = new Set(
          listing.split(/\r?\n/).flatMap((line) => {
            const marker = line.lastIndexOf(':(');
            if (marker < 0) return [];
            let aclPrincipal = line.slice(0, marker).trimStart();
            if (aclPrincipal.toLocaleLowerCase().startsWith(filePrefix)) {
              aclPrincipal = aclPrincipal.slice(file.length).trim();
            }
            return aclPrincipal ? [aclPrincipal.toLocaleLowerCase()] : [];
          })
        );
        expect(actual, listing).toEqual(
          new Set([principal.toLocaleLowerCase(), 'nt authority\\system', 'builtin\\administrators'])
        );
      } else {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('wireValueForCred (print-key wire value per scheme)', () => {
  it('emits the bare secret with no scheme, and `<scheme> <secret>` with one', () => {
    // No scheme (claude api-key) → bare.
    expect(wireValueForCred({ kind: 'api-key', value: 'sk-ant-api03-xyz' })).toBe('sk-ant-api03-xyz');
    // Bearer (claude oauth, codex api-key) → `Bearer <secret>`.
    expect(wireValueForCred({ kind: 'oauth', value: 'sk-ant-oat01-abc' }, 'Bearer')).toBe('Bearer sk-ant-oat01-abc');
    expect(wireValueForCred({ kind: 'api-key', value: 'sk-openai-xyz' }, 'Bearer')).toBe('Bearer sk-openai-xyz');
    // token (copilot pat) → `token <secret>`.
    expect(wireValueForCred({ kind: 'pat', value: 'github_pat_abc' }, 'token')).toBe('token github_pat_abc');
  });

  it('drives the wire value off the RESOLVED mode scheme per agent (not the kind)', () => {
    // The print-key flow resolves the scheme from the adapter+mode, so the same
    // api-key kind yields bare for claude but Bearer for codex.
    const claudeApiKey = resolveAuthMode(claudeCodeAdapter, 'api-key');
    const codexApiKey = resolveAuthMode(codexAdapter, 'api-key');
    const copilotPat = resolveAuthMode(copilotAdapter, 'pat');
    expect(wireValueForCred({ kind: 'api-key', value: 'k' }, claudeApiKey.scheme)).toBe('k');
    expect(wireValueForCred({ kind: 'api-key', value: 'k' }, codexApiKey.scheme)).toBe('Bearer k');
    expect(wireValueForCred({ kind: 'pat', value: 'p' }, copilotPat.scheme)).toBe('token p');
  });
});

describe('extractOAuthToken', () => {
  it('pulls a bare sk-ant-oat01- token out', () => {
    expect(extractOAuthToken('sk-ant-oat01-AbC_123-xyz')).toBe('sk-ant-oat01-AbC_123-xyz');
  });

  it('pulls the token out of the `export CLAUDE_CODE_OAUTH_TOKEN=…` line', () => {
    expect(extractOAuthToken('export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-AbC_123-xyz')).toBe(
      'sk-ant-oat01-AbC_123-xyz'
    );
  });

  it('tolerates surrounding whitespace and ANSI colour codes (TUI paste)', () => {
    expect(extractOAuthToken('  \n sk-ant-oat01-AbC_123 \n')).toBe('sk-ant-oat01-AbC_123');
    expect(extractOAuthToken('[38;2;215;119;87msk-ant-oat01-AbC_123[39m')).toBe('sk-ant-oat01-AbC_123');
  });

  it('strips a real ESC-prefixed CSI sequence wedged mid-token (no truncation)', () => {
    // A raw ESC (\x1b) mid-token must be stripped WITH its CSI body. Stripping
    // only the `[…m` body and leaving the ESC byte behind would truncate the
    // capture at the ESC (it is not in the sk-ant-oat01- char class), yielding
    // a short, invalid token — this guards the ESC introducer staying in the
    // strip pattern.
    expect(extractOAuthToken('sk-ant-oat01-AbC\x1b[0m_123')).toBe('sk-ant-oat01-AbC_123');
    expect(extractOAuthToken('export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-AbC\x1b[39m_123')).toBe(
      'sk-ant-oat01-AbC_123'
    );
  });

  it('returns null when no oauth token is present', () => {
    expect(extractOAuthToken('')).toBeNull();
    expect(extractOAuthToken('sk-ant-api03-not-an-oauth-token')).toBeNull();
  });
});

// ---- G1 Copilot adapter (PAT-broker, TEXT capture) ---------------------

describe('copilotAdapter (G1 — PAT-broker, text capture)', () => {
  it('brokers on the api.github.com token-exchange host with a `token` pat mode', () => {
    expect(copilotAdapter.type).toBe('copilot');
    expect(copilotAdapter.provider).toBe('github-copilot');
    // BROKER host is the token-EXCHANGE leg (api.github.com), NOT the model host.
    expect(copilotAdapter.apiHost).toBe('api.github.com');
    const pat = resolveAuthMode(copilotAdapter, 'pat');
    expect(pat).toEqual({
      kind: 'pat',
      header: 'authorization',
      scheme: 'token',
      env: 'COPILOT_GITHUB_TOKEN',
      login: 'pat',
      placeholder: COPILOT_PLACEHOLDER_PAT,
    });
    // The placeholder is fine-grained-PAT-shaped.
    expect(COPILOT_PLACEHOLDER_PAT.startsWith('github_pat_')).toBe(true);
  });

  it('captures TEXT (no JSON parse) and bakes the model leg into egressHosts', () => {
    expect(copilotAdapter.captureMode).toBe('text');
    // Text-mode adapters have no parseResult (classify tails stdout).
    expect(copilotAdapter.parseResult).toBeUndefined();
    expect(copilotAdapter.egressHosts).toContain('githubcopilot.com');
  });

  it('launches a bare TTY interactively and the headless autonomous argv', () => {
    expect(copilotAdapter.launchArgv({ mode: 'interactive' })).toEqual(['copilot']);
    expect(copilotAdapter.launchArgv({ mode: 'autonomous', task: 'fix it' })).toEqual([
      'copilot',
      '-p',
      'fix it',
      '-s',
      '--allow-all-tools',
      '--no-ask-user',
    ]);
  });
});

// ---- G2 Codex adapter (API-key path, JSON capture) ---------------------

describe('codexAdapter (G2 — api-key Bearer, json capture)', () => {
  it('brokers OPENAI_API_KEY as Bearer on api.openai.com (mirrors Claude api-key, diff scheme)', () => {
    expect(codexAdapter.type).toBe('codex');
    expect(codexAdapter.provider).toBe('openai');
    expect(codexAdapter.apiHost).toBe('api.openai.com');
    expect(codexAdapter.captureMode).toBe('json');
    const mode = resolveAuthMode(codexAdapter, 'api-key');
    expect(mode).toEqual({
      kind: 'api-key',
      header: 'authorization',
      scheme: 'Bearer', // SAME kind as Claude api-key, DIFFERENT scheme
      env: 'OPENAI_API_KEY',
      login: 'api-key',
      placeholder: OPENAI_PLACEHOLDER_KEY,
    });
    expect(codexAdapter.egressHosts).toContain('api.openai.com');
  });

  it('launches `codex exec --json … --dangerously-bypass-approvals-and-sandbox` autonomously', () => {
    expect(codexAdapter.launchArgv({ mode: 'interactive' })).toEqual(['codex']);
    // Interactive WITH a task seeds the TUI's first prompt (`codex "<task>"`),
    // mirroring `claude "<task>"` — the task box runs rather than silently
    // labelling the tab only.
    expect(codexAdapter.launchArgv({ mode: 'interactive', task: 'fix it' })).toEqual(['codex', 'fix it']);
    expect(codexAdapter.launchArgv({ mode: 'autonomous', task: 'fix it' })).toEqual([
      'codex',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'fix it',
    ]);
  });

  it('parseResult: turn.completed ⇒ ok, lifts the last assistant message as the summary', () => {
    // Newer item.completed event shape.
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"assistant_message","text":"all green"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10}}',
    ].join('\n');
    expect(codexAdapter.parseResult?.(jsonl)).toEqual({ ok: true, summary: 'all green' });

    // Older msg/agent_message shape is also tolerated.
    const older = ['{"msg":{"type":"agent_message","message":"done it"}}', '{"type":"turn.completed"}'].join('\n');
    expect(codexAdapter.parseResult?.(older)).toEqual({ ok: true, summary: 'done it' });
  });

  it('parseResult: no turn.completed, or a fatal error event, ⇒ not ok', () => {
    expect(
      codexAdapter.parseResult?.('{"type":"item.completed","item":{"type":"assistant_message","text":"hi"}}')
    ).toEqual({ ok: false, summary: 'hi' });
    const errored = [
      '{"type":"item.completed","item":{"type":"assistant_message","text":"partial"}}',
      '{"type":"error","message":"upstream 500"}',
      '{"type":"turn.completed"}',
    ].join('\n');
    expect(codexAdapter.parseResult?.(errored)).toEqual({ ok: false, summary: 'partial' });
    // Non-JSON noise is ignored.
    expect(codexAdapter.parseResult?.('not json at all')).toEqual({ ok: false, summary: undefined });
  });
});

// ---- captureMode branch: json (parse) vs text (exit-code + stdout tail) -

describe('classifyAutonomousResult branches on captureMode', () => {
  it('text-mode (copilot): done iff exit 0; summary is the stdout tail, no parse', () => {
    const out = 'thinking...\nedited foo.ts\nDone — the test passes now.';
    const done = classifyAutonomousResult(0, out, copilotAdapter);
    expect(done.status).toBe('done');
    expect(done.exitCode).toBe(0);
    expect(done.summary).toContain('Done — the test passes now.');

    // Non-zero exit → error even with output; still no JSON parse.
    const err = classifyAutonomousResult(3, 'boom', copilotAdapter);
    expect(err.status).toBe('error');
    expect(err.exitCode).toBe(3);
    expect(err.summary).toBe('boom');

    // Empty stdout on a clean exit still classifies done with a fallback summary.
    expect(classifyAutonomousResult(0, '', copilotAdapter)).toEqual({
      status: 'done',
      exitCode: 0,
      summary: 'completed',
    });
  });

  it('json-mode (codex): parses the JSONL stream — done only on exit 0 + turn.completed', () => {
    const jsonl = [
      '{"type":"item.completed","item":{"type":"assistant_message","text":"shipped"}}',
      '{"type":"turn.completed"}',
    ].join('\n');
    expect(classifyAutonomousResult(0, jsonl, codexAdapter)).toEqual({
      status: 'done',
      exitCode: 0,
      summary: 'shipped',
    });
    // No turn.completed → error even on exit 0.
    expect(classifyAutonomousResult(0, '{"type":"thread.started"}', codexAdapter).status).toBe('error');
  });

  it('tailLines keeps the last N non-empty-trailing lines', () => {
    expect(tailLines('a\nb\nc\n\n', 2)).toBe('b\nc');
    expect(tailLines('only', 5)).toBe('only');
    expect(tailLines('', 5)).toBe('');
  });
});

// ---- installCommandFor: all three CLIs pinned to the baked image ----

describe('installCommandFor (pinned install descriptor)', () => {
  it('pins all three CLIs to the versions baked into the prebuilt image', () => {
    expect(installCommandFor(copilotAdapter.install)).toBe(
      'command -v copilot >/dev/null 2>&1 || npm install -g @github/copilot@1.0.65 >/dev/null'
    );
    expect(installCommandFor(codexAdapter.install)).toBe(
      'command -v codex >/dev/null 2>&1 || npm install -g @openai/codex@0.142.0 >/dev/null'
    );
    // claude-code is now PINNED too (docs/fast-spin-up.md §2.6): the version
    // must equal the squashfs-baked manifest, and the `command -v claude`
    // guard makes the install a no-op when the squashfs put it on PATH.
    expect(installCommandFor(claudeCodeAdapter.install)).toBe(
      'command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code@2.1.196 >/dev/null'
    );
  });

  it('guards every install with command -v so a PATH-resident CLI is a no-op', () => {
    // The prebuilt image puts the CLIs on PATH; the `command -v <bin> ||`
    // prefix is the no-op switch (the `|| npm install` self-heal never runs).
    for (const adapter of [claudeCodeAdapter, copilotAdapter, codexAdapter]) {
      expect(installCommandFor(adapter.install)).toMatch(
        new RegExp(`^command -v ${adapter.install.bin} >/dev/null 2>&1 \\|\\| npm install -g `)
      );
    }
  });
});

// ---- G1 Sasha's HARD pre-ship guard: github_pat_-only PAT validation ---

describe('validateCopilotPat (Sasha: reject classic ghp_, require github_pat_)', () => {
  it('accepts a fine-grained github_pat_ token', () => {
    expect(validateCopilotPat('github_pat_11ABCDEF_xyz')).toEqual({ ok: true, value: 'github_pat_11ABCDEF_xyz' });
    // Surrounding whitespace is trimmed.
    expect(validateCopilotPat('  github_pat_abc\n')).toEqual({ ok: true, value: 'github_pat_abc' });
  });

  it('REJECTS a classic ghp_ PAT with the `classic` reason', () => {
    expect(validateCopilotPat('ghp_1234567890abcdef')).toEqual({ ok: false, reason: 'classic' });
  });

  it('rejects anything that is not a github_pat_ token (shape) and empty input', () => {
    expect(validateCopilotPat('sk-not-a-pat')).toEqual({ ok: false, reason: 'shape' });
    expect(validateCopilotPat('github_personal_access_token')).toEqual({ ok: false, reason: 'shape' });
    expect(validateCopilotPat('   ')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('looksLikeOpenAiKey (codex soft sk- warning)', () => {
  it('is true for sk- keys, false otherwise', () => {
    expect(looksLikeOpenAiKey('sk-proj-abc')).toBe(true);
    expect(looksLikeOpenAiKey('  sk-abc ')).toBe(true);
    expect(looksLikeOpenAiKey('nope')).toBe(false);
  });
});

describe('hostClaudeCommand', () => {
  it('uses cmd.exe on Windows so npm-installed .cmd shims resolve through PATHEXT', () => {
    expect(hostClaudeCommand(['--version'], 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/C', 'claude', '--version'],
    });
    expect(hostClaudeCommand(['setup-token'], 'linux')).toEqual({
      command: 'claude',
      args: ['setup-token'],
    });
  });
});

describe('parseStoredCred accepts the pat kind (Copilot)', () => {
  it('reads a pat envelope as { kind: pat, value }', () => {
    expect(parseStoredCred('{"kind":"pat","value":"github_pat_abc"}')).toEqual({
      kind: 'pat',
      value: 'github_pat_abc',
    });
  });
});
