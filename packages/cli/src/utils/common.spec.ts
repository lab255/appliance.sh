import { afterEach, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import {
  extractApplianceFile,
  parseApplianceManifestForPrint,
  registerManifestOptions,
  resolveApplianceDir,
} from './common.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Builds a Command carrying the standard manifest options, parsed from
// user-style argv (no node/script prefix). exitOverride keeps a parse
// error throwing instead of killing the test process.
function cmdWith(args: string[]): Command {
  const cmd = new Command();
  cmd.exitOverride();
  registerManifestOptions(cmd);
  cmd.parse(args, { from: 'user' });
  return cmd;
}

// resolveApplianceDir decides the docker build context for local
// deploys. Regression guard for the bug where `appliance deploy -d app/`
// read the manifest from app/ but built `.` (cwd) — a missing Dockerfile.
describe('resolveApplianceDir', () => {
  it('defaults to cwd when neither --file nor --directory is given', () => {
    expect(resolveApplianceDir(cmdWith([]))).toBe(process.cwd());
  });

  it('resolves --directory relative to cwd', () => {
    expect(resolveApplianceDir(cmdWith(['--directory', 'app']))).toBe(path.resolve(process.cwd(), 'app'));
  });

  it("ignores the default --file sentinel so it doesn't override --directory", () => {
    // -f defaults to "appliance.json"; that sentinel must not win over -d.
    expect(resolveApplianceDir(cmdWith(['--directory', 'app']))).toBe(path.resolve(process.cwd(), 'app'));
  });

  it("uses an explicit --file's directory", () => {
    expect(resolveApplianceDir(cmdWith(['--file', 'svc/appliance.json']))).toBe(path.resolve(process.cwd(), 'svc'));
  });

  it('lets an explicit --file take precedence over --directory (mirrors manifest resolution)', () => {
    expect(resolveApplianceDir(cmdWith(['--directory', 'app', '--file', 'svc/x.json']))).toBe(
      path.resolve(process.cwd(), 'svc')
    );
  });
});

const manifestV2 = {
  manifest: 'v2',
  kind: 'runnable',
  type: 'container',
  name: 'printable-app',
  version: '1.0.0',
  license: 'MIT',
  publisher: { name: 'Publisher' },
  payload: { images: { 'linux/arm64': { path: 'payload/images/app.oci.tar' } } },
};

describe('manifest v2 command boundary', () => {
  it('parses manifest v2 for the manifest print path', () => {
    const result = parseApplianceManifestForPrint(manifestV2);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.manifest).toBe('v2');
  });

  it('keeps other loader consumers on v1 with a clear command error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-manifest-v2-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'appliance.json');
    fs.writeFileSync(file, JSON.stringify(manifestV2));
    const cmd = cmdWith(['--file', file]).name('build');

    const result = await extractApplianceFile(cmd);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toBe('manifest v2 is not yet supported by appliance build');
  });
});
