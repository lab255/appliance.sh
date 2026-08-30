import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { logger } from '../../logger';
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
import {
  resetSelfUpdateSchedulerServiceForTests,
  setSelfUpdateSchedulerServiceForTests,
} from '../../services/self-update-scheduler.service';

function appFor(keyId = 'admin', tenantId = 'default') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.apiKeyId = keyId;
    req.apiKeyRole = 'admin';
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
    resetSelfUpdateSchedulerServiceForTests();
  });

  it('runs only a fixed target-free owner-admin check', async () => {
    const check = vi.fn(async () => ({
      at: '2026-08-31T00:00:00.000Z',
      decision: 'notify',
      reason: 'notify-marked',
    }));
    setSelfUpdateSchedulerServiceForTests({ check } as never);

    const accepted = await request(appFor()).post('/api/internal/self-update/check').send({
      kind: 'self-update-check',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ decision: 'notify', reason: 'notify-marked' });
    expect(check).toHaveBeenCalledOnce();

    const injected = await request(appFor())
      .post('/api/internal/self-update/check')
      .send({
        kind: 'self-update-check',
        targetDigest: `sha256:${'a'.repeat(64)}`,
      });
    expect(injected.status).toBe(400);
    expect(check).toHaveBeenCalledOnce();
  });

  it('rejects a signed non-owner check', async () => {
    const check = vi.fn();
    setSelfUpdateSchedulerServiceForTests({ check } as never);
    const response = await request(appFor('admin', 'tenant-b'))
      .post('/api/internal/self-update/check')
      .send({ kind: 'self-update-check' });
    expect(response.status).toBe(403);
    expect(check).not.toHaveBeenCalled();
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

  it('logs the redacted executor error and returns 500', async () => {
    execute.mockRejectedValueOnce(
      new Error('arn:aws:sts::123456789012:assumed-role/private/session cannot update account 123456789012')
    );
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const response = await request(appFor()).post('/api/internal/jobs/self-update').send({ jobId: 'selfupdate_1' });
    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalledWith(
      'self-update worker job failed',
      expect.objectContaining({ message: '[REDACTED_ARN] cannot update account [REDACTED_ACCOUNT]' }),
      expect.objectContaining({ jobId: 'selfupdate_1' })
    );
    logged.mockRestore();
  });
});
