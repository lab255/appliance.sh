import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Profile } from './profile-store.js';
import { keyIdForPublicKey, type DevSigningKey } from './bundle-sign.js';

// Keychain-first credential resolution (E4.4).
//
// OWNER DECISION: on macOS the OS Keychain is the canonical store for a
// desktop-managed cluster's API-key SECRET; ~/.appliance/profiles.json
// keeps only the (non-secret) metadata — apiUrl, keyId, name. On every
// other platform profiles.json (mode 0600) stays canonical, since the
// CLI cannot read libsecret/DPAPI and the desktop dual-writes the secret
// to the file there.
//
// This module mirrors how the desktop names its Keychain entries
// (packages/desktop/src-tauri/src/lib.rs):
//   service  = "sh.appliance.desktop"   (KEYCHAIN_SERVICE there)
//   account  = "cluster:<id>"           (cluster_keychain_account())
//   password = JSON {"id","secret"}     (a serialized ApiKey)
// For a desktop-managed profile the profiles.json map key IS the desktop
// cluster id, so the account is `cluster:<name>`.
//
// SECURITY: never log the secret. The read path passes nothing sensitive
// on argv; the (rare) write path does — see writeKeychainApiKey.
export const KEYCHAIN_SERVICE = 'sh.appliance.desktop';
export const DEVICE_KEYCHAIN_ACCOUNT = 'device:entitlements:v1';
export const ENTITLEMENT_ANCHOR_KEYCHAIN_ACCOUNT = 'device:entitlements-anchor:v1';

const SECURITY_BIN = '/usr/bin/security';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface KeychainApiKey {
  keyId: string;
  secret: string;
}

export interface DeviceKeyOptions {
  /** Appliance home, primarily for isolated tests. Defaults to ~/.appliance. */
  home?: string;
  /** Tests and non-desktop embedders can force the owner-only file adapter. */
  forceFile?: boolean;
}

export interface EntitlementAnchor {
  sequence: number;
  headHash: `sha256:${string}`;
}

/**
 * Resolve the per-device Ed25519 entitlement key. macOS uses a generic
 * password Keychain item; Linux/Windows use an owner-only file beside the
 * entitlement store. This is tamper-evidence for the same OS user, not proof
 * of consent or a non-exportable hardware key.
 */
export function getOrCreateDeviceSigningKey(options: DeviceKeyOptions = {}): DevSigningKey {
  const home = options.home ?? path.join(os.homedir(), '.appliance');
  const defaultHome = path.resolve(home) === path.resolve(path.join(os.homedir(), '.appliance'));
  if (isMacOS() && defaultHome && !options.forceFile) {
    const existing = probeDeviceKeychainSeed();
    if (existing.state === 'present') return deviceSigningKeyFromWire(existing.seed);
    if (existing.state === 'unreadable') {
      throw new Error(
        'The device entitlement key exists but macOS Keychain did not allow it to be read. No entitlement was changed.'
      );
    }
    const created = createDeviceSigningKey();
    const stored = writeDeviceKeychainSeed(privateKeyWire(created.privateKey));
    if (stored.state === 'unreadable') {
      throw new Error('The device entitlement key could not be stored in macOS Keychain. No entitlement was changed.');
    }
    if (stored.state === 'missing') {
      throw new Error('The device entitlement key disappeared during creation. No entitlement was changed.');
    }
    // A concurrent first run may have won the add. Always use the value that
    // is now canonical in Keychain rather than the key generated locally.
    return deviceSigningKeyFromWire(stored.seed);
  }
  return getOrCreateFileDeviceKey(home);
}

function getOrCreateFileDeviceKey(home: string): DevSigningKey {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const file = path.join(home, 'device-entitlement-key.json');
  if (fs.existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error('The device entitlement key file is unreadable. No entitlement was changed.');
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { privateKey?: unknown }).privateKey !== 'string') {
      throw new Error('The device entitlement key file is invalid. No entitlement was changed.');
    }
    fs.chmodSync(file, 0o600);
    return deviceSigningKeyFromWire((parsed as { privateKey: string }).privateKey);
  }
  const created = createDeviceSigningKey();
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ privateKey: privateKeyWire(created.privateKey) })}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  fs.chmodSync(temporary, 0o600);
  try {
    // link is the no-overwrite commit: concurrent first users cannot replace
    // a key another process already used to sign the initial store.
    fs.linkSync(temporary, file);
    fs.unlinkSync(temporary);
  } catch (cause) {
    fs.rmSync(temporary, { force: true });
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST' || fs.existsSync(file)) {
      return getOrCreateFileDeviceKey(home);
    }
    throw cause;
  }
  fs.chmodSync(file, 0o600);
  return created;
}

type DeviceKeyProbe = { state: 'present'; seed: string } | { state: 'missing' } | { state: 'unreadable' };

function probeDeviceKeychainSeed(): DeviceKeyProbe {
  try {
    const value = execFileSync(
      SECURITY_BIN,
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', DEVICE_KEYCHAIN_ACCOUNT, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return value.startsWith('ed25519:') ? { state: 'present', seed: value } : { state: 'unreadable' };
  } catch (cause) {
    return classifySecurityExit((cause as { status?: number | null }).status) === 'missing'
      ? { state: 'missing' }
      : { state: 'unreadable' };
  }
}

function writeDeviceKeychainSeed(seed: string): DeviceKeyProbe {
  try {
    // `security add-generic-password` has no password-from-stdin form (`-w -`
    // stores a literal dash), so the seed must remain on argv for this call.
    // Deliberately omit -U: a concurrent first-run key must never be replaced.
    execFileSync(
      SECURITY_BIN,
      ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', DEVICE_KEYCHAIN_ACCOUNT, '-w', seed],
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );
    return { state: 'present', seed };
  } catch {
    // Duplicate-item and first-run races are resolved by re-reading. An
    // existing value wins; no update/overwrite path exists here.
    return probeDeviceKeychainSeed();
  }
}

export function entitlementAnchorFile(home: string): string {
  return path.join(home, 'device-entitlement-anchor.json');
}

export function readEntitlementAnchor(options: DeviceKeyOptions = {}): EntitlementAnchor | null {
  const home = options.home ?? path.join(os.homedir(), '.appliance');
  const defaultHome = path.resolve(home) === path.resolve(path.join(os.homedir(), '.appliance'));
  if (isMacOS() && defaultHome && !options.forceFile) {
    try {
      const value = execFileSync(
        SECURITY_BIN,
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', ENTITLEMENT_ANCHOR_KEYCHAIN_ACCOUNT, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      return parseEntitlementAnchor(value);
    } catch (cause) {
      if (classifySecurityExit((cause as { status?: number | null }).status) === 'missing') return null;
      throw new Error('The entitlement rollback anchor exists but macOS Keychain did not allow it to be read.');
    }
  }
  const file = entitlementAnchorFile(home);
  try {
    const anchor = parseEntitlementAnchor(fs.readFileSync(file, 'utf8'));
    fs.chmodSync(file, 0o600);
    return anchor;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('The entitlement rollback anchor file is unreadable or invalid.');
  }
}

export function writeEntitlementAnchor(anchor: EntitlementAnchor, options: DeviceKeyOptions = {}): void {
  const valid = parseEntitlementAnchor(JSON.stringify(anchor));
  const home = options.home ?? path.join(os.homedir(), '.appliance');
  const defaultHome = path.resolve(home) === path.resolve(path.join(os.homedir(), '.appliance'));
  if (isMacOS() && defaultHome && !options.forceFile) {
    try {
      // The anchor is not secret. -U is required here because it is monotonic
      // state that advances after every entitlement mutation.
      execFileSync(
        SECURITY_BIN,
        [
          'add-generic-password',
          '-U',
          '-s',
          KEYCHAIN_SERVICE,
          '-a',
          ENTITLEMENT_ANCHOR_KEYCHAIN_ACCOUNT,
          '-w',
          JSON.stringify(valid),
        ],
        { stdio: ['ignore', 'ignore', 'ignore'] }
      );
      return;
    } catch {
      throw new Error('The entitlement rollback anchor could not be stored in macOS Keychain. No entitlement changed.');
    }
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const file = entitlementAnchorFile(home);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(valid)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function parseEntitlementAnchor(value: string): EntitlementAnchor {
  const parsed = JSON.parse(value) as Partial<EntitlementAnchor>;
  if (
    !parsed ||
    !Number.isSafeInteger(parsed.sequence) ||
    parsed.sequence! < 1 ||
    typeof parsed.headHash !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(parsed.headHash)
  ) {
    throw new Error('Invalid entitlement rollback anchor.');
  }
  return parsed as EntitlementAnchor;
}

function createDeviceSigningKey(): DevSigningKey {
  return deviceSigningKeyFromPrivateKey(generateKeyPairSync('ed25519').privateKey);
}

function deviceSigningKeyFromWire(wire: string): DevSigningKey {
  if (!wire.startsWith('ed25519:')) throw new Error('Device private key is malformed.');
  const seed = Buffer.from(wire.slice('ed25519:'.length), 'base64url');
  if (seed.length !== 32 || seed.toString('base64url') !== wire.slice('ed25519:'.length)) {
    throw new Error('Device private key is malformed.');
  }
  return deviceSigningKeyFromPrivateKey(
    createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  );
}

function deviceSigningKeyFromPrivateKey(privateKey: KeyObject): DevSigningKey {
  const publicKey = createPublicKey(privateKey);
  const exported = publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(exported) || !exported.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new Error('Device key is not a supported Ed25519 key.');
  }
  const raw = exported.subarray(ED25519_SPKI_PREFIX.length);
  return {
    privateKey,
    publicKey,
    publicKeyWire: `ed25519:${raw.toString('base64url')}`,
    keyId: keyIdForPublicKey(raw),
  };
}

function privateKeyWire(privateKey: KeyObject): string {
  const exported = privateKey.export({ format: 'der', type: 'pkcs8' });
  if (!Buffer.isBuffer(exported) || !exported.subarray(0, ED25519_PKCS8_PREFIX.length).equals(ED25519_PKCS8_PREFIX)) {
    throw new Error('Device key is not a supported Ed25519 key.');
  }
  const seed = exported.subarray(ED25519_PKCS8_PREFIX.length);
  if (seed.length !== 32) throw new Error('Device key is not a supported Ed25519 key.');
  return `ed25519:${seed.toString('base64url')}`;
}

function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/**
 * The Keychain account that backs a profile's secret, or null when the
 * secret is NOT Keychain-backed: non-macOS, or a CLI-managed profile
 * (login / bootstrap / microVM) whose secret lives in profiles.json.
 */
export function keychainAccountFor(name: string, profile: Pick<Profile, 'managed'>): string | null {
  if (!isMacOS()) return null;
  if (profile.managed !== 'desktop') return null;
  return `cluster:${name}`;
}

/**
 * Parse the raw password payload a desktop-written Keychain entry stores
 * (a serialized ApiKey, `{"id","secret"}`). Pure and unit-testable: trims,
 * JSON-parses, and guards that both fields are non-empty strings. Returns
 * null on any malformed / empty / non-string payload so callers fall back
 * to the profiles.json copy. Never logs the secret.
 */
export function parseKeychainPayload(out: string): KeychainApiKey | null {
  const trimmed = out.trim();
  if (!trimmed) return null;
  let parsed: { id?: unknown; secret?: unknown };
  try {
    parsed = JSON.parse(trimmed) as { id?: unknown; secret?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.id !== 'string' || typeof parsed.secret !== 'string') return null;
  if (parsed.id.length === 0 || parsed.secret.length === 0) return null;
  return { keyId: parsed.id, secret: parsed.secret };
}

/**
 * Classify a failed `security find-generic-password` by exit code (pure,
 * unit-tested): 44 is errSecItemNotFound — the item genuinely does not
 * exist. ANY other failure (36 errSecAuthFailed, ACL denial on a
 * dev-signed binary, missing binary → no status at all) means macOS
 * refused to answer, so the item's existence is UNKNOWN. The doctor
 * must never report a denied read as a missing secret.
 */
export function classifySecurityExit(status: number | null | undefined): 'missing' | 'unreadable' {
  return status === 44 ? 'missing' : 'unreadable';
}

export type KeychainProbeResult =
  | { state: 'present'; key: KeychainApiKey }
  | { state: 'missing' }
  | { state: 'unreadable' };

/**
 * Probe variant of readKeychainApiKey for `appliance doctor`: where the
 * read path folds every failure into null (fall back to the file), the
 * doctor needs "the entry does not exist" (exit 44) kept distinct from
 * "macOS denied the read" (anything else). A present-but-unparseable
 * payload also reports 'unreadable' — the entry EXISTS, so it must not
 * be diagnosed as missing. Never logs the secret.
 */
export function probeKeychainApiKey(account: string): KeychainProbeResult {
  if (!isMacOS()) return { state: 'missing' };
  let out: string;
  try {
    out = execFileSync(SECURITY_BIN, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    return { state: classifySecurityExit((err as { status?: number | null }).status) };
  }
  const key = parseKeychainPayload(out);
  return key ? { state: 'present', key } : { state: 'unreadable' };
}

/**
 * Read a desktop-written Keychain entry, avoiding a GUI prompt where
 * possible. Uses `security find-generic-password -w`, which prints the
 * stored password (the JSON ApiKey) to stdout. A cross-binary read of an
 * item the desktop created can trigger a one-time macOS access prompt the
 * first time; "Always Allow" suppresses it thereafter (this is the
 * macOS ACL behaviour, not something the CLI can opt out of). Returns
 * null on any miss / parse / permission failure so callers fall back to
 * the profiles.json copy (the doctor uses probeKeychainApiKey when it
 * needs the failure mode). Never logs the secret.
 */
export function readKeychainApiKey(account: string): KeychainApiKey | null {
  const probe = probeKeychainApiKey(account);
  return probe.state === 'present' ? probe.key : null;
}

/**
 * Create-or-update a desktop Keychain entry from the CLI (e.g. after
 * `appliance keys rotate` on a desktop-managed cluster) so the canonical
 * macOS store stays fresh. `-U` upserts. Best-effort: returns false on
 * any failure, and the caller then keeps the secret in profiles.json so
 * the user isn't stranded.
 *
 * SECURITY: `security` has no stdin password option for add-generic-
 * password, so the secret is passed via argv and is briefly visible to
 * `ps` for the duration of the exec. This is the only place the CLI puts
 * a secret on a command line; it is gated to the rare desktop-managed
 * rotate path. Flagged for security review in docs/control-plane.md §5.
 * Never logs the secret.
 */
export function writeKeychainApiKey(account: string, key: KeychainApiKey): boolean {
  if (!isMacOS()) return false;
  try {
    const payload = JSON.stringify({ id: key.keyId, secret: key.secret });
    execFileSync(SECURITY_BIN, ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', payload], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a desktop Keychain entry from the CLI — used by `appliance
 * doctor`'s orphan-profile cleanup so a removed cluster doesn't leave a
 * dangling secret behind. Best-effort: returns false on any failure
 * (missing item included); nothing sensitive rides argv. Never logs
 * the secret.
 */
export function deleteKeychainApiKey(account: string): boolean {
  if (!isMacOS()) return false;
  try {
    execFileSync(SECURITY_BIN, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure credential-source choice (unit-testable; mirrors the desktop's
 * pure `decide_seed`). Given the profile's file copy and what the
 * Keychain returned (or null), pick the authoritative {keyId, secret}:
 *
 *   - no Keychain entry      -> file copy (non-macOS, CLI-managed, or a
 *                               Keychain miss/declined access).
 *   - file copy is FRESHER   -> file copy. Detected by a non-empty file
 *                               secret whose keyId differs from the
 *                               Keychain's: a CLI write (rotate) that
 *                               could not reach the Keychain. The keyId is
 *                               the version marker, so this self-heals a
 *                               degraded write without serving a stale key.
 *   - otherwise              -> Keychain (canonical on macOS).
 */
export function chooseCredential(
  profile: Pick<Profile, 'keyId' | 'secret'>,
  keychainKey: KeychainApiKey | null
): { keyId: string; secret: string } {
  if (!keychainKey) {
    return { keyId: profile.keyId, secret: profile.secret };
  }
  if (profile.secret.length > 0 && profile.keyId !== keychainKey.keyId) {
    return { keyId: profile.keyId, secret: profile.secret };
  }
  return { keyId: keychainKey.keyId, secret: keychainKey.secret };
}

/**
 * Resolve a profile's credential Keychain-first on macOS (desktop-managed
 * clusters), file-only elsewhere. The IO wrapper over chooseCredential.
 */
export function resolveProfileSecret(
  name: string,
  profile: Pick<Profile, 'managed' | 'keyId' | 'secret'>
): { keyId: string; secret: string } {
  const account = keychainAccountFor(name, profile);
  const keychainKey = account ? readKeychainApiKey(account) : null;
  return chooseCredential(profile, keychainKey);
}
