import {
  CloudFormationClient,
  DescribeStacksCommand,
  SetStackPolicyCommand,
  UpdateStackCommand,
} from '@aws-sdk/client-cloudformation';
import { describe, expect, it, vi } from 'vitest';
import {
  createAwsCloudInstallDependencies,
  isNoCloudFormationUpdates,
  runCloudInstall,
  type CloudInstallDependencies,
  type CloudInstallProfile,
  type StackSnapshot,
} from './cloud-install.js';
import { APPLIANCE_STACK_POLICY, APPLIANCE_STACK_POLICY_DURING_OPERATOR_UPDATE } from './template.js';

const substrateOutputs = {
  StateBucketName: 'state-bucket',
  StateBucketArn: 'arn:aws:s3:::state-bucket',
  DataBucketName: 'data-bucket',
  DataBucketArn: 'arn:aws:s3:::data-bucket',
  StateKmsKeyArn: 'arn:aws:kms:us-east-1:111:key/1',
  StateKmsAliasName: 'alias/appliance-test',
  ImageRepositoryUrl: '111.dkr.ecr.us-east-1.amazonaws.com/repo',
  SystemApiServerRoleArn: 'arn:aws:iam::111:role/api',
  SystemWorkerRoleArn: 'arn:aws:iam::111:role/worker',
  BootstrapTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:111:secret:bootstrap',
  UserAppliancePermissionsBoundaryArn: 'arn:aws:iam::111:policy/appliance-system/test-user-appliance-boundary',
};
const functionOutputs = {
  WorkerFunctionName: 'worker',
  WorkerFunctionArn: 'arn:aws:lambda:us-east-1:111:function:worker',
  WorkerFunctionUrl: 'https://worker.lambda-url.us-east-1.on.aws/',
  ApiServerFunctionName: 'api',
  ApiServerFunctionArn: 'arn:aws:lambda:us-east-1:111:function:api',
  ApiServerFunctionUrl: 'https://api.lambda-url.us-east-1.on.aws/',
};
const { UserAppliancePermissionsBoundaryArn: _boundaryOutput, ...preCu0SubstrateOutputs } = substrateOutputs;

function harness(
  options: {
    existing?: boolean;
    previousImage?: string;
    interruptAfter?: string;
    healthFails?: boolean;
    existingBaseConfig?: Record<string, unknown>;
    preCu0Snapshot?: boolean;
  } = {}
) {
  const calls: string[] = [];
  const logs: string[] = [];
  const profiles: Array<{ name: string; profile: CloudInstallProfile }> = [];
  let stack: StackSnapshot = options.existing
    ? {
        exists: true,
        accountId: '111',
        region: 'us-east-1',
        parameters: { ImageUri: options.previousImage ?? '' },
        outputs: {
          ...(options.preCu0Snapshot ? preCu0SubstrateOutputs : substrateOutputs),
          ...(options.previousImage ? functionOutputs : {}),
        },
      }
    : { exists: false, parameters: {}, outputs: {} };
  let interruptAfter = options.interruptAfter;
  let baseConfigObject = options.existingBaseConfig;
  const mark = (name: string) => {
    calls.push(name);
    if (interruptAfter === name) {
      interruptAfter = undefined;
      throw new Error(`interrupted after ${name}`);
    }
  };
  const deps: CloudInstallDependencies = {
    async getAccountId() {
      mark('identity');
      return '111';
    },
    async getStack() {
      mark('describe');
      return stack;
    },
    async deployStack(input) {
      stack = {
        exists: true,
        accountId: '111',
        region: 'us-east-1',
        parameters: { ImageUri: input.imageUri },
        outputs: { ...substrateOutputs, ...(input.imageUri ? functionOutputs : {}) },
      };
      mark(input.imageUri ? 'image-stack' : 'substrate-stack');
      return stack;
    },
    async getRegistryCredentials() {
      mark('ecr-auth');
      return { username: 'AWS', password: 'not-logged' };
    },
    async mirror() {
      mark('mirror');
      return {
        imageUri: `${substrateOutputs.ImageRepositoryUrl}@sha256:new`,
        digest: 'sha256:new',
        uploadedBlobs: 2,
        reusedBlobs: 0,
      };
    },
    async writeBaseConfigIfAbsent(_bucket, _key, value) {
      expect(value).toMatchObject({
        provisioner: 'cloudformation-v1',
        aws: {
          dataBucketName: 'data-bucket',
          userAppliancePermissionsBoundaryArn: 'arn:aws:iam::111:policy/appliance-system/test-user-appliance-boundary',
        },
      });
      mark('base-config');
      if (baseConfigObject) return false;
      baseConfigObject = value as Record<string, unknown>;
      return true;
    },
    async updateBaseConfigBoundary(_bucket, _key, boundaryArn) {
      const config = baseConfigObject as { aws?: Record<string, unknown> } | undefined;
      if (!config?.aws) throw new Error('missing base config');
      config.aws.userAppliancePermissionsBoundaryArn = boundaryArn;
      mark('boundary-config');
    },
    async getSecret() {
      mark('secret');
      return JSON.stringify({ token: 's'.repeat(43) });
    },
    async getBootstrapStatus() {
      mark('health');
      if (options.healthFails) throw new Error('still cold');
      return { initialized: false };
    },
    async mintApiKey(_url, token) {
      expect(token).toBe('s'.repeat(43));
      mark('mint');
      return { id: 'key-1', secret: 'api-secret' };
    },
    async writeProfile(name, profile) {
      profiles.push({ name, profile });
      mark('profile');
    },
    async sleep() {},
    log(message) {
      logs.push(message);
    },
  };
  return {
    deps,
    calls,
    logs,
    profiles,
    baseConfig: () => baseConfigObject,
    disableHealthFailure: () => (options.healthFails = false),
  };
}

const input = {
  installationName: 'test-install',
  stackName: 'appliance-test',
  region: 'us-east-1',
  architecture: 'x86_64' as const,
  profileName: 'test',
  sourceImage: 'ghcr.io/appliance-sh/api-server:1',
  healthTimeoutMs: 1,
  healthPollMs: 0,
};

describe('CloudFormation cloud installer', () => {
  it('refuses a legacy profile before touching AWS', async () => {
    const h = harness();
    await expect(runCloudInstall({ ...input, existingLegacyProfile: true }, h.deps)).rejects.toThrow(/legacy Pulumi/);
    expect(h.calls).toEqual([]);
  });

  it('runs a fresh install in substrate, mirror, image, health, mint, profile order', async () => {
    const h = harness();
    const profile = await runCloudInstall(input, h.deps);
    expect(h.calls).toEqual([
      'identity',
      'describe',
      'substrate-stack',
      'ecr-auth',
      'mirror',
      'image-stack',
      'base-config',
      'health',
      'secret',
      'mint',
      'profile',
    ]);
    expect(profile).toMatchObject({
      apiUrl: 'https://api.lambda-url.us-east-1.on.aws',
      installGeneration: 'cloudformation-v1',
      cloudFormationStackName: 'appliance-test',
      awsAccountId: '111',
      awsRegion: 'us-east-1',
    });
    expect(JSON.stringify(h.logs)).not.toContain('ssss');
  });

  it.each(['substrate-stack', 'mirror', 'image-stack', 'base-config', 'secret', 'mint', 'profile'])(
    'resumes safely after interruption at %s',
    async (point) => {
      const h = harness({ interruptAfter: point });
      await expect(runCloudInstall(input, h.deps)).rejects.toThrow();
      const profile = await runCloudInstall(input, h.deps);
      expect(profile.keyId).toBe('key-1');
      expect(h.profiles.at(-1)?.name).toBe('test');
    }
  );

  it('absorbs a transient health interruption inside the health poll', async () => {
    const h = harness({ interruptAfter: 'health' });
    const profile = await runCloudInstall({ ...input, healthTimeoutMs: 100 }, h.deps);
    expect(profile.keyId).toBe('key-1');
    expect(h.calls.filter((call) => call === 'health')).toHaveLength(2);
  });

  it('reuses an existing valid raw profile without retrieving the bootstrap token', async () => {
    const h = harness({ existing: true, previousImage: 'repo@sha256:old' });
    const existing: CloudInstallProfile = {
      apiUrl: 'https://api.lambda-url.us-east-1.on.aws',
      keyId: 'old-key',
      secret: 'old-secret',
      installGeneration: 'cloudformation-v1',
      cloudFormationStackName: 'appliance-test',
      awsAccountId: '111',
      awsRegion: 'us-east-1',
    };
    h.deps.getBootstrapStatus = async () => ({ initialized: true });
    h.deps.validateExistingProfile = async () => true;
    const result = await runCloudInstall({ ...input, existingProfile: existing }, h.deps);
    expect(result).toBe(existing);
    expect(h.calls).not.toContain('secret');
    expect(h.calls).not.toContain('mint');
  });

  it('does not regress an existing epoch-2 base config when install is re-run', async () => {
    const epoch2 = {
      provisioner: 'cloudformation-v1',
      domainName: 'example.com',
      aws: {
        zoneId: 'Z123',
        cloudfrontDistributionId: 'DIST123',
        cloudfrontDistributionDomainName: 'dist.cloudfront.net',
      },
    };
    const h = harness({
      existing: true,
      previousImage: 'repo@sha256:old',
      existingBaseConfig: structuredClone(epoch2),
    });

    await runCloudInstall(input, h.deps);

    expect(h.baseConfig()).toEqual({
      ...epoch2,
      aws: {
        ...epoch2.aws,
        userAppliancePermissionsBoundaryArn: 'arn:aws:iam::111:policy/appliance-system/test-user-appliance-boundary',
      },
    });
  });

  it('resumes a pre-CU0 stack and migrates its existing base config after the template update', async () => {
    const h = harness({
      existing: true,
      previousImage: 'repo@sha256:old',
      preCu0Snapshot: true,
      existingBaseConfig: { provisioner: 'cloudformation-v1', aws: { region: 'us-east-1' } },
    });

    await runCloudInstall(input, h.deps);

    expect(h.calls).toContain('image-stack');
    expect(h.calls).toContain('boundary-config');
    expect(h.baseConfig()).toMatchObject({
      aws: {
        userAppliancePermissionsBoundaryArn: 'arn:aws:iam::111:policy/appliance-system/test-user-appliance-boundary',
      },
    });
  });

  it('reports account and region mismatches before changing the stack', async () => {
    const account = harness({ existing: true });
    account.deps.getAccountId = async () => '222';
    await expect(runCloudInstall(input, account.deps)).rejects.toThrow('belongs to AWS account 111');

    const region = harness({ existing: true });
    await expect(runCloudInstall({ ...input, region: 'eu-west-1' }, region.deps)).rejects.toThrow(
      'not requested region'
    );
  });

  it('uses profile metadata to catch a wrong account or region before looking up a regional stack', async () => {
    const existingProfile: CloudInstallProfile = {
      apiUrl: 'https://api.lambda-url.us-east-1.on.aws',
      keyId: 'key',
      secret: 'secret',
      installGeneration: 'cloudformation-v1',
      cloudFormationStackName: 'appliance-test',
      awsAccountId: '222',
      awsRegion: 'eu-west-1',
    };
    const account = harness();
    await expect(runCloudInstall({ ...input, existingProfile }, account.deps)).rejects.toThrow(
      'records AWS account 222'
    );
    expect(account.calls).not.toContain('describe');

    const region = harness();
    await expect(
      runCloudInstall({ ...input, existingProfile: { ...existingProfile, awsAccountId: '111' } }, region.deps)
    ).rejects.toThrow('records region eu-west-1');
    expect(region.calls).not.toContain('describe');
  });

  it('includes the previous digest in health-failure rollback diagnostics', async () => {
    const h = harness({ existing: true, previousImage: 'repo@sha256:old', healthFails: true });
    await expect(runCloudInstall(input, h.deps)).rejects.toThrow('previous digest repo@sha256:old');
  });

  it('recognizes the CloudFormation no-op response without hiding other failures', () => {
    expect(isNoCloudFormationUpdates(new Error('No updates are to be performed.'))).toBe(true);
    expect(isNoCloudFormationUpdates(new Error('Access denied'))).toBe(false);
  });

  it('temporarily overrides protection for operator updates and installs the policy even on no-op stacks', async () => {
    const commands: unknown[] = [];
    const send = vi.spyOn(CloudFormationClient.prototype, 'send').mockImplementation(async (command: unknown) => {
      commands.push(command);
      if (command instanceof DescribeStacksCommand) {
        return {
          Stacks: [
            {
              StackId: 'arn:aws:cloudformation:us-east-1:111111111111:stack/appliance-test/id',
              StackName: 'appliance-test',
              StackStatus: 'UPDATE_COMPLETE',
              Parameters: [],
              Outputs: [],
            },
          ],
        } as never;
      }
      if (command instanceof UpdateStackCommand) throw new Error('No updates are to be performed.');
      if (command instanceof SetStackPolicyCommand) return {} as never;
      throw new Error(`unexpected CloudFormation command ${command?.constructor.name}`);
    });
    try {
      const deps = createAwsCloudInstallDependencies({
        region: 'us-east-1',
        writeProfile() {},
      });
      await expect(
        deps.deployStack({
          stackName: 'appliance-test',
          installationName: 'test-install',
          imageUri: 'repo@sha256:digest',
          architecture: 'x86_64',
          systemRoleMode: 'scoped',
        })
      ).resolves.toMatchObject({ exists: true });
    } finally {
      send.mockRestore();
    }

    const update = commands.find((command) => command instanceof UpdateStackCommand) as UpdateStackCommand;
    expect(update.input).toMatchObject({
      Capabilities: ['CAPABILITY_NAMED_IAM'],
      StackPolicyBody: APPLIANCE_STACK_POLICY,
      StackPolicyDuringUpdateBody: APPLIANCE_STACK_POLICY_DURING_OPERATOR_UPDATE,
    });
    const policy = commands.find((command) => command instanceof SetStackPolicyCommand) as SetStackPolicyCommand;
    expect(policy.input).toEqual({ StackName: 'appliance-test', StackPolicyBody: APPLIANCE_STACK_POLICY });
    expect(commands.indexOf(policy)).toBeGreaterThan(commands.indexOf(update));
  });
});
