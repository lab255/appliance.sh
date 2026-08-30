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
  error?: string;
  recovered?: boolean;
  recoveryState?: 'unknown' | 'in-progress' | 'recovered' | 'exhausted';
}

export interface SelfUpdateWatchOptions {
  intervalMs?: number;
  onPhase?: (job: SelfUpdatePublicJob) => void;
}
