import type { ClusterInfoResponse } from '@appliance.sh/sdk';

export type CloudSelfUpdateStatus = NonNullable<ClusterInfoResponse['selfUpdate']>;

export function selfUpdateStatusLines(status: CloudSelfUpdateStatus): string[] {
  const lines = [`Scheduled cloud self-update policy: ${status.policy}`];
  const check = status.lastCheck;
  if (!check) {
    lines.push('Last check: not reported by this server version');
  } else {
    lines.push(`Last check at: ${check.at || 'never'}`);
    lines.push(`Decision: ${check.decision}`);
    lines.push(`Reason: ${check.reason}`);
    if (check.version) lines.push(`Version: ${check.version}`);
    const inactive = inactiveReasonCopy(check.reason);
    if (inactive) lines.push(`Status: ${inactive}`);
  }
  lines.push(status.available ? `Update available: v${status.available.version}` : 'Update available: none');
  return lines;
}

export function selfUpdateStatusJson(status: CloudSelfUpdateStatus): string {
  return JSON.stringify(status, null, 2);
}

export function inactiveReasonCopy(reason: string): string | undefined {
  if (reason === 'no-pinned-release-trust') {
    return 'scheduled checks are inactive: this build has no pinned release trust';
  }
  if (reason === 'unscoped-role') {
    return 'scheduled checks are inactive: enable scoped roles with appliance cloud baseline-update --system-role-mode scoped';
  }
  return undefined;
}
