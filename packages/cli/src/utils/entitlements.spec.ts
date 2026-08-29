import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApplianceV2 } from '@appliance.sh/sdk';
import { runRuntimeEntitlementsCommand } from '../appliance-runtime-entitlements';
import {
  EntitlementIntegrityError,
  UngrantedControlError,
  assertManifestEntitled,
  computeGrantDelta,
  entitlementLockFile,
  entitlementsFile,
  grantManifestEntitlements,
  latestEntitlement,
  readEntitlementStore,
  requestedGrantsForManifest,
  revokeEntitlementGrant,
  stampEntitlementUsage,
  suggestedRevocations,
} from './entitlements';
import { entitlementAnchorFile } from './credential-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-entitlements-'));
  roots.push(directory);
  return directory;
}

function manifest(version = '1.0.0'): ApplianceV2 {
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  return {
    manifest: 'v2',
    kind: 'runnable',
    type: 'container',
    name: 'journal',
    version,
    license: 'MIT',
    description: 'Journal',
    publisher: { name: 'Fixture' },
    payload: { images: { [platform]: { path: 'payload/image.tar' } } },
    env: {},
    network: { egress: [{ host: 'api.example.test', ports: [443] }] },
    mounts: [{ name: 'data', source: 'volume', guest: '/data', readOnly: false }],
    ports: [{ name: 'web', guest: 8080, protocol: 'tcp', expose: 'host' }],
    resources: { cpus: 1, memoryMib: 512 },
  };
}

function allGrantIds(value: ApplianceV2): string[] {
  return requestedGrantsForManifest(value).map((grant) => grant.id);
}

describe('signed entitlement store', () => {
  it('round-trips signed records and detects tampering', () => {
    const directory = home();
    const value = manifest();
    const record = grantManifestEntitlements(value, 'cli', allGrantIds(value), {
      home: directory,
      now: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(readEntitlementStore({ home: directory }).records).toEqual([record]);
    const file = entitlementsFile(directory);
    const edited = fs.readFileSync(file, 'utf8').replace('"license": "MIT"', '"license": "GPL-3.0"');
    fs.writeFileSync(file, edited);
    expect(() => readEntitlementStore({ home: directory })).toThrow(EntitlementIntegrityError);
    expect(fs.readFileSync(file, 'utf8')).toBe(edited);
  });

  // NTFS does not expose POSIX owner-only mode semantics.
  it.skipIf(process.platform === 'win32')('writes the store and anchor with mode 0600', () => {
    const directory = home();
    const value = manifest();
    grantManifestEntitlements(value, 'cli', allGrantIds(value), { home: directory });
    expect(fs.statSync(entitlementsFile(directory)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(entitlementAnchorFile(directory)).mode & 0o777).toBe(0o600);
  });

  it('detects deletion or reordering of otherwise valid signed history', () => {
    const directory = home();
    const first = manifest();
    grantManifestEntitlements(first, 'cli', allGrantIds(first), { home: directory });
    const second = { ...manifest(), name: 'reader' };
    grantManifestEntitlements(second, 'cli', allGrantIds(second), { home: directory });
    const file = entitlementsFile(directory);
    const store = JSON.parse(fs.readFileSync(file, 'utf8')) as { records: unknown[] };
    store.records.reverse();
    fs.writeFileSync(file, JSON.stringify(store));
    expect(() => readEntitlementStore({ home: directory })).toThrow('history chain verification failed');
  });

  it('detects whole-file rollback to a valid pre-revoke snapshot while the anchor is intact', () => {
    const directory = home();
    const value = manifest();
    grantManifestEntitlements(value, 'cli', allGrantIds(value), { home: directory });
    const beforeRevoke = fs.readFileSync(entitlementsFile(directory));
    revokeEntitlementGrant('journal', 'egress:api.example.test', { home: directory });
    fs.writeFileSync(entitlementsFile(directory), beforeRevoke);
    expect(() => readEntitlementStore({ home: directory })).toThrow(
      'Entitlement rollback detected: store sequence 1 is behind protected sequence 2'
    );
  });

  it('detects signed tail truncation while the anchor is intact', () => {
    const directory = home();
    const value = manifest();
    grantManifestEntitlements(value, 'cli', allGrantIds(value), { home: directory });
    stampEntitlementUsage('journal', ['egress:api.example.test'], { home: directory });
    const file = entitlementsFile(directory);
    const store = JSON.parse(fs.readFileSync(file, 'utf8')) as { records: unknown[] };
    store.records.pop();
    fs.writeFileSync(file, JSON.stringify(store));
    expect(() => readEntitlementStore({ home: directory })).toThrow('behind protected sequence 2');
  });

  it('computes upgrade delta by stable id and treats a widening as new', () => {
    const directory = home();
    const initial = manifest();
    const record = grantManifestEntitlements(initial, 'cli', allGrantIds(initial), { home: directory });
    const upgraded = manifest('1.1.0');
    upgraded.network = { egress: [{ host: 'api.example.test', ports: [443, 8443] }] };
    const delta = computeGrantDelta(requestedGrantsForManifest(upgraded), record);
    expect(delta.additions.map((grant) => grant.id)).toEqual(['egress:api.example.test']);
    expect(delta.unchanged.map((grant) => grant.id)).toEqual(['mount:data', 'port:web', 'resources:runtime']);
  });

  it('refuses required ungranted controls while allowing a denied optional mount', () => {
    const directory = home();
    const value = manifest();
    const required = allGrantIds(value).filter((id) => id !== 'mount:data');
    const record = grantManifestEntitlements(value, 'desktop', required, { home: directory });
    expect(assertManifestEntitled(value, record).map((grant) => grant.id)).not.toContain('mount:data');
    const revoked = revokeEntitlementGrant('journal', 'egress:api.example.test', { home: directory });
    expect(() => assertManifestEntitled(value, revoked)).toThrow(UngrantedControlError);
    expect(() => assertManifestEntitled(value, revoked)).toThrow('egress api.example.test:443');
  });

  it('stamps monotonic usage and suggests then revokes old grants', () => {
    const directory = home();
    const value = manifest();
    grantManifestEntitlements(value, 'cli', allGrantIds(value), {
      home: directory,
      now: new Date('2026-06-01T00:00:00.000Z'),
    });
    stampEntitlementUsage('journal', ['egress:api.example.test'], {
      home: directory,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    stampEntitlementUsage('journal', ['egress:api.example.test'], {
      home: directory,
      now: new Date('2026-06-10T00:00:00.000Z'),
    });
    let current = latestEntitlement(readEntitlementStore({ home: directory }).records, 'journal')!;
    expect(current.usage['egress:api.example.test']?.lastUsedAt).toBe('2026-06-15T00:00:00.000Z');
    const suggestions = suggestedRevocations(
      readEntitlementStore({ home: directory }).records,
      new Date('2026-08-01T00:00:00.000Z')
    );
    expect(suggestions).toHaveLength(3);
    expect(suggestions.map((suggestion) => suggestion.grant.id)).not.toContain('mount:data');
    expect(suggestions[0]?.revokeCommand).toContain('appliance runtime entitlements revoke journal');
    current = revokeEntitlementGrant('journal', suggestions[0]!.grant.id, { home: directory });
    expect(current.grants).toHaveLength(3);
  });

  it('serializes cross-process writers without losing a CAS mutation', async () => {
    const directory = home();
    // The project verification build precedes tests; subprocesses import that
    // exact emitted module so the test exercises real cross-process locking.
    const moduleUrl = new URL('../../dist/utils/entitlements.js', import.meta.url).href;
    const children = Array.from({ length: 6 }, (_, index) => {
      const script = `import { grantManifestEntitlements } from ${JSON.stringify(moduleUrl)};
grantManifestEntitlements({manifest:'v2',kind:'runnable',type:'container',name:'app-${index}',version:'1.0.0',license:'MIT',description:'x',publisher:{name:'x'},payload:{images:{}},env:{}},'cli',[],{home:${JSON.stringify(directory)},lockTimeoutMs:10000});`;
      return new Promise<void>((resolve, reject) => {
        const child = spawn('bun', ['--eval', script], {
          cwd: path.resolve(fileURLToPath(new URL('../../../..', import.meta.url))),
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => (stderr += String(chunk)));
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`))));
      });
    });
    await Promise.all(children);
    expect(
      readEntitlementStore({ home: directory })
        .records.map((record) => record.appId)
        .sort()
    ).toEqual(Array.from({ length: 6 }, (_, index) => `app-${index}`));
  }, 20_000);

  it('breaks a lock whose mtime is older than 60 seconds', () => {
    const directory = home();
    fs.writeFileSync(entitlementLockFile(directory), `${JSON.stringify({ pid: process.pid, token: 'stale' })}\n`, {
      mode: 0o600,
    });
    const old = new Date(Date.now() - 61_000);
    fs.utimesSync(entitlementLockFile(directory), old, old);
    expect(() =>
      grantManifestEntitlements(manifest(), 'cli', allGrantIds(manifest()), { home: directory })
    ).not.toThrow();
    expect(fs.existsSync(entitlementLockFile(directory))).toBe(false);
  });

  it('validates --days as a present positive whole number', async () => {
    const directory = home();
    await expect(
      runRuntimeEntitlementsCommand(['--home', directory, '--suggest-revoke', '--days', '0'])
    ).rejects.toThrow('--days must be a whole number (minimum 1).');
    await expect(runRuntimeEntitlementsCommand(['--home', directory, '--suggest-revoke', '--days'])).rejects.toThrow(
      '--days requires a whole number (minimum 1).'
    );
  });
});
