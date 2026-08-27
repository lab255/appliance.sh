import { applianceV2Input } from '@appliance.sh/sdk';
import { describe, expect, it } from 'vitest';
import {
  manifestToRuntimePlan,
  manifestToRuntimePolicy,
  prefixServiceLog,
  runtimePoolRestartRequired,
  sanitizeRuntimeLog,
} from './appliance-runtime.js';

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

  it('flattens a compound graph, resolves health ports, injects discovery, and publishes only the primary host port', () => {
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
      env: {
        APPLIANCE_SVC_API_URL: 'http://127.0.0.1:9000',
        APPLIANCE_SVC_API_API_URL: 'http://127.0.0.1:9000',
        APPLIANCE_SVC_WEB_URL: 'http://127.0.0.1:3000',
      },
    });
    expect(plan.ports).toMatchObject([{ name: 'web.http', guest: 3000, host: 20000 }]);
  });

  it('rejects dedicated-VM placement before Runtime preparation', () => {
    expect(() =>
      manifestToRuntimePlan(compoundManifest('vm'), '/tmp/notes-suite', '192.168.127.10', 20000, [], 'x64')
    ).toThrow('isolation: vm, which is not yet supported');
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
  });
});
