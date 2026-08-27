import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockHost } from './mock-host';

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
});
