import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireLock, releaseLock } from './entitlement-lock';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function lockPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entitlement-lock-'));
  roots.push(root);
  return path.join(root, 'store.lock');
}
function windows(): void {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
}

it.each(['EPERM', 'EACCES', 'EBUSY'])('retries Windows %s before acquiring exclusive ownership', (code) => {
  const file = lockPath();
  windows();
  const open = vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('delete pending'), { code });
  });
  const lock = acquireLock(file, 1000);
  expect(open).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe(lock.token);
  releaseLock(lock);
  expect(fs.existsSync(file)).toBe(false);
});

it('fails closed at the deadline without unlinking an inaccessible lock', () => {
  const file = lockPath();
  windows();
  fs.writeFileSync(file, 'held');
  vi.spyOn(fs, 'openSync').mockImplementation(() => {
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
  });
  const unlink = vi.spyOn(fs, 'unlinkSync');
  const stat = vi.spyOn(fs, 'statSync');
  expect(() => acquireLock(file, 0)).toThrow('No mutation was attempted unlocked');
  expect(unlink).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
});

it('does not retry Unix permission failures', () => {
  const file = lockPath();
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const open = vi.spyOn(fs, 'openSync').mockImplementation(() => {
    throw error;
  });
  expect(() => acquireLock(file, 1000)).toThrow(error);
  expect(open).toHaveBeenCalledTimes(1);
});
