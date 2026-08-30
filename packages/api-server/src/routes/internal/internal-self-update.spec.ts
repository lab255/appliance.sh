import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { internalRoutes } from './index';
import {
  resetSelfUpdateServiceForTests,
  setSelfUpdateServiceForTests,
  type SelfUpdateService,
} from '../../services/self-update.service';
import {
  resetSelfUpdateExecutorForTests,
  setSelfUpdateExecutorForTests,
  type SelfUpdateExecutor,
} from '../../services/self-update-executor.service';

function appFor(keyId = 'admin', tenantId = 'default') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.apiKeyId = keyId;
    req.tenantId = tenantId;
    next();
  });
  app.use('/api/internal', internalRoutes);
  return app;
}

describe('POST /api/internal/jobs/self-update', () => {
  const execute = vi.fn();
  const get = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    execute.mockResolvedValue('complete');
    get.mockResolvedValue({
      id: 'selfupdate_1',
      callerKeyId: 'admin',
      ownerTenantId: 'default',
      phase: 'queued',
    });
    setSelfUpdateServiceForTests({ get } as unknown as SelfUpdateService);
    setSelfUpdateExecutorForTests({ execute } as unknown as SelfUpdateExecutor);
  });

  afterEach(() => {
    resetSelfUpdateServiceForTests();
    resetSelfUpdateExecutorForTests();
  });

  it('accepts jobId only and loads the persisted job before execution', async () => {
    const response = await request(appFor()).post('/api/internal/jobs/self-update').send({ jobId: 'selfupdate_1' });
    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith('selfupdate_1');
    expect(execute).toHaveBeenCalledWith('selfupdate_1');
  });

  it.each([
    { jobId: 'selfupdate_1', targetDigest: `sha256:${'a'.repeat(64)}` },
    { jobId: 'selfupdate_1', imageUri: 'attacker/image:latest' },
    { jobId: 'selfupdate_1', version: '999.0.0' },
  ])('rejects direct-worker target injection %#', async (body) => {
    const response = await request(appFor()).post('/api/internal/jobs/self-update').send(body);
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an unknown persisted job', async () => {
    get.mockResolvedValue(null);
    const response = await request(appFor()).post('/api/internal/jobs/self-update').send({ jobId: 'missing' });
    expect(response.status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a valid key that did not create the job', async () => {
    const response = await request(appFor('other-admin')).post('/api/internal/jobs/self-update').send({
      jobId: 'selfupdate_1',
    });
    expect(response.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });
});
