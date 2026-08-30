import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectStore, ReleaseEnvelope, ReleaseSignatureEnvelope, VersionedObject } from '@appliance.sh/sdk';
import { StorageService } from './storage.service';
import {
  SELF_UPDATE_CONTROL,
  SELF_UPDATE_IDEMPOTENCY,
  SELF_UPDATE_JOBS,
  SYSTEM_SCHEDULED_SELF_UPDATE_CALLER,
  HttpSelfUpdateDispatcher,
  SelfUpdateConflictError,
  SelfUpdateService,
  type SelfUpdateDispatcher,
  type ReleaseVerifier,
} from './self-update.service';
import { resetSelfUpdateExecutorForTests, setSelfUpdateExecutorForTests } from './self-update-executor.service';

class MemoryStore implements ObjectStore {
  readonly values = new Map<string, { value: string; version: number }>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key)?.value ?? null;
  }
  async getWithVersion(key: string): Promise<VersionedObject | null> {
    const entry = this.values.get(key);
    return entry ? { value: entry.value, version: String(entry.version) } : null;
  }
  async set(key: string, value: string): Promise<void> {
    const current = this.values.get(key);
    this.values.set(key, { value, version: (current?.version ?? 0) + 1 });
  }
  async setIfAbsent(key: string, value: string): Promise<boolean> {
    if (this.values.has(key)) return false;
    this.values.set(key, { value, version: 1 });
    return true;
  }
  async setIfVersion(key: string, value: string, version: string): Promise<boolean> {
    const current = this.values.get(key);
    if (!current || String(current.version) !== version) return false;
    this.values.set(key, { value, version: current.version + 1 });
    return true;
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async list(prefix?: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => !prefix || key.startsWith(prefix));
  }
}

const digest = `sha256:${'a'.repeat(64)}`;
const payload: ReleaseEnvelope = {
  kind: 'control-plane-release',
  version: '1.58.0',
  generation: 4,
  notBefore: '2026-08-29T00:00:00.000Z',
  expires: '2026-09-30T00:00:00.000Z',
  artifacts: [
    { name: 'appliance-api-server-linux-x64', arch: 'x64', sha256: '1'.repeat(64), size: 1 },
    { name: 'appliance-api-server-linux-arm64', arch: 'arm64', sha256: '2'.repeat(64), size: 1 },
    { name: 'appliance-console.tar.gz', arch: 'any', sha256: '3'.repeat(64), size: 1 },
  ],
  image: { repository: 'ghcr.io/lab255/appliance-api-server', manifestDigest: digest },
};

function evidence(overrides: Partial<ReleaseEnvelope> = {}) {
  return { targetDigest: digest, release: { payload: { ...payload, ...overrides }, envelope: { fixture: true } } };
}

describe('SelfUpdateService durable route state', () => {
  let store: MemoryStore;
  let storage: StorageService;
  let nowMs: number;
  let dispatcher: SelfUpdateDispatcher & { dispatch: ReturnType<typeof vi.fn> };
  let verifier: ReleaseVerifier;
  let service: SelfUpdateService;

  beforeEach(() => {
    store = new MemoryStore();
    storage = new StorageService(store);
    nowMs = Date.parse('2026-08-30T00:00:00.000Z');
    dispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
    verifier = vi.fn(async (untrusted, envelope, _trust, options) => {
      const release = untrusted as ReleaseEnvelope;
      const failure = (envelope as { failure?: string }).failure;
      if (failure) throw Object.assign(new Error(failure), { code: failure });
      if (release.generation < (options?.highestGeneration ?? 0)) {
        throw Object.assign(new Error('generation rollback'), { code: 'generation-below-floor' });
      }
      return {
        payload: release,
        envelope: envelope as ReleaseSignatureEnvelope,
        verifiedAt: new Date(nowMs).toISOString(),
      };
    });
    service = new SelfUpdateService({ storage, dispatcher, verifier, now: () => new Date(nowMs) });
  });

  it('gives the reserved scheduler principal no readable signing secret', () => {
    expect(() => SYSTEM_SCHEDULED_SELF_UPDATE_CALLER.secret).toThrow('has no signing secret');
  });

  it('dispatches the reserved principal in process before any secret read', async () => {
    const execute = vi.fn(async () => 'complete' as const);
    setSelfUpdateExecutorForTests({ execute } as never);
    try {
      await expect(
        new HttpSelfUpdateDispatcher().dispatch('selfupdate_system', SYSTEM_SCHEDULED_SELF_UPDATE_CALLER)
      ).resolves.toBeUndefined();
      expect(execute).toHaveBeenCalledWith('selfupdate_system');
    } finally {
      resetSelfUpdateExecutorForTests();
    }
  });

  it('persists verified evidence and dispatches only the generated job id', async () => {
    const created = await service.create(
      evidence(),
      { keyId: 'admin-a', tenantId: 'default', secret: 'secret' },
      'once'
    );
    expect(created.reused).toBe(false);
    expect(created.job).toMatchObject({
      status: 'queued',
      targetDigest: digest,
      targetVersion: '1.58.0',
      sourceImage: `${payload.image.repository}@${digest}`,
    });
    expect(dispatcher.dispatch).toHaveBeenCalledWith(created.job.id, { keyId: 'admin-a', secret: 'secret' });
    expect(await storage.get(SELF_UPDATE_JOBS, created.job.id)).toBeTruthy();
    expect(JSON.stringify(await storage.get(SELF_UPDATE_JOBS, created.job.id))).toContain('fixture');
  });

  it('binds idempotency to the owner caller and rejects non-owner tenants before verification', async () => {
    const first = await service.create(evidence(), { keyId: 'admin-a', tenantId: 'default', secret: 'secret' }, 'same');
    const repeat = await service.create(
      evidence(),
      { keyId: 'admin-a', tenantId: 'default', secret: 'secret' },
      'same'
    );
    expect(repeat).toMatchObject({ reused: true, job: { id: first.job.id } });
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);

    await expect(
      service.create(evidence(), { keyId: 'admin-b', tenantId: 'default', secret: 'secret' }, 'same')
    ).rejects.toEqual(expect.objectContaining({ name: 'SelfUpdateConflictError', jobId: first.job.id }));
    await expect(
      service.create(evidence(), { keyId: 'admin-a', tenantId: 'owner-2', secret: 'secret' }, 'same')
    ).rejects.toThrow('control-plane self-update requires the owner tenant');
  });

  it('CAS-takes an expired lease and marks the abandoned job failed/unknown', async () => {
    const first = await service.create(evidence(), { keyId: 'admin-a', tenantId: 'default', secret: 'secret' }, 'one');
    nowMs += 61_000;
    const second = await service.create(evidence(), { keyId: 'admin-a', tenantId: 'default', secret: 'secret' }, 'two');
    expect(second.job.id).not.toBe(first.job.id);
    expect(await service.get(first.job.id)).toMatchObject({
      status: 'failed',
      recoveryState: 'unknown',
      phase: 'complete',
    });
  });

  it('re-dispatches an expired nonterminal job from GET and preserves its durable phase', async () => {
    const first = await service.create(
      evidence(),
      { keyId: 'admin-a', tenantId: 'default', secret: 'secret' },
      'resume'
    );
    const claimed = await service.claim(first.job.id);
    await service.heartbeat(first.job.id, claimed.lease.holder!, 'waiting-for-stack', { stackId: 'stack-id' });
    nowMs += 61_000;
    const resumed = await service.getAndResume(first.job.id, { keyId: 'admin-a', secret: 'secret' });
    expect(resumed).toMatchObject({ phase: 'waiting-for-stack', stackId: 'stack-id', resumeCount: 1 });
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('keeps an expired job resumable when redispatch fails', async () => {
    const first = await service.create(
      evidence(),
      { keyId: 'admin-a', tenantId: 'default', secret: 'secret' },
      'resume-failure'
    );
    await service.claim(first.job.id);
    nowMs += 61_000;
    dispatcher.dispatch.mockRejectedValueOnce(new Error('worker unavailable'));
    const resumed = await service.getAndResume(first.job.id, { keyId: 'admin-a', secret: 'secret' });
    expect(resumed).toMatchObject({ status: 'running', phase: 'verifying' });
    expect(resumed?.completedAt).toBeUndefined();
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('allows only one worker invocation to CAS-claim a live lease', async () => {
    const created = await service.create(evidence(), { keyId: 'admin-a', tenantId: 'default', secret: 'secret' });
    await expect(service.claim(created.job.id)).resolves.toMatchObject({ status: 'running' });
    await expect(service.claim(created.job.id)).rejects.toThrow('already claimed');
  });

  it('records additive per-phase durations in the public job', async () => {
    const created = await service.create(evidence(), {
      keyId: 'admin-a',
      tenantId: 'default',
      secret: 'secret',
    });
    nowMs += 1_000;
    const claimed = await service.claim(created.job.id);
    nowMs += 2_000;
    await service.heartbeat(created.job.id, claimed.lease.holder!, 'mirroring');
    nowMs += 3_000;
    await service.heartbeat(created.job.id, claimed.lease.holder!, 'waiting-for-stack');
    nowMs += 4_000;
    const finished = await service.finish(created.job.id, { status: 'succeeded' }, claimed.lease.holder!);

    expect(service.publicJob(finished)).toMatchObject({
      totalMs: 10_000,
      phaseDurationsMs: {
        queued: 1_000,
        verifying: 2_000,
        mirroring: 3_000,
        'waiting-for-stack': 4_000,
      },
    });
  });

  it('charges an expired-lease resume gap to the in-flight phase', async () => {
    const created = await service.create(evidence(), {
      keyId: 'admin-a',
      tenantId: 'default',
      secret: 'secret',
    });
    const first = await service.claim(created.job.id);
    nowMs += 2_000;
    await service.heartbeat(created.job.id, first.lease.holder!, 'waiting-for-stack');
    nowMs += 61_000;
    await service.getAndResume(created.job.id, { keyId: 'admin-a', secret: 'secret' });
    const resumed = await service.claim(created.job.id);
    nowMs += 3_000;
    await service.heartbeat(created.job.id, resumed.lease.holder!, 'probing-health');
    nowMs += 1_000;
    const finished = await service.finish(created.job.id, { status: 'succeeded' }, resumed.lease.holder!);

    expect(service.publicJob(finished)).toMatchObject({
      totalMs: 67_000,
      resumeCount: 1,
      phaseDurationsMs: { 'waiting-for-stack': 64_000 },
    });
  });

  it('fences a zombie worker after an expired lease is resumed and re-claimed', async () => {
    const created = await service.create(evidence(), {
      keyId: 'admin-a',
      tenantId: 'default',
      secret: 'secret',
    });
    const first = await service.claim(created.job.id);
    nowMs += 61_000;
    await service.getAndResume(created.job.id, { keyId: 'admin-a', secret: 'secret' });
    const second = await service.claim(created.job.id);
    expect(second.lease.holder).not.toBe(first.lease.holder);
    await expect(service.heartbeat(created.job.id, first.lease.holder!, 'waiting-for-stack')).rejects.toMatchObject({
      code: 'lease-stolen',
    });
    await expect(service.heartbeat(created.job.id, second.lease.holder!, 'waiting-for-stack')).resolves.toMatchObject({
      lease: { holder: second.lease.holder },
    });
  });

  it('returns a conflict when an idempotency key is reused for another digest or generation', async () => {
    const first = await service.create(
      evidence(),
      { keyId: 'admin-a', tenantId: 'default', secret: 'secret' },
      'immutable-request'
    );
    const otherDigest = `sha256:${'b'.repeat(64)}`;
    await expect(
      service.create(
        {
          targetDigest: otherDigest,
          release: {
            payload: { ...payload, image: { ...payload.image, manifestDigest: otherDigest } },
            envelope: { fixture: true },
          },
        },
        { keyId: 'admin-a', tenantId: 'default', secret: 'secret' },
        'immutable-request'
      )
    ).rejects.toMatchObject({ name: 'SelfUpdateConflictError', jobId: first.job.id });
    await expect(
      service.create(
        evidence({ generation: payload.generation + 1 }),
        { keyId: 'admin-a', tenantId: 'default', secret: 'secret' },
        'immutable-request'
      )
    ).rejects.toMatchObject({ name: 'SelfUpdateConflictError', jobId: first.job.id });
  });

  it('throws explicitly when the generation floor advances between verification and lease CAS', async () => {
    const racingVerifier: ReleaseVerifier = vi.fn(async (untrusted, envelope) => {
      await storage.set(SELF_UPDATE_CONTROL, 'cloud', { highestGeneration: payload.generation + 1 });
      return {
        payload: untrusted as ReleaseEnvelope,
        envelope: envelope as ReleaseSignatureEnvelope,
        verifiedAt: new Date(nowMs).toISOString(),
      };
    });
    const racingService = new SelfUpdateService({
      storage,
      dispatcher,
      verifier: racingVerifier,
      now: () => new Date(nowMs),
    });
    await expect(
      racingService.create(evidence(), { keyId: 'admin-a', tenantId: 'default', secret: 'secret' }, 'generation-race')
    ).rejects.toMatchObject({ code: 'generation-below-floor' });
    expect([...store.values.keys()].filter((key) => key.startsWith(`${SELF_UPDATE_JOBS}/`))).toEqual([]);
  });

  it('terminal jobs clear the lock, retain same-key idempotency, and never block a new key', async () => {
    const first = await service.create(evidence(), { keyId: 'admin-a', tenantId: 'default', secret: 'secret' }, 'done');
    await service.finish(first.job.id, { status: 'failed', recovered: false, recoveryState: 'exhausted' });
    const repeat = await service.create(
      evidence(),
      { keyId: 'admin-a', tenantId: 'default', secret: 'secret' },
      'done'
    );
    expect(repeat.job.id).toBe(first.job.id);
    const next = await service.create(evidence(), { keyId: 'admin-a', tenantId: 'default', secret: 'secret' }, 'retry');
    expect(next.job.id).not.toBe(first.job.id);
  });

  it.each(['unknown-key', 'bad-signature', 'expired', 'blacklisted-key', 'invalid-schema', 'wrong-role'])(
    'rejects %s evidence before persistence',
    async (failure) => {
      await expect(
        service.create(
          { targetDigest: digest, release: { payload, envelope: { failure } } },
          { keyId: 'admin-a', tenantId: 'default', secret: 'secret' },
          failure
        )
      ).rejects.toEqual(expect.objectContaining({ code: failure }));
      expect([...store.values.keys()].filter((key) => key.startsWith(`${SELF_UPDATE_JOBS}/`))).toEqual([]);
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    }
  );

  it('fails closed against the empty production pin set with AP-226 guidance', async () => {
    const productionService = new SelfUpdateService({ storage, dispatcher, now: () => new Date(nowMs) });
    await expect(
      productionService.create(
        {
          targetDigest: digest,
          release: {
            payload,
            envelope: {
              alg: 'ed25519',
              keyId: `ed25519:sha256:${'4'.repeat(64)}`,
              role: 'control-plane-release',
              sig: 'AA',
            },
          },
        },
        { keyId: 'admin-a', tenantId: 'default', secret: 'secret' },
        'production-pins-empty'
      )
    ).rejects.toMatchObject({ code: 'unknown-key', message: expect.stringContaining('AP-226') });
    expect([...store.values.keys()].filter((key) => key.startsWith(`${SELF_UPDATE_JOBS}/`))).toEqual([]);
  });

  it('rejects signed digest mismatch before creating a job', async () => {
    await expect(
      service.create(
        { ...evidence(), targetDigest: `sha256:${'b'.repeat(64)}` },
        { keyId: 'admin-a', tenantId: 'default', secret: 'secret' },
        'mismatch'
      )
    ).rejects.toEqual(expect.objectContaining({ code: 'digest-mismatch' }));
    expect([...store.values.keys()].some((key) => key.startsWith(`${SELF_UPDATE_JOBS}/`))).toBe(false);
  });

  it('persists the generation high-water mark and rejects rollback on the next request', async () => {
    const first = await service.create(evidence({ generation: 9 }), {
      keyId: 'admin-a',
      tenantId: 'default',
      secret: 'secret',
    });
    await service.finish(first.job.id, { status: 'succeeded', recovered: false });
    await expect(
      service.create(evidence({ generation: 8 }), { keyId: 'admin-a', tenantId: 'default', secret: 'secret' })
    ).rejects.toEqual(expect.objectContaining({ code: 'generation-below-floor' }));
    const control = [...store.values.entries()].find(([key]) => key.startsWith(`${SELF_UPDATE_CONTROL}/`));
    expect(control?.[1].value).toContain('"highestGeneration":9');
  });

  it('uses a collision-resistant composite idempotency storage key', async () => {
    await service.create(evidence(), { keyId: 'a/b', tenantId: 'default', secret: 'secret' }, '../same');
    const keys = [...store.values.keys()].filter((key) => key.startsWith(`${SELF_UPDATE_IDEMPOTENCY}/`));
    expect(keys).toHaveLength(1);
    const id = keys[0]!.split('/').at(-1)!.replace('.json', '');
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(id).toBe(
      createHash('sha256')
        .update(JSON.stringify(['a/b', 'default', '../same']))
        .digest('hex')
    );
  });

  it('reads an N-1 job record with additive unknown fields', async () => {
    const created = await service.create(evidence(), { keyId: 'admin-a', tenantId: 'default', secret: 'secret' });
    await storage.set(SELF_UPDATE_JOBS, created.job.id, {
      ...created.job,
      schemaVersion: 0,
      legacyWorkerNote: 'ignored by N reader',
    });
    const loaded = await service.get(created.job.id);
    expect(loaded).toMatchObject({ schemaVersion: 0, id: created.job.id, phase: 'queued' });
    expect(service.publicJob(loaded!)).toMatchObject({ jobId: created.job.id, status: 'queued' });
  });
});
