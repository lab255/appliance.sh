import * as path from 'node:path';

/**
 * Resolve the credential helper as a sibling of the running executable.
 *
 * This intentionally has no PATH, cwd, environment, or search fallback. A
 * missing sibling is a credential error for the card-2 caller, never a reason
 * to execute a same-named program from somewhere else.
 */
export function resolveCredHelperPath(): string {
  return resolveCredHelperSibling(process.execPath, process.platform);
}

/** Pure seam for platform-independent tests; not part of the package barrel. */
export function resolveCredHelperSibling(executablePath: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(executablePath)) {
    throw new Error('Cannot resolve appliance-credhelper from a non-absolute executable path.');
  }
  const extension = platform === 'win32' ? '.exe' : '';
  return pathApi.join(pathApi.dirname(executablePath), `appliance-credhelper${extension}`);
}
