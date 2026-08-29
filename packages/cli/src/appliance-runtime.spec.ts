import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applianceV2Input } from '@appliance.sh/sdk';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertRuntimeRunEntitled,
  decideRuntimeWslEgress,
  manifestToRuntimePlan,
  manifestToRuntimePolicy,
  prefixServiceLog,
  runtimePoolRestartRequired,
  rewriteEffectivePolicyAfterRevocation,
  sanitizeRuntimeLog,
  stageAndVerifyRuntimeOpenCopy,
  WSL_COOPERATIVE_WARNING,
  type EffectiveRuntimePolicy,
} from './appliance-runtime.js';
import { tinyOciTar } from './utils/bundle-oci-fixture.js';
import { writeBundle } from './utils/bundle-write.js';
import {
  grantManifestEntitlements,
  latestEntitlement,
  readEntitlementStore,
  requestedGrantsForManifest,
  revokeEntitlementGrant,
} from './utils/entitlements.js';
import { wslModeCommandArgs } from './utils/runtime-wsl-egress.js';

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

function binaryManifest(platform: 'linux/amd64' | 'linux/arm64' = 'linux/amd64') {
  return applianceV2Input.parse({
    manifest: 'v2',
    kind: 'runnable',
    type: 'binary',
    name: 'dashboard',
    version: '1.0.0',
    license: 'MIT',
    publisher: { name: 'Lab 255' },
    payload: {
      targets: {
        [platform]: {
          root: `payload/dashboard/${platform.slice('linux/'.length)}`,
          entrypoint: 'bin/dashboard',
          args: ['--listen', '0.0.0.0:8080'],
        },
      },
    },
    env: { DASHBOARD_MODE: 'live' },
    ports: [{ name: 'http', guest: 8080, protocol: 'tcp', expose: 'host', primary: true }],
  });
}

function compoundManifest(isolation: 'shared' | 'vm' = 'shared') {
  return applianceV2Input.parse({
    manifest: 'v2',
    kind: 'runnable',
    type: 'compound',
    name: 'notes-suite',
    version: '2.0.0',
    license: 'MIT',
    publisher: { name: 'Lab 255' },
    ui: { type: 'web', service: 'web', port: 'http', path: '/' },
    services: {
      web: {
        type: 'container',
        isolation,
        payload: {
          images: {
            'linux/amd64': { path: 'payload/web/web-amd64.oci.tar' },
            'linux/arm64': { path: 'payload/web/web-arm64.oci.tar' },
          },
        },
        dependsOn: ['api'],
        ports: [{ name: 'http', guest: 3000, protocol: 'tcp', expose: 'host' }],
        health: { type: 'http', port: 'http', path: '/healthz' },
      },
      api: {
        type: 'binary',
        payload: {
          targets: {
            'linux/amd64': { root: 'payload/api/amd64', entrypoint: 'bin/api' },
            'linux/arm64': { root: 'payload/api/arm64', entrypoint: 'bin/api' },
          },
        },
        ports: [{ name: 'api', guest: 9000, protocol: 'tcp', expose: 'internal', primary: true }],
        health: { type: 'tcp', port: 'api', intervalSeconds: 1, timeoutSeconds: 1, failureThreshold: 2 },
        restart: { policy: 'always', maxAttempts: 7, backoffSeconds: 3 },
      },
    },
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

  it('routes a binary manifest to an explicit host-architecture target', () => {
    const plan = manifestToRuntimePlan(
      binaryManifest(),
      '/tmp/dashboard',
      '192.168.127.10',
      20000,
      [{ name: 'http', host: 20000, guest: 8080, protocol: 'tcp' }],
      'x64'
    );
    expect(plan).toMatchObject({
      kind: 'binary',
      target: {
        path: 'payload/dashboard/amd64',
        entrypoint: 'bin/dashboard',
        args: ['--listen', '0.0.0.0:8080'],
        env: { DASHBOARD_MODE: 'live' },
        cwd: '.',
      },
    });
  });

  it('rejects the wrong binary architecture before VM boot and names the manifest fix', () => {
    expect(() =>
      manifestToRuntimePlan(binaryManifest('linux/arm64'), '/tmp/dashboard', '192.168.127.10', 20000, [], 'x64')
    ).toThrow('add payload.targets["linux/amd64"] and repackage');
  });

  it('flattens a compound graph, resolves health ports, and publishes only the primary host port', () => {
    const plan = manifestToRuntimePlan(
      compoundManifest(),
      '/tmp/notes-suite',
      '192.168.127.10',
      20000,
      [{ name: 'web.http', host: 20000, guest: 3000, protocol: 'tcp' }],
      'x64'
    );
    expect(plan.kind).toBe('compound');
    if (plan.kind !== 'compound') throw new Error('expected compound plan');
    expect(plan.services.map((service) => service.name)).toEqual(['api', 'web']);
    expect(plan.services.find((service) => service.name === 'web')).toMatchObject({
      dependsOn: ['api'],
      health: { type: 'http', port: 3000, path: '/healthz' },
      env: {},
    });
    expect(plan.ports).toMatchObject([{ name: 'web.http', guest: 3000, host: 20000 }]);
  });

  it('rejects dedicated-VM placement before Runtime preparation', () => {
    expect(() =>
      manifestToRuntimePlan(compoundManifest('vm'), '/tmp/notes-suite', '192.168.127.10', 20000, [], 'x64')
    ).toThrow('isolation: vm, which is not yet supported');
  });

  it('rejects leaf-level egress because compound leaves share one principal', () => {
    const value = compoundManifest();
    value.services.api.network = { egress: [{ host: 'api.example.com', ports: [443] }] };
    expect(() => manifestToRuntimePlan(value, '/tmp/notes-suite', '192.168.127.10', 20000, [], 'x64')).toThrow(
      'compound apps declare network.egress at the root (shared principal); move api.network.egress to the top level'
    );
  });

  it('translates the source-only notes-suite example without Docker', () => {
    const value = applianceV2Input.parse(
      JSON.parse(readFileSync(new URL('../../../examples/runtime/notes-suite/appliance.json', import.meta.url), 'utf8'))
    );
    const plan = manifestToRuntimePlan(
      value,
      '/tmp/notes-suite',
      '192.168.127.10',
      20000,
      [{ name: 'web.http', host: 20000, guest: 3000, protocol: 'tcp' }],
      'x64'
    );
    expect(plan).toMatchObject({
      kind: 'compound',
      services: [{ name: 'api' }, { name: 'web' }],
      ports: [{ name: 'web.http', host: 20000, guest: 3000 }],
    });
  });
});

describe('manifest to effective Runtime policy', () => {
  it('routes wsl-mode reads and writes through the per-VM engine command', () => {
    expect(wslModeCommandArgs(undefined)).toEqual(['egress', 'wsl-mode', '--name', 'appliance-runtime']);
    expect(wslModeCommandArgs('cooperative', 'runtime-two')).toEqual([
      'egress',
      'wsl-mode',
      'cooperative',
      '--name',
      'runtime-two',
    ]);
  });

  it('refuses WSL egress grants in strict mode and permits cooperative mode with the bypass warning', () => {
    const strict = decideRuntimeWslEgress('journal', { enforcement: { backend: 'wsl' }, wslMode: 'strict' }, true);
    expect(strict).toEqual({
      action: 'refuse',
      message:
        "Runtime start refused on WSL: 'journal' requests egress grants, but wsl-mode is strict. " +
        'Opt in to bypassable proxy enforcement with `appliance vm egress wsl-mode cooperative`.',
    });
    expect(
      decideRuntimeWslEgress('journal', { enforcement: { backend: 'wsl' }, wslMode: 'cooperative' }, true)
    ).toEqual({ action: 'allow', warning: WSL_COOPERATIVE_WARNING });
  });

  it('allows a networkless WSL app in strict mode and leaves non-WSL backends unchanged', () => {
    expect(decideRuntimeWslEgress('journal', { enforcement: { backend: 'wsl' }, wslMode: 'strict' }, false)).toEqual({
      action: 'allow',
      firstRunNotice:
        'WSL strict mode: this app requests no egress grants, so it may run; its outbound traffic is dropped.',
    });
    expect(decideRuntimeWslEgress('journal', { enforcement: { backend: 'vz' }, wslMode: 'strict' }, true)).toEqual({
      action: 'allow',
    });
  });

  it('fails closed on Windows when an old engine omits or malforms the enforcement backend', () => {
    const expected = {
      action: 'refuse',
      message:
        "Runtime start refused on WSL: 'journal' cannot verify wsl-mode because the engine is too old for wsl-mode; " +
        'update appliance-vm.',
    };
    expect(decideRuntimeWslEgress('journal', {}, true, 'win32')).toEqual(expected);
    expect(decideRuntimeWslEgress('journal', { enforcement: { backend: undefined } }, true, 'win32')).toEqual(expected);
    expect(decideRuntimeWslEgress('journal', {}, true, 'darwin')).toEqual({ action: 'allow' });
  });

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

  it('rechecks the runtime-run grant and refuses a revoke that races policy installation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-runtime-entitlement-'));
    roots.push(root);
    const value = manifest({ cpus: 1 });
    const ids = requestedGrantsForManifest(value).map((grant) => grant.id);
    grantManifestEntitlements(value, 'cli', ids, { home: root });
    expect(assertRuntimeRunEntitled(value, root).map((grant) => grant.id)).toEqual(ids);

    revokeEntitlementGrant('journal', 'port:http', { home: root });
    expect(() => assertRuntimeRunEntitled(value, root)).toThrow(
      'Runtime start refused: required control is not granted: published port http 3000/tcp (port:http).'
    );
  });

  it('rewrites the live policy from the post-revoke grant and does not stop for a mount revoke', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-runtime-revoke-'));
    roots.push(root);
    const value = manifest();
    value.network = {
      egress: [
        { host: 'api.example.test', ports: [443] },
        { host: 'sync.example.test', ports: [443] },
      ],
    };
    value.mounts = [{ name: 'data', source: 'volume', guest: '/data', readOnly: false }];
    grantManifestEntitlements(
      value,
      'cli',
      requestedGrantsForManifest(value).map((grant) => grant.id),
      { home: root }
    );
    revokeEntitlementGrant('journal', 'egress:api.example.test', { home: root });
    const installed: EffectiveRuntimePolicy[] = [];
    const stopped: string[][] = [];
    const dependencies = {
      readRuntimeRecords: () => [
        {
          appId: 'journal',
          version: '1.2.3',
          state: 'running' as const,
          principalIp: '192.168.127.10',
          hostPorts: [],
          startedAt: '2026-08-28T00:00:00.000Z',
          updatedAt: '2026-08-28T00:00:00.000Z',
          poolVm: 'appliance-runtime',
          poolRestartPending: false,
          bundlePath: '/tmp/journal.appliance.zip',
          installDir: '/tmp/journal',
          shareTag: 'ap-journal',
          uid: 20000,
        },
      ],
      readManifest: () => value,
      readCurrentGrants: () => latestEntitlement(readEntitlementStore({ home: root }).records, 'journal')!.grants,
      installPolicy: (policy: EffectiveRuntimePolicy) => installed.push(policy),
      stopRuntime: (args: string[]) => stopped.push(args),
    };
    rewriteEffectivePolicyAfterRevocation('journal', 'egress:api.example.test', dependencies);
    expect(installed[0]?.policy.allow).toEqual(['sync.example.test']);
    expect(stopped).toEqual([]);

    revokeEntitlementGrant('journal', 'mount:data', { home: root });
    rewriteEffectivePolicyAfterRevocation('journal', 'mount:data', dependencies);
    expect(stopped).toEqual([]);
  });
});

describe('runtime log rendering', () => {
  it('strips ANSI and terminal control bytes while preserving lines and tabs', () => {
    expect(sanitizeRuntimeLog('\u001b[31mred\u001b[0m\u0000\u0007\tline\nnext\u007f')).toBe('red\tline\nnext');
  });

  it('prefixes every compound service log line', () => {
    expect(prefixServiceLog('api', 'ready\nrequest\n')).toBe('[api] ready\n[api] request\n');
  });
});

describe('runtime pool share reconciliation', () => {
  it('restarts for a replaced compound install without changing legacy single-workload behavior', () => {
    expect(runtimePoolRestartRequired('compound', true, false)).toBe(true);
    expect(runtimePoolRestartRequired('container', true, false)).toBe(false);
    expect(runtimePoolRestartRequired('binary', true, false)).toBe(false);
    expect(runtimePoolRestartRequired('container', false, true)).toBe(true);
    expect(runtimePoolRestartRequired('compound', true, false, true)).toBe(false);
    expect(runtimePoolRestartRequired('compound', true, true, true)).toBe(true);
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
