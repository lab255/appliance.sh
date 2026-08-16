import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it } from 'vitest';
import { applianceBaseConfig, type ApplianceBaseConfig } from '@appliance.sh/sdk';
import {
  BaseConfigRepository,
  readBaseConfigSnapshot,
  resolveBaseConfig,
  runWithBaseConfig,
  setBaseConfigRepositoryForTests,
} from './base-config.service';
import { attachEdgeBaseConfig, detachEdgeBaseConfig } from './base-config-writer.service';
import { createStorageService } from './storage.service';

const epoch1 = applianceBaseConfig.parse({
  name: 'prod',
  type: 'appliance-base-aws-public',
  provisioner: 'cloudformation-v1',
  stateBackendUrl: 's3://state',
  aws: {
    region: 'us-east-1',
    dataBucketName: 'data',
    stateBucketName: 'state',
    stateBucketArn: 'arn:aws:s3:::state',
    kmsKeyArn: 'arn:aws:kms:us-east-1:123:key/1',
    kmsAliasName: 'alias/appliance-prod',
    ecrRepositoryUrl: '123.dkr.ecr.us-east-1.amazonaws.com/repo',
    systemRoleArns: { apiServer: 'arn:api-role', worker: 'arn:worker-role' },
    systemFunctions: {
      apiServer: { name: 'api', arn: 'arn:api', url: 'https://raw.lambda-url.us-east-1.on.aws/' },
      worker: { name: 'worker', arn: 'arn:worker', url: 'https://worker.lambda-url.us-east-1.on.aws/' },
    },
  },
});

const epoch2 = applianceBaseConfig.parse({
  ...epoch1,
  domainName: 'example.com',
  baselineVersion: 'v2',
  aws: {
    ...epoch1.aws,
    zoneId: 'Z1',
    certificateArn: 'arn:cert',
    cloudfrontDistributionId: 'DIST',
    cloudfrontDistributionDomainName: 'dist.cloudfront.net',
    edgeRouterRoleArn: 'arn:edge-role',
    apiServerPublicUrl: 'https://api.example.com',
  },
});

class FakeS3 {
  current: ApplianceBaseConfig = epoch1;
  etag = '"v1"';
  readonly commands: Array<GetObjectCommand | PutObjectCommand> = [];

  async send(command: GetObjectCommand | PutObjectCommand) {
    this.commands.push(command);
    if (command instanceof GetObjectCommand) {
      if (command.input.IfNoneMatch === this.etag) {
        throw { name: 'NotModified', $metadata: { httpStatusCode: 304 } };
      }
      return {
        ETag: this.etag,
        Body: { transformToString: async () => JSON.stringify(this.current) },
      };
    }
    if (command.input.IfMatch !== this.etag) {
      throw { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } };
    }
    this.current = applianceBaseConfig.parse(JSON.parse(String(command.input.Body)));
    this.etag = this.etag === '"v1"' ? '"v2"' : '"v3"';
    return { ETag: this.etag };
  }
}

afterEach(() => {
  delete process.env.APPLIANCE_DATA_BUCKET;
  delete process.env.APPLIANCE_BASE_CONFIG_KEY;
  delete process.env.APPLIANCE_BASE_CONFIG;
  setBaseConfigRepositoryForTests(undefined);
});

describe('base config resolution', () => {
  it('initializes cloud storage from APPLIANCE_DATA_BUCKET alone', () => {
    process.env.APPLIANCE_DATA_BUCKET = 'data-only';
    expect(() => createStorageService()).not.toThrow();
  });

  it('keeps APPLIANCE_BASE_CONFIG as the legacy fallback', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(epoch1);
    expect(await resolveBaseConfig()).toEqual(epoch1);
    expect(readBaseConfigSnapshot()).toEqual(epoch1);
  });

  it('parses substrate epoch 1 without zone or domain and uses ETag conditional reads', async () => {
    const fake = new FakeS3();
    const repository = new BaseConfigRepository('data', 'system/base-config.json', fake);
    process.env.APPLIANCE_DATA_BUCKET = 'data';
    setBaseConfigRepositoryForTests(repository);
    const first = await resolveBaseConfig();
    const second = await resolveBaseConfig();
    expect(first?.domainName).toBeUndefined();
    expect(first?.aws?.zoneId).toBeUndefined();
    expect(second).toBe(first);
    expect((fake.commands[1] as GetObjectCommand).input.IfNoneMatch).toBe('"v1"');
  });

  it('shows a changed epoch on the next boundary but never midway through one snapshot', async () => {
    const fake = new FakeS3();
    const repository = new BaseConfigRepository('data', 'system/base-config.json', fake);
    process.env.APPLIANCE_DATA_BUCKET = 'data';
    setBaseConfigRepositoryForTests(repository);
    const first = await resolveBaseConfig();
    await runWithBaseConfig(first, async () => {
      expect(readBaseConfigSnapshot()?.domainName).toBeUndefined();
      fake.current = epoch2;
      fake.etag = '"external-v2"';
      expect((await resolveBaseConfig())?.domainName).toBeUndefined();
      expect(readBaseConfigSnapshot()?.domainName).toBeUndefined();
    });
    expect((await resolveBaseConfig())?.aws?.apiServerPublicUrl).toBe('https://api.example.com');
  });

  it('conditionally attaches epoch 2 and restores epoch 1 on destroy', async () => {
    const fake = new FakeS3();
    const repository = new BaseConfigRepository('data', 'system/base-config.json', fake);
    process.env.APPLIANCE_DATA_BUCKET = 'data';
    setBaseConfigRepositoryForTests(repository);
    const attached = await attachEdgeBaseConfig(epoch2);
    expect(attached.domainName).toBe('example.com');
    const put = fake.commands.find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.IfMatch).toBe('"v1"');

    const detached = await detachEdgeBaseConfig();
    expect(detached.domainName).toBeUndefined();
    expect(detached.aws?.zoneId).toBeUndefined();
    expect(detached.aws?.apiServerPublicUrl).toBeUndefined();
    expect(detached.aws?.systemFunctions).toEqual(epoch1.aws?.systemFunctions);
  });
});
