import { AsyncLocalStorage } from 'node:async_hooks';
import { GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { applianceBaseConfig, type ApplianceBaseConfig } from '@appliance.sh/sdk';
import type { NextFunction, Request, Response } from 'express';

const DEFAULT_BASE_CONFIG_KEY = 'system/base-config.json';

interface S3Sender {
  send(command: GetObjectCommand | PutObjectCommand): Promise<{
    Body?: { transformToString(): Promise<string> };
    ETag?: string;
  }>;
}

interface CachedConfig {
  etag: string;
  config: ApplianceBaseConfig;
}

/** S3-backed, one-entry ETag cache for the installation's base config. */
export class BaseConfigRepository {
  private cache: CachedConfig | undefined;
  private inFlight: Promise<ApplianceBaseConfig> | undefined;

  constructor(
    private readonly bucket: string,
    private readonly key: string,
    private readonly s3: S3Sender
  ) {}

  resolve(): Promise<ApplianceBaseConfig> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.readConditional().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async update(transform: (current: ApplianceBaseConfig) => ApplianceBaseConfig): Promise<ApplianceBaseConfig> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.resolve();
      const etag = this.cache?.etag;
      if (!etag) throw new Error('Base config object did not return an ETag');
      const next = applianceBaseConfig.parse(transform(current));
      try {
        const response = await this.s3.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.key,
            Body: JSON.stringify(next),
            ContentType: 'application/json',
            IfMatch: etag,
          })
        );
        // S3 normally returns the new ETag. If an implementation omits it,
        // invalidate so the next request performs an unconditional read.
        this.cache = response.ETag ? { etag: response.ETag, config: next } : undefined;
        return next;
      } catch (error) {
        if (!isPreconditionFailure(error) || attempt === 2) throw error;
        this.cache = undefined;
      }
    }
    throw new Error('Base config update exhausted conditional-write retries');
  }

  clearCache(): void {
    this.cache = undefined;
  }

  private async readConditional(): Promise<ApplianceBaseConfig> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.key,
          ...(this.cache ? { IfNoneMatch: this.cache.etag } : {}),
        })
      );
      const raw = await response.Body?.transformToString();
      if (!raw) throw new Error(`Base config object s3://${this.bucket}/${this.key} is empty`);
      if (!response.ETag) throw new Error(`Base config object s3://${this.bucket}/${this.key} has no ETag`);
      const config = applianceBaseConfig.parse(JSON.parse(raw));
      this.cache = { etag: response.ETag, config };
      return config;
    } catch (error) {
      if (isNotModified(error) && this.cache) return this.cache.config;
      throw error;
    }
  }
}

const snapshotContext = new AsyncLocalStorage<ApplianceBaseConfig>();
let repositoryOverride: BaseConfigRepository | undefined;
let processRepository: BaseConfigRepository | undefined;
let processRepositoryKey = '';

function isNotModified(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'NotModified' || candidate.$metadata?.httpStatusCode === 304;
}

function isPreconditionFailure(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'PreconditionFailed' || candidate.$metadata?.httpStatusCode === 412;
}

function legacyEnvConfig(): ApplianceBaseConfig | undefined {
  const raw = process.env.APPLIANCE_BASE_CONFIG;
  return raw ? applianceBaseConfig.parse(JSON.parse(raw)) : undefined;
}

function repositoryFromEnvironment(): BaseConfigRepository | undefined {
  if (repositoryOverride) return repositoryOverride;
  const bucket = process.env.APPLIANCE_DATA_BUCKET;
  if (!bucket) return undefined;
  const key = process.env.APPLIANCE_BASE_CONFIG_KEY ?? DEFAULT_BASE_CONFIG_KEY;
  const identity = `${bucket}\n${key}\n${process.env.AWS_REGION ?? ''}`;
  if (!processRepository || processRepositoryKey !== identity) {
    const config: S3ClientConfig = { region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1' };
    processRepository = new BaseConfigRepository(bucket, key, new S3Client(config));
    processRepositoryKey = identity;
  }
  return processRepository;
}

/** Resolve the current epoch once. S3 wins; env is legacy-only fallback. */
export async function resolveBaseConfig(): Promise<ApplianceBaseConfig | undefined> {
  const existing = snapshotContext.getStore();
  if (existing) return existing;
  const repository = repositoryFromEnvironment();
  return repository ? repository.resolve() : legacyEnvConfig();
}

/** Synchronous access inside a request/job snapshot boundary. */
export function readBaseConfigSnapshot(): ApplianceBaseConfig | undefined {
  return snapshotContext.getStore() ?? (process.env.APPLIANCE_DATA_BUCKET ? undefined : legacyEnvConfig());
}

export function requireBaseConfigSnapshot(): ApplianceBaseConfig {
  const config = readBaseConfigSnapshot();
  if (!config) throw new Error('Base config snapshot is unavailable outside a request/job boundary');
  return config;
}

export function runWithBaseConfig<T>(config: ApplianceBaseConfig | undefined, fn: () => T): T {
  return config ? snapshotContext.run(config, fn) : fn();
}

export async function baseConfigSnapshotMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const config = await resolveBaseConfig();
    runWithBaseConfig(config, next);
  } catch (error) {
    res.status(500).json({ error: 'Failed to resolve base config', message: String(error), requestId: req.requestId });
  }
}

export async function updateBaseConfig(
  transform: (current: ApplianceBaseConfig) => ApplianceBaseConfig
): Promise<ApplianceBaseConfig> {
  const repository = repositoryFromEnvironment();
  if (!repository) throw new Error('Conditional base-config writes require APPLIANCE_DATA_BUCKET');
  return repository.update(transform);
}

/** Test seam; production callers never replace the process repository. */
export function setBaseConfigRepositoryForTests(repository: BaseConfigRepository | undefined): void {
  repositoryOverride = repository;
  processRepository = undefined;
  processRepositoryKey = '';
}

export { DEFAULT_BASE_CONFIG_KEY };
