import { describe, expect, it } from 'vitest';
import { applianceV2Input } from './appliance-v2';

const imagePayload = (name = 'app') => ({
  images: { 'linux/arm64': { path: `payload/images/${name}-linux-arm64.oci.tar` } },
});

const binaryPayload = (name = 'app') => ({
  targets: {
    'linux/arm64': { root: `payload/${name}/linux-arm64`, entrypoint: `bin/${name}` },
  },
});

const base = (type: 'container' | 'binary' | 'compound') => ({
  manifest: 'v2' as const,
  kind: 'runnable' as const,
  type,
  name: 'test-app',
  version: '1.2.3',
  license: 'MIT',
  publisher: { name: 'Test Publisher' },
});

const worker = (name = 'worker') => ({ type: 'container' as const, payload: imagePayload(name) });

const journal = {
  manifest: 'v2',
  kind: 'runnable',
  type: 'container',
  name: 'journal',
  version: '1.4.2',
  license: 'MIT',
  description: 'Private daily journal with AI summaries',
  publisher: {
    name: 'Lab 255',
    keyId: 'ed25519:sha256:6d4d0c8f6b9c5be36d4d0c8f6b9c5be36d4d0c8f6b9c5be36d4d0c8f6b9c5be3',
  },
  payload: imagePayload('journal'),
  ui: { type: 'web', port: 'http', path: '/' },
  ports: [{ name: 'http', guest: 3000, protocol: 'tcp', expose: 'host' }],
  network: {
    egress: [
      { host: 'api.openai.com', ports: [443] },
      { host: 'cdn.jsdelivr.net', ports: [443] },
    ],
  },
  mounts: [{ name: 'data', source: 'volume', guest: '/data', readOnly: false }],
  resources: { cpus: 1, memoryMib: 512, diskGib: 2 },
  env: { JOURNAL_LOCALE: 'en-GB' },
};

const dashboard = {
  manifest: 'v2',
  kind: 'runnable',
  type: 'binary',
  name: 'dashboard',
  version: '0.9.0',
  license: 'Apache-2.0',
  publisher: {
    name: 'Acme',
    keyId: 'ed25519:sha256:41ab3286fe2a914041ab3286fe2a914041ab3286fe2a914041ab3286fe2a9140',
  },
  payload: {
    targets: {
      'linux/arm64': {
        root: 'payload/dashboard/linux-arm64',
        entrypoint: 'bin/dashboard',
        args: ['--listen', '0.0.0.0:8080'],
      },
    },
  },
  native: {
    macos: {
      unsandboxed: true,
      targets: {
        'macos/arm64': {
          root: 'payload/dashboard/macos-arm64',
          entrypoint: 'Dashboard.app/Contents/MacOS/Dashboard',
          args: [],
        },
      },
    },
  },
  ui: { type: 'web', port: 'http', path: '/' },
  platforms: [],
  ports: [{ name: 'http', guest: 8080, protocol: 'tcp', expose: 'host' }],
};

const notesSuite = {
  manifest: 'v2',
  kind: 'runnable',
  type: 'compound',
  name: 'notes-suite',
  version: '2.0.0',
  license: 'AGPL-3.0-only',
  publisher: { name: 'Lab 255' },
  ui: { type: 'web', service: 'web', port: 'http', path: '/' },
  services: {
    web: {
      type: 'container',
      payload: imagePayload('web'),
      ports: [{ name: 'http', guest: 3000, protocol: 'tcp', expose: 'host' }],
      network: { egress: [{ host: 'fonts.gstatic.com', ports: [443] }] },
    },
    indexer: {
      type: 'binary',
      isolation: 'vm',
      payload: binaryPayload('indexer'),
      ports: [{ name: 'grpc', guest: 9000, protocol: 'tcp', expose: 'internal', primary: true }],
      mounts: [{ name: 'index', source: 'volume', guest: '/index', readOnly: false }],
    },
  },
};

describe('appliance manifest v2', () => {
  it.each([
    ['journal container', journal],
    ['dashboard binary', dashboard],
    ['notes-suite compound', notesSuite],
  ])('parses the RFC %s example', (_name, manifest) => {
    const result = applianceV2Input.safeParse(manifest);
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  it('rejects unknown keys at the root and in nested objects', () => {
    expect(applianceV2Input.safeParse({ ...journal, credentials: {} }).success).toBe(false);
    expect(applianceV2Input.safeParse({ ...journal, publisher: { name: 'Lab 255', extra: true } }).success).toBe(false);
    expect(
      applianceV2Input.safeParse({
        ...journal,
        payload: { images: { 'linux/arm64': { path: 'payload/image.tar', extra: true } } },
      }).success
    ).toBe(false);
  });

  it('selects exactly the declared container, binary, or compound branch', () => {
    expect(applianceV2Input.safeParse({ ...base('container'), payload: imagePayload() }).success).toBe(true);
    expect(applianceV2Input.safeParse({ ...base('binary'), payload: binaryPayload() }).success).toBe(true);
    expect(applianceV2Input.safeParse({ ...base('compound'), services: { worker: worker() } }).success).toBe(true);
    expect(applianceV2Input.safeParse({ ...base('container'), payload: binaryPayload() }).success).toBe(false);
  });

  it('requires Linux payload platforms even when a macOS target exists', () => {
    const manifest = {
      ...base('binary'),
      payload: { targets: { 'macos/arm64': binaryPayload().targets['linux/arm64'] } },
      native: dashboard.native,
    };
    expect(applianceV2Input.safeParse(manifest).success).toBe(false);
  });

  it('accepts root depth zero through service depth two and rejects depth three', () => {
    const depthTwo = {
      ...base('compound'),
      services: { group: { type: 'compound', services: { worker: worker() } } },
    };
    expect(applianceV2Input.safeParse(depthTwo).success).toBe(true);
    const depthThree = {
      ...base('compound'),
      services: {
        group: { type: 'compound', services: { nested: { type: 'compound', services: { worker: worker() } } } },
      },
    };
    expect(applianceV2Input.safeParse(depthThree).success).toBe(false);
  });

  it('counts runnable leaves only and caps them at 16', () => {
    const leaves = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`worker-${index}`, worker(`worker-${index}`)])
    );
    const sixteen = { ...base('compound'), services: { group: { type: 'compound', services: leaves } } };
    expect(applianceV2Input.safeParse(sixteen).success).toBe(true);
    const seventeen = { ...base('compound'), services: { ...leaves, overflow: worker('overflow') } };
    expect(applianceV2Input.safeParse(seventeen).success).toBe(false);
  });

  it('requires DNS-label keys and globally unique runnable leaf names', () => {
    expect(applianceV2Input.safeParse({ ...base('compound'), services: { Bad_Name: worker() } }).success).toBe(false);
    const duplicateLeaf = {
      ...base('compound'),
      services: {
        one: { type: 'compound', services: { api: worker('one-api') } },
        two: { type: 'compound', services: { api: worker('two-api') } },
      },
    };
    expect(applianceV2Input.safeParse(duplicateLeaf).success).toBe(false);
  });

  it('defaults the web UI port to primary and requires one primary for other port arrays', () => {
    const parsed = applianceV2Input.parse(journal);
    expect(parsed.ports?.[0].primary).toBe(true);
    expect(
      applianceV2Input.safeParse({ ...base('container'), payload: imagePayload(), ports: journal.ports }).success
    ).toBe(false);
    expect(
      applianceV2Input.safeParse({
        ...journal,
        ports: [
          { ...journal.ports[0], primary: true },
          { name: 'admin', guest: 3001, protocol: 'tcp', expose: 'host', primary: true },
        ],
      }).success
    ).toBe(false);
  });

  it('resolves UI, dependency, and health references and rejects dependency cycles', () => {
    const valid = {
      ...base('compound'),
      ui: { type: 'web', service: 'web', port: 'http' },
      services: {
        web: {
          ...worker('web'),
          ports: [{ name: 'http', guest: 3000, protocol: 'tcp', expose: 'host' }],
          dependsOn: ['api'],
          health: { type: 'http', port: 'http', path: '/healthz' },
        },
        api: { ...worker('api'), dependsOn: [] },
      },
    };
    expect(applianceV2Input.safeParse(valid).success).toBe(true);
    expect(
      applianceV2Input.safeParse({
        ...valid,
        services: { ...valid.services, api: { ...valid.services.api, dependsOn: ['web'] } },
      }).success
    ).toBe(false);
    expect(
      applianceV2Input.safeParse({
        ...valid,
        services: { ...valid.services, web: { ...valid.services.web, health: { type: 'tcp', port: 'missing' } } },
      }).success
    ).toBe(false);
    expect(
      applianceV2Input.safeParse({ ...valid, ui: { type: 'web', service: 'missing', port: 'http' } }).success
    ).toBe(false);
  });

  it('applies lifecycle defaults and enforces lifecycle placement and ranges', () => {
    const parsed = applianceV2Input.parse({ ...base('compound'), services: { worker: worker() } });
    const service = parsed.type === 'compound' ? parsed.services.worker : undefined;
    expect(service).toMatchObject({
      dependsOn: [],
      required: true,
      restart: { policy: 'on-failure', maxAttempts: 5, backoffSeconds: 2 },
    });
    expect(
      applianceV2Input.safeParse({
        ...base('compound'),
        services: { group: { type: 'compound', dependsOn: [], services: { worker: worker() } } },
      }).success
    ).toBe(false);
    expect(
      applianceV2Input.safeParse({
        ...base('compound'),
        services: {
          worker: { ...worker(), health: { type: 'exec', command: ['check'], intervalSeconds: 2, timeoutSeconds: 3 } },
        },
      }).success
    ).toBe(false);
  });

  it('requires a current single SPDX ID and strict SemVer', () => {
    expect(applianceV2Input.safeParse({ ...journal, license: 'MIT OR Apache-2.0' }).success).toBe(false);
    expect(applianceV2Input.safeParse({ ...journal, license: 'Not-A-License' }).success).toBe(false);
    expect(applianceV2Input.safeParse({ ...journal, version: 'v1.4.2' }).success).toBe(false);
    expect(applianceV2Input.safeParse({ ...journal, version: '1.4.2-beta.1+build.7' }).success).toBe(true);
  });

  it('enforces normalized payload, asset, URL, and mount paths', () => {
    expect(applianceV2Input.safeParse({ ...journal, assets: { icon: 'assets/icon.svg' } }).success).toBe(false);
    expect(
      applianceV2Input.safeParse({ ...journal, payload: { images: { 'linux/arm64': { path: '../image.tar' } } } })
        .success
    ).toBe(false);
    expect(
      applianceV2Input.safeParse({ ...journal, ui: { type: 'web', port: 'http', path: 'https://example.com' } }).success
    ).toBe(false);
    expect(
      applianceV2Input.safeParse({
        ...journal,
        mounts: [{ name: 'bad', source: 'volume', guest: '/proc/data', readOnly: false }],
      }).success
    ).toBe(false);
    expect(
      applianceV2Input.safeParse({
        ...journal,
        mounts: [
          { name: 'data', source: 'volume', guest: '/data', readOnly: false },
          { name: 'nested', source: 'host', guest: '/data/nested', readOnly: true, suggestedPath: '/Users/me/data' },
        ],
      }).success
    ).toBe(false);
  });

  it('requires the native macOS unsandboxed opt-in and known target keys', () => {
    expect(
      applianceV2Input.safeParse({ ...dashboard, native: { macos: { targets: dashboard.native.macos.targets } } })
        .success
    ).toBe(false);
    expect(
      applianceV2Input.safeParse({
        ...dashboard,
        native: {
          macos: {
            ...dashboard.native.macos,
            targets: { 'darwin-arm64': dashboard.native.macos.targets['macos/arm64'] },
          },
        },
      }).success
    ).toBe(false);
  });

  it('requires publisher.name, permits an unsigned publisher without keyId, and validates key IDs', () => {
    expect(applianceV2Input.safeParse({ ...journal, publisher: {} }).success).toBe(false);
    expect(applianceV2Input.safeParse({ ...journal, publisher: { name: 'Unsigned Publisher' } }).success).toBe(true);
    expect(applianceV2Input.safeParse({ ...journal, publisher: { name: 'Publisher', keyId: 'bad-key' } }).success).toBe(
      false
    );
    expect(applianceV2Input.safeParse({ ...journal, signature: { alg: 'ed25519' } }).success).toBe(false);
  });

  it('rejects duplicate/ranged controls and forbidden egress forms', () => {
    expect(
      applianceV2Input.safeParse({ ...journal, network: { egress: [{ host: '127.0.0.1', ports: [443] }] } }).success
    ).toBe(false);
    expect(
      applianceV2Input.safeParse({ ...journal, network: { egress: [{ host: 'com', ports: [443] }] } }).success
    ).toBe(false);
    expect(
      applianceV2Input.safeParse({ ...journal, network: { egress: [{ host: 'example.com', ports: [443, 443] }] } })
        .success
    ).toBe(false);
    expect(applianceV2Input.safeParse({ ...journal, resources: { cpus: 33 } }).success).toBe(false);
  });
});
