import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ensurePrivateDirectory, restrictWindowsAcl } from './fs-acl.js';
import {
  CREDENTIAL_STORE_SCHEMA,
  deleteProfileCredential,
  migrateWindowsCredentialFiles,
  persistProfileCredential,
} from './credential-store.js';
import { withProfilesLock as withProfilesFileLock } from './profiles-lock.js';

export { restrictWindowsAcl } from './fs-acl.js';

// Unified credentials store shared between the desktop and the CLI.
//
// Layout at ~/.appliance/profiles.json (mode 0600):
//   {
//     "version": 1,
//     "activeProfile": "local-runtime",
//     "profiles": {
//       "local-runtime": { "apiUrl": ..., "keyId": ..., "secret": ..., ... },
//       "prod":          { "apiUrl": ..., "keyId": ..., "secret": ..., ... }
//     }
//   }
//
// Backwards compatibility:
//   * If profiles.json is absent but the legacy ~/.appliance/credentials.json
//     exists, it is folded in as a single profile named "default".
//   * Every write to the active profile is mirrored to credentials.json so
//     that downgrading to a pre-multi-profile CLI does not lose access.
//   * The desktop's Rust side dual-writes to its own legacy location (the
//     <app-config>/config.json + macOS keychain) so a desktop downgrade is
//     similarly non-destructive.

export interface Profile {
  apiUrl: string;
  keyId: string;
  secret: string;
  /** ISO timestamp. Set on first save; not currently rewritten on updates. */
  createdAt?: string;
  /** Pulumi state backend URL for clusters bootstrapped from this device. */
  stateBackendUrl?: string | null;
  /** Original BootstrapInput, so Settings can re-run phase 1. Opaque to the CLI. */
  lastBootstrapInput?: unknown;
  /** Informational: which surface created the profile. */
  managed?: 'desktop' | 'cli';
  /** Server/profile generation marker for CloudFormation-owned installs. */
  installGeneration?: 'cloudformation-v1';
  /** CloudFormation stack that owns this profile's substrate. */
  cloudFormationStackName?: string;
  awsAccountId?: string;
  awsRegion?: string;
}

export interface ProfilesFile {
  version: 1;
  activeProfile: string | null;
  profiles: Record<string, Profile>;
  /** Non-secret migration hint only. Store/file reconciliation never trusts it. */
  credentialStore?: {
    schema: typeof CREDENTIAL_STORE_SCHEMA;
    profiles?: Record<string, 'migrated' | 'conflict' | 'missing'>;
  };
}

interface LegacyCredentials {
  apiUrl: string;
  keyId: string;
  secret: string;
}

const APPLIANCE_DIR = path.join(os.homedir(), '.appliance');
const PROFILES_PATH = path.join(APPLIANCE_DIR, 'profiles.json');
const LEGACY_PATH = path.join(APPLIANCE_DIR, 'credentials.json');
const LOCK_PATH = path.join(APPLIANCE_DIR, 'profiles.json.lock');

/** Default profile name used when migrating a legacy single-credentials file. */
export const DEFAULT_PROFILE_NAME = 'default';

function ensureDir(): void {
  ensurePrivateDirectory(APPLIANCE_DIR);
}

/**
 * Run `fn` while holding a cross-process advisory lock on profiles.json,
 * so a CLI read-modify-write (e.g. `appliance keys rotate`) can't
 * interleave with another `appliance` process's RMW and lose a write.
 *
 * Implemented as an O_EXCL lockfile (the portable primitive Node exposes
 * without a native flock binding): create-exclusive wins the lock; on
 * contention the shared helper retries, steals a stale lock (crashed holder),
 * and eventually proceeds unlocked rather than block the user.
 *
 * SCOPE: this serializes CLI profile RMWs and the nested Windows credential
 * migration. The helper is module-reentrant so lock order stays
 * profiles.json → credential-store without self-deadlocking.
 */
function withProfilesLock<T>(fn: () => T): T {
  return withProfilesFileLock(LOCK_PATH, fn);
}

function readJson<T>(p: string): T | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function migrateFromLegacy(legacy: LegacyCredentials): ProfilesFile {
  return {
    version: 1,
    activeProfile: DEFAULT_PROFILE_NAME,
    profiles: {
      [DEFAULT_PROFILE_NAME]: {
        apiUrl: legacy.apiUrl,
        keyId: legacy.keyId,
        secret: legacy.secret,
        managed: 'cli',
      },
    },
  };
}

/**
 * Read the profiles file. Reads ~/.appliance/profiles.json when present;
 * otherwise falls back to the legacy credentials.json (folded in as the
 * "default" profile). Returns an empty store when neither file exists.
 */
export function readProfiles(options: { migrateCredentials?: boolean } = {}): ProfilesFile {
  if (options.migrateCredentials !== false) {
    migrateWindowsCredentialFiles({
      home: APPLIANCE_DIR,
      profilesFile: PROFILES_PATH,
      legacyCredentialsFile: LEGACY_PATH,
    });
  }
  const parsed = readJson<ProfilesFile>(PROFILES_PATH);
  if (parsed && parsed.profiles) {
    return parsed;
  }
  const legacy = readJson<LegacyCredentials>(LEGACY_PATH);
  if (legacy && legacy.apiUrl && legacy.keyId && legacy.secret) {
    return migrateFromLegacy(legacy);
  }
  return { version: 1, activeProfile: null, profiles: {} };
}

function atomicWriteJson(p: string, value: unknown, mode: number): void {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  try {
    restrictWindowsAcl(tmp);
  } catch (cause) {
    fs.rmSync(tmp, { force: true });
    throw cause;
  }
  fs.renameSync(tmp, p);
}

/**
 * Write the profiles file and mirror the active profile (if any) to the
 * legacy credentials.json so the pre-multi-profile CLI keeps reading the
 * same set after a downgrade.
 */
export function writeProfiles(file: ProfilesFile): void {
  ensureDir();
  atomicWriteJson(PROFILES_PATH, file, 0o600);

  const active = file.activeProfile ? file.profiles[file.activeProfile] : undefined;
  if (active) {
    const legacy: LegacyCredentials = {
      apiUrl: active.apiUrl,
      keyId: active.keyId,
      secret: active.secret,
    };
    atomicWriteJson(LEGACY_PATH, legacy, 0o600);
  } else if (fs.existsSync(LEGACY_PATH)) {
    // No active profile any more — clear the legacy file so a downgraded
    // CLI doesn't keep using stale creds. Best-effort.
    try {
      fs.unlinkSync(LEGACY_PATH);
    } catch {
      // ignore
    }
  }
}

export interface ResolveOptions {
  /** Explicit profile name override (e.g. from a CLI --profile flag). */
  override?: string;
}

export interface ResolvedProfile {
  name: string;
  profile: Profile;
}

/**
 * Pick which profile applies. Precedence: override > APPLIANCE_PROFILE env > activeProfile.
 * Returns null when the resolved name doesn't match an existing profile, or
 * when the store is empty and no override is provided.
 */
export function resolveProfile(file: ProfilesFile, opts: ResolveOptions = {}): ResolvedProfile | null {
  const name = opts.override ?? process.env.APPLIANCE_PROFILE ?? file.activeProfile ?? null;
  if (!name) return null;
  const profile = file.profiles[name];
  if (!profile) return null;
  return { name, profile };
}

/**
 * Upsert a profile and (optionally) make it active. The legacy credentials.json
 * is updated if the saved profile is now active.
 */
export function upsertProfile(
  name: string,
  profile: Profile,
  opts: { makeActive?: boolean } = {}
): { credentialWriteFailed: boolean } {
  return withProfilesLock(() => {
    const file = readProfiles();
    const existing = file.profiles[name];
    const merged: Profile = {
      ...existing,
      ...profile,
      createdAt: existing?.createdAt ?? profile.createdAt ?? new Date().toISOString(),
    };
    const persisted = persistProfileCredential(name, merged);
    file.profiles[name] = persisted.profile;
    if (opts.makeActive || file.activeProfile === null) {
      file.activeProfile = name;
    }
    writeProfiles(file);
    return { credentialWriteFailed: persisted.credentialWriteFailed };
  });
}

/**
 * Remove a profile. If it was active, falls back to the first remaining
 * profile (or null when the store is now empty).
 */
export function removeProfile(name: string): boolean {
  return withProfilesLock(() => {
    const file = readProfiles();
    const profile = file.profiles[name];
    if (!profile) return false;
    deleteProfileCredential(name, profile);
    delete file.profiles[name];
    if (file.activeProfile === name) {
      const next = Object.keys(file.profiles)[0] ?? null;
      file.activeProfile = next;
    }
    writeProfiles(file);
    return true;
  });
}

/** Switch the active profile. Returns false if the name doesn't exist. */
export function setActiveProfile(name: string): boolean {
  return withProfilesLock(() => {
    const file = readProfiles();
    if (!file.profiles[name]) return false;
    file.activeProfile = name;
    writeProfiles(file);
    return true;
  });
}

export const PROFILES_FILE = PROFILES_PATH;
export const LEGACY_CREDENTIALS_FILE = LEGACY_PATH;
