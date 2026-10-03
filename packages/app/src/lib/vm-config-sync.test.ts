import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { ConsoleHost, HostConfig } from './host';
import { subscribeToVmConfigChanges } from './vm-config-sync';

function fixture(id: string, apiServerUrl: string) {
  const config: HostConfig = {
    clusters: [{ id, name: id, apiServerUrl, createdAt: '' }],
    selectedClusterId: id,
    apiKey: { id: 'old-key', secret: 'old-secret' },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['host', 'config'], config);
  let finish!: (value: HostConfig) => void;
  let fail!: (error: Error) => void;
  const getConfig = vi.fn(
    () =>
      new Promise<HostConfig>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      })
  );
  const unsubscribe = subscribeToVmConfigChanges(client, { getConfig } as unknown as ConsoleHost);
  return {
    config,
    client,
    getConfig,
    finish: (value: HostConfig) => finish(value),
    fail: () => fail(new Error('registry unavailable')),
    unsubscribe,
  };
}

describe('VM status config refresh', () => {
  it.each(['local', 'microvm', 'microvm-test'])('detaches %s credentials before native GC returns', async (id) => {
    const f = fixture(id, 'http://api.appliance.localhost:8081');
    const name = id === 'microvm-test' ? 'test' : 'appliance';
    f.client.setQueryData(['microvm', name, 'status'], { available: true, exists: false });
    expect(f.client.getQueryData<HostConfig>(['host', 'config'])?.apiKey).toBeNull();
    expect(f.getConfig).toHaveBeenCalledOnce();
    f.client.setQueryData(['microvm', name, 'status'], { available: true, exists: false });
    expect(f.getConfig).toHaveBeenCalledOnce();
    f.finish({ clusters: [], selectedClusterId: null, apiKey: null });
    await vi.waitFor(() => expect(f.client.getQueryData<HostConfig>(['host', 'config'])?.clusters).toEqual([]));
    f.unsubscribe();
    f.client.clear();
  });

  it('keeps credentials withheld when the native refresh fails', async () => {
    const f = fixture('microvm', 'http://localhost:8081');
    f.client.setQueryData(['microvm', 'appliance', 'status'], { available: false, exists: false });
    expect(f.getConfig).toHaveBeenCalledOnce();
    f.fail();
    await vi.waitFor(() => expect(f.client.isFetching({ queryKey: ['host', 'config'] })).toBe(0));
    expect(f.client.getQueryData<HostConfig>(['host', 'config'])?.apiKey).toBeNull();
    f.unsubscribe();
    f.client.clear();
  });

  it('preserves remote local logins and stopped VMs', () => {
    const remote = fixture('local', 'https://remote.example');
    remote.client.setQueryData(['microvm', 'appliance', 'status'], { available: true, exists: false });
    expect(remote.getConfig).not.toHaveBeenCalled();
    expect(remote.client.getQueryData<HostConfig>(['host', 'config'])?.apiKey).not.toBeNull();
    const stopped = fixture('microvm', 'http://localhost:8081');
    stopped.client.setQueryData(['microvm', 'appliance', 'status'], { available: true, exists: true, running: false });
    expect(stopped.getConfig).not.toHaveBeenCalled();
    remote.unsubscribe();
    stopped.unsubscribe();
    remote.client.clear();
    stopped.client.clear();
  });
});
