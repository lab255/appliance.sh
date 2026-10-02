import { vmNameForProfile } from './cluster-target.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Engine registry existence, independent of running state or port connectivity. */
export function microVmGone(id: string, home = process.env.HOME ?? os.homedir(), apiUrl?: string): boolean {
  const name = vmNameForProfile(id, apiUrl);
  if (name === null) return false;
  if (!name || /[/\\]/.test(name) || name === '.' || name === '..') throw new Error('Invalid VM name');
  for (const root of ['vm', 'vmm']) {
    try {
      fs.statSync(path.join(home, '.appliance', root, name, 'vm.json'));
      return false;
    } catch (error) {
      // An unreadable registry is unknown, never proof that a VM was deleted.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return true;
}
