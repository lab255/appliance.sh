import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ObjectStore, VersionedObject } from '@appliance.sh/sdk';

/**
 * Filesystem-backed object store. Used by the local-runtime variant
 * of the api-server (`appliance-base-local`) so projects, environments,
 * deployments, and api-keys persist under a single directory on the
 * developer's machine instead of S3.
 *
 * Keys map directly to relative paths under `rootDir`. Writes are
 * atomic per file: content is written to `<path>.tmp` and renamed
 * into place so concurrent readers never observe a half-written
 * record.
 */
export class FilesystemObjectStore implements ObjectStore {
  constructor(private readonly rootDir: string) {}

  async get(key: string): Promise<string | null> {
    const fullPath = this.resolveKey(key);
    try {
      return await fs.readFile(fullPath, 'utf-8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getWithVersion(key: string): Promise<VersionedObject | null> {
    const value = await this.get(key);
    return value === null ? null : { value, version: versionOf(value) };
  }

  async set(key: string, value: string): Promise<void> {
    const fullPath = this.resolveKey(key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await this.withWriteLock(fullPath, () => this.writeAtomic(fullPath, value));
  }

  async setIfAbsent(key: string, value: string): Promise<boolean> {
    const fullPath = this.resolveKey(key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    return this.withWriteLock(fullPath, async () => {
      if ((await this.get(key)) !== null) return false;
      await this.writeAtomic(fullPath, value);
      return true;
    });
  }

  async setIfVersion(key: string, value: string, version: string): Promise<boolean> {
    const fullPath = this.resolveKey(key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    return this.withWriteLock(fullPath, async () => {
      const current = await this.get(key);
      if (current === null || versionOf(current) !== version) return false;
      await this.writeAtomic(fullPath, value);
      return true;
    });
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolveKey(key));
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  async list(prefix?: string): Promise<string[]> {
    // The S3 backend returns keys verbatim including the prefix. We
    // mirror that contract so callers (StorageService.getAll) can
    // pass each returned key straight back into get().
    const searchRoot = prefix ? this.resolveKey(prefix) : this.rootDir;
    let entries: string[] = [];
    try {
      entries = await collectFiles(searchRoot);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    return (
      entries
        // Keys are S3-shaped (`/`-separated) regardless of host OS —
        // path.relative emits `\` on Windows, which would both fail the
        // prefix filter and hand callers keys get() can't round-trip.
        .map((p) => path.relative(this.rootDir, p).split(path.sep).join('/'))
        .filter((rel) => (prefix ? rel.startsWith(prefix) : true))
        // Skip the in-flight `.tmp` files set() leaves behind on crash —
        // they aren't legitimate keys and would deserialise as bad JSON.
        .filter((rel) => !rel.includes('.tmp-') && !rel.endsWith('.lock'))
    );
  }

  private resolveKey(key: string): string {
    // Defensive: refuse `..` traversal even though callers are
    // internal. The api-server collection prefixes never contain `..`,
    // but a malformed key wouldn't be caught until much later.
    const resolved = path.resolve(this.rootDir, key);
    if (!resolved.startsWith(path.resolve(this.rootDir))) {
      throw new Error(`Refusing key outside store root: ${key}`);
    }
    return resolved;
  }

  private async writeAtomic(fullPath: string, value: string): Promise<void> {
    const tmpPath = `${fullPath}.tmp-${randomUUID()}`;
    await fs.writeFile(tmpPath, value, 'utf-8');
    await fs.rename(tmpPath, fullPath);
  }

  private async withWriteLock<T>(fullPath: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = `${fullPath}.lock`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = await fs.open(lockPath, 'wx');
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    if (!handle) throw new Error(`Timed out acquiring object-store write lock for ${fullPath}`);
    try {
      return await operation();
    } finally {
      await handle.close();
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }
}

function versionOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return out;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
