import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyBundle } from './utils/bundle-read.js';
import { tinyOciTar } from './utils/bundle-oci-fixture.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('appliance package', () => {
  it('packages a manifest v2 fixture with --image pointing at a generated tiny tarball', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-package-cli-'));
    dirs.push(dir);
    const tarPath = path.join(dir, 'tiny.oci.tar');
    fs.writeFileSync(tarPath, tinyOciTar());
    fs.writeFileSync(
      path.join(dir, 'appliance.json'),
      JSON.stringify({
        manifest: 'v2',
        kind: 'runnable',
        type: 'container',
        name: 'tiny-fixture',
        version: '1.0.0',
        license: 'MIT',
        publisher: { name: 'Fixture' },
        payload: { images: { 'linux/amd64': { path: 'payload/images/tiny.oci.tar' } } },
      })
    );
    const output = path.join(dir, 'tiny-fixture.appliance.zip');
    const result = spawnSync(
      'bun',
      ['src/appliance.ts', 'package', '--directory', dir, '--image', tarPath, '--out', output],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Packaged:');
    expect(verifyBundle(output).manifest.name).toBe('tiny-fixture');
  });

  it('explains that manifest v1 remains a source build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-package-v1-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'appliance.json'),
      JSON.stringify({ manifest: 'v1', type: 'container', name: 'source' })
    );
    const result = spawnSync('bun', ['src/appliance.ts', 'builder', 'package', '--directory', dir], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('manifest v1 source project');
    expect(result.stderr).toContain('appliance build');
  });
});
