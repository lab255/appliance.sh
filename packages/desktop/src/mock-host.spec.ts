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
