import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApplianceV2 } from '@appliance.sh/sdk';
import { entitlementAnchorFile } from './credential-store';
import { entitlementLockFile, grantManifestEntitlements, readEntitlementStore } from './entitlements';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('preserves both signed mutations when a contender observes an old lock between CAS and anchor commit', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'entitlement-race-'));
  roots.push(home);
  const manifest = (name: string): ApplianceV2 => ({
    manifest: 'v2',
    kind: 'runnable',
    type: 'container',
    name,
    version: '1.0.0',
    license: 'MIT',
    description: 'fixture',
    publisher: { name: 'fixture' },
    payload: { images: {} },
    env: {},
  });
  const options = { home, lockTimeoutMs: 0 };
  const open = fs.openSync;
  let interleaved = false;
  let refused = false;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (!interleaved && String(args[0]).startsWith(`${entitlementAnchorFile(home)}.`)) {
      interleaved = true;
      // Writer A has computed its next signed record and passed CAS, but has
      // not yet published the anchor. Schedule B here, without wall-time luck.
      const old = new Date(Date.now() - 61_000);
      fs.utimesSync(entitlementLockFile(home), old, old);
      try {
        grantManifestEntitlements(manifest('writer-b'), 'cli', [], options);
      } catch (error) {
        expect((error as Error).message).toContain('No mutation was attempted unlocked');
        refused = true;
      }
    }
    return open(...args);
  });
  grantManifestEntitlements(manifest('writer-a'), 'cli', [], options);
  // A legitimate contender retries only after A has released its lock.
  if (refused) grantManifestEntitlements(manifest('writer-b'), 'cli', [], options);
  expect(interleaved).toBe(true);
  expect(readEntitlementStore(options).records.map((record) => record.appId)).toEqual(['writer-a', 'writer-b']);
  expect(refused).toBe(true);
});
