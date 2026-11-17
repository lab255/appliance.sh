import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

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
      // A stale observation cannot authorize unlink: another contender may
      // have acquired this pathname since that observation. Never reap locks.
      if (Date.now() >= deadline) {
        throw new Error(lockTimeoutMessage(file, code === 'EEXIST'));
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    const token = randomUUID();
    try {
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, token, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() })}\n`,
        'utf8'
      );
      fs.fsyncSync(descriptor);
      return { descriptor, file, token };
    } catch (cause) {
      fs.closeSync(descriptor);
      fs.unlinkSync(file);
      throw cause;
    }
  }
}

function lockTimeoutMessage(file: string, inspect: boolean): string {
  let age = 'unknown';
  let owner = 'owner unavailable';
  if (inspect) {
    try {
      age = `${Math.max(0, Math.floor((Date.now() - fs.statSync(file).mtimeMs) / 1000))} seconds`;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown; startedAt?: unknown };
      if (Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0) {
        let observation = 'currently running';
        try {
          process.kill(Number(parsed.pid), 0);
        } catch (cause) {
          observation = (cause as NodeJS.ErrnoException).code === 'ESRCH' ? 'no longer running' : 'liveness unknown';
        }
        const start = typeof parsed.startedAt === 'string' ? parsed.startedAt : 'unknown';
        owner = `PID ${parsed.pid} (${observation}; process start hint ${start})`;
      }
    } catch {
      // Diagnostics are best effort, never evidence that unlinking is safe.
    }
  }
  return `Entitlement store lock ${file}: age ${age}, ${owner}. These are observations, not proof of ownership (PIDs can be reused). Wait for active operations to finish. If no appliance process is active, remove ${file} and retry. No mutation was attempted unlocked.`;
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
