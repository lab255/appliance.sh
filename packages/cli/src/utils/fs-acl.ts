import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

export interface WindowsAclOptions {
  /** Give child files and directories the same owner-only ACL. */
  directory?: boolean;
}

function currentWindowsSid(p: string): string {
  const result = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw new Error(`cannot restrict ${p}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`cannot restrict ${p}: whoami failed: ${(result.stderr || result.stdout).trim()}`);
  }

  const row = result.stdout.trim().split(/\r?\n/, 1)[0] ?? '';
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index]!;
    if (char === '"') {
      if (quoted && row[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  const sid = fields.find((value) => /^S-\d+(?:-\d+)+$/i.test(value.trim()))?.trim();
  if (!sid) throw new Error(`cannot restrict ${p}: whoami returned no valid user SID`);
  return sid;
}

function runIcacls(p: string, args: string[], action: string): string {
  const result = spawnSync('icacls', [p, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw new Error(`cannot restrict ${p}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`cannot restrict ${p}: ${action}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function windowsAclPrincipals(p: string, listing: string): string[] {
  const pathPrefix = p.toLocaleLowerCase();
  return listing.split(/\r?\n/).flatMap((line) => {
    const marker = line.lastIndexOf(':(');
    if (marker < 0) return [];
    let principal = line.slice(0, marker).trimStart();
    if (principal.toLocaleLowerCase().startsWith(pathPrefix)) {
      principal = principal.slice(p.length).trim();
    }
    return principal ? [principal] : [];
  });
}

/**
 * Windows analogue of chmod 0600/0700: protect the DACL and retain exactly the
 * current user, SYSTEM, and Administrators. The two privileged principals can
 * take ownership regardless of the DACL. Secret-file callers let errors
 * propagate; directory callers may catch and warn because the file itself is
 * tightened after every write.
 */
export function restrictWindowsAcl(p: string, options: WindowsAclOptions = {}): void {
  if (process.platform !== 'win32') return;
  const sid = currentWindowsSid(p);
  const principal = `*${sid}`;
  const permission = options.directory ? '(OI)(CI)F' : 'F';
  runIcacls(p, ['/setowner', principal], `set owner to ${principal}`);
  runIcacls(p, ['/inheritance:r'], 'remove inherited ACEs');

  // /grant:r only replaces grants for the named SID, so remove every explicit
  // principal left by the parent before installing the accepted set.
  const listing = runIcacls(p, [], 'list explicit ACEs');
  for (const existing of windowsAclPrincipals(p, listing)) {
    runIcacls(p, ['/remove', existing], `remove explicit ACE for ${existing}`);
  }
  runIcacls(
    p,
    ['/grant:r', `${principal}:${permission}`, `*S-1-5-18:${permission}`, `*S-1-5-32-544:${permission}`],
    `grant the accepted principals access`
  );
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
