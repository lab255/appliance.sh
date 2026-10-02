import { vmNameForProfile } from './cluster-target.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** ENOENT on Windows also covers ERROR_DIRECTORY, ERROR_INVALID_NAME and
 * ERROR_INVALID_REPARSE_DATA (libuv 1.51 src/win/error.c:129-137).
 * Require a successfully enumerated parent that actually lacks the entry;
 * a present but unstatable entry is unknown, including broken junctions.
 * Access/sharing/IO errors propagate. An inaccessible drive/root is unknown. */
function confirmMissing(file: string, statError: unknown): void {
  let candidate = path.resolve(file);
  for (;;) {
    const parent = path.dirname(candidate);
    const name = path.basename(candidate);
    // Win32 can reject these without looking in the directory. Do not infer
    // deletion from such a name, even if enumeration cannot find it.
    if (
      parent === candidate ||
      /[<>:"|?*]/.test(name) ||
      [...name].some((c) => c.charCodeAt(0) < 32) ||
      /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
    )
      throw statError;
    let entries: string[];
    try {
      entries = fs.readdirSync(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      candidate = parent;
      continue;
    }
    // Case-insensitive comparison is deliberately conservative on all hosts.
    if (entries.some((entry) => entry.toLowerCase() === name.toLowerCase())) throw statError;
    return;
  }
}

/** Engine registry existence, independent of running state or port connectivity. */
export function microVmGone(id: string, home = process.env.HOME ?? os.homedir(), apiUrl?: string): boolean {
  const name = vmNameForProfile(id, apiUrl);
  if (name === null) return false;
  if (!name || /[/\\]/.test(name) || name === '.' || name === '..') throw new Error('Invalid VM name');
  for (const root of ['vm', 'vmm']) {
    const spec = path.join(home, '.appliance', root, name, 'vm.json');
    try {
      fs.statSync(spec);
      return false;
    } catch (error) {
      // An unreadable registry is unknown, never proof that a VM was deleted.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      confirmMissing(spec, error);
    }
  }
  return true;
}
