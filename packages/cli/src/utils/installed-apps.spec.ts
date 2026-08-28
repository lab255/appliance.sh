import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstalledApp } from '@appliance.sh/sdk';
import {
  assertNtfsSafeBundleBasename,
  immutableBundlePath,
  isBundleReferenced,
  readInstalledApps,
  removeInstalledApp,
  resolveImmutableBundlePath,
  upsertInstalledApp,
} from './installed-apps';

const roots: string[] = [];

function fixture(root: string, overrides: Partial<InstalledApp> = {}): InstalledApp {
  return {
    appId: 'journal',
    version: '1.2.0',
    name: 'Journal',
    license: 'MIT',
    publisher: { name: 'Local developer', tier: 'unknown' },
    digest: `sha256:${'1'.repeat(64)}`,
    bundlePath: immutableBundlePath(`sha256:${'1'.repeat(64)}`, root),
    installedAt: '2026-08-28T00:00:00.000Z',
    source: 'file',
    verification: { signature: 'unsigned' },
    controlsSummary: {
      egressHosts: [],
      mounts: [],
      publishedPorts: [],
      resources: {},
      serviceCount: 1,
      serviceNames: [],
    },
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('installed app store', () => {
  it('uses an NTFS-safe immutable bundle basename', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(path.basename(immutableBundlePath(digest, '/runtime'))).toBe(`sha256-${'a'.repeat(64)}.appliance.zip`);
    expect(() => assertNtfsSafeBundleBasename(`sha256:${'a'.repeat(64)}.appliance.zip`)).toThrow(
      'NTFS-unsafe filename'
    );
    expect(() => assertNtfsSafeBundleBasename('bundle.appliance.zip.')).toThrow('NTFS-unsafe filename');
    expect(() => assertNtfsSafeBundleBasename('bundle.appliance.zip ')).toThrow('NTFS-unsafe filename');
  });

  it.skipIf(process.platform === 'win32')(
    'resolves legacy immutable bundle names when no canonical copy exists',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-installed-'));
      roots.push(root);
      const digest = `sha256:${'1'.repeat(64)}`;
      const canonical = immutableBundlePath(digest, root);
      const legacy = path.join(root, 'bundles', `${digest}.appliance.zip`);
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, 'legacy');
      expect(resolveImmutableBundlePath(digest, root)).toBe(legacy);
      fs.writeFileSync(canonical, 'canonical');
      expect(resolveImmutableBundlePath(digest, root)).toBe(canonical);
    }
  );

  it('round-trips atomically with owner-only permissions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-installed-'));
    roots.push(root);
    const app = fixture(root);
    upsertInstalledApp('local', app, root);
    expect(readInstalledApps('local', root)).toEqual([app]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(root, 'installed', 'local', 'apps.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps an immutable bundle while another target references it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-installed-'));
    roots.push(root);
    const app = fixture(root);
    upsertInstalledApp('local', app, root);
    upsertInstalledApp('cloud', app, root);
    expect(removeInstalledApp('local', app.appId, root)).toEqual(app);
    expect(isBundleReferenced(app.bundlePath, root)).toBe(true);
    expect(removeInstalledApp('cloud', app.appId, root)).toEqual(app);
    expect(isBundleReferenced(app.bundlePath, root)).toBe(false);
  });

  it('fails closed when a store document is malformed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-installed-'));
    roots.push(root);
    const directory = path.join(root, 'installed', 'local');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'apps.json'), '{"apps":[]}');
    expect(() => readInstalledApps('local', root)).toThrow('Installed-app store is invalid');
  });
});
