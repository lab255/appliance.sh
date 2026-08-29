import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

export interface WindowsAclOptions {
  /** Give child files and directories the same owner-only ACL. */
  directory?: boolean;
}

/**
 * Windows analogue of chmod 0600/0700: remove inherited ACEs and grant full
 * control only to the account running the CLI. Secret-file callers let errors
 * propagate; directory callers may catch and warn because the file itself is
 * tightened after every write.
 */
export function restrictWindowsAcl(p: string, options: WindowsAclOptions = {}): void {
  if (process.platform !== 'win32') return;
  const username = process.env.USERNAME;
  if (!username) throw new Error(`cannot restrict ${p}: USERNAME is unavailable`);
  const domain = process.env.USERDOMAIN;
  const principal = domain && domain !== '.' ? `${domain}\\${username}` : username;
  const permission = options.directory ? '(OI)(CI)F' : 'F';
  const result = spawnSync('icacls', [p, '/inheritance:r', '/grant:r', `${principal}:${permission}`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw new Error(`cannot restrict ${p}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`cannot restrict ${p} to ${principal}: ${(result.stderr || result.stdout).trim()}`);
  }
}

/** Create an owner-only directory, warning if Windows cannot tighten its ACL. */
export function ensurePrivateDirectory(p: string): void {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  fs.chmodSync(p, 0o700);
  try {
    restrictWindowsAcl(p, { directory: true });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.warn(`Warning: ${detail}`);
  }
}
