import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VERSION } from '@appliance.sh/sdk';
import { resolveVmBinary } from './microvm-up.js';

// `appliance doctor --bundle` — a redacted support tarball. One file an
// operator can attach to a bug report that carries everything a
// maintainer needs (report, environment, VM state, log tails) and
// NOTHING that grants access to the runtime or third parties.
//
// Redaction is layered:
//   * FORBIDDEN files are never read at all: the bootstrap token (key-
//     mint credential — presence+mtime only), egress-secrets.json
//     (captured third-party creds!), kubeconfig.yaml (client certs;
//     only its `server:` line is recorded), the raw profiles.json /
//     credentials.json, and anything Keychain.
//   * STRUCTURAL redaction for JSON we do ship: parse, replace the
//     secret-bearing fields (`secret`, `lastBootstrapInput`, egress
//     `helper` commands) with `<redacted:len=N>` placeholders that keep
//     shape/diagnosability, re-serialize. Never regex over raw JSON.
//   * TEXT scrubbing for log tails (console.log, host.log, the guest
//     api-server log): secret-shaped tokens (32+ hex runs, JWTs) are
//     replaced — the same rules the engine applies server-side, applied
//     again here as belt-and-braces.
//
// The redaction tests (doctor-bundle.spec.ts) plant a fake secret in
// every redacted location and assert the produced tarball never
// contains any of them.

const LOG_TAIL_BYTES = 512 * 1024;

// ---- pure redaction helpers -------------------------------------------------

type RedactRule = 'string-len' | 'opaque';

const placeholder = (value: unknown): string =>
  typeof value === 'string' ? `<redacted:len=${value.length}>` : '<redacted>';

/** Deep-walk a parsed JSON tree, replacing every value whose KEY matches
 *  a rule: `string-len` keeps the length for diagnosability, `opaque`
 *  drops the whole subtree. Structural — never a regex over raw JSON. */
export function redactDeep(value: unknown, rules: Record<string, RedactRule>): unknown {
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, rules));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const rule = rules[key];
    if (rule === 'opaque') {
      out[key] = '<redacted>';
    } else if (rule === 'string-len') {
      out[key] = v === '' || v === null || v === undefined ? v : placeholder(v);
    } else {
      out[key] = redactDeep(v, rules);
    }
  }
  return out;
}

/** profiles.json → shareable: secrets replaced with length markers
 *  (keyId kept — it identifies which key without granting anything),
 *  bootstrap inputs (may embed cloud credentials) dropped opaque. */
export function redactProfilesFile(parsed: unknown): unknown {
  return redactDeep(parsed, { secret: 'string-len', lastBootstrapInput: 'opaque' });
}

/** Desktop config.json → shareable: same rules, both key spellings
 *  (the Rust side serializes camelCase; legacy shapes vary). */
export function redactDesktopConfig(parsed: unknown): unknown {
  return redactDeep(parsed, {
    secret: 'string-len',
    lastBootstrapInput: 'opaque',
    last_bootstrap_input: 'opaque',
  });
}

/** egress-policy.json → shareable: `helper` values are commands that
 *  can embed API keys on their command line. */
export function redactEgressPolicy(parsed: unknown): unknown {
  return redactDeep(parsed, { helper: 'string-len' });
}

/** Scrub secret-shaped tokens out of free log text: 32+ char hex runs
 *  (bootstrap tokens), `sk_`/`sk-`-prefixed hex runs (minted api-key
 *  secrets are `sk_` + 64 hex — api-key.service.ts — where the s/k/_
 *  keep the word from passing a plain hex test), and JWT-shaped `eyJ…`
 *  words (the api-server's ServiceAccount token). Mirrors scrub_secrets
 *  in packages/vm/src/doctor.rs — keep the rules in sync. */
export function scrubLogText(text: string): string {
  return text.replace(/[A-Za-z0-9_.-]+/g, (word) => {
    if (word.length >= 32 && /^[0-9a-fA-F]+$/.test(word)) return `<scrubbed:${word.length}ch>`;
    if (/^sk[_-][0-9a-fA-F]{32,}$/.test(word)) return `<scrubbed:${word.length}ch>`;
    if (word.startsWith('eyJ') && word.length >= 20 && word.includes('.')) return `<scrubbed:${word.length}ch>`;
    return word;
  });
}

/** The only part of kubeconfig.yaml a bundle records: the `server:`
 *  line(s), which say where the client points — the certs stay home. */
export function kubeconfigServerLines(raw: string): string {
  const lines = raw.split('\n').filter((l) => /^\s*server:/.test(l));
  return lines.length > 0 ? lines.map((l) => l.trim()).join('\n') + '\n' : '(no server line found)\n';
}

// ---- bundle assembly ----------------------------------------------------------

/** Injectable process runners so the redaction tests can drive the
 *  bundle without an engine or a cluster. */
export type ProcessRunner = (args: string[]) => { status: number | null; stdout: string } | null;

export interface BundleContext {
  vm: string;
  /** The doctor report (the exact `--json` object) to embed. */
  report: unknown;
  /** Where the tarball is written. Default: ./appliance-doctor-<vm>-<ts>.tar.gz */
  outPath?: string;
  /** Test override: the home directory the appliance state lives under. */
  homeDir?: string;
  /** Test override: candidate paths for the desktop's config.json. */
  desktopConfigPaths?: string[];
  /** Test override: appliance-vm invocations. */
  engine?: ProcessRunner;
  /** Test override: kubectl invocations. */
  kubectl?: ProcessRunner;
}

function defaultEngineRunner(): ProcessRunner {
  const bin = resolveVmBinary();
  if (!bin) return () => null;
  return (args) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
    if (r.error) return null;
    return { status: r.status, stdout: r.stdout ?? '' };
  };
}

function defaultKubectlRunner(): ProcessRunner {
  return (args) => {
    const r = spawnSync('kubectl', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15_000 });
    if (r.error) return null;
    return { status: r.status, stdout: r.stdout ?? '' };
  };
}

/** Default desktop config.json locations (Tauri app_config_dir with the
 *  `sh.appliance.desktop` identifier), per platform. */
function defaultDesktopConfigPaths(homeDir: string): string[] {
  return [
    path.join(homeDir, 'Library', 'Application Support', 'sh.appliance.desktop', 'config.json'),
    path.join(homeDir, '.config', 'sh.appliance.desktop', 'config.json'),
    path.join(homeDir, 'AppData', 'Roaming', 'sh.appliance.desktop', 'config.json'),
  ];
}

/** Last `n` bytes of a file, or null when unreadable. */
function tailBytes(filePath: string, n: number): string | null {
  try {
    const size = fs.statSync(filePath).size;
    const fd = fs.openSync(filePath, 'r');
    try {
      const start = Math.max(0, size - n);
      const buf = Buffer.alloc(Math.min(size, n));
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readJson(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Assemble and write the redacted support bundle. Returns the tarball
 * path. Every input is best-effort: a missing file is skipped (or
 * recorded as absent), never fatal — a support bundle must be
 * producible from exactly the broken states it exists to diagnose.
 */
export async function writeSupportBundle(ctx: BundleContext): Promise<string> {
  const homeDir = ctx.homeDir ?? os.homedir();
  const applianceDir = path.join(homeDir, '.appliance');
  const vmStateDir = path.join(applianceDir, 'vm', ctx.vm);
  const engine = ctx.engine ?? defaultEngineRunner();
  const kubectl = ctx.kubectl ?? defaultKubectlRunner();

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-doctor-bundle-'));
  const put = (rel: string, content: string): void => {
    const dest = path.join(staging, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, { mode: 0o600 });
  };

  // report.json — the doctor's own findings.
  put('report.json', JSON.stringify(ctx.report, null, 2));

  // env.json — versions, platform, engine identity, and the bootstrap
  // token's PRESENCE + mtime (never its content).
  const tokenPath = path.join(vmStateDir, 'bootstrap-token');
  let tokenStat: fs.Stats | null = null;
  try {
    tokenStat = fs.statSync(tokenPath);
  } catch {
    tokenStat = null;
  }
  const enginePath = resolveVmBinary();
  const engineVersion = engine(['--version']);
  put(
    'env.json',
    JSON.stringify(
      {
        cliVersion: VERSION,
        platform: process.platform,
        osRelease: os.release(),
        arch: process.arch,
        enginePath,
        engineVersion: engineVersion?.status === 0 ? engineVersion.stdout.trim() : null,
        bootstrapToken: {
          present: tokenStat !== null,
          mtime: tokenStat ? tokenStat.mtime.toISOString() : null,
        },
      },
      null,
      2
    )
  );

  // profiles.redacted.json — structural redaction, never the raw file.
  const profiles = readJson(path.join(applianceDir, 'profiles.json'));
  if (profiles !== null) {
    put('profiles.redacted.json', JSON.stringify(redactProfilesFile(profiles), null, 2));
  }

  // desktop-config.redacted.json — first existing candidate path.
  for (const candidate of ctx.desktopConfigPaths ?? defaultDesktopConfigPaths(homeDir)) {
    const parsed = readJson(candidate);
    if (parsed !== null) {
      put('desktop-config.redacted.json', JSON.stringify(redactDesktopConfig(parsed), null, 2));
      break;
    }
  }

  // guest-assets/stamp — the staged api-server version marker.
  try {
    const stamp = fs.readFileSync(
      path.join(applianceDir, 'vm', 'images', 'guest-assets', 'appliance-api-server.version'),
      'utf8'
    );
    put('guest-assets/stamp', stamp);
  } catch {
    // not staged — nothing to record
  }

  // vm/<name>/ — spec, bring-up state, engine status, log tails.
  const vmRel = (f: string) => `vm/${ctx.vm}/${f}`;
  for (const plain of ['vm.json', 'bringup.json']) {
    try {
      put(vmRel(plain), fs.readFileSync(path.join(vmStateDir, plain), 'utf8'));
    } catch {
      // absent — skip
    }
  }
  const status = engine(['status', ctx.vm]);
  if (status && status.stdout.trim()) {
    put(vmRel('status.json'), status.stdout);
  }
  for (const log of ['host.log', 'console.log']) {
    const tail = tailBytes(path.join(vmStateDir, log), LOG_TAIL_BYTES);
    if (tail !== null) put(vmRel(log), scrubLogText(tail));
  }
  const egressPolicy = readJson(path.join(vmStateDir, 'egress-policy.json'));
  if (egressPolicy !== null) {
    put(vmRel('egress-policy.json'), JSON.stringify(redactEgressPolicy(egressPolicy), null, 2));
  }
  // Guest api-server log via the engine (already scrubbed server-side;
  // scrubbed again here as belt-and-braces).
  const apiLog = engine(['doctor', '--apiserver-log', ctx.vm]);
  if (apiLog?.status === 0 && apiLog.stdout.trim()) {
    put(vmRel('apiserver.log'), scrubLogText(apiLog.stdout));
  }
  // kubeconfig: the server line ONLY — never the certs.
  try {
    const kubeconfigRaw = fs.readFileSync(path.join(vmStateDir, 'kubeconfig.yaml'), 'utf8');
    put(vmRel('kubeconfig-server.txt'), kubeconfigServerLines(kubeconfigRaw));
    const ingress = kubectl([
      '--kubeconfig',
      path.join(vmStateDir, 'kubeconfig.yaml'),
      'get',
      'ingress',
      '-A',
      '-o',
      'json',
    ]);
    if (ingress?.status === 0 && ingress.stdout.trim()) {
      put(vmRel('kubectl/ingress.json'), ingress.stdout);
    }
  } catch {
    // no kubeconfig — VM never came up; skip both
  }

  // Tarball via spawned tar (the CLI is spawn-heavy already). The
  // archive name is passed RELATIVE with cwd set to its directory: GNU
  // tar parses a `C:\…` absolute -f argument as `host:path` (remote
  // archive) on Windows, so an absolute path breaks whenever GNU tar
  // (Git for Windows) shadows the system bsdtar.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = ctx.outPath ?? path.resolve(`appliance-doctor-${ctx.vm}-${stamp}.tar.gz`);
  const tar = spawnSync('tar', ['-czf', path.basename(outPath), '-C', staging, '.'], {
    encoding: 'utf8',
    cwd: path.dirname(outPath),
  });
  fs.rmSync(staging, { recursive: true, force: true });
  if (tar.error || tar.status !== 0) {
    const detail = tar.error?.message ?? tar.stderr;
    const hint =
      (tar.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
        ? process.platform === 'win32'
          ? ' (`tar.exe` ships with Windows 10 1803+; ensure C:\\Windows\\System32 is on PATH)'
          : ' (install tar with your package manager)'
        : '';
    throw new Error(`tar failed: ${detail}${hint}`);
  }
  return outPath;
}
