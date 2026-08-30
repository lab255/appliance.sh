import { describe, expect, it } from 'vitest';
import { cloudBuildImageTag } from './build.service';

describe('cloud build image tags', () => {
  it('uses the lifecycle-scoped workload prefix', () => {
    expect(cloudBuildImageTag('project-prod-deployment_123')).toBe('build-project-prod-deployment_123');
  });
});
