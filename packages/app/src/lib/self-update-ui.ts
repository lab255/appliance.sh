import {
  fetchReleaseEvidence,
  SELF_UPDATE_DISABLED_AP226,
  SelfUpdateStartError,
  type ApplianceClient,
  type ResolvedReleaseEvidence,
  type SelfUpdatePublicJob,
} from '@appliance.sh/sdk';
import { errorText } from '@/components/friendly-error';

export interface DesktopCloudSelfUpdateOptions {
  idempotencyKey: string;
  intervalMs?: number;
  onPhase?: (job: SelfUpdatePublicJob) => void;
  onExistingJob?: (statusUrl: string, jobId: string) => void;
  resolveEvidence?: (version: string) => Promise<ResolvedReleaseEvidence>;
}

export async function runDesktopCloudSelfUpdate(
  client: ApplianceClient,
  version: string,
  options: DesktopCloudSelfUpdateOptions
): Promise<{ job: SelfUpdatePublicJob; existingStatusUrl?: string }> {
  const evidence = await (options.resolveEvidence ?? ((target) => fetchReleaseEvidence({ version: target })))(version);
  const started = await client.selfUpdate.start({
    targetDigest: evidence.targetDigest,
    release: evidence.release,
    idempotencyKey: options.idempotencyKey,
  });
  if (!started.success) throw started.error;
  if (started.data.httpStatus === 409) {
    options.onExistingJob?.(started.data.statusUrl, started.data.jobId);
  }
  const watched = await client.selfUpdate.watch(started.data.jobId, {
    intervalMs: options.intervalMs,
    onPhase: options.onPhase,
  });
  if (!watched.success) throw watched.error;
  return {
    job: watched.data,
    ...(started.data.httpStatus === 409 ? { existingStatusUrl: started.data.statusUrl } : {}),
  };
}

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
  if (job.recovered) return 'Update rolled back; the previous image was re-pinned and is healthy';
  return 'Update failed and automatic recovery did not complete';
}

export function selfUpdateTerminalError(job: SelfUpdatePublicJob): string {
  const detail = job.error ?? 'The service update failed.';
  if (job.recovered) return `${detail} The previous image was re-pinned and passed health checks.`;
  if (job.recoveryState === 'exhausted') {
    return `${detail} Automatic recovery is exhausted; the installation may still be running the failed image.\nRestore from a terminal:\nappliance cloud update --local`;
  }
  return detail;
}

export function selfUpdateRollbackMessage(previousServerVersion: string | null): string {
  const serving = previousServerVersion
    ? `v${previousServerVersion} is serving and healthy`
    : 'the previous version is serving and healthy';
  return `Update rolled back — ${serving}.`;
}

export function desktopSelfUpdateError(error: unknown): string {
  if (
    errorText(error) === SELF_UPDATE_DISABLED_AP226 ||
    (error instanceof SelfUpdateStartError && error.code === 'trust-not-provisioned')
  ) {
    return 'This build ships no production release key; run appliance cloud update --local or install a newer release.';
  }
  return errorText(error);
}
