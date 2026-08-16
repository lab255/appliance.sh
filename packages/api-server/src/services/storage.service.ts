import { applianceBaseConfig, getDockerParams, getKubernetesParams, type ObjectStore } from '@appliance.sh/sdk';
import { S3ObjectStore } from './s3-object-store';
import { FilesystemObjectStore } from './filesystem-object-store';
import { scopePath } from './tenant-context';

/**
 * Collections that are looked up BEFORE a principal is known and must
 * therefore stay un-tenant-scoped. `api-keys` is the auth root: the
 * tenant is resolved *from* the key, so scoping the key lookup by tenant
 * would be circular. This is the ONE deliberate, centralized exemption
 * (Quinn #3) — it lives inside the choke point so it is auditable, not an
 * arbitrary caller-side escape hatch. The server-bootstrap "is there any
 * key at all" gate (`ApiKeyService.exists`) rides on this same
 * collection.
 */
const AUTH_ROOT_COLLECTIONS = new Set<string>(['api-keys']);

export class StorageService {
  private readonly store: ObjectStore;

  constructor(store: ObjectStore) {
    this.store = store;
  }

  /**
   * THE tenant-scoping choke point for point operations. Every keyed
   * read/write/delete funnels through here, so an unresolved principal
   * (multi-tenant on, no context) FAILS CLOSED via `scopePath` instead of
   * falling back to a global store. Auth-root collections are the single
   * exemption.
   */
  private getKey(collection: string, id: string): string {
    const raw = `${collection}/${id}.json`;
    return AUTH_ROOT_COLLECTIONS.has(collection) ? raw : scopePath(raw);
  }

  /**
   * THE tenant-scoping choke point for list operations. `getAll` (and
   * therefore every `list`/`filter` — projects.list, deployment/env
   * filters) narrows to the caller's tenant by prefixing the list key,
   * so a `list` can never enumerate another tenant's records.
   */
  private getListPrefix(collection: string): string {
    const raw = `${collection}/`;
    return AUTH_ROOT_COLLECTIONS.has(collection) ? raw : scopePath(raw);
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const data = await this.store.get(this.getKey(collection, id));
    if (!data) return null;
    return JSON.parse(data) as T;
  }

  async getVersioned<T>(collection: string, id: string): Promise<{ value: T; version: string } | null> {
    if (!this.store.getWithVersion) throw new Error('Object store does not support optimistic concurrency');
    const data = await this.store.getWithVersion(this.getKey(collection, id));
    if (!data) return null;
    return { value: JSON.parse(data.value) as T, version: data.version };
  }

  async getAll<T>(collection: string): Promise<T[]> {
    const keys = await this.store.list(this.getListPrefix(collection));
    const items: T[] = [];

    for (const key of keys) {
      const data = await this.store.get(key);
      if (data) {
        items.push(JSON.parse(data) as T);
      }
    }

    return items;
  }

  async set<T>(collection: string, id: string, value: T): Promise<void> {
    await this.store.set(this.getKey(collection, id), JSON.stringify(value));
  }

  async setIfVersion<T>(collection: string, id: string, value: T, version: string): Promise<boolean> {
    if (!this.store.setIfVersion) throw new Error('Object store does not support optimistic concurrency');
    return this.store.setIfVersion(this.getKey(collection, id), JSON.stringify(value), version);
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.store.delete(this.getKey(collection, id));
  }

  async filter<T>(collection: string, predicate: (item: T) => boolean): Promise<T[]> {
    const all = await this.getAll<T>(collection);
    return all.filter(predicate);
  }
}

export function createStorageService(): StorageService {
  // New CFN installs can initialize storage before the first base-config
  // read. This also breaks the config↔storage bootstrap cycle: the config
  // object itself lives in this bucket.
  const dataBucket = process.env.APPLIANCE_DATA_BUCKET;
  if (dataBucket) {
    return new StorageService(
      new S3ObjectStore(dataBucket, process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1')
    );
  }
  const baseConfigJson = process.env.APPLIANCE_BASE_CONFIG;
  if (!baseConfigJson) {
    throw new Error('APPLIANCE_BASE_CONFIG environment variable is required');
  }

  const config = applianceBaseConfig.parse(JSON.parse(baseConfigJson));

  // Kubernetes-driven bases (local microVM + generic external clusters)
  // and Docker bases (the single-binary local daemon) all back state
  // with a filesystem dataDir. The cloud (AWS) path falls through to
  // S3 below.
  const k8s = getKubernetesParams(config);
  const docker = getDockerParams(config);
  const dataDir = k8s?.dataDir ?? docker?.dataDir;
  if (k8s || docker) {
    if (!dataDir) {
      throw new Error(`dataDir is required in APPLIANCE_BASE_CONFIG for ${config.type} bases`);
    }
    return new StorageService(new FilesystemObjectStore(dataDir));
  }

  if (!config.aws?.dataBucketName) {
    throw new Error('aws.dataBucketName is required in APPLIANCE_BASE_CONFIG for cloud bases');
  }
  const store = new S3ObjectStore(config.aws.dataBucketName, config.aws.region);
  return new StorageService(store);
}

let storageServiceInstance: StorageService | null = null;

export function getStorageService(): StorageService {
  if (!storageServiceInstance) {
    storageServiceInstance = createStorageService();
  }
  return storageServiceInstance;
}

export function resetStorageServiceForTests(): void {
  storageServiceInstance = null;
}
