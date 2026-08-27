import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockHost, mockHostEnabled } from './mock-host';

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
