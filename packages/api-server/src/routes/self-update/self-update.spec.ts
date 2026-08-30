import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requireAdmin } from '../../middleware/auth';
import { createSelfUpdateRoutes, redactSelfUpdateError, requireOwnerTenant } from './index';

const mockApiKeyService = vi.hoisted(() => ({ getByKeyId: vi.fn() }));
vi.mock('../../services/api-key.service', () => ({ apiKeyService: mockApiKeyService }));

const digest = `sha256:${'a'.repeat(64)}`;
const job = {
  schemaVersion: 1 as const,
  id: 'selfupdate_job-1',
  ownerTenantId: 'default',
  callerKeyId: 'admin',
  idempotencyHash: 'hash',
  status: 'queued' as const,
  phase: 'queued' as const,
  targetDigest: digest,
  targetVersion: '1.58.0',
  generation: 1,
  sourceImage: `ghcr.io/lab255/appliance@${digest}`,
  release: { payload: {}, envelope: {}, verifiedAt: '2026-08-30T00:00:00.000Z' },
  lease: { heartbeatAt: '2026-08-30T00:00:00.000Z', expiresAt: '2026-08-30T00:01:00.000Z' },
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
};

function appFor(
  service: {
    create: ReturnType<typeof vi.fn>;
    getAndResume: ReturnType<typeof vi.fn>;
    publicJob: ReturnType<typeof vi.fn>;
  },
  role: 'admin' | 'member',
  tenantId: string
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.apiKeyId = 'admin';
    req.apiKeyRole = role;
    req.tenantId = tenantId;
    next();
  });
  app.use(
    '/api/v1/self-update',
    requireAdmin,
    requireOwnerTenant,
    createSelfUpdateRoutes(() => service as never)
  );
  return app;
}

describe('self-update routes', () => {
  let service: {
    create: ReturnType<typeof vi.fn>;
    getAndResume: ReturnType<typeof vi.fn>;
    publicJob: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockApiKeyService.getByKeyId.mockResolvedValue({ id: 'admin', secret: 'secret' });
    service = {
      create: vi.fn().mockResolvedValue({ job, reused: false }),
      getAndResume: vi.fn().mockResolvedValue(job),
      publicJob: vi.fn().mockReturnValue({ jobId: job.id, status: job.status, phase: job.phase }),
    };
  });

  it('returns POST 202 and GET status for an owner admin', async () => {
    const app = appFor(service, 'admin', 'default');
    const post = await request(app)
      .post('/api/v1/self-update')
      .set('idempotency-key', 'cli-1')
      .send({ targetDigest: digest, release: { payload: {}, envelope: {} } });
    expect(post.status).toBe(202);
    expect(post.body).toEqual({
      jobId: job.id,
      status: 'queued',
      statusUrl: `/api/v1/self-update/${job.id}`,
    });
    expect(service.create).toHaveBeenCalledWith(
      expect.anything(),
      {
        keyId: 'admin',
        tenantId: 'default',
        secret: 'secret',
      },
      'cli-1'
    );

    const get = await request(app).get(`/api/v1/self-update/${job.id}`);
    expect(get.status).toBe(200);
    expect(get.body).toEqual({ jobId: job.id, status: 'queued', phase: 'queued' });
  });

  it.each(['POST', 'GET'])('rejects member %s with 403', async (method) => {
    const call = request(appFor(service, 'member', 'default'));
    const response =
      method === 'POST'
        ? await call.post('/api/v1/self-update').send({ targetDigest: digest, release: { payload: {}, envelope: {} } })
        : await call.get(`/api/v1/self-update/${job.id}`);
    expect(response.status).toBe(403);
    expect(service.create).not.toHaveBeenCalled();
    expect(service.getAndResume).not.toHaveBeenCalled();
  });

  it.each(['POST', 'GET'])('rejects non-owner tenant %s with 403', async (method) => {
    const call = request(appFor(service, 'admin', 'tenant-b'));
    const response =
      method === 'POST'
        ? await call.post('/api/v1/self-update').send({ targetDigest: digest, release: { payload: {}, envelope: {} } })
        : await call.get(`/api/v1/self-update/${job.id}`);
    expect(response.status).toBe(403);
  });

  it('rejects extra request controls before calling the service', async () => {
    const response = await request(appFor(service, 'admin', 'default'))
      .post('/api/v1/self-update')
      .send({ targetDigest: digest, release: { payload: {}, envelope: {} }, imageUri: 'attacker/image:latest' });
    expect(response.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('redacts the complete CU1 sensitive error set', () => {
    const error = redactSelfUpdateError(
      new Error(
        'Basic dXNlcjpwYXNz 123456789012.dkr.ecr.us-east-1.amazonaws.com arn:aws:iam::123456789012:role/private self-update-job signature=abc signature-input=def content-digest=ghi envelope:"bytes"'
      )
    ).message;
    expect(error).not.toMatch(/dXNlcj|123456789012|private|self-update-job|signature=abc|def|ghi|"bytes"/);
    expect(error).toContain('[REDACTED_ECR_TOKEN]');
    expect(error).toContain('[REDACTED_ECR_REGISTRY]');
    expect(error).toContain('[REDACTED_ROLE_ARN]');
    expect(error).toContain('[REDACTED_ROLE_SESSION]');
  });
});
