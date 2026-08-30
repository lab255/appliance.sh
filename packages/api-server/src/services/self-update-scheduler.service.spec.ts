import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectStore } from '@appliance.sh/sdk';
import { logger } from '../logger';
import { StorageService } from './storage.service';
import {
  SelfUpdateSchedulerService,
  type SelfUpdatePolicy,
  type SelfUpdateSchedulerDependencies,
} from './self-update-scheduler.service';
import { SelfUpdateConflictError, SYSTEM_SCHEDULED_SELF_UPDATE_CALLER } from './self-update.service';

const OLD_DIGEST = `sha256:${'a'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'b'.repeat(64)}`;

class MemoryStore implements ObjectStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async list(prefix = ''): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
}

function evidence(version: string, digest: string, generation: number) {
  return {
    version,
    targetDigest: digest,
    release: {
      payload: { version, generation, image: { manifestDigest: digest } },
      envelope: { role: 'control-plane-release' },
    },
  } as never;
}

function job(id = 'selfupdate_scheduled', status: 'queued' | 'succeeded' | 'failed' = 'queued') {
  return { id, status } as never;
}

function service(
  policy: SelfUpdatePolicy,
  overrides: Partial<SelfUpdateSchedulerDependencies> = {}
): {
  scheduler: SelfUpdateSchedulerService;
  store: MemoryStore;
  create: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  resolveLatest: ReturnType<typeof vi.fn>;
  resolveRunning: ReturnType<typeof vi.fn>;
} {
  const store = new MemoryStore();
  const create = vi.fn(async () => ({ job: job(), reused: false }));
  const resume = vi.fn(async () => job());
  const resolveLatest = vi.fn(async () => evidence('1.58.0', NEW_DIGEST, 8));
  const resolveRunning = vi.fn(async () => evidence('1.57.0', OLD_DIGEST, 7));
  const scheduler = new SelfUpdateSchedulerService({
    storage: new StorageService(store),
    jobs: { create, getAndResume: resume } as never,
    aws: {
      assumeRole: vi.fn(async () => ({ accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' })),
      describeStack: vi.fn(async () => ({
        stackId: 'stack',
        stackName: 'appliance-test',
        status: 'UPDATE_COMPLETE',
        parameters: [{ key: 'ImageUri', value: `repo@${OLD_DIGEST}` }],
        outputs: {},
      })),
    },
    trust: { keys: { release: 'pin' }, generationFloor: 1, blacklistedKeyIds: [] } as never,
    resolveLatest,
    resolveRunning,
    now: () => new Date('2026-08-31T00:00:00.000Z'),
    policy: () => policy,
    ...overrides,
  });
  return { scheduler, store, create, resume, resolveLatest, resolveRunning };
}

describe('scheduled self-update check', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SELF_UPDATE_ROLE_ARN: 'arn:aws:iam::111111111111:role/appliance-system/self-update',
      APPLIANCE_STACK_ID: 'arn:aws:cloudformation:us-east-1:111111111111:stack/appliance/id',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('does nothing when policy is off', async () => {
    const { scheduler, resolveLatest, create } = service('off');
    await expect(scheduler.check()).resolves.toMatchObject({ decision: 'off', reason: 'policy-off' });
    await expect(scheduler.getLastCheck()).resolves.toMatchObject({ decision: 'off', reason: 'policy-off' });
    expect(resolveLatest).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('logs the locked reason and exits successfully when release pins are empty', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { scheduler, resolveLatest } = service('auto', {
      trust: { keys: {}, generationFloor: 0, blacklistedKeyIds: [] } as never,
    });
    await expect(scheduler.check()).resolves.toMatchObject({
      decision: 'no-trust',
      reason: 'no-pinned-release-trust',
    });
    expect(info).toHaveBeenCalledWith('self-update-check skipped: no pinned release trust');
    expect(resolveLatest).not.toHaveBeenCalled();
  });

  it('does nothing in admin system-role mode', async () => {
    delete process.env.SELF_UPDATE_ROLE_ARN;
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { scheduler, resolveLatest } = service('auto');
    await expect(scheduler.check()).resolves.toMatchObject({ decision: 'unscoped-role', reason: 'unscoped-role' });
    expect(info).toHaveBeenCalledWith(
      'self-update-check skipped: scoped self-update role unavailable (SystemRoleMode=admin)'
    );
    expect(resolveLatest).not.toHaveBeenCalled();
  });

  it('does nothing when the signed latest digest is already running', async () => {
    const { scheduler, resolveLatest, resolveRunning, create } = service('auto', {
      resolveLatest: vi.fn(async () => evidence('1.57.0', OLD_DIGEST, 7)),
    });
    await expect(scheduler.check()).resolves.toMatchObject({
      decision: 'current',
      reason: 'up-to-date',
      version: '1.57.0',
    });
    expect(resolveLatest).not.toHaveBeenCalled();
    expect(resolveRunning).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a signed release generation older than the running image', async () => {
    const { scheduler, create } = service('auto', {
      resolveLatest: vi.fn(async () => evidence('1.56.0', NEW_DIGEST, 6)),
    });
    await expect(scheduler.check()).resolves.toMatchObject({
      decision: 'older-generation',
      reason: 'older-generation',
      version: '1.56.0',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('persists the complete marker in notify mode', async () => {
    const { scheduler, create } = service('notify');
    await expect(scheduler.check()).resolves.toMatchObject({
      decision: 'notify',
      reason: 'notify-marked',
      version: '1.58.0',
    });
    await expect(scheduler.getAvailable()).resolves.toEqual({
      version: '1.58.0',
      digest: NEW_DIGEST,
      generation: 8,
      seenAt: '2026-08-31T00:00:00.000Z',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('clears availability only when the successful executor applied its digest', async () => {
    const { scheduler } = service('notify');
    await scheduler.check();
    await expect(scheduler.clearAvailableIfDigest(OLD_DIGEST)).resolves.toBe(false);
    await expect(scheduler.getAvailable()).resolves.toMatchObject({ digest: NEW_DIGEST });
    await expect(scheduler.clearAvailableIfDigest(NEW_DIGEST)).resolves.toBe(true);
    await expect(scheduler.getAvailable()).resolves.toBeNull();
  });

  it('creates auto jobs through the verified service path with the explicit system caller', async () => {
    const { scheduler, create } = service('auto');
    await expect(scheduler.check()).resolves.toMatchObject({ decision: 'auto-created', reason: 'auto-created' });
    expect(create.mock.calls[0]?.[0]).toEqual({
      targetDigest: NEW_DIGEST,
      release: evidence('1.58.0', NEW_DIGEST, 8).release,
    });
    expect(create.mock.calls[0]?.[1]).toBe(SYSTEM_SCHEDULED_SELF_UPDATE_CALLER);
    expect(create.mock.calls[0]?.[2]).toBe(`scheduled:${NEW_DIGEST}`);
  });

  it('uses the same digest idempotency key on repeated checks and resumes a reused nonterminal job', async () => {
    const { scheduler, create, resume } = service('auto');
    create.mockResolvedValueOnce({ job: job('one'), reused: false }).mockResolvedValueOnce({
      job: job('one'),
      reused: true,
    });
    await expect(scheduler.check()).resolves.toMatchObject({ decision: 'auto-created' });
    await expect(scheduler.check()).resolves.toMatchObject({ decision: 'auto-reused' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.map((call) => call[2])).toEqual([`scheduled:${NEW_DIGEST}`, `scheduled:${NEW_DIGEST}`]);
    expect(resume.mock.calls[0]?.[0]).toBe('one');
    expect(resume.mock.calls[0]?.[1]).toBe(SYSTEM_SCHEDULED_SELF_UPDATE_CALLER);
  });

  it('skips a live lease conflict without surfacing an invocation error', async () => {
    const { scheduler, create } = service('auto');
    create.mockRejectedValue(new SelfUpdateConflictError('selfupdate_live'));
    await expect(scheduler.check()).resolves.toMatchObject({ decision: 'lease-conflict', reason: 'lease-conflict' });
  });

  it('redacts unexpected errors and exits successfully', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { scheduler } = service('auto', {
      resolveLatest: vi.fn(async () => {
        throw new Error('failed arn:aws:iam::111111111111:role/private');
      }),
    });
    await expect(scheduler.check()).resolves.toMatchObject({ decision: 'error', reason: 'error' });
    const logged = errorLog.mock.calls[0]?.[1] as Error;
    expect(logged.message).not.toContain('111111111111');
    expect(logged.message).not.toContain('private');
  });

  it('memoizes availability reads for unauthenticated bootstrap polling', async () => {
    const { scheduler, store } = service('notify');
    const get = vi.spyOn(store, 'get');
    await scheduler.getAvailable();
    await scheduler.getAvailable();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('threads registry and release origins through the injected fetcher', async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith('https://registry.test/token')) {
        return new Response(JSON.stringify({ token: 'token' }), { status: 200 });
      }
      if (url === 'https://registry.test/v2/custom/image/tags/list') {
        return new Response(JSON.stringify({ tags: ['1.58.0'] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const { scheduler } = service('notify', {
      resolveLatest: undefined,
      resolveRunning: undefined,
      fetcher: fetcher as typeof globalThis.fetch,
      releaseBase: 'https://releases.test/download',
      registryTokenEndpoint: 'https://registry.test/token',
      registryEndpoint: 'https://registry.test/v2',
      image: 'custom/image',
    });
    await scheduler.check();
    expect(requested).toContain('https://registry.test/token?scope=repository:custom/image:pull');
    expect(requested).toContain('https://registry.test/v2/custom/image/tags/list');
    expect(requested).toContain('https://releases.test/download/v1.58.0/control-plane-release.json');
    expect(requested).toContain('https://releases.test/download/v1.58.0/control-plane-release.sig.json');
  });
});
