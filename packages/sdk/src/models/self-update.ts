import type { ReleaseEnvelope, ReleaseSignatureEnvelope } from './release-trust';

export type SelfUpdateStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type SelfUpdatePhase =
  | 'queued'
  | 'verifying'
  | 'describing-stack'
  | 'mirroring'
  | 'submitting-update'
  | 'waiting-for-stack'
  | 'probing-health'
  | 'submitting-recovery'
  | 'waiting-for-recovery'
  | 'complete';

/** Milliseconds spent in each phase. Missing keys are expected on N-1 jobs. */
export type SelfUpdatePhaseDurations = Partial<Record<SelfUpdatePhase, number>>;

export interface SelfUpdateReleaseEvidence {
  payload: ReleaseEnvelope;
  envelope: ReleaseSignatureEnvelope;
}

export interface SelfUpdateStartInput {
  targetDigest: string;
  release: SelfUpdateReleaseEvidence;
  idempotencyKey: string;
}

export interface SelfUpdateStartAccepted {
  httpStatus: 202;
  jobId: string;
  status: SelfUpdateStatus;
  statusUrl: string;
}

export interface SelfUpdateStartConflict {
  httpStatus: 409;
  jobId: string;
  statusUrl: string;
}

export type SelfUpdateStartResponse = SelfUpdateStartAccepted | SelfUpdateStartConflict;

export type SelfUpdateStartErrorCode =
  | 'trust-not-provisioned'
  | 'forbidden'
  | 'scoped-roles-required'
  | 'invalid-request'
  | 'invalid-response'
  | 'http-error';

/** Typed, non-throwing `selfUpdate.start` failure carried by `Result.error`. */
export class SelfUpdateStartError extends Error {
  constructor(
    readonly code: SelfUpdateStartErrorCode,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'SelfUpdateStartError';
  }
}

export interface SelfUpdatePublicJob {
  jobId: string;
  status: SelfUpdateStatus;
  phase: SelfUpdatePhase;
  target: { digest: string; version: string; generation: number; source: string };
  previousImage?: string;
  targetImage?: string;
  timestamps: {
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    completedAt?: string;
    heartbeatAt: string;
    leaseExpiresAt: string;
  };
  /** Additive CU2 timing evidence; older persisted jobs may omit it. */
  phaseDurationsMs?: SelfUpdatePhaseDurations;
  /** Terminal wall-clock duration from job start through completion. */
  totalMs?: number;
  /** Number of expired-lease takeovers. Resumed jobs are not valid live timing samples. */
  resumeCount?: number;
  error?: string;
  recovered?: boolean;
  recoveryState?: 'unknown' | 'in-progress' | 'recovered' | 'exhausted';
}

export interface SelfUpdateWatchOptions {
  intervalMs?: number;
  /** Overall polling budget. Defaults to 20 minutes. */
  deadlineMs?: number;
  /** Cancels an active status request and the polling loop. */
  signal?: AbortSignal;
  /** Consecutive transient poll failures tolerated before returning an error. Defaults to 5. */
  maxConsecutiveErrors?: number;
  /** Minimum continuous status-outage window tolerated. Defaults to 120 seconds. */
  consecutiveErrorWindowMs?: number;
  onPhase?: (job: SelfUpdatePublicJob) => void;
}
