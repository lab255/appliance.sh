import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectStore, VersionedObject } from '@appliance.sh/sdk';
import { StorageService } from './storage.service';
import {
  SELF_UPDATE_CONTROL,
  SELF_UPDATE_IDEMPOTENCY,
  SELF_UPDATE_JOBS,
  SelfUpdateConflictError,
  SelfUpdateService,
  type SelfUpdateDispatcher,
} from './self-update.service';
import type { ControlPlaneRelease, ReleaseVerifier } from './release-trust.adapter';

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
const payload: ControlPlaneRelease = {
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

function evidence(overrides: Partial<ControlPlaneRelease> = {}) {
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
    verifier = vi.fn(async (untrusted, envelope, options) => {
      const release = untrusted as ControlPlaneRelease;
      const failure = (envelope as { failure?: string }).failure;
      if (failure) throw Object.assign(new Error(failure), { code: failure });
      if (release.generation < (options?.highestGeneration ?? 0)) {
        throw Object.assign(new Error('generation rollback'), { code: 'generation-below-floor' });
      }
      return { payload: release, envelope, verifiedAt: new Date(nowMs).toISOString() };
    });
    service = new SelfUpdateService({ storage, dispatcher, verifier, now: () => new Date(nowMs) });
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

  it('binds idempotency to caller and tenant and rejects only a different request behind a live lease', async () => {
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
    ).rejects.toBeInstanceOf(SelfUpdateConflictError);
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
    await service.claim(first.job.id);
    await service.heartbeat(first.job.id, 'waiting-for-stack', { stackId: 'stack-id' });
    nowMs += 61_000;
    const resumed = await service.getAndResume(first.job.id, { keyId: 'admin-a', secret: 'secret' });
    expect(resumed).toMatchObject({ phase: 'waiting-for-stack', stackId: 'stack-id' });
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('allows only one worker invocation to CAS-claim a live lease', async () => {
    const created = await service.create(evidence(), { keyId: 'admin-a', tenantId: 'default', secret: 'secret' });
    await expect(service.claim(created.job.id)).resolves.toMatchObject({ status: 'running' });
    await expect(service.claim(created.job.id)).rejects.toThrow('already claimed');
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
