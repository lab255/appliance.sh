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

// Schedule the OS operations explicitly: A releases after B sees EEXIST;
// B observes ENOENT, but C creates its lock before B handles that result.
it.each(
  ['win32', 'linux', 'darwin'].flatMap((platform) =>
    ['missing', 'old'].map((observation) => ({ platform, observation }))
  )
)('preserves a successor after $observation lock observation on $platform', ({ platform, observation }) => {
  vi.stubGlobal('process', { ...process, platform });
  const file = lockPath();
  const first = acquireLock(file, 1000);
  let successor: ReturnType<typeof acquireLock> | undefined;
  if (observation === 'old') {
    const old = new Date(Date.now() - 61_000);
    fs.utimesSync(file, old, old);
  }
  const stat = fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementationOnce((...args: Parameters<typeof fs.statSync>) => {
    if (observation === 'old') {
      const snapshot = stat(...args);
      releaseLock(first);
      successor = acquireLock(file, 1000);
      return snapshot;
    }
    releaseLock(first);
    try {
      return stat(...args);
    } catch (missing) {
      successor = acquireLock(file, 1000);
      throw missing;
    }
  });
  // Only timeout diagnostics need stat now. If those diagnostics omit it,
  // install the successor after refusal to check the same ownership rule.
  expect(() => acquireLock(file, 0)).toThrow('No mutation was attempted unlocked');
  if (!successor) {
    releaseLock(first);
    successor = acquireLock(file, 1000);
  }
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe(successor.token);
  releaseLock(successor);
});

it('does not evict a live owner merely because its timestamp is old', () => {
  const file = lockPath();
  const owner = acquireLock(file, 1000);
  const old = new Date(Date.now() - 61_000);
  fs.utimesSync(file, old, old);
  expect(() => acquireLock(file, 0)).toThrow('No mutation was attempted unlocked');
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe(owner.token);
  releaseLock(owner);
});

it.each(['alive', 'dead', 'unknown'])(
  'reports actionable owner observations (%s) without deleting the lock',
  (state) => {
    const file = lockPath();
    const owner = acquireLock(file, 1000);
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Number.isFinite(Date.parse(metadata.startedAt))).toBe(true);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (state !== 'alive') throw Object.assign(new Error('probe'), { code: state === 'dead' ? 'ESRCH' : 'EPERM' });
      return true;
    });
    let message = '';
    try {
      acquireLock(file, 0);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(file);
    expect(message).toContain(`PID ${process.pid}`);
    expect(message).toContain(`process start hint ${metadata.startedAt}`);
    expect(message).toContain('age 0 seconds');
    expect(message).toContain(
      state === 'alive' ? 'currently running' : state === 'dead' ? 'no longer running' : 'liveness unknown'
    );
    expect(message).toContain(`If no appliance process is active, remove ${file} and retry`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe(owner.token);
    releaseLock(owner);
  }
);
