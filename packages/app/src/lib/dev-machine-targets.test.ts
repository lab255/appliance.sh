import { describe, expect, it } from 'vitest';
import { resolveDevMachineTargets } from './dev-machine-targets';
import type { Cluster } from './host';

const vm = { name: 'appliance', hostPort: 9443, running: true };

function cluster(id: string, apiServerUrl: string): Cluster {
  return { id, name: id, apiServerUrl, createdAt: '2026-01-01T00:00:00.000Z' };
}

describe('resolveDevMachineTargets', () => {
  it('transitions a core VM to one canonical deploy-target row', () => {
    expect(resolveDevMachineTargets([], []).state).toBe('none');

    const core = resolveDevMachineTargets([], [vm]);
    expect(core.state).toBe('core-machine');
    expect(core.machines).toEqual([vm]);
    expect(core.coreMachines).toEqual([vm]);
    expect(core.visibleClusters).toEqual([]);

    const registered = cluster('microvm', 'http://api.appliance.localhost:9443');
    const profileAlias = cluster('local', 'http://api.appliance.localhost:9443');
    const deployTarget = resolveDevMachineTargets([profileAlias, registered], [vm]);

    expect(deployTarget.state).toBe('deploy-target');
    expect(deployTarget.machines).toEqual([vm]);
    expect(deployTarget.coreMachines).toEqual([]);
    expect(deployTarget.visibleClusters).toEqual([registered]);
    expect(deployTarget.aliasToMicroVm.get('local')).toBe('microvm');
  });
});
