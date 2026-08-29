import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __testing,
  CREDENTIAL_STORE_SCHEMA,
  CredentialStoreError,
  encodeAgentCredential,
  parseStoredAgentCredential,
} from './credential-store.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `appliance-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('agent credential envelope contract', () => {
  it('matches every cross-language golden vector byte-for-byte', () => {
    const vectors = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, '../../../credential-store/testdata/envelope-vectors.json'),
        'utf8'
      )
    ) as Array<{ kind: string; value: string; encoded: string }>;
    expect(vectors.length).toBeGreaterThan(0);
    for (const vector of vectors) {
      const encoded = encodeAgentCredential({ kind: vector.kind, value: vector.value });
      expect(encoded.equals(Buffer.from(vector.encoded, 'utf8'))).toBe(true);
      if (vector.kind === 'api-key' || vector.kind === 'oauth' || vector.kind === 'pat') {
        expect(parseStoredAgentCredential(encoded)).toEqual({ kind: vector.kind, value: vector.value });
      } else {
        expect(parseStoredAgentCredential(encoded)).toBeNull();
      }
    }
  });

  it('fails closed on an envelope drift instead of treating it as a bare key', () => {
    expect(parseStoredAgentCredential(Buffer.from('{"kind":"oauth","value":"truncated'))).toBeNull();
    expect(parseStoredAgentCredential(Buffer.from('{"kind":"unknown","value":"secret"}'))).toBeNull();
  });
});

class MemoryBackend {
  readonly values = new Map<string, Buffer>();
  readonly writes: Array<{ key: string; value: Buffer }> = [];

  private key(target: { kind: string; identifier?: string }): string {
    return `${target.kind}:${target.identifier ?? ''}`;
  }

  get(target: { kind: string; identifier?: string }): Buffer | null {
    return this.values.get(this.key(target)) ?? null;
  }

  put(target: { kind: string; identifier?: string }, value: Buffer): void {
    const key = this.key(target);
    const copy = Buffer.from(value);
    this.values.set(key, copy);
    this.writes.push({ key, value: copy });
  }

  delete(target: { kind: string; identifier?: string }): void {
    this.values.delete(this.key(target));
  }

  importEntitlementAnchor(candidate: Buffer): Buffer {
    const key = 'entitlement-anchor:';
    const existing = this.values.get(key);
    if (existing) return Buffer.from(existing);
    this.put({ kind: 'entitlement-anchor' }, candidate);
    return Buffer.from(this.values.get(key)!);
  }
}

function migrationFixture(): {
  home: string;
  profilesFile: string;
  legacyCredentialsFile: string;
} {
  const home = temporaryDirectory('credential-migration');
  return {
    home,
    profilesFile: path.join(home, 'profiles.json'),
    legacyCredentialsFile: path.join(home, 'credentials.json'),
  };
}

interface MigratedProfilesFixture {
  profiles: Record<string, { secret: string }>;
  credentialStore: { schema: string };
}

interface MigratedLegacyFixture {
  secret: string;
}

describe('verified Windows cluster scrub migration', () => {
  it('imports every profile plus the active legacy mirror, verifies, then blanks both files idempotently', () => {
    const paths = migrationFixture();
    fs.writeFileSync(
      paths.profilesFile,
      JSON.stringify({
        version: 1,
        activeProfile: 'prod',
        profiles: {
          prod: { apiUrl: 'https://prod.test', keyId: 'prod-key', secret: 'prod-secret', managed: 'cli' },
          'dev profile': { apiUrl: 'https://dev.test', keyId: 'dev-key', secret: 'dev-secret', managed: 'cli' },
        },
      })
    );
    fs.writeFileSync(
      paths.legacyCredentialsFile,
      JSON.stringify({ apiUrl: 'https://prod.test', keyId: 'prod-key', secret: 'prod-secret' })
    );
    const backend = new MemoryBackend();

    const first = __testing.migrateWindowsCredentialFilesWithBackend(paths, backend);
    expect(first.conflicts).toEqual([]);
    expect(new Set(first.migrated)).toEqual(new Set(['prod', 'dev profile']));
    expect(backend.values.get('cluster:prod')?.equals(Buffer.from('{"id":"prod-key","secret":"prod-secret"}'))).toBe(
      true
    );
    // The free-form profile name is encoded at the helper/store boundary.
    expect(backend.values.get('cluster:dev%20profile')).toEqual(Buffer.from('{"id":"dev-key","secret":"dev-secret"}'));

    const profiles = JSON.parse(fs.readFileSync(paths.profilesFile, 'utf8')) as MigratedProfilesFixture;
    const legacy = JSON.parse(fs.readFileSync(paths.legacyCredentialsFile, 'utf8')) as MigratedLegacyFixture;
    expect(profiles.profiles.prod.secret).toBe('');
    expect(profiles.profiles['dev profile'].secret).toBe('');
    expect(legacy.secret).toBe('');
    expect(profiles.credentialStore.schema).toBe(CREDENTIAL_STORE_SCHEMA);

    const writes = backend.writes.length;
    const second = __testing.migrateWindowsCredentialFilesWithBackend(paths, backend);
    expect(second.conflicts).toEqual([]);
    expect(backend.writes).toHaveLength(writes);
  });

  it('scrubs byte-equal duplicates but preserves both sides of a conflict', () => {
    const paths = migrationFixture();
    fs.writeFileSync(
      paths.profilesFile,
      JSON.stringify({
        version: 1,
        activeProfile: 'conflict',
        profiles: {
          equal: { apiUrl: 'https://equal.test', keyId: 'k1', secret: 'same', managed: 'cli' },
          conflict: { apiUrl: 'https://conflict.test', keyId: 'file-key', secret: 'file-secret', managed: 'cli' },
        },
      })
    );
    const backend = new MemoryBackend();
    backend.values.set('cluster:equal', Buffer.from('{"id":"k1","secret":"same"}'));
    backend.values.set('cluster:conflict', Buffer.from('{"id":"store-key","secret":"store-secret"}'));

    const report = __testing.migrateWindowsCredentialFilesWithBackend(paths, backend);
    expect(report.conflicts).toEqual(['conflict']);
    const profiles = JSON.parse(fs.readFileSync(paths.profilesFile, 'utf8')) as MigratedProfilesFixture;
    expect(profiles.profiles.equal.secret).toBe('');
    expect(profiles.profiles.conflict.secret).toBe('file-secret');
    expect(backend.values.get('cluster:conflict')).toEqual(Buffer.from('{"id":"store-key","secret":"store-secret"}'));
  });
});

describe('verified Windows agent and entitlement migration', () => {
  it('copies an agent envelope byte-for-byte and deletes the legacy file only after read-back', () => {
    const home = temporaryDirectory('agent-migration');
    const directory = path.join(home, 'agent');
    fs.mkdirSync(directory);
    const file = path.join(directory, 'anthropic-cred');
    const envelope = Buffer.from('{"kind":"oauth","value":"line one\\nline two"}');
    fs.writeFileSync(file, envelope);
    const backend = new MemoryBackend();

    const canonical = __testing.migrateWindowsAgent('anthropic', backend, home);
    expect(canonical).toEqual(envelope);
    expect(backend.values.get('agent:anthropic')).toEqual(envelope);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('imports a validated entitlement key with existing-key-wins conflict preservation', () => {
    const home = temporaryDirectory('entitlement-key-migration');
    const file = path.join(home, 'device-entitlement-key.json');
    const legacy = `ed25519:${Buffer.alloc(32, 7).toString('base64url')}`;
    fs.writeFileSync(file, JSON.stringify({ privateKey: legacy }));
    let canonical: Buffer | undefined;
    const backend = {
      getOrCreateEntitlementKey(candidate?: Buffer): Buffer {
        canonical ??= candidate && Buffer.from(candidate);
        if (!canonical) throw new Error('expected a migration candidate');
        return Buffer.from(canonical);
      },
    };

    expect(__testing.migrateWindowsEntitlementKey(home, backend)).toEqual(Buffer.from(legacy));
    expect(fs.existsSync(file)).toBe(false);

    const conflictHome = temporaryDirectory('entitlement-key-conflict');
    const conflictFile = path.join(conflictHome, 'device-entitlement-key.json');
    fs.writeFileSync(conflictFile, JSON.stringify({ privateKey: legacy }));
    const other = Buffer.from(`ed25519:${Buffer.alloc(32, 8).toString('base64url')}`);
    expect(() =>
      __testing.migrateWindowsEntitlementKey(conflictHome, {
        getOrCreateEntitlementKey: () => other,
      })
    ).toThrow(/conflicts/);
    expect(fs.existsSync(conflictFile)).toBe(true);
  });

  it('validates and verifies a legacy entitlement anchor before scrubbing it', () => {
    const home = temporaryDirectory('entitlement-anchor-migration');
    const file = path.join(home, 'device-entitlement-anchor.json');
    const anchor = { sequence: 4, headHash: `sha256:${'a'.repeat(64)}` };
    fs.writeFileSync(file, `${JSON.stringify(anchor)}\n`);
    const backend = new MemoryBackend();

    expect(__testing.migrateWindowsEntitlementAnchor(home, backend)).toEqual(anchor);
    expect(JSON.parse(backend.values.get('entitlement-anchor:')!.toString('utf8'))).toEqual(anchor);
    expect(fs.existsSync(file)).toBe(false);

    const conflictHome = temporaryDirectory('entitlement-anchor-conflict');
    const conflictFile = path.join(conflictHome, 'device-entitlement-anchor.json');
    fs.writeFileSync(conflictFile, JSON.stringify(anchor));
    const conflictBackend = new MemoryBackend();
    const existing = { sequence: 5, headHash: `sha256:${'b'.repeat(64)}` };
    conflictBackend.values.set('entitlement-anchor:', Buffer.from(JSON.stringify(existing)));
    expect(() => __testing.migrateWindowsEntitlementAnchor(conflictHome, conflictBackend)).toThrow(/conflicts/);
    expect(fs.existsSync(conflictFile)).toBe(true);
    expect(JSON.parse(conflictBackend.values.get('entitlement-anchor:')!.toString('utf8'))).toEqual(existing);
  });
});

describe('Windows helper fail-closed behavior', () => {
  it('treats a missing sibling helper as a hard credential error', () => {
    const missing = path.join(temporaryDirectory('missing-helper'), 'appliance-credhelper.exe');
    const backend = new __testing.WindowsBackend(missing);
    expect(() => backend.get({ kind: 'agent', identifier: 'anthropic' })).toThrowError(CredentialStoreError);
    try {
      backend.get({ kind: 'agent', identifier: 'anthropic' });
    } catch (error) {
      expect((error as CredentialStoreError).state).toBe('helper-missing');
    }
  });
});
