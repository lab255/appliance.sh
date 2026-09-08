import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensurePrivateDirectory } from './fs-acl.js';

const LOCK_TIMEOUT_MS = 20_000;
const heldLocks = new Set<string>();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Cross-process profiles.json lock. Reentrant within this module so a
 * profile RMW can safely invoke the credential migration it contains. */
export function withProfilesLock<T>(lockPath: string, fn: () => T): T {
  const resolvedLock = path.resolve(lockPath);
  if (heldLocks.has(resolvedLock)) return fn();

  ensurePrivateDirectory(path.dirname(resolvedLock));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | undefined;
  for (;;) {
    try {
      fd = fs.openSync(resolvedLock, 'wx', 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Never steal a live native refresh lock or continue unlocked.
      if (Date.now() > deadline) throw new Error('Profile credentials are busy; retry.');
      sleepSync(50);
    }
  }

  heldLocks.add(resolvedLock);
  try {
    return fn();
  } finally {
    heldLocks.delete(resolvedLock);
    try {
      fs.closeSync(fd);
      fs.unlinkSync(resolvedLock);
    } catch {
      // Best-effort release; a leftover lock is reaped as stale.
    }
  }
}
