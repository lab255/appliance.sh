import { describe, expect, it } from 'vitest';
import { selectDeployCluster } from './cluster-registry.js';

describe('selectDeployCluster', () => {
  it('preserves the deploy profile cascade', () => {
    expect(selectDeployCluster({ command: 'deploy' })).toBeUndefined();
    expect(
      selectDeployCluster({
        command: 'deploy',
        profile: 'flag',
        envProfile: 'environment',
        activeProfile: 'active',
      })
    ).toBe('flag');
    expect(selectDeployCluster({ command: 'deploy', envProfile: 'environment', activeProfile: 'active' })).toBe(
      'environment'
    );
    expect(selectDeployCluster({ command: 'deploy', activeProfile: 'active' })).toBe('active');
  });

  it('defaults install to local and honors explicit cluster selection', () => {
    expect(selectDeployCluster({ command: 'install', activeProfile: 'cloud' })).toBe('local');
    expect(selectDeployCluster({ command: 'install', cluster: 'staging', activeProfile: 'cloud' })).toBe('staging');
    expect(selectDeployCluster({ command: 'install', profile: 'legacy-flag', activeProfile: 'cloud' })).toBe(
      'legacy-flag'
    );
  });
});
