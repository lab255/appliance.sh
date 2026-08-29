import * as React from 'react';
import { Check, ExternalLink, Github, KeyRound, Loader2, Sparkles, TerminalSquare } from 'lucide-react';
import { useHost } from '@/providers/host-provider';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/ui/banner';
import { CommandSnippet } from '@/components/ui/command-snippet';
import { Input } from '@/components/ui/input';
import {
  localMachineLabel,
  localMachineLabelInline,
  type AgentAuthKind,
  type AgentAuthStatus,
  type HostPlatform,
} from '@/lib/host';
import {
  AGENT_ADAPTERS,
  agentAdapter,
  DEFAULT_AGENT_TYPE,
  GITHUB_FINE_GRAINED_PAT_SETTINGS_URL,
  looksLikeOpenAiKey,
  validateCopilotPat,
} from '@/lib/agents';
import { cn } from '@/lib/utils';

// Desktop agent login (Phase 5, L3 / multi-agent G3 — docs/agent-login.md §4,
// docs/multi-agent-adapters.md §4). Lets a desktop-only user authenticate a
// coding agent WITHOUT a terminal, PARAMETERIZED by agent type. Each agent's
// credential UX (and its host store) differs:
//   • claude-code — API key (masked paste → `agent login api-key`) OR
//     "Sign in with Claude": runs `claude setup-token` in a visible host
//     terminal (the full-screen TUI shows a one-year token on-screen ONLY —
//     there is no headless capture, docs §7), then a masked field captures the
//     token the user copies. Stored under the `anthropic` provider.
//   • copilot — a masked fine-grained GitHub PAT field. We REQUIRE a
//     `github_pat_` token scoped to ONLY `Copilot Requests` (mirrors the CLI's
//     `validateCopilotPat`; the narrow scope is the security bound on host-keyed
//     injection, docs §4/§7) and REJECT classic `ghp_` PATs. Stored under the
//     `github-copilot` provider, tagged `pat`.
//   • codex — a masked OpenAI API key field, soft `sk-` shape warning. Stored
//     under the `openai` provider, tagged `api-key`.
// The credential is stored host-side (Keychain) PER PROVIDER and NEVER sent to
// the VM — the egress broker injects it host-side at request time.

const SETUP_TOKEN_CMD = 'claude setup-token';

/**
 * Best-effort `{ agentType → has a stored credential }` map, for the per-agent
 * "signed in" dot on the agent-type pickers (launcher + Settings — Devon nit).
 * Polls each registered agent's host store status when `enabled`; resolves
 * empty (no dots) where the host has no `agentAuth` capability (web shell). The
 * `refreshToken` re-runs the probe after a login so a freshly-signed-in agent
 * lights up without a remount. NEVER reads the secret — `status()` is
 * prompt-free.
 */
export function useAgentSignedIn(enabled: boolean, refreshToken?: unknown): Record<string, boolean> {
  const auth = useHost().agentAuth;
  const [map, setMap] = React.useState<Record<string, boolean>>({});
  React.useEffect(() => {
    if (!enabled || !auth) {
      setMap({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      AGENT_ADAPTERS.map(async (a) => {
        try {
          const s = await auth.status(a.type);
          return [a.type, s.configured] as const;
        } catch {
          return [a.type, false] as const;
        }
      })
    ).then((entries) => {
      if (!cancelled) setMap(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, auth, refreshToken]);
  return map;
}

/** Pull the first `sk-ant-oat01-…` token out of a paste — mirrors the CLI's
 *  `extractOAuthToken` so a paste of the bare token OR the whole
 *  `export CLAUDE_CODE_OAUTH_TOKEN=…` line `setup-token` prints both work
 *  (ANSI colour codes stripped first). Returns null when no token is found. */
function extractOauthToken(raw: string): string | null {
  const clean = raw.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');
  const m = clean.match(/sk-ant-oat01-[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

/** Label a stored credential kind in the agent's own vocabulary. */
function kindLabel(kind: AgentAuthKind): string {
  if (kind === 'oauth') return 'Claude subscription';
  if (kind === 'pat') return 'GitHub PAT';
  return 'API key';
}

/**
 * Self-contained agent-login control, parameterized by `agentType` (default
 * `claude-code`). Shows the current signed-in state for THAT agent and lets the
 * user store its credential host-side via `host.agentAuth` (each agent → its
 * own provider store). Reused on the launcher's keyless path and in Settings.
 * Renders nothing when the host has no `agentAuth` capability (web shell).
 */
export function AgentLoginPanel({
  agentType = DEFAULT_AGENT_TYPE,
  onAuthenticated,
  className,
}: {
  agentType?: string;
  onAuthenticated?: (status: AgentAuthStatus) => void;
  className?: string;
}) {
  const host = useHost();
  const auth = host.agentAuth;
  const adapter = agentAdapter(agentType);

  const [status, setStatus] = React.useState<AgentAuthStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // The kind we just stored — Settings can label "Signed in (…)" immediately
  // even on macOS, where `status()` deliberately doesn't read the secret to
  // discover the kind (that would pop a Keychain prompt).
  const [lastKind, setLastKind] = React.useState<AgentAuthKind | null>(null);
  const [showForm, setShowForm] = React.useState(false);
  const [confirmSignOut, setConfirmSignOut] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState('');

  const refreshStatus = React.useCallback(async (): Promise<AgentAuthStatus | null> => {
    if (!auth) return null;
    try {
      const s = await auth.status(adapter.type);
      setStatus(s);
      return s;
    } catch {
      const s = { configured: false, kind: null } as const;
      setStatus(s);
      return s;
    }
  }, [auth, adapter.type]);

  React.useEffect(() => {
    // Re-resolve when the agent type changes (the picker switches stores).
    setStatus(null);
    setLastKind(null);
    setErr(null);
    setShowForm(false);
    setConfirmSignOut(false);
    void refreshStatus();
  }, [refreshStatus]);

  if (!auth) return null; // desktop-only capability

  const finish = (kind: AgentAuthKind, s: AgentAuthStatus | null) => {
    setLastKind(kind);
    setShowForm(false);
    setAnnouncement(`Signed in to ${adapter.label}`);
    onAuthenticated?.(s ?? { configured: true, kind });
  };

  // Store a resolved secret under this agent's provider store, tagged by kind.
  // Shared by all three credential UXes — the only per-agent differences are
  // the input + validation that produce `(kind, value)`.
  const store = async (kind: AgentAuthKind, value: string, after?: () => void) => {
    setBusy(true);
    setErr(null);
    try {
      await auth.login({ agentType: adapter.type, kind, value });
      after?.();
      finish(kind, await refreshStatus());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setErr(null);
    try {
      await auth.logout(adapter.type);
      setLastKind(null);
      const next = await refreshStatus();
      setConfirmSignOut(false);
      setAnnouncement(`Signed out of ${adapter.label}`);
      onAuthenticated?.(next ?? { configured: false, kind: null });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const displayKind = status?.kind ?? lastKind;

  return (
    <div className={cn('w-full max-w-md space-y-3 text-xs', className)}>
      {status?.configured ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2">
          <span className="flex items-center gap-2">
            <Check className="h-3.5 w-3.5" aria-hidden />
            Signed in to {adapter.label}
            {displayKind ? (
              <span className="text-[var(--color-muted-foreground)]"> · {kindLabel(displayKind)}</span>
            ) : null}
          </span>
          <span className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => setShowForm((value) => !value)} disabled={busy}>
              {showForm ? 'Keep current sign-in' : 'Change sign-in'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmSignOut(true)} disabled={busy}>
              Sign out
            </Button>
          </span>
        </div>
      ) : null}

      {confirmSignOut ? (
        <Banner
          tone="warning"
          title={`Sign out of ${adapter.label} on this computer?`}
          action={
            <>
              <Button variant="outline" size="sm" onClick={() => setConfirmSignOut(false)}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void signOut()} disabled={busy}>
                {busy ? 'Signing out…' : 'Sign out'}
              </Button>
            </>
          }
        >
          New sessions will need you to sign in again.
        </Banner>
      ) : null}

      {!status?.configured || showForm ? (
        adapter.login === 'claude' ? (
          <ClaudeLogin platform={host.platform} auth={auth} busy={busy} setErr={setErr} store={store} />
        ) : adapter.login === 'github-pat' ? (
          <CopilotPatLogin busy={busy} setErr={setErr} store={store} />
        ) : (
          <OpenAiKeyLogin busy={busy} setErr={setErr} store={store} />
        )
      ) : null}

      {err ? <Banner tone="error">{err}</Banner> : null}

      <p className="text-xs leading-4 text-[var(--color-muted-foreground)]">
        Saved securely on this computer and used only when this agent connects.
      </p>
      {announcement ? (
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="text-xs leading-4 text-[var(--color-muted-foreground)]"
        >
          {announcement}
        </p>
      ) : null}
    </div>
  );
}

// ---- claude-code: API key OR "Sign in with Claude" (unchanged UX) --------

type StoreFn = (kind: AgentAuthKind, value: string, after?: () => void) => Promise<void>;

function ClaudeLogin({
  platform,
  auth,
  busy,
  setErr,
  store,
}: {
  platform: HostPlatform;
  auth: NonNullable<ReturnType<typeof useHost>['agentAuth']>;
  busy: boolean;
  setErr: (e: string | null) => void;
  store: StoreFn;
}) {
  const machineLabel = localMachineLabel(platform);
  const machineLabelInline = localMachineLabelInline(platform);
  const [mode, setMode] = React.useState<'oauth' | 'api-key'>('oauth');
  const [apiKey, setApiKey] = React.useState('');
  const [paste, setPaste] = React.useState('');
  const [hasClaude, setHasClaude] = React.useState<boolean | null>(null);
  const [terminalLaunched, setTerminalLaunched] = React.useState(false);
  // True when the last "Open terminal" click could NOT auto-launch a terminal
  // (non-macOS, where runSetupToken() resolves false, or a launch error). Drives
  // an inline "copy the command below" note so the click is never a dead no-op.
  const [terminalAutoOpenFailed, setTerminalAutoOpenFailed] = React.useState(false);

  // Probe host `claude` lazily the first time the OAuth mode is shown — it
  // gates "Sign in with Claude" (setup-token needs a host `claude`).
  React.useEffect(() => {
    if (mode !== 'oauth' || hasClaude !== null) return;
    let cancelled = false;
    void auth
      .hasHostClaude()
      .then((ok) => !cancelled && setHasClaude(ok))
      .catch(() => !cancelled && setHasClaude(false));
    return () => {
      cancelled = true;
    };
  }, [mode, auth, hasClaude]);

  // The "Terminal opened" confirmation is transient: re-clicking re-launches,
  // so revert the label after a few seconds rather than leaving a stale sticky
  // "Terminal opened" that hides that the button is still actionable.
  React.useEffect(() => {
    if (!terminalLaunched) return;
    const id = setTimeout(() => setTerminalLaunched(false), 4000);
    return () => clearTimeout(id);
  }, [terminalLaunched]);

  const saveApiKey = () => {
    const value = apiKey.trim();
    if (!value) {
      setErr('Paste an Anthropic API key first.');
      return;
    }
    void store('api-key', value, () => setApiKey(''));
  };

  const saveOauth = () => {
    const token = extractOauthToken(paste);
    if (!token) {
      setErr(
        'That doesn’t look like the token — copy the sk-ant-oat01-… value the terminal shows after you approve in your browser.'
      );
      return;
    }
    void store('oauth', token, () => setPaste(''));
  };

  const openTerminal = async () => {
    setErr(null);
    setTerminalAutoOpenFailed(false);
    try {
      const launched = await auth.runSetupToken();
      setTerminalLaunched(launched);
      // Off-macOS (or any host without an auto-launch) resolves false — surface
      // the manual fallback instead of a silent no-op.
      setTerminalAutoOpenFailed(!launched);
    } catch (e) {
      // Best-effort: the manual command below is always available.
      setTerminalLaunched(false);
      setTerminalAutoOpenFailed(true);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  // Soft, NON-blocking shape check: Anthropic keys are `sk-ant-…`. A mis-paste
  // would store "successfully" then 401 at launch, so warn early — but let the
  // user proceed (we don't gate Save on it; the prefix isn't a hard contract).
  const apiKeyTrimmed = apiKey.trim();
  const apiKeyShapeWarn = apiKeyTrimmed.length > 0 && !apiKeyTrimmed.startsWith('sk-ant-');

  return (
    <>
      {/* Mode toggle: lead with the subscription path, API key as the
          alternative. */}
      <div
        role="tablist"
        aria-label="Authentication method"
        className="inline-flex rounded-md border border-[var(--color-border)] p-0.5"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
          event.preventDefault();
          tabs[(current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length]?.click();
          tabs[(current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length]?.focus();
        }}
      >
        <ModeTab active={mode === 'oauth'} onClick={() => setMode('oauth')}>
          <Sparkles className="h-3.5 w-3.5" /> Sign in with Claude
        </ModeTab>
        <ModeTab active={mode === 'api-key'} onClick={() => setMode('api-key')}>
          <KeyRound className="h-3.5 w-3.5" /> API key
        </ModeTab>
      </div>

      {mode === 'oauth' ? (
        hasClaude === false ? (
          // Claude Code missing on the host. A one-click install here needs a
          // host-side install/exec capability the bridge doesn't expose yet
          // (agentAuth only offers status/login/logout/hasHostClaude/
          // runSetupToken) — until it does, offer the copyable command.
          <div className="space-y-2 rounded-md border border-dashed border-[var(--color-border)] p-3 text-[var(--color-muted-foreground)]">
            <p>
              {machineLabel} needs Claude Code before you can sign in with a Claude subscription.
              {platform === 'windows'
                ? ' Copy one of these commands and run it in a terminal — or use an API key instead.'
                : ' Copy this command and run it in a terminal to install it — or use an API key instead.'}
            </p>
            {platform === 'windows' ? (
              <>
                <div className="space-y-1" role="group" aria-labelledby="winget-install-label">
                  <span id="winget-install-label">Install with WinGet:</span>
                  <CommandSnippet
                    command="winget install Anthropic.ClaudeCode"
                    copyButtonAriaLabel="Copy the WinGet command"
                  />
                </div>
                <div className="space-y-1">
                  <span>Or, if Node.js is installed:</span>
                  <CommandSnippet
                    command="npm install -g @anthropic-ai/claude-code"
                    copyButtonAriaLabel="Copy the npm command"
                  />
                </div>
              </>
            ) : (
              <CommandSnippet command="npm install -g @anthropic-ai/claude-code" />
            )}
            <Button variant="outline" size="sm" onClick={() => setMode('api-key')}>
              <KeyRound className="h-3.5 w-3.5" /> Use an API key
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[var(--color-muted-foreground)]">
              Sign in with your Claude Pro/Max/Team subscription — no API key needed. A sign-in terminal opens on{' '}
              {machineLabelInline}, your browser asks you to approve, and the terminal then shows a token to paste
              below.
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void openTerminal()}
                disabled={busy || hasClaude === null}
              >
                <TerminalSquare className="h-3.5 w-3.5" />
                {terminalLaunched ? 'Start sign-in again' : 'Start sign-in'}
              </Button>
              {hasClaude === null ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-muted-foreground)]" />
              ) : null}
            </div>
            {terminalLaunched ? (
              <p role="status" aria-live="polite" aria-atomic="true">
                Sign-in terminal opened
              </p>
            ) : null}
            {/* Linux still uses the manual fallback; Windows and macOS hosts
                auto-launch a visible terminal. */}
            {terminalAutoOpenFailed ? (
              <p className="text-[var(--color-muted-foreground)]">
                A terminal couldn&rsquo;t be opened automatically on {machineLabelInline} — copy the command below and
                run it in any terminal instead.
              </p>
            ) : null}
            <div className="space-y-1">
              <span className="text-[var(--color-muted-foreground)]">
                {terminalAutoOpenFailed ? 'Run this in any terminal:' : '…or run it yourself:'}
              </span>
              <CommandSnippet command={SETUP_TOKEN_CMD} />
            </div>
            <label className="block space-y-1">
              <span className="font-medium text-[var(--color-foreground)]">
                Paste the token that appears after you approve in your browser
              </span>
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveOauth();
                }}
                placeholder="sk-ant-oat01-…"
                disabled={busy}
                mono
              />
              <span className="block text-xs leading-4 text-[var(--color-muted-foreground)]">
                It starts with <code className="font-mono">sk-ant-oat01-</code>. Pasting the whole line the terminal
                printed works too.
              </span>
            </label>
            <Button size="sm" onClick={saveOauth} disabled={busy || !paste.trim()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save token
            </Button>
          </div>
        )
      ) : (
        <div className="space-y-2">
          <p className="text-[var(--color-muted-foreground)]">
            Paste an Anthropic API key (<code className="font-mono">sk-ant-…</code>). Get one from the Anthropic
            Console.
          </p>
          <label className="block space-y-1">
            <span className="text-[var(--color-muted-foreground)]">API key</span>
            <Input
              id="claude-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveApiKey();
              }}
              placeholder="sk-ant-…"
              disabled={busy}
              mono
              aria-describedby={apiKeyShapeWarn ? 'claude-api-key-warning' : undefined}
            />
          </label>
          {apiKeyShapeWarn ? (
            <p id="claude-api-key-warning" className="text-[var(--color-warning-foreground)]">
              That doesn&rsquo;t look like an Anthropic key — they start with <code className="font-mono">sk-ant-</code>
              . You can still save it.
            </p>
          ) : null}
          <Button size="sm" onClick={saveApiKey} disabled={busy || !apiKey.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save key
          </Button>
        </div>
      )}
    </>
  );
}

// ---- copilot: fine-grained GitHub PAT (Copilot Requests only) ------------

function CopilotPatLogin({
  busy,
  setErr,
  store,
}: {
  busy: boolean;
  setErr: (e: string | null) => void;
  store: StoreFn;
}) {
  const [pat, setPat] = React.useState('');

  const save = () => {
    const v = validateCopilotPat(pat);
    if (!v.ok) {
      setErr(
        v.reason === 'classic'
          ? 'Classic ghp_ PAT rejected — it carries your full account scope. Create a fine-grained github_pat_ token scoped to Copilot Requests only.'
          : v.reason === 'empty'
            ? 'Paste a fine-grained GitHub PAT first.'
            : 'Expected a fine-grained GitHub PAT starting with github_pat_. Mint one scoped to Copilot Requests and paste it.'
      );
      return;
    }
    void store('pat', v.value, () => setPat(''));
  };

  const trimmed = pat.trim();
  // Live shape feedback BEFORE save: a classic ghp_ is a hard reject; anything
  // non-empty that isn't github_pat_ gets a soft heads-up (Save still validates).
  const isClassic = trimmed.startsWith('ghp_');
  const wrongShape = trimmed.length > 0 && !isClassic && !trimmed.startsWith('github_pat_');

  return (
    <div className="space-y-2">
      <p className="text-[var(--color-muted-foreground)]">
        GitHub Copilot signs in with a <span className="text-[var(--color-foreground)]">fine-grained GitHub PAT</span>.
        It stays on this computer and is used only when Copilot connects.
      </p>

      {/* Security bound (Sasha's pre-ship guard): the fine-grained PAT's narrow
          scope is the ENTIRE bound on host-keyed injection, so make the
          single-scope requirement impossible to miss. */}
      <Banner
        tone="warning"
        title={
          <>
            Grant only the <code className="font-mono">Copilot Requests</code> permission.
          </>
        }
      >
        <details>
          <summary className="cursor-pointer rounded text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
            Technical details
          </summary>
          <p className="mt-1 text-xs leading-4">
            The PAT is added to <code className="font-mono">api.github.com</code> requests from the Sandbox. Broader
            scopes could allow access beyond Copilot requests. Classic <code className="font-mono">ghp_</code> tokens
            are rejected.
          </p>
        </details>
        <a
          href={GITHUB_FINE_GRAINED_PAT_SETTINGS_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 rounded text-xs font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        >
          <ExternalLink className="h-3 w-3" aria-hidden /> Create a fine-grained token on GitHub
        </a>
      </Banner>

      <label className="block space-y-1">
        <span className="text-[var(--color-muted-foreground)]">Fine-grained PAT</span>
        <Input
          id="copilot-pat"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          placeholder="github_pat_…"
          disabled={busy}
          mono
          invalid={isClassic}
          aria-describedby={isClassic || wrongShape ? 'copilot-pat-warning' : undefined}
        />
      </label>
      {isClassic ? (
        <p id="copilot-pat-warning" className="text-[var(--color-destructive-foreground)]">
          That&rsquo;s a classic <code className="font-mono">ghp_</code> token — rejected. Use a fine-grained{' '}
          <code className="font-mono">github_pat_</code> token scoped to Copilot Requests only.
        </p>
      ) : wrongShape ? (
        <p id="copilot-pat-warning" className="text-[var(--color-warning-foreground)]">
          A fine-grained PAT starts with <code className="font-mono">github_pat_</code>.
        </p>
      ) : null}
      <Button size="sm" onClick={save} disabled={busy || !trimmed || isClassic}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Github className="h-3.5 w-3.5" />} Save PAT
      </Button>
    </div>
  );
}

// ---- codex: OpenAI API key -----------------------------------------------

function OpenAiKeyLogin({
  busy,
  setErr,
  store,
}: {
  busy: boolean;
  setErr: (e: string | null) => void;
  store: StoreFn;
}) {
  const [key, setKey] = React.useState('');

  const save = () => {
    const value = key.trim();
    if (!value) {
      setErr('Paste an OpenAI API key first.');
      return;
    }
    void store('api-key', value, () => setKey(''));
  };

  // Soft, NON-blocking shape check (mirrors the CLI's `looksLikeOpenAiKey`):
  // OpenAI keys are `sk-…`. Warn but never gate Save — there's no hard format.
  const trimmed = key.trim();
  const shapeWarn = trimmed.length > 0 && !looksLikeOpenAiKey(trimmed);

  return (
    <div className="space-y-2">
      <p className="text-[var(--color-muted-foreground)]">
        Paste an OpenAI API key (<code className="font-mono">sk-…</code>). It stays on this computer and is used only
        when Codex connects. Get one from the OpenAI platform dashboard.
      </p>
      {/* Acknowledge the deferred ChatGPT-subscription path (docs §7): it
          writes a durable refresh_token into the guest, so it isn't brokered
          here yet — set the expectation rather than leaving a silent gap. */}
      <p className="text-xs leading-4 text-[var(--color-muted-foreground)]">
        ChatGPT subscription login isn&rsquo;t supported here yet — use an API key.
      </p>
      <label className="block space-y-1">
        <span className="text-[var(--color-muted-foreground)]">API key</span>
        <Input
          id="openai-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          placeholder="sk-…"
          disabled={busy}
          mono
          aria-describedby={shapeWarn ? 'openai-api-key-warning' : undefined}
        />
      </label>
      {shapeWarn ? (
        <p id="openai-api-key-warning" className="text-[var(--color-warning-foreground)]">
          That doesn&rsquo;t look like an OpenAI key — they start with <code className="font-mono">sk-</code>. You can
          still save it.
        </p>
      ) : null}
      <Button size="sm" onClick={save} disabled={busy || !trimmed}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save key
      </Button>
    </div>
  );
}

function ModeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
        active
          ? 'bg-[var(--color-accent)] text-[var(--color-foreground)]'
          : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]'
      )}
    >
      {children}
    </button>
  );
}
