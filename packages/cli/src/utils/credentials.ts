// Thin compatibility shim over the unified profile store. Existing
// callers (`appliance init` / `appliance deploy` / etc.) continue to
// use loadCredentials() / saveCredentials() unchanged — profile
// selection happens transparently via the override-passing helpers
// below + the APPLIANCE_PROFILE env var.

import {
  DEFAULT_PROFILE_NAME,
  type Profile,
  readProfiles,
  removeProfile as removeProfileFromStore,
  resolveProfile,
  upsertProfile,
} from './profile-store.js';
import { resolveProfileSecret } from './credential-store.js';

export interface Credentials {
  apiUrl: string;
  keyId: string;
  secret: string;
}

// Process-wide override set by the root command's `--profile` option.
// Set once on startup so individual commands don't need to thread it
// through every call site.
let activeProfileOverride: string | undefined;

export function setActiveProfileOverride(name: string | undefined): void {
  activeProfileOverride = name && name.length > 0 ? name : undefined;
}

export function getActiveProfileOverride(): string | undefined {
  return activeProfileOverride;
}

/**
 * Load the active profile's credentials. Picks the profile via:
 *   1. --profile flag (setActiveProfileOverride())
 *   2. APPLIANCE_PROFILE env var
 *   3. activeProfile in ~/.appliance/profiles.json
 *   4. Legacy ~/.appliance/credentials.json (auto-migrated as "default")
 *
 * APPLIANCE_API_URL still overrides apiUrl on the resolved profile so
 * pre-existing scripts that pin the URL via env keep working.
 *
 * The secret comes from the central typed store: Credential Manager for every
 * Windows profile, Keychain for macOS desktop-managed profiles, and the
 * owner-only profile file elsewhere.
 */
export function loadCredentials(): Credentials | null {
  const file = readProfiles();
  const resolved = resolveProfile(file, { override: activeProfileOverride });
  if (!resolved) return null;
  const { name, profile } = resolved;
  const apiUrl = process.env.APPLIANCE_API_URL ?? profile.apiUrl;
  const { keyId, secret } = resolveProfileSecret(name, profile);
  return { apiUrl, keyId, secret };
}

/**
 * Save credentials. Writes to the named profile (or the resolved-active
 * profile when no name is provided, defaulting to "default" on a fresh
 * install). The legacy credentials.json file is mirrored automatically
 * by the profile store.
 */
export function saveCredentials(credentials: Credentials, profileName?: string): void {
  const file = readProfiles();
  const targetName =
    profileName ?? activeProfileOverride ?? process.env.APPLIANCE_PROFILE ?? file.activeProfile ?? DEFAULT_PROFILE_NAME;
  const next: Profile = {
    apiUrl: credentials.apiUrl,
    keyId: credentials.keyId,
    secret: credentials.secret,
    managed: 'cli',
  };
  upsertProfile(targetName, next, { makeActive: true });
}

/**
 * Remove the currently-resolved profile (CLI-side equivalent of "logout").
 * Returns false if no profile is active.
 */
export function clearCredentials(): boolean {
  const file = readProfiles();
  const resolved = resolveProfile(file, { override: activeProfileOverride });
  if (!resolved) return false;
  return removeProfileFromStore(resolved.name);
}
