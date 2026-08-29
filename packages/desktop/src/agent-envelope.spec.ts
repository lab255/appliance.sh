import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ============================================================
// Agent-credential envelope + per-provider store parity (Sasha's L3 nit,
// extended for multi-agent G3).
//
// Each agent's host credential is written by TWO producers that MUST agree
// byte-for-byte, because a third process (the egress broker's
// `print-key --type <agent>`) reads it back and a drift fails the broker CLOSED:
//
//   • Rust  — `microvm_agent_login` in packages/desktop/src-tauri/src/lib.rs
//             (the desktop per-agent login path).
//   • TS    — `writeAgentKey(provider, value, kind)` / `parseStoredCred` in
//             packages/cli/src/utils/agent.ts (the `appliance agent login`
//             path + the print-key reader).
//
// Both call the SAME neutral store boundary, which selects Keychain on macOS,
// Credential Manager on Windows, or `<provider>-cred` on Linux, holding the
// SAME `{"kind","value"}` JSON envelope with the SAME kind strings
// (`api-key` / `oauth` / `pat`). The per-provider store keys (claude-code →
// anthropic, copilot → github-copilot, codex → openai) MUST also agree.
//
// The Rust unit suite reads the shared golden vectors directly. This TS test
// checks the same vectors and guards that both thin callers still route through
// the neutral store rather than reintroducing platform-specific persistence.
// ============================================================

/** The canonical envelope + per-provider store contract. Both producers + the
 *  parser MUST match. */
const CONTRACT = {
  keychainService: 'sh.appliance.agent',
  /** agent `--type` → host cred-store provider key. */
  providers: {
    'claude-code': 'anthropic',
    copilot: 'github-copilot',
    codex: 'openai',
  } as Record<string, string>,
  kinds: ['api-key', 'oauth', 'pat'] as const,
  envelopeKeys: ['kind', 'value'] as const,
};

type AgentAuthKind = (typeof CONTRACT.kinds)[number];
interface StoredCred {
  kind: AgentAuthKind;
  value: string;
}

/** Build the envelope exactly as both central encoders do. Rust uses an ordered
 * struct and TS uses an object literal with `kind` before `value`. */
function buildEnvelope(kind: AgentAuthKind, value: string): string {
  return JSON.stringify({ kind, value });
}

/** A faithful mirror of `parseStoredCred` (packages/cli/src/utils/agent.ts) and
 *  the Rust `parse_cred_kind` — kept here so the round-trip is self-contained.
 *  The source-drift assertions below guard the real implementations against
 *  diverging from this mirror. Fail-closed: a `{`-prefixed but broken envelope
 *  returns null (never treated as a bare key). */
function parseStoredCredMirror(raw: string): StoredCred | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s) as { kind?: unknown; value?: unknown };
      const kind = o.kind;
      const value = typeof o.value === 'string' ? o.value.trim() : '';
      if ((kind === 'api-key' || kind === 'oauth' || kind === 'pat') && value) return { kind, value };
      return null;
    } catch {
      return null;
    }
  }
  return { kind: 'api-key', value: s };
}

const here = dirname(fileURLToPath(import.meta.url));
const RUST_SRC = readFileSync(resolve(here, '../src-tauri/src/lib.rs'), 'utf-8');
const CLI_SRC = readFileSync(resolve(here, '../../cli/src/utils/agent.ts'), 'utf-8');
const CREDENTIAL_STORE_SRC = readFileSync(resolve(here, '../../cli/src/utils/credential-store.ts'), 'utf-8');
const KEYRING_STORE_SRC = readFileSync(resolve(here, '../../credential-store/src/keyring_store.rs'), 'utf-8');
const ENVELOPE_VECTORS = JSON.parse(
  readFileSync(resolve(here, '../../credential-store/testdata/envelope-vectors.json'), 'utf-8')
) as Array<{ kind: AgentAuthKind | 'control'; value: string; encoded: string }>;
// The desktop UI's adapter registry is a THIRD producer of the type→provider
// map (+ the github_pat_/ghp_ prefixes + the mirrored validateCopilotPat /
// looksLikeOpenAiKey). It can't import the CLI module (node built-ins) so it
// hand-mirrors those fields — guard the mirror against drifting from the CLI.
const APP_SRC = readFileSync(resolve(here, '../../app/src/lib/agents.ts'), 'utf-8');

/** The cross-source agent contract the CLI + App-UI registries share, per
 *  agent type: the host cred-store `provider`, the App-UI `login` style, and
 *  the CLI auth-mode `kind`(s) the login style maps onto. */
const AGENTS = {
  'claude-code': { provider: 'anthropic', appLogin: 'claude', cliKinds: ['api-key', 'oauth'] },
  copilot: { provider: 'github-copilot', appLogin: 'github-pat', cliKinds: ['pat'] },
  codex: { provider: 'openai', appLogin: 'openai-key', cliKinds: ['api-key'] },
} as const;

/** Slice one App-UI registry entry (`type: '<type>'` → its closing `},`) — the
 *  entries have no nested braces, so the first `},` after the type IS the end.
 *  Used to assert per-entry fields (provider/login) without a brittle whole-file
 *  `toContain`. */
function appAdapterBlock(type: string): string {
  const start = APP_SRC.indexOf(`type: '${type}'`);
  expect(start, `app adapter '${type}' not found`).toBeGreaterThanOrEqual(0);
  const end = APP_SRC.indexOf('},', start);
  return APP_SRC.slice(start, end < 0 ? undefined : end);
}

/** Slice a whole CLI adapter object (`export const <name>Adapter` → the next
 *  top-level `export const`). The CLI adapters nest braces (install, authModes),
 *  so we bound on the export markers rather than the first `},`. */
const CLI_ADAPTER_CONST: Record<string, string> = {
  'claude-code': 'claudeCodeAdapter',
  copilot: 'copilotAdapter',
  codex: 'codexAdapter',
};
function cliAdapterBlock(type: string): string {
  const start = CLI_SRC.indexOf(`export const ${CLI_ADAPTER_CONST[type]}: AgentAdapter = {`);
  expect(start, `CLI adapter for '${type}' not found`).toBeGreaterThanOrEqual(0);
  const next = CLI_SRC.indexOf('\nexport const ', start + 1);
  return CLI_SRC.slice(start, next < 0 ? undefined : next);
}

describe('agent-credential envelope round-trip', () => {
  it('round-trips every kind through the producer envelope', () => {
    for (const kind of CONTRACT.kinds) {
      const value =
        kind === 'oauth'
          ? 'sk-ant-oat01-roundtrip'
          : kind === 'pat'
            ? 'github_pat_roundtrip'
            : 'sk-ant-api03-roundtrip';
      const envelope = buildEnvelope(kind, value);
      // Exactly the two contract keys, in the documented order.
      expect(Object.keys(JSON.parse(envelope))).toEqual([...CONTRACT.envelopeKeys]);
      expect(parseStoredCredMirror(envelope)).toEqual({ kind, value });
    }
  });

  it('matches every checked-in cross-language golden vector byte-for-byte', () => {
    for (const vector of ENVELOPE_VECTORS) {
      expect(buildEnvelope(vector.kind as AgentAuthKind, vector.value)).toBe(vector.encoded);
    }
  });

  it('reads a legacy bare string as an api-key (back-compat)', () => {
    expect(parseStoredCredMirror('sk-ant-api03-legacy')).toEqual({
      kind: 'api-key',
      value: 'sk-ant-api03-legacy',
    });
  });

  it('fails CLOSED on a truncated / unknown-kind / empty-value envelope', () => {
    expect(parseStoredCredMirror('{"kind":"oauth","value":"sk-ant-oat01-abc')).toBeNull();
    expect(parseStoredCredMirror('{"kind":"totp","value":"x"}')).toBeNull();
    expect(parseStoredCredMirror('{"kind":"api-key","value":""}')).toBeNull();
    expect(parseStoredCredMirror('   ')).toBeNull();
  });
});

describe('Rust producer parity (packages/desktop/src-tauri/src/lib.rs)', () => {
  it('uses the neutral store that declares the canonical service', () => {
    expect(RUST_SRC).toMatch(
      /desktop_credential_store\(\)\s*\.put\(&agent_store_key\(provider\)\?, envelope\.as_bytes\(\)\)/
    );
    expect(RUST_SRC).toMatch(/fn agent_store_key\([^)]*\)[^{]*\{\s*StoreKey::agent\(encode_identifier\(provider\)\)/);
    expect(KEYRING_STORE_SRC).toMatch(/StoreKey::Agent\(provider\)\s*=>\s*\(AGENT_SERVICE,/);
    expect(KEYRING_STORE_SRC).toContain(`const AGENT_SERVICE: &str = "${CONTRACT.keychainService}";`);
  });

  it('emits the ordered `{kind,value}` envelope once', () => {
    expect(RUST_SRC).toContain("struct AgentCredentialEnvelope<'a>");
    expect(RUST_SRC).toContain('serde_json::to_string(&AgentCredentialEnvelope { kind, value })');
  });

  it('maps every agent type to its provider store key', () => {
    expect(RUST_SRC).toContain('"claude-code" => Some("anthropic")');
    expect(RUST_SRC).toContain('"copilot" => Some("github-copilot")');
    expect(RUST_SRC).toContain('"codex" => Some("openai")');
  });

  it('encodes the provider at the typed store boundary without duplicate platform stores', () => {
    expect(RUST_SRC).toContain('StoreKey::agent(encode_identifier(provider))');
    expect(RUST_SRC).not.toContain('/usr/bin/security');
    expect(RUST_SRC).not.toContain('.join(format!("{provider}-cred"))');
  });

  it('accepts all contract kinds when parsing', () => {
    expect(RUST_SRC).toContain('kind == "api-key" || kind == "oauth" || kind == "pat"');
  });
});

describe('TS producer/parser parity (packages/cli/src/utils/agent.ts)', () => {
  it('uses the central store that declares the canonical service', () => {
    expect(CLI_SRC).toContain("from './credential-store.js'");
    expect(CREDENTIAL_STORE_SRC).toContain(`export const AGENT_KEYCHAIN_SERVICE = '${CONTRACT.keychainService}';`);
  });

  it('delegates the `{kind,value}` envelope to the central encoder', () => {
    expect(CLI_SRC).toContain('writeAgentCredential(provider, { kind, value: secret }, options)');
    expect(CREDENTIAL_STORE_SRC).toContain('JSON.stringify({ kind: credential.kind, value: credential.value })');
  });

  it('declares exactly the contract kinds', () => {
    expect(CLI_SRC).toContain(`export type AgentAuthKind = 'api-key' | 'oauth' | 'pat';`);
  });

  it('accepts all contract kinds when parsing', () => {
    expect(CREDENTIAL_STORE_SRC).toContain(
      "parsed.kind === 'api-key' || parsed.kind === 'oauth' || parsed.kind === 'pat'"
    );
  });

  it('encodes providers at one boundary and keeps Linux file policy private', () => {
    expect(CREDENTIAL_STORE_SRC).toContain("encodedTarget('agent', provider)");
    expect(CREDENTIAL_STORE_SRC).toContain('`${target.identifier}-cred`');
    expect(CLI_SRC).not.toContain('/usr/bin/security');
    expect(CLI_SRC).not.toContain('`${provider}-cred`');
  });

  it('maps every agent type to its provider store key', () => {
    for (const provider of Object.values(CONTRACT.providers)) {
      expect(CLI_SRC).toContain(`provider: '${provider}'`);
    }
  });
});

describe('App-UI registry parity (packages/app/src/lib/agents.ts)', () => {
  it('maps every agent type to the SAME provider store key as the CLI', () => {
    for (const [type, { provider }] of Object.entries(AGENTS)) {
      // Both the CONTRACT (already cross-checked vs Rust) and the CLI source
      // agree on this provider…
      expect(CONTRACT.providers[type]).toBe(provider);
      expect(cliAdapterBlock(type)).toContain(`provider: '${provider}'`);
      // …and the App-UI registry entry for THIS type maps to it too.
      expect(appAdapterBlock(type)).toContain(`provider: '${provider}'`);
    }
  });

  it('pairs each App-UI login style with the CLI auth-mode kind(s)', () => {
    for (const [type, { appLogin, cliKinds }] of Object.entries(AGENTS)) {
      expect(appAdapterBlock(type)).toContain(`login: '${appLogin}'`);
      const cli = cliAdapterBlock(type);
      for (const kind of cliKinds) expect(cli).toContain(`kind: '${kind}'`);
    }
  });

  it('mirrors the github_pat_/ghp_ PAT prefixes byte-for-byte with the CLI', () => {
    for (const src of [APP_SRC, CLI_SRC]) {
      expect(src).toContain(`GITHUB_FINE_GRAINED_PAT_PREFIX = 'github_pat_'`);
      expect(src).toContain(`GITHUB_CLASSIC_PAT_PREFIX = 'ghp_'`);
    }
  });

  it('mirrors the OpenAI `sk-` key shape guard with the CLI', () => {
    for (const src of [APP_SRC, CLI_SRC]) {
      expect(src).toContain('export function looksLikeOpenAiKey');
      expect(src).toContain(`.startsWith('sk-')`);
    }
  });
});
