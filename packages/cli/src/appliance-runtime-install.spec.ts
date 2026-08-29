import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PINNED_CATALOGUE_TRUST,
  type CatalogueBlacklist,
  type CatalogueIndex,
  type InstalledApp,
  type VerifiedCatalogue,
} from '@appliance.sh/sdk';
import {
  BlacklistedBundleError,
  UnknownPublisherError,
  assertBlacklistStaleness,
  blacklistRefreshDue,
  formatInstalledAppsTable,
  installBundle,
  unknownPublisherWarningDue,
  uninstallInstalledApp,
} from './appliance-runtime-install';
import { EntitlementGrantRequiredError, wslCooperativeGrantWarning } from './appliance-runtime-entitlements';
import { describeRuntimeApp } from './appliance-runtime-open';
import { readDevSigningKey } from './utils/bundle-sign';
import { latestEntitlement, readEntitlementStore } from './utils/entitlements';
import {
  immutableBundlePath,
  listInstalledTargets,
  readInstalledApps,
  upsertInstalledApp,
} from './utils/installed-apps';
import { tinyOciTar } from './utils/bundle-oci-fixture';
import { writeBundle } from './utils/bundle-write';

vi.mock('./utils/fs-acl.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./utils/fs-acl.js')>();
  return { ...original, restrictWindowsAcl: vi.fn() };
});

const roots: string[] = [];

it('shows the WSL bypass warning only for cooperative egress grants', () => {
  const details = {
    appId: 'journal',
    version: '1.0.0',
    license: 'MIT',
    upgrade: false,
    grants: [
      {
        id: 'egress:api.example.test',
        control: 'egress-host' as const,
        value: { host: 'api.example.test', ports: [443] },
        approvedAt: '2026-08-29T00:00:00.000Z',
      },
    ],
    requiredGrantIds: ['egress:api.example.test'],
  };
  expect(wslCooperativeGrantWarning(details, 'win32', 'cooperative')).toContain('WSL cooperative mode is bypassable');
  expect(wslCooperativeGrantWarning(details, 'win32', 'strict')).toBeNull();
  expect(wslCooperativeGrantWarning(details, 'darwin', 'cooperative')).toBeNull();
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function unsignedBundle(directory: string) {
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  return writeBundle({
    outputPath: path.join(directory, 'journal.appliance.zip'),
    manifest: {
      manifest: 'v2',
      kind: 'runnable',
      type: 'container',
      name: 'journal',
      version: '1.2.0',
      license: 'MIT',
      description: 'Private daily notes.',
      publisher: { name: 'Local developer' },
      payload: { images: { [platform]: { path: 'payload/image.tar' } } },
      env: {},
    },
    files: [{ path: 'payload/image.tar', data: tinyOciTar(platform) }],
  });
}

async function controlledBundle(directory: string, version: string, hosts: string[]) {
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  return writeBundle({
    outputPath: path.join(directory, `journal-${version}.appliance.zip`),
    manifest: {
      manifest: 'v2',
      kind: 'runnable',
      type: 'container',
      name: 'journal',
      version,
      license: 'MIT',
      description: 'Private daily notes.',
      publisher: { name: 'Local developer' },
      payload: { images: { [platform]: { path: 'payload/image.tar' } } },
      env: {},
      network: { egress: hosts.map((host) => ({ host, ports: [443] })) },
      mounts: [{ name: 'data', source: 'volume', guest: '/data', readOnly: false }],
    },
    files: [{ path: 'payload/image.tar', data: tinyOciTar(platform) }],
  });
}

function blacklist(appId: string): VerifiedCatalogue<CatalogueBlacklist> {
  return {
    payload: {
      schema: 'appliance.blacklist/v1',
      generation: 4,
      issuedAt: '2026-08-27T00:00:00.000Z',
      expiresAt: '2026-09-03T00:00:00.000Z',
      entries: [{ appId, reason: 'compromised' }],
    },
    envelope: { alg: 'ed25519', keyId: `ed25519:sha256:${'1'.repeat(64)}`, role: 'blacklist', sig: 'x' },
    stale: false,
    verifiedAt: '2026-08-28T00:00:00.000Z',
  };
}

describe('runtime install', () => {
  it('stores a fresh install under the NTFS-safe immutable bundle name', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-install-'));
    roots.push(directory);
    const root = path.join(directory, 'runtime');
    const bundle = await unsignedBundle(directory);
    const installed = await installBundle(bundle.outputPath, {
      root,
      target: 'local',
      acceptUnknownPublisher: true,
      verifiedBlacklist: null,
    });
    const expected = immutableBundlePath(bundle.digest, root);
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'installed', 'local', 'apps.json'), 'utf8')) as {
      apps: InstalledApp[];
    };
    expect(path.basename(installed.bundlePath)).toBe(`sha256-${bundle.digest.slice('sha256:'.length)}.appliance.zip`);
    expect(installed.bundlePath).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(stored.apps[0]?.bundlePath).toBe(expected);
  });

  it('requires explicit acceptance for an unsigned local bundle', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-install-'));
    roots.push(directory);
    const bundle = await unsignedBundle(directory);
    await expect(
      installBundle(bundle.outputPath, { root: path.join(directory, 'runtime'), verifiedBlacklist: null })
    ).rejects.toBeInstanceOf(UnknownPublisherError);
    expect(fs.existsSync(immutableBundlePath(bundle.digest, path.join(directory, 'runtime')))).toBe(false);
  });

  it('refuses a bundle selected by the verified blacklist', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-install-'));
    roots.push(directory);
    const bundle = await unsignedBundle(directory);
    await expect(
      installBundle(bundle.outputPath, {
        root: path.join(directory, 'runtime'),
        acceptUnknownPublisher: true,
        verifiedBlacklist: blacklist('journal'),
      })
    ).rejects.toBeInstanceOf(BlacklistedBundleError);
  });

  it('reports a valid signature without current index evidence as valid Unknown Publisher', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-install-'));
    roots.push(directory);
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyFile = path.join(directory, 'publisher.pem');
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const key = readDevSigningKey(keyFile);
    const unsigned = await unsignedBundle(directory);
    const signed = await writeBundle({
      outputPath: path.join(directory, 'signed.appliance.zip'),
      manifest: unsigned.manifest,
      files: [
        {
          path: 'payload/image.tar',
          data: tinyOciTar(process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'),
        },
      ],
      signingKeyPath: keyFile,
    });
    const policy = {
      ...PINNED_CATALOGUE_TRUST,
      keys: { ...PINNED_CATALOGUE_TRUST.keys, [key.keyId]: key.publicKeyWire },
    };
    const error = await installBundle(signed.outputPath, {
      root: path.join(directory, 'runtime'),
      verifiedBlacklist: null,
      policy,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UnknownPublisherError);
    expect((error as UnknownPublisherError).details.signature).toBe('valid');
  });

  it('refreshes blacklist evidence after six hours and fails network installs after seven stale days', () => {
    const verified = blacklist('journal');
    expect(blacklistRefreshDue(verified, new Date('2026-08-28T05:59:59.000Z'))).toBe(false);
    expect(blacklistRefreshDue(verified, new Date('2026-08-28T06:00:00.000Z'))).toBe(true);
    expect(() => assertBlacklistStaleness(verified, new Date('2026-09-10T00:00:00.001Z'), true)).toThrow(
      'more than seven days stale'
    );
  });

  it('accepts HTTPS only for URL installs', async () => {
    await expect(installBundle('http://journal.appliance.zip', { verifiedBlacklist: null })).rejects.toThrow(
      'must use HTTPS'
    );
  });

  it('refuses a catalogue digest mismatch before recording the app', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-install-'));
    roots.push(directory);
    const bundle = await unsignedBundle(directory);
    const url = 'https://journal.appliance.zip/';
    const entry = {
      id: 'journal',
      name: 'Journal',
      version: '1.2.0',
      description: 'Private daily notes.',
      license: 'MIT',
      publisher: { name: 'Local developer' },
      tier: 'known-publisher' as const,
      url,
      digest: `sha256:${'9'.repeat(64)}`,
    };
    const index: VerifiedCatalogue<CatalogueIndex> = {
      payload: {
        schema: 'appliance.catalogue-index/v1',
        generation: 8,
        issuedAt: '2026-08-27T00:00:00.000Z',
        expiresAt: '2026-09-03T00:00:00.000Z',
        entries: [entry],
      },
      envelope: { alg: 'ed25519', keyId: `ed25519:sha256:${'1'.repeat(64)}`, role: 'index', sig: 'x' },
      stale: false,
      verifiedAt: '2026-08-28T00:00:00.000Z',
    };
    const bytes = fs.readFileSync(bundle.outputPath);
    await expect(
      installBundle(url, {
        root: path.join(directory, 'runtime'),
        verifiedIndex: index,
        verifiedBlacklist: null,
        fetcher: async () => new Response(bytes, { status: 200 }),
      })
    ).rejects.toThrow('Catalogue digest mismatch');
  });

  it('requires a grant prompt before installing controlled bytes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-install-'));
    roots.push(directory);
    const root = path.join(directory, 'runtime');
    const bundle = await controlledBundle(directory, '1.0.0', ['api.example.test']);
    await expect(
      installBundle(bundle.outputPath, { root, acceptUnknownPublisher: true, verifiedBlacklist: null })
    ).rejects.toBeInstanceOf(EntitlementGrantRequiredError);
    expect(readInstalledApps('local', root)).toEqual([]);
    expect(fs.existsSync(immutableBundlePath(bundle.digest, root))).toBe(false);
  });

  it('uses an isolated runtime home for Windows install validation without a credential helper', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-install-win32-'));
    roots.push(directory);
    const root = path.join(directory, 'runtime');
    const unsigned = await unsignedBundle(directory);
    const controlled = await controlledBundle(directory, '1.0.0', ['api.example.test']);
    // Seed the key while the host platform is still active so this regression
    // can mock backend selection without invoking host-incompatible ACL tools.
    readEntitlementStore({ home: root });

    const { privateKey } = generateKeyPairSync('ed25519');
    const keyFile = path.join(directory, 'publisher-win32.pem');
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const key = readDevSigningKey(keyFile);
    const signed = await writeBundle({
      outputPath: path.join(directory, 'signed-win32.appliance.zip'),
      manifest: unsigned.manifest,
      files: [
        {
          path: 'payload/image.tar',
          data: tinyOciTar(process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'),
        },
      ],
      signingKeyPath: keyFile,
    });
    const policy = {
      ...PINNED_CATALOGUE_TRUST,
      keys: { ...PINNED_CATALOGUE_TRUST.keys, [key.keyId]: key.publicKeyWire },
    };
    const url = 'https://journal.appliance.zip/';
    const index: VerifiedCatalogue<CatalogueIndex> = {
      payload: {
        schema: 'appliance.catalogue-index/v1',
        generation: 8,
        issuedAt: '2026-08-27T00:00:00.000Z',
        expiresAt: '2026-09-03T00:00:00.000Z',
        entries: [
          {
            id: 'journal',
            name: 'Journal',
            version: '1.2.0',
            description: 'Private daily notes.',
            license: 'MIT',
            publisher: { name: 'Local developer' },
            tier: 'known-publisher',
            url,
            digest: `sha256:${'9'.repeat(64)}`,
          },
        ],
      },
      envelope: { alg: 'ed25519', keyId: `ed25519:sha256:${'1'.repeat(64)}`, role: 'index', sig: 'x' },
      stale: false,
      verifiedAt: '2026-08-28T00:00:00.000Z',
    };
    const bytes = fs.readFileSync(unsigned.outputPath);
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await expect(installBundle(unsigned.outputPath, { root, verifiedBlacklist: null })).rejects.toBeInstanceOf(
        UnknownPublisherError
      );
      await expect(
        installBundle(unsigned.outputPath, {
          root,
          acceptUnknownPublisher: true,
          verifiedBlacklist: blacklist('journal'),
        })
      ).rejects.toBeInstanceOf(BlacklistedBundleError);
      await expect(installBundle(signed.outputPath, { root, verifiedBlacklist: null, policy })).rejects.toBeInstanceOf(
        UnknownPublisherError
      );
      await expect(installBundle('http://journal.appliance.zip', { root, verifiedBlacklist: null })).rejects.toThrow(
        'must use HTTPS'
      );
      await expect(
        installBundle(url, {
          root,
          verifiedIndex: index,
          verifiedBlacklist: null,
          fetcher: async () => new Response(bytes, { status: 200 }),
        })
      ).rejects.toThrow('Catalogue digest mismatch');
      await expect(
        installBundle(controlled.outputPath, {
          root,
          acceptUnknownPublisher: true,
          verifiedBlacklist: null,
        })
      ).rejects.toBeInstanceOf(EntitlementGrantRequiredError);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });

  it('prompts only for an upgrade delta and preserves unchanged approval times', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-install-'));
    roots.push(directory);
    const root = path.join(directory, 'runtime');
    const initial = await controlledBundle(directory, '1.0.0', ['api.example.test']);
    await installBundle(initial.outputPath, {
      root,
      acceptUnknownPublisher: true,
      verifiedBlacklist: null,
      grantAll: true,
      now: new Date('2026-06-01T00:00:00.000Z'),
    });
    const before = latestEntitlement(readEntitlementStore({ home: root }).records, 'journal')!;
    const upgraded = await controlledBundle(directory, '1.1.0', ['api.example.test', 'sync.example.test']);
    let prompted: string[] = [];
    await installBundle(upgraded.outputPath, {
      root,
      acceptUnknownPublisher: true,
      verifiedBlacklist: null,
      now: new Date('2026-07-01T00:00:00.000Z'),
      confirmEntitlementGrants: async (details) => {
        prompted = details.grants.map((grant) => grant.id);
        return prompted;
      },
    });
    expect(prompted).toEqual(['egress:sync.example.test']);
    const after = latestEntitlement(readEntitlementStore({ home: root }).records, 'journal')!;
    expect(after.version).toBe('1.1.0');
    expect(after.grants.find((grant) => grant.id === 'egress:api.example.test')?.approvedAt).toBe(
      before.grants.find((grant) => grant.id === 'egress:api.example.test')?.approvedAt
    );
  });
});

describe('runtime uninstall/list', () => {
  function app(root: string, target: string): InstalledApp {
    return {
      appId: 'journal',
      version: '1.2.0',
      name: 'Journal',
      license: 'MIT',
      publisher: { name: 'Local developer', tier: 'unknown' },
      digest: `sha256:${'1'.repeat(64)}`,
      bundlePath: immutableBundlePath(`sha256:${'1'.repeat(64)}`, root),
      installedAt: '2026-08-28T00:00:00.000Z',
      source: target === 'local' ? 'file' : 'https://journal.appliance.zip/',
      verification: { signature: 'unsigned' },
      controlsSummary: {
        egressHosts: [],
        mounts: [],
        publishedPorts: [],
        resources: {},
        serviceCount: 1,
        serviceNames: [],
      },
    };
  }

  it('keeps the immutable bundle until the last target uninstalls it', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-uninstall-'));
    roots.push(directory);
    const root = path.join(directory, 'runtime');
    const local = app(root, 'local');
    fs.mkdirSync(path.dirname(local.bundlePath), { recursive: true });
    fs.writeFileSync(local.bundlePath, 'immutable');
    const extracted = path.join(root, 'apps', local.appId, local.version);
    fs.mkdirSync(extracted, { recursive: true });
    fs.writeFileSync(path.join(extracted, 'payload'), 'runtime payload');
    upsertInstalledApp('local', local, root);
    upsertInstalledApp('cloud', app(root, 'cloud'), root);
    await uninstallInstalledApp('Journal', { target: 'local', root });
    expect(fs.existsSync(local.bundlePath)).toBe(true);
    expect(fs.existsSync(extracted)).toBe(true);
    await uninstallInstalledApp('journal', { target: 'cloud', root });
    expect(fs.existsSync(local.bundlePath)).toBe(false);
    expect(fs.existsSync(extracted)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('uninstalls an owner-read-only immutable bundle', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-uninstall-'));
    roots.push(directory);
    const root = path.join(directory, 'runtime');
    const installed = app(root, 'local');
    fs.mkdirSync(path.dirname(installed.bundlePath), { recursive: true });
    fs.writeFileSync(installed.bundlePath, 'immutable', { mode: 0o400 });
    fs.chmodSync(installed.bundlePath, 0o400);
    upsertInstalledApp('local', installed, root);

    await uninstallInstalledApp('journal', { target: 'local', root });

    expect(fs.existsSync(installed.bundlePath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('lists and uninstalls a pre-existing legacy immutable bundle', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-uninstall-'));
    roots.push(directory);
    const root = path.join(directory, 'runtime');
    const bundle = await unsignedBundle(directory);
    const legacy = path.join(root, 'bundles', `${bundle.digest}.appliance.zip`);
    const installed = { ...app(root, 'local'), digest: bundle.digest, bundlePath: legacy };
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.copyFileSync(bundle.outputPath, legacy);
    upsertInstalledApp('local', installed, root);

    const listed = listInstalledTargets(root).flatMap((group) =>
      group.apps.map((listedApp) => ({ target: group.target, app: listedApp }))
    );
    expect(listed).toHaveLength(1);
    const listedApp = listed[0]!.app;
    expect(listedApp.bundlePath).toBe(legacy);
    expect(formatInstalledAppsTable(listed)).toContain('local\tJournal\t1.2.0');
    expect(describeRuntimeApp('journal', 'local', { installed: listedApp })).toMatchObject({
      appId: 'journal',
      version: '1.2.0',
    });

    await uninstallInstalledApp('journal', { target: 'local', root });
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('never deletes a non-canonical bundle path during uninstall', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-uninstall-'));
    roots.push(directory);
    const root = path.join(directory, 'runtime');
    const external = path.join(directory, 'user-owned.appliance.zip');
    fs.writeFileSync(external, 'keep me');
    const installed = { ...app(root, 'local'), bundlePath: external };
    upsertInstalledApp('local', installed, root);
    await uninstallInstalledApp('journal', { target: 'local', root });
    expect(fs.readFileSync(external, 'utf8')).toBe('keep me');
  });

  it('revokes effective policy even when the app is already stopped', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-uninstall-'));
    roots.push(directory);
    const root = path.join(directory, 'runtime');
    const installed = app(root, 'local');
    upsertInstalledApp('local', installed, root);
    const revoked: string[] = [];

    await uninstallInstalledApp('journal', {
      target: 'local',
      root,
      revokePolicy: (appId) => revoked.push(appId),
    });

    expect(revoked).toEqual(['journal']);
  });

  it('formats the per-target CLI table', () => {
    const row = app('/tmp/runtime', 'local');
    expect(formatInstalledAppsTable([{ target: 'local', app: row }])).toBe(
      'TARGET\tAPP\tVERSION\tLICENSE\tPUBLISHER\tINSTALLED\n' +
        'local\tJournal\t1.2.0\tMIT\tUnknown Publisher\t2026-08-28T00:00:00.000Z'
    );
  });

  it('re-warns an unknown publisher after the 30-day RFC cadence', () => {
    const row = app('/tmp/runtime', 'local');
    expect(unknownPublisherWarningDue(row, new Date('2026-09-01T00:00:00.000Z'))).toBe(true);
    row.lastWarnedAt = '2026-08-28T00:00:00.000Z';
    expect(unknownPublisherWarningDue(row, new Date('2026-09-01T00:00:00.000Z'))).toBe(false);
    expect(unknownPublisherWarningDue(row, new Date('2026-09-28T00:00:00.000Z'))).toBe(true);
  });
});
import { generateKeyPairSync } from 'node:crypto';
