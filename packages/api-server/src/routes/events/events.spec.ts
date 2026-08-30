import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetSelfUpdateSchedulerServiceForTests,
  setSelfUpdateSchedulerServiceForTests,
} from '../../services/self-update-scheduler.service';
import { eventRoutes } from './index';

function app() {
  const value = express();
  value.use(express.json());
  value.use('/events', eventRoutes);
  return value;
}

describe('Lambda pass-through self-update events', () => {
  afterEach(() => resetSelfUpdateSchedulerServiceForTests());

  it('accepts only the fixed target-free scheduled check', async () => {
    const check = vi.fn(async () => 'notify' as const);
    setSelfUpdateSchedulerServiceForTests({ check } as never);

    const response = await request(app()).post('/events').send({ kind: 'self-update-check' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(check).toHaveBeenCalledOnce();
  });

  it('hides the pass-through route from Function URL requests', async () => {
    const check = vi.fn();
    setSelfUpdateSchedulerServiceForTests({ check } as never);

    const response = await request(app())
      .post('/events')
      .set('x-amzn-request-context', JSON.stringify({ requestId: 'public-function-url' }))
      .send({ kind: 'self-update-check' });

    expect(response.status).toBe(404);
    expect(response.text).toBe('');
    expect(check).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'self-update-check', targetDigest: `sha256:${'a'.repeat(64)}` },
    { kind: 'self-update-check', version: '9.9.9' },
    { kind: 'self-update-check', uri: 'ghcr.io/attacker/image:latest' },
    { jobId: 'bypass' },
  ])('rejects injected target controls: %j', async (body) => {
    const check = vi.fn();
    setSelfUpdateSchedulerServiceForTests({ check } as never);

    const response = await request(app()).post('/events').send(body);

    expect(response.status).toBe(400);
    expect(check).not.toHaveBeenCalled();
  });
});
