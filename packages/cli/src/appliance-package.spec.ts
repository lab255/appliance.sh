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

describe('Workbench packaging protocol (real CLI)', () => {
  function binaryWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-package-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'payload/bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'payload/bin/review'), '#!/bin/sh\necho review\n');
    fs.writeFileSync(
      path.join(dir, 'appliance.json'),
      JSON.stringify({
        manifest: 'v2',
        kind: 'runnable',
        type: 'binary',
        name: 'workbench-review',
        version: '1.0.0',
        license: 'MIT',
        publisher: { name: 'Local developer' },
        payload: { targets: { 'linux/arm64': { root: 'payload/bin', entrypoint: 'review' } } },
      })
    );
    return dir;
  }
  function run(dir: string, extra: string[] = []) {
    const out = path.join(dir, 'review.appliance.zip');
    const process = spawnSync(
      'bun',
      ['src/appliance.ts', 'builder', 'package', '--directory', dir, '--out', out, '--json', ...extra],
      {
        cwd: globalThis.process.cwd(),
        encoding: 'utf8',
        env: { ...globalThis.process.env, NO_COLOR: '1' },
      }
    );
    const events = process.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { process, events, out };
  }
  it('returns verified unsigned bytes and real stages, without installing or deploying', () => {
    const dir = binaryWorkspace();
    const { process, events, out } = run(dir);
    expect(process.status, process.stderr).toBe(0);
    const artifact = events.at(-1).result;
    expect(events.filter((e) => e.type === 'stage').map((e) => e.message)).toEqual([
      'Validating manifest…',
      'Staging runnable payloads…',
      'Writing unsigned hand-off file…',
      'Verifying hand-off file…',
    ]);
    expect(artifact.signatureStatus).toBe('unsigned');
    expect(artifact.outputPath).toBe(out);
    expect(artifact.digest).toBe(verifyBundle(out).digest);
    expect(artifact.keyId).toBeUndefined();
    expect(fs.readdirSync(dir).sort()).toEqual(['appliance.json', 'payload', 'review.appliance.zip']);
  });
  it('signs with a local Ed25519 key and returns the verified digest/key ID', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { readDevSigningKey } = await import('./utils/bundle-sign.js');
    const dir = binaryWorkspace();
    const key = path.join(dir, 'developer.pem');
    fs.writeFileSync(key, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    const { process, events, out } = run(dir, ['--sign', key]);
    expect(process.status, process.stderr).toBe(0);
    const artifact = events.at(-1).result;
    expect(artifact.signatureStatus).toBe('signed');
    expect(artifact.keyId).toBe(readDevSigningKey(key).keyId);
    expect(verifyBundle(out, { publicKey: readDevSigningKey(key).publicKey }).signature?.valid).toBe(true);
    expect(artifact.digest).toBe(verifyBundle(out).digest);
  });
  it('rejects v1 with the engine error and never emits a success result or file', () => {
    const dir = binaryWorkspace();
    fs.writeFileSync(
      path.join(dir, 'appliance.json'),
      JSON.stringify({ manifest: 'v1', type: 'container', name: 'source' })
    );
    const { process, events, out } = run(dir);
    expect(process.status).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: expect.stringContaining('manifest v1 source project'),
    });
    expect(events.some((e) => e.type === 'result')).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });
  it('fails closed on an invalid configured signing key', () => {
    const dir = binaryWorkspace();
    const key = path.join(dir, 'invalid.pem');
    fs.writeFileSync(key, 'not a key');
    const { process, events, out } = run(dir, ['--sign', key]);
    expect(process.status).toBe(1);
    expect(events.at(-1).type).toBe('error');
    expect(events.some((e) => e.type === 'result')).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });
});
