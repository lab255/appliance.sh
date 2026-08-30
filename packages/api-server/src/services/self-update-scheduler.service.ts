import {
  fetchReleaseEvidence,
  PINNED_RELEASE_TRUST,
  VERSION,
  z,
  type ReleaseTrustPolicy,
  type ResolvedReleaseEvidence,
} from '@appliance.sh/sdk';
import { logger } from '../logger';
import { redactSelfUpdateError } from './self-update-redaction';
import {
  createAwsSelfUpdateDependencies,
  type AssumedCredentials,
  type SelfUpdateStack,
} from './self-update-executor.service';
import {
  getSelfUpdateService,
  SelfUpdateConflictError,
  SYSTEM_SCHEDULED_SELF_UPDATE_CALLER,
  type SelfUpdateService,
} from './self-update.service';
import { getStorageService, type StorageService } from './storage.service';
import { DEFAULT_TENANT, runWithTenant } from './tenant-context';

export type SelfUpdatePolicy = 'off' | 'notify' | 'auto';

export interface SelfUpdateAvailableMarker {
  version: string;
  digest: string;
  generation: number;
  seenAt: string;
}

export type SelfUpdateCheckDecision =
  | 'off'
  | 'no-trust'
  | 'unscoped-role'
  | 'current'
  | 'older-generation'
  | 'notify'
  | 'auto-created'
  | 'auto-reused'
  | 'lease-conflict'
  | 'error';

export interface SelfUpdateLastCheck {
  at: string;
  decision: SelfUpdateCheckDecision | 'not-checked';
  reason: string;
  version?: string;
}

export const SELF_UPDATE_AVAILABILITY = 'self-update-availability';
export const SELF_UPDATE_LAST_CHECK = 'self-update-last-check';
const AVAILABILITY_ID = 'cloud';
const LAST_CHECK_ID = 'cloud';
export const SELF_UPDATE_STATE_CACHE_MS = 60_000;
const GHCR_TOKEN_ENDPOINT = 'https://ghcr.io/token';
const GHCR_REGISTRY_ENDPOINT = 'https://ghcr.io/v2';
const RELEASE_BASE = 'https://github.com/lab255/appliance.sh/releases/download';
const DEFAULT_IMAGE = 'appliance-sh/api-server';
const SEMVER_TAG = /^\d+\.\d+\.\d+$/;

export const selfUpdateCheckEventSchema = z.strictObject({ kind: z.literal('self-update-check') });

interface SchedulerAws {
  assumeRole(roleArn: string, sourceIdentity: string): Promise<AssumedCredentials>;
  describeStack(credentials: AssumedCredentials, stackId: string): Promise<SelfUpdateStack>;
}

export interface SelfUpdateSchedulerDependencies {
  storage?: StorageService;
  jobs?: Pick<SelfUpdateService, 'create' | 'getAndResume'>;
  aws?: SchedulerAws;
  trust?: ReleaseTrustPolicy;
  resolveLatest?: (trust: ReleaseTrustPolicy) => Promise<ResolvedReleaseEvidence>;
  resolveRunning?: (trust: ReleaseTrustPolicy) => Promise<ResolvedReleaseEvidence>;
  fetcher?: typeof globalThis.fetch;
  releaseBase?: string;
  registryTokenEndpoint?: string;
  registryEndpoint?: string;
  image?: string;
  now?: () => Date;
  policy?: () => SelfUpdatePolicy;
}

export function selfUpdatePolicy(value = process.env.SELF_UPDATE_POLICY): SelfUpdatePolicy {
  return value === 'notify' || value === 'auto' ? value : 'off';
}

export class SelfUpdateSchedulerService {
  private readonly storage: StorageService;
  private readonly jobs: Pick<SelfUpdateService, 'create' | 'getAndResume'>;
  private readonly aws: SchedulerAws;
  private readonly trust: ReleaseTrustPolicy;
  private readonly resolveLatest: (trust: ReleaseTrustPolicy) => Promise<ResolvedReleaseEvidence>;
  private readonly resolveRunning: (trust: ReleaseTrustPolicy) => Promise<ResolvedReleaseEvidence>;
  private readonly now: () => Date;
  private readonly policy: () => SelfUpdatePolicy;
  private availabilityCache?: { expiresAt: number; value: SelfUpdateAvailableMarker | null };

  constructor(deps: SelfUpdateSchedulerDependencies = {}) {
    const aws = deps.aws ?? createAwsSelfUpdateDependencies();
    this.storage = deps.storage ?? getStorageService();
    this.jobs = deps.jobs ?? getSelfUpdateService();
    this.aws = aws;
    this.trust = deps.trust ?? PINNED_RELEASE_TRUST;
    const fetcher = deps.fetcher ?? globalThis.fetch;
    const releaseBase = deps.releaseBase ?? RELEASE_BASE;
    this.resolveLatest =
      deps.resolveLatest ??
      ((trust) =>
        resolveLatestReleaseEvidence(trust, {
          fetcher,
          releaseBase,
          tokenEndpoint: deps.registryTokenEndpoint ?? GHCR_TOKEN_ENDPOINT,
          registryEndpoint: deps.registryEndpoint ?? GHCR_REGISTRY_ENDPOINT,
          image: deps.image ?? DEFAULT_IMAGE,
        }));
    this.resolveRunning =
      deps.resolveRunning ?? ((trust) => fetchReleaseEvidence({ version: VERSION, trust, fetcher, releaseBase }));
    this.now = deps.now ?? (() => new Date());
    this.policy = deps.policy ?? (() => selfUpdatePolicy());
  }

  async check(): Promise<SelfUpdateLastCheck> {
    return runWithTenant(DEFAULT_TENANT, () => this.checkOwnerTenant());
  }

  async getAvailable(): Promise<SelfUpdateAvailableMarker | null> {
    return runWithTenant(DEFAULT_TENANT, async () => {
      const timestamp = this.now().getTime();
      if (this.availabilityCache && this.availabilityCache.expiresAt > timestamp) {
        return this.availabilityCache.value;
      }
      const value = await this.storage.get<SelfUpdateAvailableMarker>(SELF_UPDATE_AVAILABILITY, AVAILABILITY_ID);
      this.availabilityCache = { expiresAt: timestamp + SELF_UPDATE_STATE_CACHE_MS, value };
      return value;
    });
  }

  async getLastCheck(): Promise<SelfUpdateLastCheck | null> {
    return runWithTenant(DEFAULT_TENANT, () =>
      this.storage.get<SelfUpdateLastCheck>(SELF_UPDATE_LAST_CHECK, LAST_CHECK_ID)
    );
  }

  async clearAvailableIfDigest(targetDigest: string): Promise<boolean> {
    return runWithTenant(DEFAULT_TENANT, async () => {
      const marker = await this.storage.get<SelfUpdateAvailableMarker>(SELF_UPDATE_AVAILABILITY, AVAILABILITY_ID);
      if (marker?.digest !== targetDigest) return false;
      await this.clearAvailable();
      return true;
    });
  }

  private async checkOwnerTenant(): Promise<SelfUpdateLastCheck> {
    const policy = this.policy();
    if (policy === 'off') {
      logger.info('self-update-check skipped: policy off');
      return this.record('off', 'policy-off');
    }
    if (Object.keys(this.trust.keys).length === 0) {
      logger.info('self-update-check skipped: no pinned release trust');
      return this.record('no-trust', 'no-pinned-release-trust');
    }

    const roleArn = process.env.SELF_UPDATE_ROLE_ARN;
    const stackId = process.env.APPLIANCE_STACK_ID;
    if (!roleArn || !stackId) {
      logger.info('self-update-check skipped: scoped self-update role unavailable (SystemRoleMode=admin)');
      return this.record('unscoped-role', 'unscoped-role');
    }

    let version: string | undefined;
    try {
      const latest = await this.resolveLatest(this.trust);
      version = latest.version;
      const credentials = await this.aws.assumeRole(roleArn, 'self-update-check');
      const stack = await this.aws.describeStack(credentials, stackId);
      const runningDigest = imageDigest(parameterValue(stack, 'ImageUri'));
      if (!runningDigest) throw new Error('running CloudFormation ImageUri is not digest-pinned');

      if (latest.targetDigest === runningDigest) {
        await this.clearAvailable();
        logger.info('self-update-check current', { policy, version: latest.version });
        return this.record('current', 'up-to-date', latest.version);
      }

      const running = await this.resolveRunning(this.trust);
      if (running.targetDigest !== runningDigest) {
        throw new Error('running ImageUri digest does not match signed running release evidence');
      }
      const latestGeneration = latest.release.payload.generation;
      const runningGeneration = running.release.payload.generation;
      if (latestGeneration <= runningGeneration) {
        await this.clearAvailable();
        if (latestGeneration < runningGeneration) {
          logger.warn('self-update-check refused older release generation', {
            policy,
            latestGeneration,
            runningGeneration,
          });
          return this.record('older-generation', 'older-generation', latest.version);
        }
        logger.info('self-update-check skipped: release generation is not newer', {
          policy,
          generation: latestGeneration,
        });
        return this.record('current', 'up-to-date', latest.version);
      }

      const marker: SelfUpdateAvailableMarker = {
        version: latest.version,
        digest: latest.targetDigest,
        generation: latestGeneration,
        seenAt: this.now().toISOString(),
      };
      if (policy === 'notify') {
        await this.storage.set(SELF_UPDATE_AVAILABILITY, AVAILABILITY_ID, marker);
        this.availabilityCache = {
          expiresAt: this.now().getTime() + SELF_UPDATE_STATE_CACHE_MS,
          value: marker,
        };
        logger.info('self-update-check update available', {
          policy,
          version: marker.version,
          generation: marker.generation,
        });
        return this.record('notify', 'notify-marked', latest.version);
      }

      await this.clearAvailable();
      try {
        const created = await this.jobs.create(
          { targetDigest: latest.targetDigest, release: latest.release },
          SYSTEM_SCHEDULED_SELF_UPDATE_CALLER,
          `scheduled:${latest.targetDigest}`
        );
        if (created.reused && created.job.status !== 'succeeded' && created.job.status !== 'failed') {
          await this.jobs.getAndResume(created.job.id, SYSTEM_SCHEDULED_SELF_UPDATE_CALLER);
        }
        logger.info('self-update-check scheduled job', {
          policy,
          jobId: created.job.id,
          reused: created.reused,
          version: latest.version,
          generation: latestGeneration,
        });
        return this.record(
          created.reused ? 'auto-reused' : 'auto-created',
          created.reused ? 'auto-reused' : 'auto-created',
          latest.version
        );
      } catch (error) {
        if (error instanceof SelfUpdateConflictError) {
          logger.info('self-update-check skipped: live self-update lease', { policy, jobId: error.jobId });
          return this.record('lease-conflict', 'lease-conflict', latest.version);
        }
        throw error;
      }
    } catch (error) {
      logger.error('self-update-check failed', redactSelfUpdateError(error), { policy });
      return this.record('error', 'error', version);
    }
  }

  private async clearAvailable(): Promise<void> {
    await this.storage.delete(SELF_UPDATE_AVAILABILITY, AVAILABILITY_ID);
    this.availabilityCache = {
      expiresAt: this.now().getTime() + SELF_UPDATE_STATE_CACHE_MS,
      value: null,
    };
  }

  private async record(
    decision: SelfUpdateCheckDecision,
    reason: string,
    version?: string
  ): Promise<SelfUpdateLastCheck> {
    const check: SelfUpdateLastCheck = {
      at: this.now().toISOString(),
      decision,
      reason,
      ...(version ? { version } : {}),
    };
    await this.storage.set(SELF_UPDATE_LAST_CHECK, LAST_CHECK_ID, check);
    return check;
  }
}

function parameterValue(stack: SelfUpdateStack, key: string): string | undefined {
  return stack.parameters.find((parameter) => parameter.key === key)?.value;
}

function imageDigest(imageUri: string | undefined): string | undefined {
  const digest = imageUri?.match(/@(sha256:[0-9a-f]{64})$/)?.[1];
  return digest;
}

async function resolveLatestReleaseEvidence(
  trust: ReleaseTrustPolicy,
  options: {
    fetcher: typeof globalThis.fetch;
    releaseBase: string;
    tokenEndpoint: string;
    registryEndpoint: string;
    image: string;
  }
): Promise<ResolvedReleaseEvidence> {
  const version = await latestGhcrTag(options);
  return fetchReleaseEvidence({ version, trust, fetcher: options.fetcher, releaseBase: options.releaseBase });
}

async function latestGhcrTag(options: {
  fetcher: typeof globalThis.fetch;
  tokenEndpoint: string;
  registryEndpoint: string;
  image: string;
}): Promise<string> {
  const tokenResponse = await options.fetcher(`${options.tokenEndpoint}?scope=repository:${options.image}:pull`);
  if (!tokenResponse.ok) throw new Error(`GHCR token endpoint returned HTTP ${tokenResponse.status}`);
  const token = (await tokenResponse.json()) as { token?: unknown };
  if (typeof token.token !== 'string' || !token.token) throw new Error('GHCR token endpoint returned no token');
  const tagsResponse = await options.fetcher(`${options.registryEndpoint}/${options.image}/tags/list`, {
    headers: { authorization: `Bearer ${token.token}` },
  });
  if (!tagsResponse.ok) throw new Error(`GHCR tags endpoint returned HTTP ${tagsResponse.status}`);
  const body = (await tagsResponse.json()) as { tags?: unknown };
  const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const versions = tags.filter((tag) => SEMVER_TAG.test(tag)).sort(compareSemverDescending);
  if (!versions[0]) throw new Error('GHCR returned no semver release tags');
  return versions[0];
}

function compareSemverDescending(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

let service: SelfUpdateSchedulerService | undefined;

export function getSelfUpdateSchedulerService(): SelfUpdateSchedulerService {
  service ??= new SelfUpdateSchedulerService();
  return service;
}

export function setSelfUpdateSchedulerServiceForTests(value: SelfUpdateSchedulerService): void {
  service = value;
}

export function resetSelfUpdateSchedulerServiceForTests(): void {
  service = undefined;
}
