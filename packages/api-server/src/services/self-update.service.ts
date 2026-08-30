import { createHash, randomUUID } from 'node:crypto';
import {
  PINNED_RELEASE_TRUST,
  signRequest,
  verifyReleaseEnvelope,
  z,
  type ReleaseEnvelope,
  type SelfUpdatePhase,
  type SelfUpdatePhaseDurations,
  type SelfUpdatePublicJob,
  type SelfUpdateStatus,
  type SigningCredentials,
} from '@appliance.sh/sdk';
import { getStorageService, type StorageService } from './storage.service';
import { logger } from '../logger';

export const SELF_UPDATE_JOBS = 'self-update-jobs';
export const SELF_UPDATE_CONTROL = 'self-update-control';
export const SELF_UPDATE_IDEMPOTENCY = 'self-update-idempotency';
const CONTROL_ID = 'cloud';
const LEASE_MS = 60_000;
const DISPATCH_TIMEOUT_MS = 5_000;
const MAX_CAS_ATTEMPTS = 12;

export const selfUpdateRequestSchema = z.strictObject({
  targetDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  release: z.strictObject({ payload: z.unknown(), envelope: z.unknown() }),
});

export const selfUpdateWorkerEventSchema = z.strictObject({ jobId: z.string().min(1) });

export interface SelfUpdateLease {
  expiresAt: string;
  heartbeatAt: string;
  claimedAt?: string;
  holder?: string;
}

export interface SelfUpdateJob {
  /** Version 0 used the same core fields; readers intentionally accept N-1. */
  schemaVersion: 0 | 1;
  id: string;
  ownerTenantId: string;
  callerKeyId: string;
  idempotencyHash: string;
  status: SelfUpdateStatus;
  phase: SelfUpdatePhase;
  targetDigest: string;
  targetVersion: string;
  generation: number;
  sourceImage: string;
  release: { payload: ReleaseEnvelope; envelope: unknown; verifiedAt: string };
  lease: SelfUpdateLease;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Additive CU2 fields; absent on schema-v0/N-1 records. */
  phaseStartedAt?: string;
  phaseDurationsMs?: SelfUpdatePhaseDurations;
  previousImage?: string;
  targetImage?: string;
  stackId?: string;
  stackName?: string;
  templateIdentity?: string;
  healthUrl?: string;
  error?: string;
  recovered?: boolean;
  recoveryState?: 'unknown' | 'in-progress' | 'recovered' | 'exhausted';
}

interface ControlState {
  highestGeneration: number;
  lease?: SelfUpdateLease & { jobId: string; idempotencyHash: string };
}

interface IdempotencyBinding {
  jobId: string;
  createdAt: string;
}

export class SelfUpdateConflictError extends Error {
  constructor(readonly jobId: string) {
    super(`Self-update job ${jobId} holds the live lease`);
    this.name = 'SelfUpdateConflictError';
  }
}

export class SelfUpdateLeaseStolenError extends Error {
  readonly code = 'lease-stolen';

  constructor(readonly jobId: string) {
    super(`Self-update lease was stolen for ${jobId}`);
    this.name = 'SelfUpdateLeaseStolenError';
  }
}

export interface SelfUpdateDispatcher {
  dispatch(jobId: string, caller: SigningCredentials): Promise<void>;
}

export class HttpSelfUpdateDispatcher implements SelfUpdateDispatcher {
  async dispatch(jobId: string, caller: SigningCredentials): Promise<void> {
    const workerUrl = process.env.WORKER_URL;
    if (!workerUrl) throw new Error('WORKER_URL is required for cloud self-update');
    const url = `${workerUrl.replace(/\/$/, '')}/api/internal/jobs/self-update`;
    const body = JSON.stringify({ jobId });
    const baseHeaders: Record<string, string> = { 'content-type': 'application/json' };
    const signed = await signRequest(caller, { method: 'POST', url, headers: baseHeaders, body });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...baseHeaders, ...signed },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`worker returned ${response.status}: ${await response.text()}`);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface SelfUpdateServiceDependencies {
  storage?: StorageService;
  verifier?: ReleaseVerifier;
  dispatcher?: SelfUpdateDispatcher;
  now?: () => Date;
}

export type ReleaseVerifier = typeof verifyReleaseEnvelope;

export class SelfUpdateService {
  private readonly storage: StorageService;
  private readonly verifier: ReleaseVerifier;
  private readonly dispatcher: SelfUpdateDispatcher;
  private readonly now: () => Date;

  constructor(deps: SelfUpdateServiceDependencies = {}) {
    this.storage = deps.storage ?? getStorageService();
    this.verifier = deps.verifier ?? verifyReleaseEnvelope;
    this.dispatcher = deps.dispatcher ?? new HttpSelfUpdateDispatcher();
    this.now = deps.now ?? (() => new Date());
  }

  async create(
    input: z.infer<typeof selfUpdateRequestSchema>,
    principal: { keyId: string; tenantId: string; secret: string },
    idempotencyKey?: string
  ): Promise<{ job: SelfUpdateJob; reused: boolean }> {
    const initialState = await this.getControlState();
    const verified = await this.verifier(input.release.payload, input.release.envelope, PINNED_RELEASE_TRUST, {
      now: this.now(),
      highestGeneration: initialState.value.highestGeneration,
    });
    if (verified.payload.image.manifestDigest !== input.targetDigest) {
      throw Object.assign(new Error('targetDigest does not match the signed release image digest'), {
        name: 'CatalogueTrustError',
        code: 'digest-mismatch',
      });
    }

    const normalizedKey = normalizeIdempotencyKey(idempotencyKey) ?? `request-${randomUUID()}`;
    const idempotencyHash = hashIdempotency(principal.keyId, principal.tenantId, normalizedKey);
    const existingBinding = await this.storage.get<IdempotencyBinding>(SELF_UPDATE_IDEMPOTENCY, idempotencyHash);
    if (existingBinding) {
      const existing = await this.get(existingBinding.jobId);
      if (existing) {
        if (existing.targetDigest !== input.targetDigest || existing.generation !== verified.payload.generation) {
          throw new SelfUpdateConflictError(existing.id);
        }
        return { job: existing, reused: true };
      }
    }

    const now = this.now();
    const lease = newLease(now);
    const job: SelfUpdateJob = {
      schemaVersion: 1,
      id: `selfupdate_${randomUUID()}`,
      ownerTenantId: principal.tenantId,
      callerKeyId: principal.keyId,
      idempotencyHash,
      status: 'queued',
      phase: 'queued',
      targetDigest: input.targetDigest,
      targetVersion: verified.payload.version,
      generation: verified.payload.generation,
      sourceImage: `${verified.payload.image.repository}@${input.targetDigest}`,
      release: verified,
      lease,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      phaseStartedAt: now.toISOString(),
      phaseDurationsMs: {},
    };
    if (!(await this.storage.setIfAbsent(SELF_UPDATE_JOBS, job.id, job))) {
      throw new Error('self-update job id collision');
    }

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.getControlState();
      if (current.value.highestGeneration > verified.payload.generation) {
        await this.storage.delete(SELF_UPDATE_JOBS, job.id);
        throw Object.assign(new Error('release generation is below the persisted high-water mark'), {
          name: 'CatalogueTrustError',
          code: 'generation-below-floor',
        });
      }
      const active = current.value.lease;
      if (active && isLeaseLive(active, this.now())) {
        await this.storage.delete(SELF_UPDATE_JOBS, job.id);
        if (active.idempotencyHash === idempotencyHash) {
          const existing = await this.get(active.jobId);
          if (existing) return { job: existing, reused: true };
        }
        throw new SelfUpdateConflictError(active.jobId);
      }
      const next: ControlState = {
        highestGeneration: Math.max(current.value.highestGeneration, verified.payload.generation),
        lease: { ...lease, jobId: job.id, idempotencyHash },
      };
      if (!(await this.storage.setIfVersion(SELF_UPDATE_CONTROL, CONTROL_ID, next, current.version))) continue;
      if (active) await this.failAbandoned(active.jobId);
      await this.storage.setIfAbsent(SELF_UPDATE_IDEMPOTENCY, idempotencyHash, {
        jobId: job.id,
        createdAt: now.toISOString(),
      });
      await this.dispatchOrFail(job, { keyId: principal.keyId, secret: principal.secret });
      return { job: (await this.get(job.id)) ?? job, reused: false };
    }
    await this.storage.delete(SELF_UPDATE_JOBS, job.id);
    throw new Error('self-update lease contention did not converge');
  }

  async get(jobId: string): Promise<SelfUpdateJob | null> {
    return this.storage.get<SelfUpdateJob>(SELF_UPDATE_JOBS, jobId);
  }

  async getAndResume(jobId: string, caller: SigningCredentials): Promise<SelfUpdateJob | null> {
    let job = await this.get(jobId);
    if (!job || isTerminal(job)) return job;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const control = await this.getControlState();
      const active = control.value.lease;
      if (active?.jobId !== jobId || isLeaseLive(active, this.now())) return job;
      const lease = newLease(this.now());
      const next: ControlState = {
        ...control.value,
        lease: { ...lease, jobId, idempotencyHash: job.idempotencyHash },
      };
      if (!(await this.storage.setIfVersion(SELF_UPDATE_CONTROL, CONTROL_ID, next, control.version))) continue;
      await this.updateJob(jobId, (current) => ({ ...current, lease, updatedAt: this.now().toISOString() }));
      await this.dispatchForResume(job, caller);
      job = await this.get(jobId);
      return job;
    }
    return job;
  }

  async claim(jobId: string): Promise<SelfUpdateJob> {
    const job = await this.get(jobId);
    if (!job) throw new Error(`Self-update job not found: ${jobId}`);
    if (isTerminal(job)) return job;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const control = await this.getControlState();
      const active = control.value.lease;
      if (!active || active.jobId !== jobId || !isLeaseLive(active, this.now())) {
        throw new Error(`Self-update lease is not live for ${jobId}`);
      }
      if (active.claimedAt) throw new Error(`Self-update lease is already claimed for ${jobId}`);
      const lease = {
        ...newLease(this.now()),
        claimedAt: this.now().toISOString(),
        holder: randomUUID(),
      };
      const next = { ...control.value, lease: { ...active, ...lease } };
      if (!(await this.storage.setIfVersion(SELF_UPDATE_CONTROL, CONTROL_ID, next, control.version))) continue;
      return this.updateJob(jobId, (current) => ({
        ...transitionPhase(current, current.phase === 'queued' ? 'verifying' : current.phase, this.now()),
        status: 'running',
        lease,
        startedAt: current.startedAt ?? this.now().toISOString(),
        updatedAt: this.now().toISOString(),
      }));
    }
    throw new Error('self-update worker lease contention did not converge');
  }

  async heartbeat(
    jobId: string,
    holder: string,
    phase: SelfUpdatePhase,
    patch: Partial<SelfUpdateJob> = {}
  ): Promise<SelfUpdateJob> {
    const lease = newLease(this.now());
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const control = await this.getControlState();
      if (control.value.lease?.jobId !== jobId || control.value.lease.holder !== holder) {
        throw new SelfUpdateLeaseStolenError(jobId);
      }
      const next = {
        ...control.value,
        lease: { ...control.value.lease, ...lease },
      };
      if (!(await this.storage.setIfVersion(SELF_UPDATE_CONTROL, CONTROL_ID, next, control.version))) continue;
      return this.updateJob(jobId, (job) => ({
        ...transitionPhase(job.lease.holder === holder ? job : throwLeaseStolen(jobId), phase, this.now()),
        ...patch,
        lease: {
          ...lease,
          claimedAt: job.lease.claimedAt,
          holder,
        },
        updatedAt: this.now().toISOString(),
      }));
    }
    throw new Error('self-update heartbeat contention did not converge');
  }

  async finish(jobId: string, patch: Partial<SelfUpdateJob>, holder?: string): Promise<SelfUpdateJob> {
    if (holder) await this.assertHolder(jobId, holder);
    const finished = await this.updateJob(jobId, (job) => ({
      ...transitionPhase(holder && job.lease.holder !== holder ? throwLeaseStolen(jobId) : job, 'complete', this.now()),
      ...patch,
      completedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    }));
    await this.clearLease(jobId, holder);
    return finished;
  }

  publicJob(job: SelfUpdateJob): SelfUpdatePublicJob {
    return {
      jobId: job.id,
      status: job.status,
      phase: job.phase,
      target: {
        digest: job.targetDigest,
        version: job.targetVersion,
        generation: job.generation,
        source: job.sourceImage,
      },
      ...(job.previousImage ? { previousImage: job.previousImage } : {}),
      ...(job.targetImage ? { targetImage: job.targetImage } : {}),
      timestamps: {
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        ...(job.startedAt ? { startedAt: job.startedAt } : {}),
        ...(job.completedAt ? { completedAt: job.completedAt } : {}),
        heartbeatAt: job.lease.heartbeatAt,
        leaseExpiresAt: job.lease.expiresAt,
      },
      ...(job.phaseDurationsMs ? { phaseDurationsMs: job.phaseDurationsMs } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.recovered !== undefined ? { recovered: job.recovered } : {}),
      ...(job.recoveryState ? { recoveryState: job.recoveryState } : {}),
    };
  }

  private async getControlState(): Promise<{ value: ControlState; version: string }> {
    await this.storage.setIfAbsent<ControlState>(SELF_UPDATE_CONTROL, CONTROL_ID, { highestGeneration: 0 });
    const state = await this.storage.getVersioned<ControlState>(SELF_UPDATE_CONTROL, CONTROL_ID);
    if (!state) throw new Error('self-update control state disappeared');
    return state;
  }

  private async updateJob(jobId: string, update: (job: SelfUpdateJob) => SelfUpdateJob): Promise<SelfUpdateJob> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.storage.getVersioned<SelfUpdateJob>(SELF_UPDATE_JOBS, jobId);
      if (!current) throw new Error(`Self-update job not found: ${jobId}`);
      const next = update(current.value);
      if (await this.storage.setIfVersion(SELF_UPDATE_JOBS, jobId, next, current.version)) return next;
    }
    throw new Error(`self-update job ${jobId} CAS contention did not converge`);
  }

  private async failAbandoned(jobId: string): Promise<void> {
    const job = await this.get(jobId);
    if (!job || isTerminal(job)) return;
    await this.updateJob(jobId, (current) => ({
      ...transitionPhase(current, 'complete', this.now()),
      status: 'failed',
      recoveryState: 'unknown',
      error: 'worker lease expired before completion; final infrastructure state is unknown',
      completedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    }));
  }

  private async clearLease(jobId: string, holder?: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const control = await this.getControlState();
      if (control.value.lease?.jobId !== jobId) {
        if (holder) throw new SelfUpdateLeaseStolenError(jobId);
        return;
      }
      if (holder && control.value.lease.holder !== holder) throw new SelfUpdateLeaseStolenError(jobId);
      const { lease: _lease, ...next } = control.value;
      if (await this.storage.setIfVersion(SELF_UPDATE_CONTROL, CONTROL_ID, next, control.version)) return;
    }
    throw new Error(`self-update lease clear contention did not converge for ${jobId}`);
  }

  private async dispatchOrFail(job: SelfUpdateJob, caller: SigningCredentials): Promise<void> {
    try {
      await this.dispatcher.dispatch(job.id, caller);
    } catch (error) {
      logger.error('self-update worker dispatch failed', error, { jobId: job.id, phase: job.phase });
      await this.finish(job.id, {
        status: 'failed',
        recovered: false,
        recoveryState: 'unknown',
        error: 'worker dispatch failed',
      });
    }
  }

  private async dispatchForResume(job: SelfUpdateJob, caller: SigningCredentials): Promise<void> {
    try {
      await this.dispatcher.dispatch(job.id, caller);
    } catch (error) {
      logger.error('self-update worker resume dispatch failed; job remains resumable', error, {
        jobId: job.id,
        phase: job.phase,
      });
    }
  }

  private async assertHolder(jobId: string, holder: string): Promise<void> {
    const control = await this.getControlState();
    if (control.value.lease?.jobId !== jobId || control.value.lease.holder !== holder) {
      throw new SelfUpdateLeaseStolenError(jobId);
    }
  }
}

function normalizeIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[\x21-\x7e]{1,200}$/.test(value)) throw new Error('Idempotency-Key must be 1-200 visible ASCII characters');
  return value;
}

function hashIdempotency(keyId: string, tenantId: string, idempotencyKey: string): string {
  return createHash('sha256')
    .update(JSON.stringify([keyId, tenantId, idempotencyKey]))
    .digest('hex');
}

function newLease(now: Date): SelfUpdateLease {
  return { heartbeatAt: now.toISOString(), expiresAt: new Date(now.getTime() + LEASE_MS).toISOString() };
}

function isLeaseLive(lease: SelfUpdateLease, now: Date): boolean {
  return Date.parse(lease.expiresAt) > now.getTime();
}

function isTerminal(job: SelfUpdateJob): boolean {
  return job.status === 'succeeded' || job.status === 'failed';
}

function transitionPhase(job: SelfUpdateJob, phase: SelfUpdatePhase, now: Date): SelfUpdateJob {
  if (job.phase === phase) return job;
  const phaseStartedAt = Date.parse(job.phaseStartedAt ?? job.updatedAt ?? job.createdAt);
  const elapsed = Number.isFinite(phaseStartedAt) ? Math.max(0, now.getTime() - phaseStartedAt) : 0;
  return {
    ...job,
    phase,
    phaseStartedAt: now.toISOString(),
    phaseDurationsMs: {
      ...(job.phaseDurationsMs ?? {}),
      [job.phase]: (job.phaseDurationsMs?.[job.phase] ?? 0) + elapsed,
    },
  };
}

function throwLeaseStolen(jobId: string): never {
  throw new SelfUpdateLeaseStolenError(jobId);
}

let service: SelfUpdateService | undefined;

export function getSelfUpdateService(): SelfUpdateService {
  service ??= new SelfUpdateService();
  return service;
}

export function resetSelfUpdateServiceForTests(): void {
  service = undefined;
}

export function setSelfUpdateServiceForTests(value: SelfUpdateService): void {
  service = value;
}
