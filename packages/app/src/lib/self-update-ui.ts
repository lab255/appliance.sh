import type { SelfUpdatePublicJob } from '@appliance.sh/sdk';

const LABELS: Record<SelfUpdatePublicJob['phase'], string> = {
  queued: 'Queued — waiting for the update worker',
  verifying: 'Verifying signed release evidence',
  'describing-stack': 'Reading the current CloudFormation deployment',
  mirroring: 'Mirroring the signed image digest',
  'submitting-update': 'Submitting the service update',
  'waiting-for-stack': 'Updating the service with CloudFormation',
  'probing-health': 'Checking the updated service health',
  'submitting-recovery': 'Target failed — re-pinning the previous image',
  'waiting-for-recovery': 'Waiting for the previous image to recover',
  complete: 'Update finished',
};

export function selfUpdatePhaseMessage(job: SelfUpdatePublicJob): string {
  if (job.phase !== 'complete') return LABELS[job.phase];
  if (job.status === 'succeeded') return `Updated successfully to ${job.target.version}`;
  if (job.recovered) return 'Update failed; the previous image was re-pinned and is healthy';
  return 'Update failed and automatic recovery did not complete';
}

export function selfUpdateTerminalError(job: SelfUpdatePublicJob): string {
  const detail = job.error ?? 'The service update failed.';
  if (job.recovered) return `${detail} The previous image was re-pinned and passed health checks.`;
  if (job.recoveryState === 'exhausted') {
    return `${detail} Automatic recovery is exhausted. Run appliance cloud update --local from a terminal.`;
  }
  return detail;
}
