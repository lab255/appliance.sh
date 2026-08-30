import { describe, expect, it } from 'vitest';
import {
  ApplianceBaseType,
  applianceBaseConfig,
  applianceBaseConfigInput,
  applianceBaseConfigStrict,
  getKubernetesParams,
  isKubernetesBase,
  sanitizeBaseConfigForWire,
  type ApplianceBaseConfig,
} from './appliance-base';

describe('appliance-base-kubernetes schema', () => {
  it('round-trips a server+token config through the input discriminator', () => {
    const parsed = applianceBaseConfigInput.parse({
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'remote',
      kubernetes: {
        server: 'https://kube.example.com:6443',
        token: 'sha256~abc',
        ca: 'LS0tLS1CRUdJTi==',
        dataDir: '/data',
        namespace: 'apps',
        hostnameSuffix: 'apps.example.com',
        ingressClassName: 'nginx',
      },
    });
    expect(parsed.type).toBe(ApplianceBaseType.ApplianceKubernetes);
    if (parsed.type !== ApplianceBaseType.ApplianceKubernetes) throw new Error('narrow failed');
    expect(parsed.kubernetes.server).toBe('https://kube.example.com:6443');
    expect(parsed.kubernetes.dataDir).toBe('/data');
  });

  it('round-trips an inline-kubeconfig config', () => {
    const parsed = applianceBaseConfigInput.parse({
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'kubeconfig',
      kubernetes: {
        kubeconfig: 'apiVersion: v1\nkind: Config\n',
        dataDir: '/data',
      },
    });
    if (parsed.type !== ApplianceBaseType.ApplianceKubernetes) throw new Error('narrow failed');
    expect(parsed.kubernetes.kubeconfig).toContain('apiVersion: v1');
  });

  it('round-trips the optional buildkit address on both input and resolved schemas', () => {
    const input = applianceBaseConfigInput.parse({
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'local',
      kubernetes: {
        kubeconfig: 'apiVersion: v1\nkind: Config\n',
        dataDir: '/data',
        registry: { url: 'localhost:5052', insecure: true },
        buildkit: { addr: 'tcp://127.0.0.1:5054' },
      },
    });
    if (input.type !== ApplianceBaseType.ApplianceKubernetes) throw new Error('narrow failed');
    expect(input.kubernetes.buildkit?.addr).toBe('tcp://127.0.0.1:5054');

    const resolved = applianceBaseConfig.parse({
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'local',
      kubernetes: {
        kubeconfig: 'apiVersion: v1\nkind: Config\n',
        dataDir: '/data',
        buildkit: { addr: 'tcp://127.0.0.1:5054' },
      },
    });
    expect(resolved.kubernetes?.buildkit?.addr).toBe('tcp://127.0.0.1:5054');

    // buildkit stays optional: a config without it still parses.
    const bare = applianceBaseConfig.parse({
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'byo',
      kubernetes: { dataDir: '/data' },
    });
    expect(bare.kubernetes?.buildkit).toBeUndefined();
  });

  it('requires dataDir on the kubernetes variant', () => {
    expect(() =>
      applianceBaseConfigInput.parse({
        type: ApplianceBaseType.ApplianceKubernetes,
        name: 'broken',
        kubernetes: { server: 'https://x', token: 't' },
      })
    ).toThrow();
  });

  // THE regression test for incident B: an OLD schema (one that doesn't
  // know a field a NEWER writer added) parsing a round-tripped config
  // must PRESERVE the unknown keys, not silently drop them. The
  // incident: a pre-buildkit schema parsed a config carrying
  // `kubernetes.buildkit`, re-serialized it without the key, and source
  // builds died until the VM was recreated. `.passthrough()` on every
  // config object node is the fix — unknown keys (stand-ins for any
  // future field) survive a parse → JSON → parse cycle at every level.
  it('preserves unknown keys through an old-schema parse (incident B regression)', () => {
    const newerConfig = {
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'local',
      baseConfigVersion: '9.9.9',
      futureTopLevelField: { anything: true },
      kubernetes: {
        kubeconfigPath: '/etc/rancher/k3s/k3s.yaml',
        dataDir: '/data',
        buildkit: { addr: 'tcp://127.0.0.1:5054', futureBuildkitField: 'x' },
        registry: { url: 'localhost:5052', futureRegistryField: 1 },
        futureKubernetesField: 'keep-me',
      },
    };

    const parsed = applianceBaseConfig.parse(newerConfig);
    // Round-trip exactly as the guest/env plumbing does.
    const roundTripped = applianceBaseConfig.parse(JSON.parse(JSON.stringify(parsed)));

    expect(roundTripped).toMatchObject(newerConfig);
    // The incident's exact casualty, spelled out.
    expect((roundTripped.kubernetes as Record<string, unknown>)?.buildkit).toEqual({
      addr: 'tcp://127.0.0.1:5054',
      futureBuildkitField: 'x',
    });
    expect(roundTripped.baseConfigVersion).toBe('9.9.9');
  });

  it('preserves unknown keys on the aws and docker config blocks too', () => {
    const aws = applianceBaseConfig.parse({
      type: ApplianceBaseType.ApplianceAwsPublic,
      name: 'prod',
      aws: { region: 'us-east-1', zoneId: 'Z1', futureAwsField: 'keep', buildkit: { addr: 'tcp://b', extra: 1 } },
    });
    expect((aws.aws as Record<string, unknown>).futureAwsField).toBe('keep');
    expect((aws.aws?.buildkit as Record<string, unknown>).extra).toBe(1);

    const docker = applianceBaseConfig.parse({
      type: ApplianceBaseType.ApplianceDocker,
      name: 'dockerbox',
      docker: { dataDir: '/data', futureDockerField: true },
    });
    expect((docker.docker as Record<string, unknown>).futureDockerField).toBe(true);
  });

  it('accepts a CFN substrate epoch with no edge fields', () => {
    const config = applianceBaseConfig.parse({
      type: ApplianceBaseType.ApplianceAwsPublic,
      name: 'prod',
      provisioner: 'cloudformation-v1',
      stateBackendUrl: 's3://prod-state',
      aws: {
        region: 'us-east-1',
        stateBucketName: 'prod-state',
        stateBucketArn: 'arn:aws:s3:::prod-state',
        dataBucketName: 'prod-data',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123:key/key-1',
        kmsAliasName: 'alias/appliance/prod-state',
        ecrRepositoryUrl: '123.dkr.ecr.us-east-1.amazonaws.com/prod',
        userAppliancePermissionsBoundaryArn: 'arn:aws:iam::123:policy/appliance-system/prod-user-appliance-boundary',
        systemRoleArns: {
          apiServer: 'arn:aws:iam::123:role/api',
          worker: 'arn:aws:iam::123:role/worker',
        },
        systemFunctions: {
          apiServer: {
            name: 'prod-api',
            arn: 'arn:aws:lambda:us-east-1:123:function:prod-api',
            url: 'https://api.lambda-url.us-east-1.on.aws/',
          },
          worker: {
            name: 'prod-worker',
            arn: 'arn:aws:lambda:us-east-1:123:function:prod-worker',
            url: 'https://worker.lambda-url.us-east-1.on.aws/',
          },
        },
      },
    });

    expect(config.provisioner).toBe('cloudformation-v1');
    expect(config.aws?.zoneId).toBeUndefined();
    expect(config.domainName).toBeUndefined();
    expect(config.aws?.systemFunctions?.worker.name).toBe('prod-worker');
  });
});

describe('sanitizeBaseConfigForWire', () => {
  const secretful = {
    type: ApplianceBaseType.ApplianceKubernetes,
    name: 'local',
    stateBackendUrl: 's3://bucket',
    baselineVersion: '1.50.0',
    futureTopLevelField: 'leak-me-not',
    kubernetes: {
      server: 'https://10.0.0.1:6443',
      token: 'sha256~the-sa-token',
      ca: 'LS0tLS1CRUdJTi==',
      kubeconfig: 'apiVersion: v1\nkind: Config\n',
      kubeconfigPath: '/etc/rancher/k3s/k3s.yaml',
      dataDir: '/data',
      registry: { url: 'localhost:5052', futureRegistryField: 1 },
      buildkit: { addr: 'tcp://127.0.0.1:5054' },
      futureKubernetesField: 'leak-me-not',
    },
  };

  it('drops the credential-bearing kubernetes fields from the wire copy', () => {
    const wire = sanitizeBaseConfigForWire(applianceBaseConfig.parse(secretful));
    expect(wire.kubernetes?.token).toBeUndefined();
    expect(wire.kubernetes?.kubeconfig).toBeUndefined();
    expect(wire.kubernetes?.ca).toBeUndefined();
    // No credential material anywhere in the serialized copy.
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain('sha256~the-sa-token');
    expect(serialized).not.toContain('LS0tLS1CRUdJTi==');
    expect(serialized).not.toContain('kind: Config');
  });

  it('strips unknown keys at every level (member keys must not see them)', () => {
    const wire = sanitizeBaseConfigForWire(applianceBaseConfig.parse(secretful)) as Record<string, unknown>;
    expect(wire.futureTopLevelField).toBeUndefined();
    expect((wire.kubernetes as Record<string, unknown>).futureKubernetesField).toBeUndefined();
    expect(
      ((wire.kubernetes as { registry?: Record<string, unknown> }).registry ?? {}).futureRegistryField
    ).toBeUndefined();
  });

  it('keeps everything clients actually consume', () => {
    const wire = sanitizeBaseConfigForWire(applianceBaseConfig.parse(secretful));
    expect(wire.type).toBe(ApplianceBaseType.ApplianceKubernetes);
    expect(wire.stateBackendUrl).toBe('s3://bucket');
    expect(wire.baselineVersion).toBe('1.50.0');
    // Block presence drives the app's "kubernetes base?" probe; the
    // registry/buildkit endpoints stay for host-side builds.
    expect(wire.kubernetes?.dataDir).toBe('/data');
    expect(wire.kubernetes?.registry?.url).toBe('localhost:5052');
    expect(wire.kubernetes?.buildkit?.addr).toBe('tcp://127.0.0.1:5054');
  });

  it('the strict twin keeps strip semantics while the round-trip schema preserves (drift guard)', () => {
    const parsedLoose = applianceBaseConfig.parse(secretful);
    const parsedStrict = applianceBaseConfigStrict.parse(secretful);
    expect((parsedLoose as Record<string, unknown>).futureTopLevelField).toBe('leak-me-not');
    expect((parsedStrict as Record<string, unknown>).futureTopLevelField).toBeUndefined();
    // Same known fields on both — the twin is the same shape.
    expect(parsedStrict.kubernetes?.server).toBe(parsedLoose.kubernetes?.server);
  });
});

describe('isKubernetesBase', () => {
  it('returns true for local and kubernetes; narrows the union accordingly', () => {
    const local: ApplianceBaseConfig = {
      type: ApplianceBaseType.ApplianceLocal,
      name: 'dev',
      local: { dataDir: '/tmp/dev' },
    };
    const remote: ApplianceBaseConfig = {
      type: ApplianceBaseType.ApplianceKubernetes,
      name: 'remote',
      kubernetes: { dataDir: '/data' },
    };
    const aws: ApplianceBaseConfig = {
      type: ApplianceBaseType.ApplianceAwsPublic,
      name: 'prod',
      aws: { region: 'us-east-1', zoneId: 'Z1' },
    };
    expect(isKubernetesBase(local)).toBe(true);
    expect(isKubernetesBase(remote)).toBe(true);
    expect(isKubernetesBase(aws)).toBe(false);
  });
});

describe('getKubernetesParams', () => {
  it('extracts common k8s deploy params from the local variant', () => {
    const params = getKubernetesParams(
      applianceBaseConfig.parse({
        type: ApplianceBaseType.ApplianceLocal,
        name: 'dev',
        local: {
          dataDir: '/tmp/dev',
          cluster: { namespace: 'demo', hostnameSuffix: 'dev.local', ingressClassName: 'traefik' },
        },
      })
    );
    expect(params).toEqual({
      dataDir: '/tmp/dev',
      namespace: 'demo',
      hostnameSuffix: 'dev.local',
      ingressClassName: 'traefik',
    });
  });

  it('extracts common k8s deploy params from the kubernetes variant', () => {
    const params = getKubernetesParams(
      applianceBaseConfig.parse({
        type: ApplianceBaseType.ApplianceKubernetes,
        name: 'remote',
        kubernetes: {
          dataDir: '/data',
          namespace: 'apps',
          hostnameSuffix: 'apps.example.com',
          ingressClassName: 'nginx',
        },
      })
    );
    expect(params).toEqual({
      dataDir: '/data',
      namespace: 'apps',
      hostnameSuffix: 'apps.example.com',
      ingressClassName: 'nginx',
    });
  });

  it('returns null for AWS bases', () => {
    const params = getKubernetesParams(
      applianceBaseConfig.parse({
        type: ApplianceBaseType.ApplianceAwsPublic,
        name: 'prod',
        aws: { region: 'us-east-1', zoneId: 'Z1' },
      })
    );
    expect(params).toBeNull();
  });
});
