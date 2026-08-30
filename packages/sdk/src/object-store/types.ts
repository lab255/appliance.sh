export interface VersionedObject {
  value: string;
  /** Opaque storage revision (S3 ETag in production). */
  version: string;
}

export interface ObjectStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Create only when the key does not exist; false means another writer won. */
  setIfAbsent?(key: string, value: string): Promise<boolean>;
  getWithVersion?(key: string): Promise<VersionedObject | null>;
  /** Write only if version still matches; false means another writer won. */
  setIfVersion?(key: string, value: string, version: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
