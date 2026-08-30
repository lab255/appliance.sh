import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FilesystemObjectStore } from './filesystem-object-store';

describe('FilesystemObjectStore', () => {
  let dir: string;
  let store: FilesystemObjectStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fs-object-store-'));
    store = new FilesystemObjectStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for missing keys', async () => {
    expect(await store.get('projects/missing.json')).toBeNull();
  });

  it('round-trips set + get', async () => {
    await store.set('projects/p1.json', JSON.stringify({ id: 'p1' }));
    expect(await store.get('projects/p1.json')).toBe('{"id":"p1"}');
  });

  it('creates atomically only when absent', async () => {
    expect(await store.setIfAbsent('jobs/lease.json', 'first')).toBe(true);
    expect(await store.setIfAbsent('jobs/lease.json', 'second')).toBe(false);
    expect(await store.get('jobs/lease.json')).toBe('first');
  });

  it('list returns the keys under a prefix verbatim', async () => {
    await store.set('projects/a.json', '1');
    await store.set('projects/b.json', '2');
    await store.set('envs/x.json', '3');
    const keys = await store.list('projects/');
    expect(keys.sort()).toEqual(['projects/a.json', 'projects/b.json']);
  });

  it('list returns an empty array when the prefix has no entries', async () => {
    expect(await store.list('does-not-exist/')).toEqual([]);
  });

  it('delete is idempotent for missing keys', async () => {
    await expect(store.delete('projects/missing.json')).resolves.toBeUndefined();
  });

  it('refuses keys that escape the store root', async () => {
    await expect(store.set('../outside.json', 'oops')).rejects.toThrow(/Refusing key outside store root/);
  });
});
