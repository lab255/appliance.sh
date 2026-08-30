import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VERSION } from '@appliance.sh/sdk';
import { clusterInfoRoutes } from './index';
import {
  resetSelfUpdateSchedulerServiceForTests,
  setSelfUpdateSchedulerServiceForTests,
} from '../../services/self-update-scheduler.service';

function createTestApp(role: 'admin' | 'member' = 'admin') {
  const app = express();
  app.use((req, _res, next) => {
    req.apiKeyRole = role;
    next();
  });
  app.use('/api/v1/cluster-info', clusterInfoRoutes);
  return app;
}

const K8S_BASE = {
  type: 'appliance-base-kubernetes',
  name: 'local-runtime',
  kubernetes: { dataDir: '/data' },
};

describe('GET /api/v1/cluster-info', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    setSelfUpdateSchedulerServiceForTests({ getAvailable: async () => null, getLastCheck: async () => null } as never);
  });

  afterEach(() => {
    process.env = originalEnv;
    resetSelfUpdateSchedulerServiceForTests();
  });

  it('surfaces policy and only the non-sensitive notify marker fields', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(K8S_BASE);
    process.env.SELF_UPDATE_POLICY = 'notify';
    setSelfUpdateSchedulerServiceForTests({
      getAvailable: async () => ({
        version: '1.58.0',
        digest: `sha256:${'a'.repeat(64)}`,
        generation: 8,
        seenAt: '2026-08-31T00:00:00.000Z',
      }),
      getLastCheck: async () => ({
        at: '2026-08-31T00:00:00.000Z',
        decision: 'notify',
        reason: 'notify-marked',
        version: '1.58.0',
      }),
    } as never);

    const res = await request(createTestApp()).get('/api/v1/cluster-info');

    expect(res.status).toBe(200);
    expect(res.body.selfUpdate).toEqual({
      policy: 'notify',
      lastCheck: {
        at: '2026-08-31T00:00:00.000Z',
        decision: 'notify',
        reason: 'notify-marked',
        version: '1.58.0',
      },
      available: { version: '1.58.0', generation: 8 },
    });
    expect(res.text).not.toContain('sha256:');
    expect(res.text).not.toContain('seenAt');
  });

  it('does not expose the actionable marker to member keys', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(K8S_BASE);
    process.env.SELF_UPDATE_POLICY = 'notify';
    let markerReads = 0;
    setSelfUpdateSchedulerServiceForTests({
      getAvailable: async () => {
        markerReads += 1;
        return { version: '1.58.0' };
      },
      getLastCheck: async () => null,
    } as never);

    const res = await request(createTestApp('member')).get('/api/v1/cluster-info');

    expect(res.status).toBe(200);
    expect(res.body.selfUpdate.available).toBeUndefined();
    expect(markerReads).toBe(0);
  });

  it('suppresses a stale marker whose version is already running', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(K8S_BASE);
    process.env.SELF_UPDATE_POLICY = 'notify';
    setSelfUpdateSchedulerServiceForTests({
      getAvailable: async () => ({
        version: VERSION,
        digest: `sha256:${'a'.repeat(64)}`,
        generation: 8,
        seenAt: '2026-08-31T00:00:00.000Z',
      }),
      getLastCheck: async () => null,
    } as never);

    const res = await request(createTestApp()).get('/api/v1/cluster-info');
    expect(res.status).toBe(200);
    expect(res.body.selfUpdate.available).toBeUndefined();
  });

  it('reports serverVersion and uploadBuilds=true on a kubernetes base with a builder', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify({
      ...K8S_BASE,
      kubernetes: { dataDir: '/data', buildkit: { addr: 'tcp://127.0.0.1:5054' } },
    });

    const res = await request(createTestApp()).get('/api/v1/cluster-info');

    expect(res.status).toBe(200);
    expect(res.body.serverVersion).toBe(VERSION);
    expect(res.body.capabilities).toEqual({ uploadBuilds: true });
    expect(res.body.selfUpdate).toEqual({
      policy: 'off',
      lastCheck: { at: '', decision: 'not-checked', reason: 'policy-off' },
    });
  });

  it('reports an advisory minClientVersion', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(K8S_BASE);

    const res = await request(createTestApp()).get('/api/v1/cluster-info');

    expect(res.status).toBe(200);
    // Semver-shaped; "0.0.0" until the floor is deliberately raised.
    expect(res.body.minClientVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reports uploadBuilds=false on a kubernetes base without a builder', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(K8S_BASE);

    const res = await request(createTestApp()).get('/api/v1/cluster-info');

    expect(res.status).toBe(200);
    expect(res.body.capabilities).toEqual({ uploadBuilds: false });
  });

  it('sanitizes both substrate and attached-edge cloud epochs', async () => {
    const substrate = {
      name: 'prod',
      type: 'appliance-base-aws-public',
      provisioner: 'cloudformation-v1',
      stateBackendUrl: 's3://state',
      aws: {
        region: 'us-east-1',
        dataBucketName: 'data',
        futureSecret: 'must-not-leak',
      },
    };
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(substrate);
    const first = await request(createTestApp()).get('/api/v1/cluster-info');
    expect(first.status).toBe(200);
    expect(first.body.baseConfig.domainName).toBeUndefined();
    expect(first.body.baseConfig.aws.zoneId).toBeUndefined();
    expect(first.text).not.toContain('must-not-leak');

    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify({
      ...substrate,
      domainName: 'example.com',
      aws: {
        ...substrate.aws,
        zoneId: 'Z1',
        certificateArn: 'arn:cert',
        cloudfrontDistributionId: 'DIST',
        cloudfrontDistributionDomainName: 'dist.cloudfront.net',
        edgeRouterRoleArn: 'arn:edge',
        apiServerPublicUrl: 'https://api.example.com',
      },
    });
    const second = await request(createTestApp()).get('/api/v1/cluster-info');
    expect(second.status).toBe(200);
    expect(second.body.baseConfig.domainName).toBe('example.com');
    expect(second.body.baseConfig.aws.apiServerPublicUrl).toBe('https://api.example.com');
    expect(second.text).not.toContain('must-not-leak');
  });

  it('never leaks cluster credentials or unknown config keys in baseConfig', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify({
      ...K8S_BASE,
      futureTopLevelField: 'internal-only',
      kubernetes: {
        dataDir: '/data',
        server: 'https://10.0.0.1:6443',
        token: 'sha256~the-k3s-sa-token',
        ca: 'LS0tLS1CRUdJTi==',
        kubeconfig: 'apiVersion: v1\nkind: Config\n',
        buildkit: { addr: 'tcp://127.0.0.1:5054' },
        futureKubernetesField: 'internal-only',
      },
    });

    const res = await request(createTestApp()).get('/api/v1/cluster-info');

    expect(res.status).toBe(200);
    // Credential-bearing fields are dropped from the wire copy…
    expect(res.body.baseConfig.kubernetes.token).toBeUndefined();
    expect(res.body.baseConfig.kubernetes.ca).toBeUndefined();
    expect(res.body.baseConfig.kubernetes.kubeconfig).toBeUndefined();
    expect(res.text).not.toContain('sha256~the-k3s-sa-token');
    expect(res.text).not.toContain('internal-only');
    // …while capabilities still see the FULL config (buildkit ⇒ uploads)
    // and clients keep the fields they consume.
    expect(res.body.capabilities).toEqual({ uploadBuilds: true });
    expect(res.body.baseConfig.kubernetes.dataDir).toBe('/data');
    expect(res.body.baseConfig.kubernetes.buildkit).toEqual({ addr: 'tcp://127.0.0.1:5054' });
  });

  it('surfaces deduplicated watchdog warnings from APPLIANCE_WARNINGS_FILE', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(K8S_BASE);
    const file = join(tmpdir(), `appliance-warnings-${process.pid}-${Date.now()}`);
    const line = 'legacy api-server deploy detected and removed (namespace appliance-system) — update the CLI';
    writeFileSync(file, `${line}\n${line}\n\n`);
    process.env.APPLIANCE_WARNINGS_FILE = file;

    try {
      const res = await request(createTestApp()).get('/api/v1/cluster-info');
      expect(res.status).toBe(200);
      expect(res.body.warnings).toEqual([line]);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('omits warnings when the file is absent or empty', async () => {
    process.env.APPLIANCE_BASE_CONFIG = JSON.stringify(K8S_BASE);
    process.env.APPLIANCE_WARNINGS_FILE = join(tmpdir(), 'appliance-warnings-does-not-exist');

    const res = await request(createTestApp()).get('/api/v1/cluster-info');

    expect(res.status).toBe(200);
    expect(res.body.warnings).toBeUndefined();
  });
});
