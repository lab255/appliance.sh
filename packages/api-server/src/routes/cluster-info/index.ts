import { Router } from 'express';
import { readFileSync } from 'fs';
import { sanitizeBaseConfigForWire, VERSION, type ApplianceBaseConfig } from '@appliance.sh/sdk';
import { getConsoleMode, getExternalConsoleUrl, type ConsoleMode } from '../../console-static';
import { supportsUploadBuilds } from '../../services/build-upload.service';
import { logger } from '../../logger';
import { requireBaseConfigSnapshot } from '../../services/base-config.service';
import {
  getSelfUpdateSchedulerService,
  selfUpdatePolicy,
  type SelfUpdateAvailableMarker,
  type SelfUpdateLastCheck,
} from '../../services/self-update-scheduler.service';
import { redactSelfUpdateError } from '../../services/self-update-redaction';
import { DEFAULT_TENANT, runWithTenant } from '../../services/tenant-context';

export interface ClusterInfo {
  /**
   * The api-server's running version (the SDK's pinned VERSION at
   * the time this image was built). Surfaced so the desktop Settings
   * page can compare against the bundled bootstrapper version and
   * offer a self-update. Older deployments that predate this field
   * will simply 404 / 500 the route — callers should treat that as
   * "version unknown" and allow updating regardless.
   */
  version: string;
  /**
   * SANITIZED copy of the server's resolved base config: unknown keys
   * are stripped (the passthrough round-trip is an internal surface,
   * not a wire one) and credential-bearing fields (`kubernetes.token`,
   * `kubernetes.kubeconfig`, `kubernetes.ca` — the k3s SA credentials)
   * are dropped. This route answers ANY authenticated key, member role
   * included, so nothing here may grant cluster access.
   */
  baseConfig: ApplianceBaseConfig;
  /**
   * How this server exposes its web console (`full` | `bootstrap` |
   * `off`), and where the canonical console lives when it is hosted
   * separately. Clients building invite links use `consoleUrl` (falling
   * back to the api-server URL) so teammates land on the console the
   * operator intends. Absent on older servers — treat as full/same-origin.
   */
  consoleMode?: ConsoleMode;
  consoleUrl?: string;
  /**
   * The server's own version, under the name the desktop's capability
   * probe reads (same value as `version`, which predates it). Absent
   * on older servers — clients must tolerate omission.
   */
  serverVersion: string;
  /**
   * The oldest client version this server supports, for the client-side
   * preflight. ADVISORY ONLY: clients compare their own version and
   * print/render an upgrade hint — neither side enforces anything.
   */
  minClientVersion: string;
  /**
   * What this base can do, so clients can warn up front instead of
   * discovering it via a failed request. `uploadBuilds`: whether
   * upload-flow (source zip) builds can run here — mirrors the gates
   * POST /api/v1/builds enforces (409 when they fail). Absent on
   * older servers.
   */
  capabilities: { uploadBuilds: boolean };
  /**
   * Operational warnings raised OUTSIDE this process (e.g. the guest's
   * legacy-deploy quarantine watchdog appends to the file named by
   * APPLIANCE_WARNINGS_FILE). Deduplicated; omitted when there are
   * none. Best-effort — a missing/unreadable file is simply no
   * warnings.
   */
  warnings?: string[];
  /** Scheduled cloud image update policy and signed notify marker. */
  selfUpdate: {
    policy: 'off' | 'notify' | 'auto';
    lastCheck: SelfUpdateLastCheck;
    available?: { version: string; generation: number };
  };
}

/**
 * Hand-raised when a wire-breaking change ships. "0.0.0" = every client
 * is acceptable (the advisory floor has never been raised).
 */
const MIN_CLIENT_VERSION = '0.0.0';

/** Read + dedupe the watchdog warnings file. Never throws. */
function readWarnings(): string[] | undefined {
  const file = process.env.APPLIANCE_WARNINGS_FILE;
  if (!file) return undefined;
  try {
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const unique = [...new Set(lines)];
    return unique.length > 0 ? unique : undefined;
  } catch {
    return undefined;
  }
}

async function readAvailableMarker(): Promise<SelfUpdateAvailableMarker | null> {
  try {
    return await runWithTenant(DEFAULT_TENANT, () => getSelfUpdateSchedulerService().getAvailable());
  } catch (error) {
    logger.warn('cluster-info self-update marker unavailable', {
      error: redactSelfUpdateError(error).message,
    });
    return null;
  }
}

async function readLastCheck(
  policy: ClusterInfo['selfUpdate']['policy'],
  exposeOwnerState: boolean
): Promise<SelfUpdateLastCheck> {
  if (exposeOwnerState) {
    try {
      const stored = await runWithTenant(DEFAULT_TENANT, () => getSelfUpdateSchedulerService().getLastCheck());
      if (stored) return stored;
    } catch (error) {
      logger.warn('cluster-info self-update last check unavailable', {
        error: redactSelfUpdateError(error).message,
      });
    }
  }
  return {
    at: '',
    decision: 'not-checked',
    reason: policy === 'off' ? 'policy-off' : 'not-checked',
  };
}

export const clusterInfoRoutes: Router = Router();

clusterInfoRoutes.get('/', async (req, res) => {
  try {
    const baseConfig = requireBaseConfigSnapshot();
    const externalUrl = getExternalConsoleUrl();
    const warnings = readWarnings();
    const policy = selfUpdatePolicy();
    // Availability and check health disclose owner-operator posture. Only an
    // owner-tenant admin may read either; policy itself remains non-sensitive.
    const exposeOwnerState = req.apiKeyRole === 'admin' && req.tenantId === DEFAULT_TENANT;
    const storedAvailable = policy === 'notify' && exposeOwnerState ? await readAvailableMarker() : null;
    const available = storedAvailable?.version === VERSION ? null : storedAvailable;
    const lastCheck = await readLastCheck(policy, exposeOwnerState);
    const body: ClusterInfo = {
      version: VERSION,
      // The RESPONSE copy is sanitized; `baseConfig` itself (the full
      // passthrough parse) stays local to compute capabilities.
      baseConfig: sanitizeBaseConfigForWire(baseConfig),
      consoleMode: getConsoleMode(),
      ...(externalUrl ? { consoleUrl: externalUrl } : {}),
      serverVersion: VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
      capabilities: { uploadBuilds: supportsUploadBuilds(baseConfig) },
      ...(warnings ? { warnings } : {}),
      selfUpdate: {
        policy,
        lastCheck,
        ...(available ? { available: { version: available.version, generation: available.generation } } : {}),
      },
    };
    res.json(body);
  } catch (error) {
    logger.error('get cluster-info failed', error, { requestId: req.requestId });
    res.status(500).json({ error: 'Failed to read cluster info', message: String(error) });
  }
});
