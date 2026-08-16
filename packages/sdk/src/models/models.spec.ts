import { describe, it, expect } from 'vitest';
import {
  projectInput,
  ProjectStatus,
  environmentInput,
  EnvironmentStatus,
  deploymentInput,
  DeploymentAction,
  DeploymentStatus,
  apiKeyInput,
  apiKeyCreateResponse,
  applianceInput,
  applianceBaseConfig,
  applianceBaseConfigInput,
  ApplianceType,
  ApplianceFramework,
  ApplianceBaseType,
} from '../index';

describe('projectInput schema', () => {
  it('should accept valid input with name only', () => {
    const result = projectInput.safeParse({ name: 'my-project' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('my-project');
      expect(result.data.description).toBeUndefined();
    }
  });

  it('should accept valid input with name and description', () => {
    const result = projectInput.safeParse({ name: 'my-project', description: 'A test project' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe('A test project');
    }
  });

  it('should reject input without name', () => {
    const result = projectInput.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should reject non-string name', () => {
    const result = projectInput.safeParse({ name: 123 });
    expect(result.success).toBe(false);
  });
});

describe('deploymentInput schema', () => {
  it('should accept valid deploy action', () => {
    const result = deploymentInput.safeParse({
      environmentId: 'env-123',
      action: DeploymentAction.Deploy,
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid destroy action', () => {
    const result = deploymentInput.safeParse({
      environmentId: 'env-123',
      action: DeploymentAction.Destroy,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid action', () => {
    const result = deploymentInput.safeParse({
      environmentId: 'env-123',
      action: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing environmentId', () => {
    const result = deploymentInput.safeParse({
      action: DeploymentAction.Deploy,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an explicit edge target with create or attach zone inputs', () => {
    expect(
      deploymentInput.safeParse({
        environmentId: 'env-edge',
        action: DeploymentAction.Deploy,
        target: { type: 'edge', domainName: 'example.com', zone: { mode: 'create' } },
      }).success
    ).toBe(true);
    expect(
      deploymentInput.safeParse({
        environmentId: 'env-edge',
        action: DeploymentAction.Deploy,
        target: {
          type: 'edge',
          domainName: 'example.com',
          zone: { mode: 'attach', hostedZoneId: 'Z123' },
        },
      }).success
    ).toBe(true);
  });

  it('refuses workload build/runtime fields on an edge target', () => {
    const result = deploymentInput.safeParse({
      environmentId: 'env-edge',
      action: DeploymentAction.Deploy,
      target: { type: 'edge', domainName: 'example.com', zone: { mode: 'create' } },
      buildId: 'build-1',
      memory: 2048,
    });
    expect(result.success).toBe(false);
  });
});

describe('apiKeyInput schema', () => {
  it('should accept valid name', () => {
    const result = apiKeyInput.safeParse({ name: 'cli' });
    expect(result.success).toBe(true);
  });

  it('should reject missing name', () => {
    const result = apiKeyInput.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('apiKeyCreateResponse schema', () => {
  it('should accept valid response', () => {
    const result = apiKeyCreateResponse.safeParse({
      id: 'ak_test',
      name: 'cli',
      secret: 'sk_abc123',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('should reject response missing secret', () => {
    const result = apiKeyCreateResponse.safeParse({
      id: 'ak_test',
      name: 'cli',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('applianceInput schema', () => {
  it('should accept valid framework appliance', () => {
    const result = applianceInput.safeParse({
      manifest: 'v1',
      name: 'my-app',
      type: ApplianceType.framework,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe(ApplianceType.framework);
      if (result.data.type === ApplianceType.framework) {
        expect(result.data.framework).toBe('auto');
      }
    }
  });

  it('should accept valid container appliance with port', () => {
    const result = applianceInput.safeParse({
      manifest: 'v1',
      name: 'my-container',
      type: ApplianceType.container,
      port: 8080,
    });
    expect(result.success).toBe(true);
  });

  it('should reject container without port', () => {
    const result = applianceInput.safeParse({
      manifest: 'v1',
      name: 'my-container',
      type: ApplianceType.container,
    });
    expect(result.success).toBe(false);
  });

  it('should accept other type appliance', () => {
    const result = applianceInput.safeParse({
      manifest: 'v1',
      name: 'my-other',
      type: ApplianceType.other,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid manifest version', () => {
    const result = applianceInput.safeParse({
      manifest: 'v2',
      name: 'test',
      type: ApplianceType.framework,
    });
    expect(result.success).toBe(false);
  });

  it('should reject container with invalid port', () => {
    const result = applianceInput.safeParse({
      manifest: 'v1',
      name: 'test',
      type: ApplianceType.container,
      port: 0,
    });
    expect(result.success).toBe(false);
  });

  it('should reject container with port above 65535', () => {
    const result = applianceInput.safeParse({
      manifest: 'v1',
      name: 'test',
      type: ApplianceType.container,
      port: 70000,
    });
    expect(result.success).toBe(false);
  });

  it('should accept framework with optional fields', () => {
    const result = applianceInput.safeParse({
      manifest: 'v1',
      name: 'my-app',
      type: ApplianceType.framework,
      framework: ApplianceFramework.Node,
      port: 3000,
      includes: ['src/**'],
      excludes: ['node_modules'],
    });
    expect(result.success).toBe(true);
  });
});

describe('environmentInput schema', () => {
  // Environments inherit the cluster's base config from the
  // api-server (APPLIANCE_BASE_CONFIG); callers only name the
  // environment and its project.
  it('should accept valid environment input', () => {
    const result = environmentInput.safeParse({
      name: 'production',
      projectId: 'proj-123',
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing projectId', () => {
    const result = environmentInput.safeParse({
      name: 'production',
    });
    expect(result.success).toBe(false);
  });

  it('should reject an invalid DNS name', () => {
    const result = environmentInput.safeParse({
      name: 'Not A DNS Name!',
      projectId: 'proj-123',
    });
    expect(result.success).toBe(false);
  });
});

describe('enum values', () => {
  it('should have correct ProjectStatus values', () => {
    expect(ProjectStatus.Active).toBe('active');
    expect(ProjectStatus.Archived).toBe('archived');
  });

  it('should have correct EnvironmentStatus values', () => {
    expect(EnvironmentStatus.Pending).toBe('pending');
    expect(EnvironmentStatus.Deploying).toBe('deploying');
    expect(EnvironmentStatus.Deployed).toBe('deployed');
    expect(EnvironmentStatus.Destroying).toBe('destroying');
    expect(EnvironmentStatus.Destroyed).toBe('destroyed');
    expect(EnvironmentStatus.Failed).toBe('failed');
  });

  it('should have correct DeploymentAction values', () => {
    expect(DeploymentAction.Deploy).toBe('deploy');
    expect(DeploymentAction.Destroy).toBe('destroy');
  });

  it('should have correct DeploymentStatus values', () => {
    expect(DeploymentStatus.Pending).toBe('pending');
    expect(DeploymentStatus.InProgress).toBe('in_progress');
    expect(DeploymentStatus.Succeeded).toBe('succeeded');
    expect(DeploymentStatus.Failed).toBe('failed');
  });
});

describe('applianceBaseConfigInput discriminated union', () => {
  it('accepts an aws-public input shape', () => {
    const result = applianceBaseConfigInput.safeParse({
      type: ApplianceBaseType.ApplianceAwsPublic,
      name: 'prod-base',
      region: 'us-east-1',
      dns: { domainName: 'example.com' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an appliance-base-local input with no dns or region', () => {
    const result = applianceBaseConfigInput.safeParse({
      type: ApplianceBaseType.ApplianceLocal,
      name: 'dev-local',
      cluster: { clusterName: 'appliance-local', namespace: 'appliance', hostPort: 8081 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe(ApplianceBaseType.ApplianceLocal);
    }
  });

  it('rejects an unknown base type', () => {
    const result = applianceBaseConfigInput.safeParse({
      type: 'appliance-base-mars',
      name: 'mars',
    });
    expect(result.success).toBe(false);
  });
});

describe('applianceBaseConfig persisted shape', () => {
  it('accepts a local persisted config with a dataDir', () => {
    const result = applianceBaseConfig.safeParse({
      type: ApplianceBaseType.ApplianceLocal,
      name: 'dev-local',
      local: { dataDir: '/tmp/appliance-local' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a cloud persisted config without local block', () => {
    const result = applianceBaseConfig.safeParse({
      type: ApplianceBaseType.ApplianceAwsPublic,
      name: 'prod',
      stateBackendUrl: 's3://my-bucket',
      aws: { region: 'us-east-1', zoneId: 'Z123' },
    });
    expect(result.success).toBe(true);
  });
});
