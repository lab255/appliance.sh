import type { InstalledApp } from '@appliance.sh/sdk';

export interface UnknownPublisherPrompt {
  appId: string;
  name: string;
  version: string;
  license: string;
  source: string;
  digest: string;
  signature: 'unsigned' | 'invalid';
  publisher: string;
  controlsSummary: InstalledApp['controlsSummary'];
}

const UNKNOWN_PREFIX = 'UNKNOWN_PUBLISHER:';

export function parseUnknownPublisherError(cause: unknown): UnknownPublisherPrompt | null {
  const message = cause instanceof Error ? cause.message : String(cause);
  const offset = message.indexOf(UNKNOWN_PREFIX);
  if (offset < 0) return null;
  try {
    const value = JSON.parse(message.slice(offset + UNKNOWN_PREFIX.length)) as UnknownPublisherPrompt;
    if (!value || typeof value !== 'object' || typeof value.appId !== 'string' || typeof value.digest !== 'string') {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function unknownPublisherWarningDue(app: InstalledApp, now = Date.now()): boolean {
  if (app.publisher.tier !== 'unknown') return false;
  return !app.lastWarnedAt || now - Date.parse(app.lastWarnedAt) >= 30 * 24 * 60 * 60 * 1000;
}
