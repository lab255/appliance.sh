import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockDeploymentService = vi.hoisted(() => ({
  execute: vi.fn(),
  get: vi.fn(),
  continueEdge: vi.fn(),
}));

vi.mock('../../services/deployment.service', () => ({
  deploymentService: mockDeploymentService,
  // The real class must survive the module mock — the route's catch
  // branches on `instanceof EnvironmentBusyError`, and an undefined
  // right-hand side turns every 400 into a 500 TypeError.
  EnvironmentBusyError: class EnvironmentBusyError extends Error {},
}));

const mockApiKeyService = vi.hoisted(() => ({
  getByKeyId: vi.fn(),
}));

vi.mock('../../services/api-key.service', () => ({
  apiKeyService: mockApiKeyService,
}));

import { deploymentRoutes } from './index';

function createTestApp(role: 'admin' | 'member' = 'admin') {
  const app = express();
  app.use(express.json());
  // Stand-in for the signature-auth middleware: the POST route reads
  // req.apiKeyId to re-sign the worker dispatch with the caller's key.
  app.use((req, _res, next) => {
    req.apiKeyId = 'ak_test';
    req.apiKeyRole = role;
    next();
  });
  app.use('/api/v1/deployments', deploymentRoutes);
  return app;
}

describe('Deployment routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockApiKeyService.getByKeyId.mockResolvedValue({ id: 'ak_test', secret: 'sk_test' });
  });

  describe('POST /api/v1/deployments', () => {
    it('should execute a deploy action', async () => {
      const mockDeployment = {
        id: 'deploy-1',
        environmentId: 'env-1',
        projectId: 'proj-1',
        action: 'deploy',
        status: 'succeeded',
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:01:00.000Z',
      };
      mockDeploymentService.execute.mockResolvedValue(mockDeployment);

      const app = createTestApp();
      const res = await request(app).post('/api/v1/deployments').send({
        environmentId: 'env-1',
        action: 'deploy',
      });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('deploy-1');
      expect(res.body.action).toBe('deploy');
    });

    it('should execute a destroy action', async () => {
      const mockDeployment = {
        id: 'deploy-2',
        environmentId: 'env-1',
        action: 'destroy',
        status: 'succeeded',
      };
      mockDeploymentService.execute.mockResolvedValue(mockDeployment);

      const app = createTestApp();
      const res = await request(app).post('/api/v1/deployments').send({
        environmentId: 'env-1',
        action: 'destroy',
      });

      expect(res.status).toBe(201);
      expect(res.body.action).toBe('destroy');
    });

    it('should return 400 for invalid action', async () => {
      const app = createTestApp();
      const res = await request(app).post('/api/v1/deployments').send({
        environmentId: 'env-1',
        action: 'restart',
      });

      expect(res.status).toBe(400);
    });

    it('should return 400 for missing environmentId', async () => {
      const app = createTestApp();
      const res = await request(app).post('/api/v1/deployments').send({
        action: 'deploy',
      });

      expect(res.status).toBe(400);
    });

    it('requires an admin key for the explicit edge target', async () => {
      const input = {
        environmentId: 'env-edge',
        action: 'deploy',
        target: { type: 'edge', domainName: 'example.com', zone: { mode: 'create' } },
      };

      const denied = await request(createTestApp('member')).post('/api/v1/deployments').send(input);
      expect(denied.status).toBe(403);
      expect(mockDeploymentService.execute).not.toHaveBeenCalled();

      mockDeploymentService.execute.mockResolvedValue({ id: 'deploy-edge', ...input, status: 'pending' });
      const allowed = await request(createTestApp('admin')).post('/api/v1/deployments').send(input);
      expect(allowed.status).toBe(201);
      expect(mockDeploymentService.execute).toHaveBeenCalledOnce();
    });
  });

  describe('GET /api/v1/deployments/:id', () => {
    it('should return a deployment by id', async () => {
      mockDeploymentService.get.mockResolvedValue({
        id: 'deploy-1',
        status: 'succeeded',
      });

      const app = createTestApp();
      const res = await request(app).get('/api/v1/deployments/deploy-1');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('deploy-1');
    });

    it('should return 404 when deployment not found', async () => {
      mockDeploymentService.get.mockResolvedValue(null);

      const app = createTestApp();
      const res = await request(app).get('/api/v1/deployments/non-existent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Deployment not found');
    });
  });

  describe('POST /api/v1/deployments/:id/continue', () => {
    it('requires admin and re-dispatches a ready edge deployment with the caller key', async () => {
      const deployment = {
        id: 'deploy-edge',
        environmentId: 'env-edge',
        action: 'deploy',
        target: { type: 'edge' },
        status: 'in_progress',
        edgeConvergence: { state: 'running', attempt: 2 },
      };
      mockDeploymentService.continueEdge.mockResolvedValue(deployment);

      const denied = await request(createTestApp('member')).post('/api/v1/deployments/deploy-edge/continue').send({});
      expect(denied.status).toBe(403);
      expect(mockDeploymentService.continueEdge).not.toHaveBeenCalled();

      const allowed = await request(createTestApp('admin')).post('/api/v1/deployments/deploy-edge/continue').send({});
      expect(allowed.status).toBe(202);
      expect(mockDeploymentService.continueEdge).toHaveBeenCalledWith('deploy-edge', {
        keyId: 'ak_test',
        secret: 'sk_test',
      });
    });
  });
});
