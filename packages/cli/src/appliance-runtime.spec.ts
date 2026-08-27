import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applianceV2Input } from '@appliance.sh/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  manifestToRuntimePlan,
  manifestToRuntimePolicy,
  sanitizeRuntimeLog,
  stageAndVerifyRuntimeOpenCopy,
} from './appliance-runtime.js';
import { tinyOciTar } from './utils/bundle-oci-fixture.js';
import { writeBundle } from './utils/bundle-write.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function manifest(resources: Record<string, number> = {}) {
  return applianceV2Input.parse({
    manifest: 'v2',
    kind: 'runnable',
    type: 'container',
    name: 'journal',
    version: '1.2.3',
    license: 'MIT',
    publisher: { name: 'Lab 255' },
    payload: {
      images: {
        'linux/arm64': { path: 'payload/journal.oci.tar' },
        'linux/amd64': { path: 'payload/journal.oci.tar' },
      },
    },
    ports: [{ name: 'http', guest: 3000, protocol: 'tcp', expose: 'host', primary: true }],
    resources,
  });
}

describe('manifest to pooled runtime plan', () => {
  it('targets published ports at the principal /32 and maps resources to cgroup hints', () => {
    const plan = manifestToRuntimePlan(
      manifest({ cpus: 2, memoryMib: 1024, diskGib: 4 }),
      '/tmp/journal',
      '192.168.127.10',
      20000,
      [{ name: 'http', host: 20000, guest: 3000, protocol: 'tcp' }]
    );
    expect(plan.ports).toEqual([
      {
        name: 'http',
        host: 20000,
        guest: 3000,
        protocol: 'tcp',
        relay: 22000,
        target: '192.168.127.10',
      },
    ]);
    expect(plan.resources).toEqual({ cpus: 2, memoryMib: 1024, diskGib: 4, pids: 256 });
    expect(plan.share).toMatchObject({ readOnly: true, hostPath: '/tmp/journal' });
    expect(plan.share.tag).toMatch(/^ap-[0-9a-f]{32}$/);
  });

  it('applies RFC defaults without changing the 2 CPU / 4 GiB pool size', () => {
    expect(
      manifestToRuntimePlan(manifest(), '/tmp/journal', '192.168.127.10', 20000, [
        { name: 'http', host: 20000, guest: 3000, protocol: 'tcp' },
      ]).resources
    ).toEqual({ cpus: 1, memoryMib: 512, diskGib: 2, pids: 256 });
  });

  it('bounds relay allocation to one 16-port principal slice', () => {
    const value = manifest();
    value.ports = Array.from({ length: 17 }, (_, index) => ({
      name: `p${index}`,
      guest: 3000 + index,
      protocol: 'tcp' as const,
      expose: 'host' as const,
      primary: index === 0,
    }));
    expect(() =>
      manifestToRuntimePlan(
        value,
        '/tmp/journal',
        '192.168.127.10',
        20000,
        value.ports.map((port, index) => ({ ...port, host: 20000 + index }))
      )
    ).toThrow('at most 16 ports');
  });
});

describe('manifest to effective Runtime policy', () => {
  it('installs a default-deny principal policy with normalized host/port grants', () => {
    const value = manifest();
    value.network = {
      egress: [
        { host: '*.example.com', ports: [443, 80] },
        { host: 'example.com', ports: [443] },
      ],
    };
    expect(manifestToRuntimePolicy(value, '192.168.127.10')).toEqual({
      version: 1,
      app: 'journal',
      vm: 'appliance-runtime',
      principal: 'journal',
      source: '192.168.127.10',
      policy: { default: 'deny', allow: ['example.com'], deny: [], mitm: false },
      allowPorts: { 'example.com': [80, 443] },
    });
  });

  it('rewrites effective policy as the intersection after an egress revoke', () => {
    const value = manifest();
    value.network = {
      egress: [
        { host: 'api.example.test', ports: [443] },
        { host: 'sync.example.test', ports: [443] },
      ],
    };
    const effective = manifestToRuntimePolicy(value, '192.168.127.10', [
      {
        id: 'egress:api.example.test',
        control: 'egress-host',
        value: { host: 'api.example.test', ports: [443] },
        approvedAt: '2026-08-28T00:00:00.000Z',
      },
    ]);
    expect(effective.policy.allow).toEqual(['api.example.test']);
    expect(effective.allowPorts).toEqual({ 'api.example.test': [443] });
  });
});

describe('runtime log rendering', () => {
  it('strips ANSI and terminal control bytes while preserving lines and tabs', () => {
    expect(sanitizeRuntimeLog('\u001b[31mred\u001b[0m\u0000\u0007\tline\nnext\u007f')).toBe('red\tline\nnext');
  });
});

describe('runtime immutable pre-open copy', () => {
  it('hashes the exact staged bytes and rejects a stored digest mismatch before open', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-preopen-'));
    roots.push(root);
    const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
    const bundleManifest = manifest();
    bundleManifest.payload.images = { [platform]: { path: 'payload/journal.oci.tar' } };
    const bundle = await writeBundle({
      outputPath: path.join(root, 'journal.appliance.zip'),
      manifest: bundleManifest,
      files: [{ path: 'payload/journal.oci.tar', data: tinyOciTar(platform) }],
    });
    const opened = stageAndVerifyRuntimeOpenCopy(bundle.outputPath, bundle.digest, path.join(root, 'preopen'));
    fs.appendFileSync(bundle.outputPath, 'source changed after copy');
    expect(opened.loaded.digest).toBe(bundle.digest);
    expect(fs.readFileSync(opened.bundlePath).includes(Buffer.from('source changed after copy'))).toBe(false);
    expect(() =>
      stageAndVerifyRuntimeOpenCopy(opened.bundlePath, `sha256:${'f'.repeat(64)}`, path.join(root, 'preopen-mismatch'))
    ).toThrow('exact immutable pre-open copy');
  });
});
