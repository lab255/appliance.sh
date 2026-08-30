import * as aws from '@pulumi/aws';
import * as awsNative from '@pulumi/aws-native';
import * as pulumi from '@pulumi/pulumi';
import { ApplianceBaseType, applianceBaseConfig } from '@appliance.sh/sdk';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplianceStack, assertAwsEdgeProvisioned } from './ApplianceStack';

interface RegisteredResource {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

const resources: RegisteredResource[] = [];

beforeAll(async () => {
  await pulumi.runtime.setMocks(
    {
      call: (args) => ({ ...args.inputs, id: `mock-${args.token.split(':').at(-1)}` }),
      newResource: (args) => {
        resources.push({ type: args.type, name: args.name, inputs: args.inputs });
        const state: Record<string, unknown> = { ...args.inputs };
        if (args.type === 'aws:iam/role:Role') {
          state.name = args.name;
          state.arn = `arn:aws:iam::123456789012:role${String(args.inputs.path)}${args.name}`;
        }
        if (args.type === 'aws:iam/policy:Policy') {
          state.name = args.name;
          state.arn = `arn:aws:iam::123456789012:policy${String(args.inputs.path)}${args.name}`;
        }
        if (args.type === 'aws:lambda/function:Function') {
          state.name = args.name;
          state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.name}`;
        }
        if (args.type === 'aws:lambda/functionUrl:FunctionUrl') state.functionUrl = 'https://function.example';
        return { id: `${args.name}-id`, state };
      },
    },
    'appliance-stack-test',
    'unit'
  );
});

beforeEach(() => {
  resources.length = 0;
});

describe('assertAwsEdgeProvisioned', () => {
  it('refuses an ordinary workload during the substrate-only epoch', () => {
    const substrateConfig = applianceBaseConfig.parse({
      name: 'prod',
      type: ApplianceBaseType.ApplianceAwsPublic,
      provisioner: 'cloudformation-v1',
      stateBackendUrl: 's3://prod-state',
      aws: { region: 'us-east-1', dataBucketName: 'prod-data' },
    });

    expect(() => assertAwsEdgeProvisioned(substrateConfig)).toThrow(/provision the edge base first/i);
  });
});

describe('ApplianceStack', () => {
  it('uses the scoped role path, boundary output, and policy path for the no-build branch', async () => {
    const config = applianceBaseConfig.parse({
      name: 'prod',
      type: ApplianceBaseType.ApplianceAwsPublic,
      provisioner: 'cloudformation-v1',
      stateBackendUrl: 's3://prod-state',
      domainName: 'example.com',
      aws: {
        region: 'us-east-1',
        zoneId: 'Z123',
        cloudfrontDistributionId: 'DIST123',
        cloudfrontDistributionDomainName: 'distribution.cloudfront.net',
        dataBucketName: 'prod-data',
        userAppliancePermissionsBoundaryArn:
          'arn:aws:iam::123456789012:policy/appliance-system/prod-user-appliance-boundary',
      },
    });
    const regionalProvider = new aws.Provider('regional-provider', { region: 'us-east-1' });
    const globalProvider = new aws.Provider('global-provider', { region: 'us-east-1' });
    const nativeProvider = new awsNative.Provider('native-provider', { region: 'us-east-1' });
    const nativeGlobalProvider = new awsNative.Provider('native-global-provider', { region: 'us-east-1' });

    const stack = new ApplianceStack(
      'sample',
      { config },
      { provider: regionalProvider, globalProvider, nativeProvider, nativeGlobalProvider }
    );
    await stack.lambda.arn.promise();

    const role = resources.find((resource) => resource.type === 'aws:iam/role:Role');
    expect(role?.inputs).toMatchObject({
      path: '/appliance/sample/',
      permissionsBoundary: 'arn:aws:iam::123456789012:policy/appliance-system/prod-user-appliance-boundary',
      tags: { 'appliance:managed': 'true' },
    });

    const policy = resources.find((resource) => resource.type === 'aws:iam/policy:Policy');
    expect(policy?.inputs).toMatchObject({ path: '/appliance/sample/', tags: { 'appliance:managed': 'true' } });

    const lambda = resources.find((resource) => resource.type === 'aws:lambda/function:Function');
    expect(lambda?.inputs.role).toContain('role/appliance/sample/');
  }, 20_000);
});
