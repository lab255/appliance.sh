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

export type SelfUpdateCheckOutcome =
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

const SELF_UPDATE_AVAILABILITY = 'self-update-availability';
const AVAILABILITY_ID = 'cloud';
const GHCR_TOKEN_ENDPOINT = 'https://ghcr.io/token';
const GHCR_REGISTRY_ENDPOINT = 'https://ghcr.io/v2';
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

  constructor(deps: SelfUpdateSchedulerDependencies = {}) {
    const aws = deps.aws ?? createAwsSelfUpdateDependencies();
    this.storage = deps.storage ?? getStorageService();
    this.jobs = deps.jobs ?? getSelfUpdateService();
    this.aws = aws;
    this.trust = deps.trust ?? PINNED_RELEASE_TRUST;
    this.resolveLatest = deps.resolveLatest ?? resolveLatestReleaseEvidence;
    this.resolveRunning = deps.resolveRunning ?? ((trust) => fetchReleaseEvidence({ version: VERSION, trust }));
    this.now = deps.now ?? (() => new Date());
    this.policy = deps.policy ?? (() => selfUpdatePolicy());
  }

  async check(): Promise<SelfUpdateCheckOutcome> {
    return runWithTenant(DEFAULT_TENANT, () => this.checkOwnerTenant());
  }

  async getAvailable(): Promise<SelfUpdateAvailableMarker | null> {
    return this.storage.get<SelfUpdateAvailableMarker>(SELF_UPDATE_AVAILABILITY, AVAILABILITY_ID);
  }

  private async checkOwnerTenant(): Promise<SelfUpdateCheckOutcome> {
    const policy = this.policy();
    if (policy === 'off') {
      logger.info('self-update-check skipped: policy off');
      return 'off';
    }
    if (Object.keys(this.trust.keys).length === 0) {
      logger.info('self-update-check skipped: no pinned release trust');
      return 'no-trust';
    }

    const roleArn = process.env.SELF_UPDATE_ROLE_ARN;
    const stackId = process.env.APPLIANCE_STACK_ID;
    if (!roleArn || !stackId) {
      logger.info('self-update-check skipped: scoped self-update role unavailable (SystemRoleMode=admin)');
      return 'unscoped-role';
    }

    try {
      const latest = await this.resolveLatest(this.trust);
      const credentials = await this.aws.assumeRole(roleArn, 'self-update-check');
      const stack = await this.aws.describeStack(credentials, stackId);
      const runningDigest = imageDigest(parameterValue(stack, 'ImageUri'));
      if (!runningDigest) throw new Error('running CloudFormation ImageUri is not digest-pinned');

      if (latest.targetDigest === runningDigest) {
        await this.clearAvailable();
        logger.info('self-update-check current', { policy, version: latest.version });
        return 'current';
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
          return 'older-generation';
        }
        logger.info('self-update-check skipped: release generation is not newer', {
          policy,
          generation: latestGeneration,
        });
        return 'current';
      }

      const marker: SelfUpdateAvailableMarker = {
        version: latest.version,
        digest: latest.targetDigest,
        generation: latestGeneration,
        seenAt: this.now().toISOString(),
      };
      if (policy === 'notify') {
        await this.storage.set(SELF_UPDATE_AVAILABILITY, AVAILABILITY_ID, marker);
        logger.info('self-update-check update available', {
          policy,
          version: marker.version,
          generation: marker.generation,
        });
        return 'notify';
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
        return created.reused ? 'auto-reused' : 'auto-created';
      } catch (error) {
        if (error instanceof SelfUpdateConflictError) {
          logger.info('self-update-check skipped: live self-update lease', { policy, jobId: error.jobId });
          return 'lease-conflict';
        }
        throw error;
      }
    } catch (error) {
      logger.error('self-update-check failed', redactSelfUpdateError(error), { policy });
      return 'error';
    }
  }

  private async clearAvailable(): Promise<void> {
    await this.storage.delete(SELF_UPDATE_AVAILABILITY, AVAILABILITY_ID);
  }
}

function parameterValue(stack: SelfUpdateStack, key: string): string | undefined {
  return stack.parameters.find((parameter) => parameter.key === key)?.value;
}

function imageDigest(imageUri: string | undefined): string | undefined {
  const digest = imageUri?.match(/@(sha256:[0-9a-f]{64})$/)?.[1];
  return digest;
}

async function resolveLatestReleaseEvidence(trust: ReleaseTrustPolicy): Promise<ResolvedReleaseEvidence> {
  const version = await latestGhcrTag();
  return fetchReleaseEvidence({ version, trust });
}

async function latestGhcrTag(fetcher: typeof globalThis.fetch = globalThis.fetch): Promise<string> {
  const tokenResponse = await fetcher(`${GHCR_TOKEN_ENDPOINT}?scope=repository:${DEFAULT_IMAGE}:pull`);
  if (!tokenResponse.ok) throw new Error(`GHCR token endpoint returned HTTP ${tokenResponse.status}`);
  const token = (await tokenResponse.json()) as { token?: unknown };
  if (typeof token.token !== 'string' || !token.token) throw new Error('GHCR token endpoint returned no token');
  const tagsResponse = await fetcher(`${GHCR_REGISTRY_ENDPOINT}/${DEFAULT_IMAGE}/tags/list`, {
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
