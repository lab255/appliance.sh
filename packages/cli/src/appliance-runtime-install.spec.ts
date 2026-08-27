import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogueBlacklist, CatalogueIndex, InstalledApp, VerifiedCatalogue } from '@appliance.sh/sdk';
import {
  BlacklistedBundleError,
  UnknownPublisherError,
  formatInstalledAppsTable,
  installBundle,
  unknownPublisherWarningDue,
  uninstallInstalledApp,
} from './appliance-runtime-install';
import { immutableBundlePath, upsertInstalledApp } from './utils/installed-apps';
import { tinyOciTar } from './utils/bundle-oci-fixture';
import { writeBundle } from './utils/bundle-write';

const roots: string[] = [];

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
      controlsSummary: { egressHosts: [], mounts: [], publishedPorts: [], resources: {}, serviceCount: 1 },
    };
  }

  it('keeps the immutable bundle until the last target uninstalls it', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-uninstall-'));
    roots.push(directory);
    const root = path.join(directory, 'runtime');
    const local = app(root, 'local');
    fs.mkdirSync(path.dirname(local.bundlePath), { recursive: true });
    fs.writeFileSync(local.bundlePath, 'immutable');
    upsertInstalledApp('local', local, root);
    upsertInstalledApp('cloud', app(root, 'cloud'), root);
    await uninstallInstalledApp('Journal', { target: 'local', root });
    expect(fs.existsSync(local.bundlePath)).toBe(true);
    await uninstallInstalledApp('journal', { target: 'cloud', root });
    expect(fs.existsSync(local.bundlePath)).toBe(false);
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
