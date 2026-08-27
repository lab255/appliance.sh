import { Command } from 'commander';
import path from 'node:path';
import * as fs from 'node:fs';
import { type ManifestContext } from '@appliance.sh/sdk';
import { evaluateManifest } from './sandbox/index.js';
import { parseApplianceManifestForPrint } from './utils/common.js';

// `appliance manifest read` evaluates a programmatic manifest in the
// QuickJS sandbox and prints the resolved object as JSON on stdout.
//
// Primary consumer: the desktop wizard (Tauri), which spawns the
// bundled CLI as a sidecar instead of embedding its own JS runtime.
// Also handy from a shell when debugging a TS manifest.
//
// Path resolution mirrors loadManifest: a directory is probed for the
// usual `appliance.ts` / `.mts` / `.cts` / `.js` / `.mjs` / `.cjs`
// filenames in order; a file path is taken verbatim. `appliance.json`
// is also accepted and short-circuits the sandbox (just JSON.parse).
const DEFAULT_FILENAMES = [
  'appliance.ts',
  'appliance.mts',
  'appliance.cts',
  'appliance.js',
  'appliance.mjs',
  'appliance.cjs',
  'appliance.json',
];

const program = new Command();
program
  .command('read [path]')
  .description('Evaluate a programmatic appliance manifest in a QuickJS sandbox and print the resolved object as JSON')
  .option('--ctx <json>', 'JSON-encoded ManifestContext to pass to the manifest function')
  .option('--timeout <ms>', 'Sandbox wall-clock timeout in milliseconds (default 5000)')
  .option('--memory <mb>', 'Sandbox memory cap in MB (default 64)')
  .option('--no-validate', 'Skip Zod validation of the result against applianceFullInput')
  .action(async (pathArg: string | undefined, opts) => {
    try {
      const resolved = resolveManifestPath(pathArg);
      const ctx = parseContext(opts.ctx as string | undefined);
      const ext = path.extname(resolved).toLowerCase();

      let raw: unknown;
      if (ext === '.json') {
        raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
      } else {
        raw = await evaluateManifest(resolved, ctx, {
          timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
          memoryLimitMB: opts.memory ? Number(opts.memory) : undefined,
        });
      }

      if (opts.validate !== false) {
        const parsed = parseApplianceManifestForPrint(raw);
        if (!parsed.success) {
          fail({ ok: false, kind: 'validation', error: parsed.error.message, path: resolved });
        }
        emit({ ok: true, path: resolved, manifest: parsed.data });
      } else {
        emit({ ok: true, path: resolved, manifest: raw });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fail({ ok: false, kind: 'runtime', error: message });
    }
  });

function resolveManifestPath(pathArg: string | undefined): string {
  const cwd = process.cwd();
  if (!pathArg) {
    for (const name of DEFAULT_FILENAMES) {
      const candidate = path.join(cwd, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`No appliance manifest found in ${cwd}`);
  }

  const resolved = path.isAbsolute(pathArg) ? pathArg : path.resolve(cwd, pathArg);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    for (const name of DEFAULT_FILENAMES) {
      const candidate = path.join(resolved, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`No appliance manifest found in ${resolved}`);
  }
  return resolved;
}

function parseContext(raw: string | undefined): ManifestContext {
  const base: ManifestContext = {
    cwd: process.cwd(),
    env: { ...process.env },
  };
  if (!raw) return base;
  let parsed: Partial<ManifestContext>;
  try {
    parsed = JSON.parse(raw) as Partial<ManifestContext>;
  } catch (e) {
    throw new Error(`--ctx is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    cwd: parsed.cwd ?? base.cwd,
    variant: parsed.variant,
    project: parsed.project,
    environment: parsed.environment,
    env: { ...base.env, ...(parsed.env ?? {}) },
  };
}

function emit(payload: object): void {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function fail(payload: object): never {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(1);
}

program.parse(process.argv);
