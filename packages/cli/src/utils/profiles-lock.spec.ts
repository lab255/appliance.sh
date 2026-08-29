import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withProfilesLock } from './profiles-lock.js';

describe('profiles lock', () => {
  it('is reentrant and releases only after the outer operation finishes', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-profiles-lock-'));
    const lock = path.join(home, 'profiles.json.lock');
    try {
      withProfilesLock(lock, () => {
        expect(fs.existsSync(lock)).toBe(true);
        withProfilesLock(lock, () => expect(fs.existsSync(lock)).toBe(true));
        expect(fs.existsSync(lock)).toBe(true);
      });
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
