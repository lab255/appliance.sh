import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockApiKeyService = vi.hoisted(() => ({
  create: vi.fn(),
  exists: vi.fn(),
}));

vi.mock('../../services/api-key.service', () => ({
  apiKeyService: mockApiKeyService,
}));

const mockInviteService = vi.hoisted(() => ({
  redeem: vi.fn(),
}));

vi.mock('../../services/invite.service', () => ({
  inviteService: mockInviteService,
}));

import { bootstrapRoutes } from './index';
import {
  resetSelfUpdateSchedulerServiceForTests,
  setSelfUpdateSchedulerServiceForTests,
} from '../../services/self-update-scheduler.service';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/bootstrap', bootstrapRoutes);
  return app;
}

describe('Bootstrap routes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockApiKeyService.exists.mockResolvedValue(false);
    process.env = { ...originalEnv, BOOTSTRAP_TOKEN: 'test-token-123' };
    setSelfUpdateSchedulerServiceForTests({ getAvailable: async () => null } as never);
  });

  afterEach(() => {
    process.env = originalEnv;
    resetSelfUpdateSchedulerServiceForTests();
  });

  describe('POST /bootstrap/create-key', () => {
    it('should create API key with valid bootstrap token', async () => {
      mockApiKeyService.create.mockResolvedValue({
        id: 'ak_test',
        name: 'cli',
        secret: 'sk_secret',
        createdAt: '2025-01-01T00:00:00.000Z',
      });

      const app = createTestApp();
      const res = await request(app)
        .post('/bootstrap/create-key')
        .set('x-bootstrap-token', 'test-token-123')
        .send({ name: 'cli' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('ak_test');
      expect(res.body.secret).toBe('sk_secret');
      expect(mockApiKeyService.create).toHaveBeenCalledWith('cli');
    });

    it('rejects the permanent bootstrap token after the first API key exists', async () => {
      mockApiKeyService.exists.mockResolvedValue(true);

      const res = await request(createTestApp())
        .post('/bootstrap/create-key')
        .set('x-bootstrap-token', 'test-token-123')
        .send({ name: 'second-admin' });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already initialized/i);
      expect(mockApiKeyService.create).not.toHaveBeenCalled();
    });

    it('should return 403 for invalid bootstrap token', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/bootstrap/create-key')
        .set('x-bootstrap-token', 'wrong-token')
        .send({ name: 'cli' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Invalid bootstrap token');
    });

    it('should return 403 when no token provided', async () => {
      const app = createTestApp();
      const res = await request(app).post('/bootstrap/create-key').send({ name: 'cli' });

      expect(res.status).toBe(403);
    });

    it('should return 500 when BOOTSTRAP_TOKEN not configured', async () => {
      delete process.env.BOOTSTRAP_TOKEN;

      const app = createTestApp();
      const res = await request(app)
        .post('/bootstrap/create-key')
        .set('x-bootstrap-token', 'any')
        .send({ name: 'cli' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Bootstrap token not configured');
    });

    it('should return 400 for invalid body', async () => {
      const app = createTestApp();
      const res = await request(app).post('/bootstrap/create-key').set('x-bootstrap-token', 'test-token-123').send({});

      expect(res.status).toBe(400);
    });
  });

  describe('POST /bootstrap/redeem-invite', () => {
    it('mints a key for a valid token without any auth headers', async () => {
      mockInviteService.redeem.mockResolvedValue({
        ok: true,
        key: {
          id: 'apikey_new',
          name: 'teammate',
          secret: 'sk_new',
          createdAt: '2025-01-01T00:00:00.000Z',
          role: 'member',
        },
      });

      const app = createTestApp();
      const res = await request(app).post('/bootstrap/redeem-invite').send({ token: 'inv_abc' });

      expect(res.status).toBe(201);
      expect(res.body.secret).toBe('sk_new');
      expect(res.body.role).toBe('member');
      expect(mockInviteService.redeem).toHaveBeenCalledWith('inv_abc');
    });

    it('returns 404 for an unknown token', async () => {
      mockInviteService.redeem.mockResolvedValue({ ok: false, reason: 'not-found' });

      const app = createTestApp();
      const res = await request(app).post('/bootstrap/redeem-invite').send({ token: 'inv_nope' });

      expect(res.status).toBe(404);
    });

    it('returns 410 for an already-used token', async () => {
      mockInviteService.redeem.mockResolvedValue({ ok: false, reason: 'redeemed' });

      const app = createTestApp();
      const res = await request(app).post('/bootstrap/redeem-invite').send({ token: 'inv_used' });

      expect(res.status).toBe(410);
      expect(res.body.error).toContain('already used');
    });

    it('returns 410 for an expired token', async () => {
      mockInviteService.redeem.mockResolvedValue({ ok: false, reason: 'expired' });

      const app = createTestApp();
      const res = await request(app).post('/bootstrap/redeem-invite').send({ token: 'inv_old' });

      expect(res.status).toBe(410);
      expect(res.body.error).toContain('expired');
    });

    it('returns 400 when the token is missing', async () => {
      const app = createTestApp();
      const res = await request(app).post('/bootstrap/redeem-invite').send({});

      expect(res.status).toBe(400);
      expect(mockInviteService.redeem).not.toHaveBeenCalled();
    });
  });

  describe('GET /bootstrap/status', () => {
    it('should return initialized: false when no keys exist', async () => {
      mockApiKeyService.exists.mockResolvedValue(false);

      const app = createTestApp();
      const res = await request(app).get('/bootstrap/status');

      expect(res.status).toBe(200);
      expect(res.body.initialized).toBe(false);
    });

    it('should return initialized: true when keys exist', async () => {
      mockApiKeyService.exists.mockResolvedValue(true);

      const app = createTestApp();
      const res = await request(app).get('/bootstrap/status');

      expect(res.status).toBe(200);
      expect(res.body.initialized).toBe(true);
    });

    it('should report serverVersion on the unauthenticated probe', async () => {
      mockApiKeyService.exists.mockResolvedValue(true);

      const app = createTestApp();
      const res = await request(app).get('/bootstrap/status');

      expect(res.status).toBe(200);
      // The pre-credential version-skew signal: cluster-info needs a
      // signed request, this route does not.
      expect(typeof res.body.serverVersion).toBe('string');
      expect(res.body.serverVersion.length).toBeGreaterThan(0);
    });

    it('exposes only an availability boolean on the unauthenticated probe', async () => {
      process.env.SELF_UPDATE_POLICY = 'notify';
      setSelfUpdateSchedulerServiceForTests({
        getAvailable: async () => ({
          version: '9.9.9',
          digest: `sha256:${'a'.repeat(64)}`,
          generation: 99,
          seenAt: '2026-08-31T00:00:00.000Z',
        }),
      } as never);

      const res = await request(createTestApp()).get('/bootstrap/status');

      expect(res.status).toBe(200);
      expect(res.body.selfUpdateAvailable).toBe(true);
      expect(res.text).not.toContain('9.9.9');
      expect(res.text).not.toContain('sha256:');
      expect(res.text).not.toContain('generation');
    });
  });
});
