import * as pulumi from '@pulumi/pulumi';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplianceEdgeBase } from './ApplianceEdgeBase';
import { ApplianceSystemSubstrate } from './ApplianceSystemSubstrate';

interface RegisteredResource {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

const resources: RegisteredResource[] = [];

beforeAll(async () => {
  await pulumi.runtime.setMocks(
    {
      call: (args) => {
        if (args.token === 'aws:index/getPartition:getPartition') return { partition: 'aws' };
        if (args.token === 'aws:index/getCallerIdentity:getCallerIdentity') {
          return { accountId: '123456789012', arn: 'arn:aws:iam::123456789012:root', userId: 'root' };
        }
        return { ...args.inputs, id: `mock-${args.token.split(':').at(-1)}` };
      },
      newResource: (args) => {
        resources.push({ type: args.type, name: args.name, inputs: args.inputs });
        const state: Record<string, unknown> = { ...args.inputs };
        if (args.type === 'aws:iam/role:Role') {
          state.name = args.name;
          state.arn = `arn:aws:iam::123456789012:role/${args.name}`;
        }
        if (args.type === 'aws:acm/certificate:Certificate') {
          state.arn = `arn:aws:acm:us-east-1:123456789012:certificate/${args.name}`;
          state.domainValidationOptions = [
            {
              resourceRecordName: `_validation.${args.name}`,
              resourceRecordType: 'CNAME',
              resourceRecordValue: 'validation.example.test',
            },
          ];
        }
        if (args.type === 'aws:route53/record:Record') state.fqdn = String(args.inputs.name);
        if (args.type === 'aws:acm/certificateValidation:CertificateValidation') {
          state.certificateArn = args.inputs.certificateArn;
        }
        if (args.type === 'aws:lambda/function:Function') {
          state.name = args.name;
          state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.name}`;
          state.qualifiedArn = `${state.arn}:1`;
          state.version = '1';
        }
        if (args.type === 'aws:cloudfront/distribution:Distribution') {
          state.arn = `arn:aws:cloudfront::123456789012:distribution/${args.name}`;
          state.domainName = `${args.name}.cloudfront.net`;
        }
        return { id: `${args.name}-id`, state };
      },
    },
    'edge-test',
    'unit'
  );
});

beforeEach(() => {
  resources.length = 0;
});

describe('ApplianceEdgeBase', () => {
  // Pulumi's mock runtime resolves the full resource graph in this test;
  // ~1.3s locally but the default 5s deadline flakes on loaded CI runners.
  it(
    'creates edge-only resources, system routing, NONE permissions, and the edge-role invoke grant',
    { timeout: 20_000 },
    async () => {
      const substrate = new ApplianceSystemSubstrate({
        installationName: 'prod',
        region: 'us-east-1',
        stateBackendUrl: 's3://prod-state',
        stateBucketName: 'prod-state',
        stateBucketArn: 'arn:aws:s3:::prod-state',
        dataBucketName: 'prod-data',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/key-1',
        kmsAliasName: 'alias/appliance/prod-state',
        ecrRepositoryUrl: '123456789012.dkr.ecr.us-east-1.amazonaws.com/prod',
        userAppliancePermissionsBoundaryArn:
          'arn:aws:iam::123456789012:policy/appliance-system/prod-user-appliance-boundary',
        systemRoleArns: {
          apiServer: 'arn:aws:iam::123456789012:role/prod-api',
          worker: 'arn:aws:iam::123456789012:role/prod-worker',
        },
        systemFunctions: {
          apiServer: {
            name: 'prod-api',
            arn: 'arn:aws:lambda:us-east-1:123456789012:function:prod-api',
            url: 'https://api-id.lambda-url.us-east-1.on.aws/',
          },
          worker: {
            name: 'prod-worker',
            arn: 'arn:aws:lambda:us-east-1:123456789012:function:prod-worker',
            url: 'https://worker-id.lambda-url.us-east-1.on.aws/',
          },
        },
      });

      const edge = new ApplianceEdgeBase('prod-edge', {
        substrate,
        domain: { domainName: 'example.com', zone: { mode: 'attach', hostedZoneId: 'Z123' } },
      });
      const config = await edge.config.promise();
      await pulumi.all([edge.systemApiCname.fqdn, edge.systemApiOrigin.fqdn]).promise();

      const forbiddenTypes = [
        'aws:s3/bucket:Bucket',
        'aws:kms/key:Key',
        'aws:kms/alias:Alias',
        'aws:ecr/repository:Repository',
      ];
      expect(resources.filter((resource) => forbiddenTypes.includes(resource.type))).toEqual([]);

      const functions = resources.filter((resource) => resource.type === 'aws:lambda/function:Function');
      expect(functions).toHaveLength(1);
      expect(functions[0]?.name).toContain('edge-router');

      const distribution = resources.find((resource) => resource.type === 'aws:cloudfront/distribution:Distribution');
      expect(distribution?.inputs.origins).toMatchObject([
        { originId: 'SystemApiServerOrigin', domainName: 'api-id.lambda-url.us-east-1.on.aws' },
      ]);

      const roles = resources.filter((resource) => resource.type === 'aws:iam/role:Role');
      expect(roles).toHaveLength(1);
      expect(roles[0]?.name).toContain('edge-router-role');
      expect(roles[0]?.inputs).toMatchObject({
        path: '/appliance/prod-edge/',
        permissionsBoundary: 'arn:aws:iam::123456789012:policy/appliance-system/prod-user-appliance-boundary',
        tags: { 'appliance:managed': 'true' },
      });

      const invokePolicy = resources.find(
        (resource) => resource.type === 'aws:iam/rolePolicy:RolePolicy' && resource.name.includes('system-invoke')
      );
      expect(invokePolicy).toBeDefined();
      const policy = JSON.parse(String(invokePolicy?.inputs.policy));
      expect(policy.Statement[0]).toMatchObject({
        Effect: 'Allow',
        Action: 'lambda:InvokeFunctionUrl',
        Resource: [substrate.systemFunctions.apiServer.arn, substrate.systemFunctions.worker.arn],
      });

      const publicUrlPermissions = resources.filter(
        (resource) =>
          resource.type === 'aws:lambda/permission:Permission' &&
          resource.inputs.action === 'lambda:InvokeFunctionUrl' &&
          resource.inputs.principal === '*'
      );
      expect(publicUrlPermissions).toEqual([]);
      const edgeInvokePermissions = resources.filter(
        (resource) =>
          resource.type === 'aws:lambda/permission:Permission' &&
          resource.inputs.action === 'lambda:InvokeFunction' &&
          resource.inputs.principal === 'edgelambda.amazonaws.com'
      );
      expect(edgeInvokePermissions).toHaveLength(1);

      const records = resources
        .filter((resource) => resource.type === 'aws:route53/record:Record')
        .map((resource) => resource.inputs.name);
      expect(records).toContain('api.example.com');
      expect(records).toContain('origin.api.example.com');

      expect(config.provisioner).toBe('cloudformation-v1');
      expect(config.aws?.apiServerPublicUrl).toBe('https://api.example.com');
      expect(config.aws?.stateBucketName).toBe('prod-state');
    }
  );
});
