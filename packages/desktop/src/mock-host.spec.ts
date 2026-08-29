import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockHost, mockHostEnabled } from './mock-host';
import { freeCatalogueEntries, verifyCatalogueIndexPair } from '@appliance.sh/sdk';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('mock host app mode', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
  });

  it('persists mode changes through the host capability', async () => {
    const host = createMockHost();
    expect(await host.appMode?.get()).toBe('developer');

    await host.appMode?.set('user');

    expect(await createMockHost().appMode?.get()).toBe('user');
  });

  it('provides local-first user-mode workspace scenario data', async () => {
    vi.stubGlobal('window', { location: { search: '?mock-host&scenario=user-mode' } });
    expect(mockHostEnabled()).toBe(true);

    const host = createMockHost();
    const config = await host.getConfig();
    expect(config.clusters.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'microvm', name: 'Dev Machine' },
      { id: 'mock-acme-prod', name: 'acme-prod' },
    ]);
    expect(config.selectedClusterId).toBe('microvm');
  });

  it('provides a user-mode scenario without a local VM', async () => {
    vi.stubGlobal('window', { location: { search: '?mock-host&scenario=user-mode-no-vm' } });
    expect(mockHostEnabled()).toBe(true);

    const host = createMockHost();
    expect((await host.getConfig()).clusters.map((cluster) => cluster.name)).toEqual(['acme-prod']);
    expect(await host.vm?.list()).toEqual([]);
    expect(await host.appMode?.get()).toBe('user');
  });
});

describe('mock host platform', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
  });

  it.each(['macos', 'windows', 'linux'] as const)('reads ?platform=%s', (platform) => {
    vi.stubGlobal('window', { location: { search: `?mock-host&platform=${platform}` } });
    expect(mockHostEnabled()).toBe(true);
    expect(createMockHost().platform).toBe(platform);
  });

  it.each(['?mock-host', '?mock-host&platform=plan9'])('defaults %s to macos', (search) => {
    vi.stubGlobal('window', { location: { search } });
    expect(mockHostEnabled()).toBe(true);
    expect(createMockHost().platform).toBe('macos');
  });

  it('exposes the Windows Claude install-copy fixture', async () => {
    vi.stubGlobal('window', { location: { search: '?mock-host&platform=windows' } });
    expect(mockHostEnabled()).toBe(true);

    await expect(createMockHost().agentAuth?.hasHostClaude()).resolves.toBe(false);
  });
});

describe('mock host catalogue scenarios', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
  });

  async function verifyScenario(name: string) {
    sessionStorage.setItem('mock-host:scenario', name);
    const pair = await createMockHost().catalogue!.fetchCatalogue();
    const verified = await verifyCatalogueIndexPair({
      indexBytes: new TextEncoder().encode(pair.indexJson),
      envelopeBytes: new TextEncoder().encode(pair.signatureJson),
      policy: pair.developmentTrustPolicy!,
      allowExpired: true,
    });
    return verified;
  }

  it('serves a runtime-signed verified fixture with paid entries removed at the trust boundary', async () => {
    const verified = await verifyScenario('catalogue');
    expect(verified.stale).toBe(false);
    expect(freeCatalogueEntries(verified.payload).some((entry) => entry.paid)).toBe(false);
  });

  it('serves a bad signature for the unverified scenario', async () => {
    await expect(verifyScenario('catalogue-unverified')).rejects.toMatchObject({ code: 'bad-signature' });
  });

  it('serves a correctly signed expired pair for the stale scenario', async () => {
    await expect(verifyScenario('catalogue-stale')).resolves.toMatchObject({ stale: true });
  });
});

describe('mock host installed-app scenarios', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
  });

  async function hostFor(scenario: string) {
    vi.stubGlobal('window', { location: { search: `?mock-host&scenario=${scenario}` }, open: vi.fn() });
    expect(mockHostEnabled()).toBe(true);
    return createMockHost();
  }

  it('provides populated and empty per-workspace stores', async () => {
    const populated = await hostFor('installed-apps');
    expect(await populated.installedApps?.list('microvm')).toHaveLength(3);

    sessionStorage.clear();
    const empty = await hostFor('installed-apps-empty');
    expect(await empty.installedApps?.list('microvm')).toEqual([]);
  });

  it('requires explicit acceptance for the unknown-publisher fixture', async () => {
    const host = await hostFor('unknown-publisher');
    await expect(host.installedApps?.installBundle('/tmp/local.appliance.zip', 'microvm')).rejects.toEqual(
      expect.stringContaining('UNKNOWN_PUBLISHER:')
    );
    await expect(
      host.installedApps?.installBundle('/tmp/local.appliance.zip', 'microvm', { acceptUnknownPublisher: true })
    ).resolves.toMatchObject({ publisher: { tier: 'unknown' } });
  });

  it('serves the grant-prompt scenario and accepts an explicit checkbox selection', async () => {
    const host = await hostFor('grant-prompt');
    await expect(host.installedApps?.installBundle('/tmp/local.appliance.zip', 'microvm')).rejects.toEqual(
      expect.stringContaining('ENTITLEMENT_GRANT_REQUIRED:')
    );
    await expect(
      host.installedApps?.installBundle('/tmp/local.appliance.zip', 'microvm', {
        grantIds: ['egress:sync.example.com', 'port:web', 'resources:runtime'],
      })
    ).resolves.toMatchObject({ appId: 'journal-import' });
  });

  it('rejects install failures with the same plain string shape as Tauri invoke', async () => {
    const host = await hostFor('install-error');
    await expect(host.installedApps?.installBundle('C:\\x.zip', 'microvm')).rejects.toBe(
      'Bundle is not a regular file: C:\\x.zip'
    );
  });

  it('serves and revokes the suggested-revocation scenario', async () => {
    const host = await hostFor('entitlements-suggest-revoke');
    expect(await host.entitlements?.suggestions()).toHaveLength(1);
    await host.entitlements?.revoke('journal', 'egress:api.example.com');
    expect(await host.entitlements?.suggestions()).toEqual([]);
  });

  it('provides running and exited dedicated-window scenarios', async () => {
    const running = await hostFor('app-window');
    const runningApp = (await running.installedApps!.list('microvm'))[0]!;
    expect(runningApp).toMatchObject({ state: 'running', ui: { type: 'web', port: 'web' } });
    await expect(running.installedApps!.windowStatus('journal', 'microvm')).resolves.toMatchObject({
      appId: 'journal',
      state: 'running',
      hostPort: 8443,
      egressHostCount: 2,
    });

    sessionStorage.clear();
    const exited = await hostFor('app-exited');
    expect((await exited.installedApps!.list('microvm'))[0]).toMatchObject({ state: 'exited', exitCode: 17 });
  });
});
