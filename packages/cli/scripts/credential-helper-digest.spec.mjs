import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function checkArtifact(bytes, args = ['--', '--check']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'credhelper-artifact-'));
  directories.push(root);
  const scripts = path.join(root, 'packages/cli/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['credential-helper-digest.mjs', 'verify-credential-helper-digest.mjs']) {
    fs.copyFileSync(path.join(import.meta.dirname, name), path.join(scripts, name));
  }
  const manifest = path.join(scripts, 'credential-helper-checksums.json');
  const original = JSON.stringify({
    digests: { 'x86_64-pc-windows-msvc': createHash('sha256').update('canonical CI bytes').digest('hex') },
  });
  fs.writeFileSync(manifest, original);
  const artifact = path.join(root, 'helper.exe');
  if (bytes !== undefined) fs.writeFileSync(artifact, bytes);
  const result = spawnSync(process.execPath, [path.join(scripts, 'credential-helper-digest.mjs'), ...args], {
    encoding: 'utf8',
    // No compiler, rustup, tar, or sysroot is available in this fixture.
    env: { ...process.env, PATH: '', APPLIANCE_CREDHELPER_BINARY: artifact },
  });
  expect(fs.readFileSync(manifest, 'utf8')).toBe(original);
  return result;
}

describe('credential helper canonical artifact check', () => {
  it('checks canonical bytes without requiring a compiler on the consumer host', () => {
    const result = checkArtifact('canonical CI bytes');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Verified');
  });

  it('rejects substituted bytes without modifying the pin', () => {
    const result = checkArtifact('substituted bytes');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('do not match byte-for-byte');
  });

  it('rejects a missing artifact', () => {
    const result = checkArtifact(undefined);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing from the release layout');
  });

  it('does not let an artifact input regenerate the pin', () => {
    const result = checkArtifact('substituted bytes', []);
    expect(result.status).not.toBe(0);
  });
});
