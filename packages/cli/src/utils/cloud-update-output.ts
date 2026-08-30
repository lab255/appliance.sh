import type { SelfUpdatePublicJob } from '@appliance.sh/sdk';

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

export function terminalFailureMessage(job: SelfUpdatePublicJob): string {
  const detail = job.error ?? 'self-update failed without detail';
  if (job.recovered) {
    return `${detail}. The target failed, but the previous image was re-pinned and passed health checks.`;
  }
  if (job.recoveryState === 'exhausted') {
    return `${detail}. Automatic recovery is exhausted; use appliance cloud update --local as the break-glass path.`;
  }
  return detail;
}
