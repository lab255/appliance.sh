import type { SelfUpdatePublicJob } from '@appliance.sh/sdk';
import type { CloudRouteUpdateResult } from '@appliance.sh/install-aws';

const PHASE_LABELS: Record<SelfUpdatePublicJob['phase'], string> = {
  queued: 'queued: waiting for the self-update worker',
  verifying: 'verifying: checking signed release evidence',
  'describing-stack': 'updating: reading the current CloudFormation identity',
  mirroring: 'mirror: copying the signed image digest into private ECR',
  'submitting-update': 'updating: submitting the image-only CloudFormation change',
  'waiting-for-stack': 'updating: waiting for CloudFormation',
  'probing-health': 'health: probing the new server version',
  'submitting-recovery': 'recovery: re-pinning the previous image',
  'waiting-for-recovery': 'recovery: waiting for the previous image to become healthy',
  complete: 'complete',
};

export function phaseMessage(job: SelfUpdatePublicJob): string {
  if (job.phase !== 'complete') return PHASE_LABELS[job.phase];
  if (job.status === 'succeeded') return 'complete: target image is healthy';
  if (job.recovered) return 'failed: target was unhealthy; previous image was re-pinned and is healthy';
  return 'failed: self-update did not recover automatically';
}

/** Stateful phase stream: close the previous phase with its duration, then show the current wall-clock elapsed line. */
export function createPhaseLineFormatter(now: () => number = Date.now): (job: SelfUpdatePublicJob) => string[] {
  let previousPhase: SelfUpdatePublicJob['phase'] | undefined;
  return (job) => {
    const lines: string[] = [];
    if (previousPhase && previousPhase !== job.phase) {
      const duration = job.phaseDurationsMs?.[previousPhase];
      if (duration !== undefined) lines.push(`» ${PHASE_LABELS[previousPhase]} (${formatSeconds(duration)})`);
    }
    const elapsed = job.totalMs ?? elapsedSinceStart(job, now());
    lines.push(`» ${phaseMessage(job)} (${formatSeconds(elapsed)}${job.phase === 'complete' ? '' : ' elapsed'})`);
    previousPhase = job.phase;
    return lines;
  };
}

/** Stable acceptance-artifact envelope; callers intentionally emit no other stdout in JSON mode. */
export function cloudUpdateJson(result: CloudRouteUpdateResult): string {
  return JSON.stringify(result);
}

export function cloudUpdateExitCode(result: CloudRouteUpdateResult): number | undefined {
  if (result.outcome === 'conflict') return 3;
  return result.job.status === 'failed' ? 1 : undefined;
}

export function terminalFailureMessage(job: SelfUpdatePublicJob): string {
  const detail = job.error ?? 'self-update failed without detail';
  if (job.recovered) {
    return `${detail}. The target failed, but the previous image was re-pinned and passed health checks.`;
  }
  if (job.recoveryState === 'exhausted') {
    return `${detail}. Automatic recovery is exhausted; the installation may still be running the failed image. Restore with appliance cloud update --local.`;
  }
  return detail;
}

function elapsedSinceStart(job: SelfUpdatePublicJob, nowMs: number): number {
  const startedAt = Date.parse(job.timestamps.startedAt ?? job.timestamps.createdAt);
  return Number.isFinite(startedAt) ? Math.max(0, nowMs - startedAt) : 0;
}

function formatSeconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1_000))}s`;
}
