import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

const STALE_LOCK_MS = 60_000;

interface EntitlementLock {
  descriptor: number;
  file: string;
  token: string;
}

export function acquireLock(file: string, timeoutMs: number): EntitlementLock {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let descriptor: number;
    try {
      descriptor = fs.openSync(file, 'wx', 0o600);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      // Windows can deny creation while the previous lock is delete-pending.
      // Retry acquisition within the same deadline, never proceed unlocked or
      // infer staleness from a sharing/permission failure.
      const windowsContention =
        process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
      if (code !== 'EEXIST' && !windowsContention) throw cause;
      if (code === 'EEXIST' && staleLock(file)) {
        try {
          fs.unlinkSync(file);
        } catch (unlinkCause) {
          if ((unlinkCause as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkCause;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          'Another live process still owns the entitlement store lock; wait for that operation to finish. No mutation was attempted unlocked.'
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    const token = randomUUID();
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token })}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      return { descriptor, file, token };
    } catch (cause) {
      fs.closeSync(descriptor);
      fs.unlinkSync(file);
      throw cause;
    }
  }
}

function staleLock(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) return true;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown };
    if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) < 1) return false;
    try {
      process.kill(Number(parsed.pid), 0);
      return false;
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code === 'ESRCH';
    }
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export function releaseLock(lock: EntitlementLock): void {
  let closeError: unknown;
  try {
    fs.closeSync(lock.descriptor);
  } catch (cause) {
    closeError = cause;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(lock.file, 'utf8')) as { token?: unknown };
    if (parsed.token === lock.token) fs.unlinkSync(lock.file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  if (closeError) throw closeError;
}
