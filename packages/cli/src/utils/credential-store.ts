import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeCredentialIdentifier, resolveCredHelperPath } from '@appliance.sh/helper';
import { keyIdForPublicKey, type DevSigningKey } from './bundle-sign.js';
import { ensurePrivateDirectory, restrictWindowsAcl } from './fs-acl.js';
import type { Profile } from './profile-store.js';

export const KEYCHAIN_SERVICE = 'sh.appliance.desktop';
export const AGENT_KEYCHAIN_SERVICE = 'sh.appliance.agent';
export const DEVICE_KEYCHAIN_ACCOUNT = 'device:entitlements:v1';
export const ENTITLEMENT_ANCHOR_KEYCHAIN_ACCOUNT = 'device:entitlements-anchor:v1';
export const CREDENTIAL_STORE_SCHEMA = 'appliance.credential-store/v1' as const;

const SECURITY_BIN = '/usr/bin/security';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;

export type CredentialErrorState = 'denied' | 'malformed' | 'invalid-identifier' | 'internal' | 'helper-missing';

export class CredentialStoreError extends Error {
  constructor(
    public readonly state: CredentialErrorState,
    message: string,
    _cause?: unknown
  ) {
    super(message);
    this.name = 'CredentialStoreError';
  }
}

type StoreTarget =
  | { kind: 'cluster'; identifier: string }
  | { kind: 'agent'; identifier: string }
  | { kind: 'entitlement-key' }
  | { kind: 'entitlement-anchor' };

interface CredentialBackend {
  get(target: StoreTarget): Buffer | null;
  put(target: StoreTarget, value: Buffer): void;
  delete(target: StoreTarget): void;
  importEntitlementAnchor?(candidate: Buffer): Buffer;
}

export interface CredentialStoreOptions {
  platform?: NodeJS.Platform;
  home?: string;
  forceFile?: boolean;
  helperPath?: string;
}

type BackendOptions = CredentialStoreOptions;

function applianceHome(): string {
  return path.join(os.homedir(), '.appliance');
}

function targetServiceAndAccount(target: StoreTarget): [string, string] {
  switch (target.kind) {
    case 'cluster':
      return [KEYCHAIN_SERVICE, `cluster:${target.identifier}`];
    case 'agent':
      return [AGENT_KEYCHAIN_SERVICE, target.identifier];
    case 'entitlement-key':
      return [KEYCHAIN_SERVICE, DEVICE_KEYCHAIN_ACCOUNT];
    case 'entitlement-anchor':
      return [KEYCHAIN_SERVICE, ENTITLEMENT_ANCHOR_KEYCHAIN_ACCOUNT];
  }
}

/** `security -w` appends one line ending; remove only that transport byte. */
function securityValue(stdout: Buffer): Buffer {
  if (stdout.length > 0 && stdout[stdout.length - 1] === 0x0a) {
    const end = stdout.length > 1 && stdout[stdout.length - 2] === 0x0d ? stdout.length - 2 : stdout.length - 1;
    return stdout.subarray(0, end);
  }
  return stdout;
}

class MacOSBackend implements CredentialBackend {
  get(target: StoreTarget): Buffer | null {
    const [service, account] = targetServiceAndAccount(target);
    try {
      const output = execFileSync(SECURITY_BIN, ['find-generic-password', '-s', service, '-a', account, '-w'], {
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return securityValue(output);
    } catch (cause) {
      if (classifySecurityExit((cause as { status?: number | null }).status) === 'missing') return null;
      throw new CredentialStoreError('denied', 'macOS Keychain did not allow the credential to be read.', { cause });
    }
  }

  put(target: StoreTarget, value: Buffer): void {
    const [service, account] = targetServiceAndAccount(target);
    try {
      // `security` has no password-from-stdin form. Preserve the established
      // macOS behavior: fixed argv, no shell, and `-U` for ordinary upserts.
      execFileSync(
        SECURITY_BIN,
        ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value.toString('utf8')],
        { stdio: ['ignore', 'ignore', 'ignore'] }
      );
    } catch (cause) {
      throw new CredentialStoreError('denied', 'macOS Keychain did not allow the credential to be stored.', { cause });
    }
  }

  putIfAbsent(target: StoreTarget, value: Buffer): Buffer {
    const [service, account] = targetServiceAndAccount(target);
    try {
      execFileSync(SECURITY_BIN, ['add-generic-password', '-s', service, '-a', account, '-w', value.toString('utf8')], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      // Duplicate item / first-run race: the existing value wins.
    }
    const canonical = this.get(target);
    if (!canonical) throw new CredentialStoreError('internal', 'The Keychain credential disappeared during creation.');
    return canonical;
  }

  delete(target: StoreTarget): void {
    const [service, account] = targetServiceAndAccount(target);
    try {
      execFileSync(SECURITY_BIN, ['delete-generic-password', '-s', service, '-a', account], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (cause) {
      if (classifySecurityExit((cause as { status?: number | null }).status) !== 'missing') {
        throw new CredentialStoreError('denied', 'macOS Keychain did not allow the credential to be deleted.', {
          cause,
        });
      }
    }
  }
}

const HELPER_EXIT = {
  missing: 3,
  denied: 4,
  malformed: 5,
  invalidIdentifier: 6,
} as const;

function helperArguments(target: StoreTarget, operation: 'get' | 'put' | 'delete' | 'probe'): string[] {
  switch (target.kind) {
    case 'cluster':
      return ['cluster', operation, '--profile', target.identifier];
    case 'agent':
      return ['agent', operation, '--provider', target.identifier];
    case 'entitlement-anchor':
      if (operation !== 'get' && operation !== 'put') {
        throw new CredentialStoreError('internal', `unsupported entitlement-anchor operation: ${operation}`);
      }
      return ['entitlement-anchor', operation];
    case 'entitlement-key':
      throw new CredentialStoreError('internal', `unsupported entitlement-key operation: ${operation}`);
  }
}

class WindowsBackend implements CredentialBackend {
  private readonly helperPath: string;

  constructor(helperPath?: string) {
    if (helperPath) {
      this.helperPath = helperPath;
      return;
    }
    try {
      this.helperPath = resolveCredHelperPath();
    } catch (cause) {
      throw new CredentialStoreError(
        'helper-missing',
        'Windows credential helper is unavailable outside the packaged CLI sibling layout.',
        cause
      );
    }
  }

  private run(args: string[], input?: Buffer, missingIsNull = false): Buffer | null {
    const result = spawnSync(this.helperPath, args, {
      input,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new CredentialStoreError(
          'helper-missing',
          `Windows credential helper is missing at its required sibling path: ${this.helperPath}`,
          { cause: result.error }
        );
      }
      throw new CredentialStoreError('internal', 'Windows credential helper could not be started.', {
        cause: result.error,
      });
    }
    if (result.status === 0) {
      // Buffer is returned exactly as the binary pipe produced it. In
      // particular, never decode and `.trim()` a credential value here.
      return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? []);
    }
    if (missingIsNull && result.status === HELPER_EXIT.missing) return null;
    const diagnostic = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : String(result.stderr ?? '').trim();
    const suffix = diagnostic ? `: ${diagnostic}` : '';
    if (result.status === HELPER_EXIT.denied) {
      throw new CredentialStoreError('denied', `Windows Credential Manager denied access${suffix}`);
    }
    if (result.status === HELPER_EXIT.malformed) {
      throw new CredentialStoreError('malformed', `Windows Credential Manager value is malformed${suffix}`);
    }
    if (result.status === HELPER_EXIT.invalidIdentifier) {
      throw new CredentialStoreError('invalid-identifier', `Credential identifier was rejected${suffix}`);
    }
    throw new CredentialStoreError('internal', `Windows credential helper failed (exit ${result.status})${suffix}`);
  }

  get(target: StoreTarget): Buffer | null {
    return this.run(helperArguments(target, 'get'), undefined, true);
  }

  put(target: StoreTarget, value: Buffer): void {
    this.run(helperArguments(target, 'put'), value);
  }

  delete(target: StoreTarget): void {
    this.run(helperArguments(target, 'delete'));
  }

  getOrCreateEntitlementKey(candidate?: Buffer): Buffer {
    const args = candidate ? ['entitlement-key', 'import'] : ['entitlement-key', 'get-or-create'];
    const value = this.run(args, candidate);
    if (!value) throw new CredentialStoreError('internal', 'Windows entitlement key helper returned no value.');
    return value;
  }

  importEntitlementAnchor(candidate: Buffer): Buffer {
    const value = this.run(['entitlement-anchor', 'import'], candidate);
    if (!value) throw new CredentialStoreError('internal', 'Windows entitlement anchor helper returned no value.');
    return value;
  }
}

class FileBackend implements CredentialBackend {
  constructor(private readonly home: string) {}

  private targetPath(target: StoreTarget): string {
    switch (target.kind) {
      case 'agent':
        return path.join(this.home, 'agent', `${target.identifier}-cred`);
      case 'entitlement-key':
        return path.join(this.home, 'device-entitlement-key.json');
      case 'entitlement-anchor':
        return entitlementAnchorFile(this.home);
      case 'cluster':
        throw new CredentialStoreError('internal', 'Cluster file values live in profiles.json metadata.');
    }
  }

  get(target: StoreTarget): Buffer | null {
    try {
      return fs.readFileSync(this.targetPath(target));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CredentialStoreError('denied', 'Owner-only credential file could not be read.', { cause });
    }
  }

  put(target: StoreTarget, value: Buffer): void {
    writeOwnerOnlyFile(this.targetPath(target), value);
  }

  delete(target: StoreTarget): void {
    try {
      fs.rmSync(this.targetPath(target), { force: true });
    } catch (cause) {
      throw new CredentialStoreError('denied', 'Owner-only credential file could not be deleted.', { cause });
    }
  }
}

function backendFor(options: BackendOptions = {}): CredentialBackend {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? applianceHome();
  const defaultHome = path.resolve(home) === path.resolve(applianceHome());
  if (options.forceFile || !defaultHome || (platform !== 'darwin' && platform !== 'win32')) {
    return new FileBackend(home);
  }
  if (platform === 'darwin') return new MacOSBackend();
  return new WindowsBackend(options.helperPath);
}

function encodedTarget(kind: 'cluster' | 'agent', value: string): StoreTarget {
  const identifier = encodeCredentialIdentifier(value);
  return { kind, identifier };
}

function writeOwnerOnlyFile(file: string, value: Buffer): void {
  const directory = path.dirname(file);
  ensurePrivateDirectory(directory);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.chmodSync(temporary, 0o600);
    restrictWindowsAcl(temporary);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    restrictWindowsAcl(file);
  } catch (cause) {
    fs.rmSync(temporary, { force: true });
    throw cause;
  }
}

export interface KeychainApiKey {
  keyId: string;
  secret: string;
}

function encodeClusterCredential(key: KeychainApiKey): Buffer {
  return Buffer.from(JSON.stringify({ id: key.keyId, secret: key.secret }), 'utf8');
}

export function parseKeychainPayload(raw: string | Buffer): KeychainApiKey | null {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw) as {
      id?: unknown;
      secret?: unknown;
    };
    if (typeof parsed.id !== 'string' || typeof parsed.secret !== 'string') return null;
    if (!parsed.id || !parsed.secret) return null;
    return { keyId: parsed.id, secret: parsed.secret };
  } catch {
    return null;
  }
}

export function classifySecurityExit(status: number | null | undefined): 'missing' | 'unreadable' {
  return status === 44 ? 'missing' : 'unreadable';
}

export function chooseCredential(
  profile: Pick<Profile, 'keyId' | 'secret'>,
  keychainKey: KeychainApiKey | null
): KeychainApiKey {
  if (!keychainKey) return { keyId: profile.keyId, secret: profile.secret };
  if (profile.secret.length > 0 && profile.keyId !== keychainKey.keyId) {
    return { keyId: profile.keyId, secret: profile.secret };
  }
  return keychainKey;
}

function clusterUsesOsStore(profile: Pick<Profile, 'managed'>, platform = process.platform): boolean {
  return platform === 'win32' || (platform === 'darwin' && profile.managed === 'desktop');
}

export function resolveProfileSecret(
  name: string,
  profile: Pick<Profile, 'managed' | 'keyId' | 'secret'>,
  options: BackendOptions = {}
): KeychainApiKey {
  const platform = options.platform ?? process.platform;
  if (!clusterUsesOsStore(profile, platform)) return { keyId: profile.keyId, secret: profile.secret };
  const backend = backendFor(options);
  let raw: Buffer | null;
  try {
    raw = backend.get(encodedTarget('cluster', name));
  } catch (cause) {
    if (platform === 'darwin') return { keyId: profile.keyId, secret: profile.secret };
    throw cause;
  }
  if (!raw) {
    // Windows must never fall back to a cleartext profile secret. Its lazy
    // migration runs before normal profile reads; a miss here is a hard,
    // unusable credential state. macOS retains its established fallback.
    return platform === 'win32'
      ? { keyId: profile.keyId, secret: '' }
      : { keyId: profile.keyId, secret: profile.secret };
  }
  const canonical = parseKeychainPayload(raw);
  if (!canonical) {
    if (platform === 'darwin') return { keyId: profile.keyId, secret: profile.secret };
    throw new CredentialStoreError('malformed', `Credential Manager entry for profile '${name}' is malformed.`);
  }
  return platform === 'darwin' ? chooseCredential(profile, canonical) : canonical;
}

export interface PersistProfileResult {
  profile: Profile;
  credentialWriteFailed: boolean;
}

export function persistProfileCredential(
  name: string,
  profile: Profile,
  options: BackendOptions = {}
): PersistProfileResult {
  const platform = options.platform ?? process.platform;
  if (!profile.secret || !clusterUsesOsStore(profile, platform)) {
    return { profile, credentialWriteFailed: false };
  }
  const backend = backendFor(options);
  const target = encodedTarget('cluster', name);
  const payload = encodeClusterCredential({ keyId: profile.keyId, secret: profile.secret });
  try {
    backend.put(target, payload);
    const verified = backend.get(target);
    if (!verified || !verified.equals(payload)) {
      throw new CredentialStoreError('internal', `Credential store verification failed for profile '${name}'.`);
    }
    return { profile: { ...profile, secret: '' }, credentialWriteFailed: false };
  } catch (cause) {
    if (platform === 'darwin') return { profile, credentialWriteFailed: true };
    throw cause;
  }
}

export function deleteProfileCredential(
  name: string,
  profile: Pick<Profile, 'managed'>,
  options: BackendOptions = {}
): void {
  const platform = options.platform ?? process.platform;
  if (!clusterUsesOsStore(profile, platform)) return;
  try {
    backendFor(options).delete(encodedTarget('cluster', name));
  } catch (cause) {
    if (platform !== 'darwin') throw cause;
  }
}

export type ProfileCredentialProbe =
  | { state: 'not-applicable' }
  | { state: 'missing' }
  | { state: 'denied' }
  | { state: 'malformed' }
  | { state: 'migrated'; keyId: string }
  | { state: 'conflict'; keyId: string };

export function probeProfileCredential(
  name: string,
  profile: Pick<Profile, 'managed' | 'keyId' | 'secret'>,
  options: BackendOptions = {}
): ProfileCredentialProbe {
  const platform = options.platform ?? process.platform;
  if (!clusterUsesOsStore(profile, platform)) return { state: 'not-applicable' };
  try {
    const raw = backendFor(options).get(encodedTarget('cluster', name));
    if (!raw) return { state: 'missing' };
    const key = parseKeychainPayload(raw);
    if (!key) return { state: 'malformed' };
    if (platform === 'win32' && profile.secret) {
      const legacy = encodeClusterCredential({ keyId: profile.keyId, secret: profile.secret });
      if (!legacy.equals(raw)) return { state: 'conflict', keyId: key.keyId };
    }
    return { state: 'migrated', keyId: key.keyId };
  } catch (cause) {
    if (cause instanceof CredentialStoreError && cause.state === 'malformed') return { state: 'malformed' };
    return { state: 'denied' };
  }
}

export type AgentCredentialKind = 'api-key' | 'oauth' | 'pat';
export interface StoredAgentCredential {
  kind: AgentCredentialKind;
  value: string;
}

export function encodeAgentCredential(credential: { kind: string; value: string }): Buffer {
  return Buffer.from(JSON.stringify({ kind: credential.kind, value: credential.value }), 'utf8');
}

export function parseStoredAgentCredential(raw: string | Buffer): StoredAgentCredential | null {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { kind?: unknown; value?: unknown };
      if (
        (parsed.kind === 'api-key' || parsed.kind === 'oauth' || parsed.kind === 'pat') &&
        typeof parsed.value === 'string' &&
        parsed.value.trim().length > 0
      ) {
        return { kind: parsed.kind, value: parsed.value };
      }
      return null;
    } catch {
      return null;
    }
  }
  const legacy = text.trim();
  return legacy ? { kind: 'api-key', value: legacy } : null;
}

function agentFiles(home: string, provider: string): string[] {
  const identifier = encodeCredentialIdentifier(provider);
  const files = [path.join(home, 'agent', `${identifier}-cred`)];
  if (provider === 'anthropic') files.push(path.join(home, 'agent', 'anthropic-key'));
  return files;
}

function existingFileValues(files: string[]): Array<{ file: string; value: Buffer }> {
  return files.flatMap((file) => {
    try {
      return [{ file, value: fs.readFileSync(file) }];
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw cause;
    }
  });
}

function migrateWindowsAgent(provider: string, backend: CredentialBackend, home: string): Buffer | null {
  return withCredentialStoreLock(home, () => {
    const target = encodedTarget('agent', provider);
    let canonical = backend.get(target);
    const legacy = existingFileValues(agentFiles(home, provider));
    if (!canonical && legacy.length > 0) {
      backend.put(target, legacy[0].value);
      canonical = backend.get(target);
      if (!canonical || !canonical.equals(legacy[0].value)) {
        throw new CredentialStoreError('internal', `Agent credential migration verification failed for '${provider}'.`);
      }
    }
    if (!canonical) return null;
    let conflict = false;
    for (const candidate of legacy) {
      if (candidate.value.equals(canonical)) fs.rmSync(candidate.file, { force: true });
      else conflict = true;
    }
    writeMigrationHint(home, `agent:${encodeCredentialIdentifier(provider)}`, conflict ? 'conflict' : 'migrated');
    return canonical;
  });
}

export function readAgentCredential(provider: string, options: BackendOptions = {}): StoredAgentCredential | null {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? applianceHome();
  const target = encodedTarget('agent', provider);
  try {
    let raw: Buffer | null;
    if (platform === 'win32' && path.resolve(home) === path.resolve(applianceHome()) && !options.forceFile) {
      raw = migrateWindowsAgent(provider, backendFor(options), home);
    } else {
      const backend = backendFor(options);
      raw = backend.get(target);
      if (!raw && backend instanceof FileBackend && provider === 'anthropic') {
        try {
          raw = fs.readFileSync(path.join(home, 'agent', 'anthropic-key'));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
      }
    }
    return raw ? parseStoredAgentCredential(raw) : null;
  } catch (cause) {
    // Preserve established macOS/Linux login UX (an inaccessible credential is
    // simply unavailable). Windows is fail-closed: helper/store failures must
    // remain hard errors and can never activate a file fallback.
    if (platform === 'win32') throw cause;
    return null;
  }
}

export function writeAgentCredential(
  provider: string,
  credential: StoredAgentCredential,
  options: BackendOptions = {}
): void {
  if (!credential.value.trim()) throw new Error(`refusing to store an empty ${provider} credential`);
  const platform = options.platform ?? process.platform;
  const home = options.home ?? applianceHome();
  const backend = backendFor(options);
  const target = encodedTarget('agent', provider);
  const encoded = encodeAgentCredential(credential);
  if (platform === 'win32' && path.resolve(home) === path.resolve(applianceHome()) && !options.forceFile) {
    withCredentialStoreLock(home, () => {
      backend.put(target, encoded);
      const verified = backend.get(target);
      if (!verified || !verified.equals(encoded)) {
        throw new CredentialStoreError('internal', `Agent credential verification failed for '${provider}'.`);
      }
      for (const file of agentFiles(home, provider)) fs.rmSync(file, { force: true });
      writeMigrationHint(home, `agent:${encodeCredentialIdentifier(provider)}`, 'migrated');
    });
    return;
  }
  backend.put(target, encoded);
}

export function probeAgentCredential(provider: string, options: BackendOptions = {}): ProfileCredentialProbe {
  try {
    const value = backendFor(options).get(encodedTarget('agent', provider));
    if (!value) return { state: 'missing' };
    return parseStoredAgentCredential(value) ? { state: 'migrated', keyId: '' } : { state: 'malformed' };
  } catch (cause) {
    if (cause instanceof CredentialStoreError && cause.state === 'malformed') return { state: 'malformed' };
    return { state: 'denied' };
  }
}

export function deleteAgentCredential(provider: string, options: BackendOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? applianceHome();
  try {
    backendFor(options).delete(encodedTarget('agent', provider));
  } catch (cause) {
    if (platform === 'win32') throw cause;
  }
  for (const file of agentFiles(home, provider)) fs.rmSync(file, { force: true });
}

export interface DeviceKeyOptions {
  home?: string;
  forceFile?: boolean;
}

export interface EntitlementAnchor {
  sequence: number;
  headHash: `sha256:${string}`;
}

export function entitlementAnchorFile(home: string): string {
  return path.join(home, 'device-entitlement-anchor.json');
}

function parseEntitlementKeyWire(value: Buffer | string): string {
  const wire = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (!wire.startsWith('ed25519:')) throw new CredentialStoreError('malformed', 'Device private key is malformed.');
  const encoded = wire.slice('ed25519:'.length);
  const seed = Buffer.from(encoded, 'base64url');
  if (seed.length !== 32 || seed.toString('base64url') !== encoded) {
    throw new CredentialStoreError('malformed', 'Device private key is malformed.');
  }
  return wire;
}

function legacyDeviceKey(home: string): { file: string; wire: Buffer } | null {
  const file = path.join(home, 'device-entitlement-key.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { privateKey?: unknown };
    if (typeof parsed.privateKey !== 'string') throw new Error('missing privateKey');
    return { file, wire: Buffer.from(parseEntitlementKeyWire(parsed.privateKey), 'utf8') };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CredentialStoreError('malformed', 'The device entitlement key file is invalid.', { cause });
  }
}

function migrateWindowsEntitlementKey(
  home: string,
  backend: Pick<WindowsBackend, 'getOrCreateEntitlementKey'>
): Buffer {
  const legacy = legacyDeviceKey(home);
  const canonical = backend.getOrCreateEntitlementKey(legacy?.wire);
  parseEntitlementKeyWire(canonical);
  if (legacy) {
    if (!canonical.equals(legacy.wire)) {
      writeMigrationHint(home, 'entitlement-key', 'conflict');
      throw new CredentialStoreError(
        'malformed',
        'The entitlement key in Credential Manager conflicts with the legacy file; the file was preserved.'
      );
    }
    fs.rmSync(legacy.file, { force: true });
    writeMigrationHint(home, 'entitlement-key', 'migrated');
  }
  return canonical;
}

export function getOrCreateDeviceSigningKey(options: DeviceKeyOptions = {}): DevSigningKey {
  const home = options.home ?? applianceHome();
  const defaultHome = path.resolve(home) === path.resolve(applianceHome());
  const platform = process.platform;
  if (!options.forceFile && defaultHome && platform === 'win32') {
    const backend = backendFor({ home });
    if (!(backend instanceof WindowsBackend))
      throw new CredentialStoreError('internal', 'Windows backend unavailable.');
    const canonical = migrateWindowsEntitlementKey(home, backend);
    return deviceSigningKeyFromWire(canonical.toString('utf8'));
  }
  if (!options.forceFile && defaultHome && platform === 'darwin') {
    const backend = backendFor({ home });
    const target: StoreTarget = { kind: 'entitlement-key' };
    const existing = backend.get(target);
    if (existing) return deviceSigningKeyFromWire(parseEntitlementKeyWire(existing));
    const created = createDeviceSigningKey();
    const candidate = Buffer.from(privateKeyWire(created.privateKey), 'utf8');
    const canonical = (backend as MacOSBackend).putIfAbsent(target, candidate);
    return deviceSigningKeyFromWire(parseEntitlementKeyWire(canonical));
  }
  return getOrCreateFileDeviceKey(home);
}

function getOrCreateFileDeviceKey(home: string): DevSigningKey {
  const legacy = legacyDeviceKey(home);
  if (legacy) {
    fs.chmodSync(legacy.file, 0o600);
    restrictWindowsAcl(legacy.file);
    return deviceSigningKeyFromWire(legacy.wire.toString('utf8'));
  }
  const created = createDeviceSigningKey();
  const file = path.join(home, 'device-entitlement-key.json');
  ensurePrivateDirectory(home);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ privateKey: privateKeyWire(created.privateKey) })}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  try {
    restrictWindowsAcl(temporary);
    fs.linkSync(temporary, file);
    fs.unlinkSync(temporary);
  } catch (cause) {
    fs.rmSync(temporary, { force: true });
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST' || fs.existsSync(file))
      return getOrCreateFileDeviceKey(home);
    throw cause;
  }
  return created;
}

export function readEntitlementAnchor(options: DeviceKeyOptions = {}): EntitlementAnchor | null {
  const home = options.home ?? applianceHome();
  const defaultHome = path.resolve(home) === path.resolve(applianceHome());
  if (!options.forceFile && defaultHome && process.platform === 'win32') {
    return migrateWindowsEntitlementAnchor(home, backendFor({ home }));
  }
  if (!options.forceFile && defaultHome && process.platform === 'darwin') {
    const backend = backendFor({ home });
    const target: StoreTarget = { kind: 'entitlement-anchor' };
    const canonical = backend.get(target);
    return canonical ? parseEntitlementAnchor(canonical.toString('utf8')) : null;
  }
  try {
    const anchor = parseEntitlementAnchor(fs.readFileSync(entitlementAnchorFile(home), 'utf8'));
    fs.chmodSync(entitlementAnchorFile(home), 0o600);
    return anchor;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('The entitlement rollback anchor file is unreadable or invalid.');
  }
}

function migrateWindowsEntitlementAnchor(home: string, backend: CredentialBackend): EntitlementAnchor | null {
  const target: StoreTarget = { kind: 'entitlement-anchor' };
  const canonical = backend.get(target);
  const legacyFile = entitlementAnchorFile(home);
  let legacy: EntitlementAnchor | null = null;
  try {
    legacy = parseEntitlementAnchor(fs.readFileSync(legacyFile, 'utf8'));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CredentialStoreError('malformed', 'The entitlement rollback anchor file is invalid.', { cause });
    }
  }
  if (!legacy) return canonical ? parseEntitlementAnchor(canonical.toString('utf8')) : null;
  if (backend.importEntitlementAnchor) {
    const candidate = Buffer.from(JSON.stringify(legacy), 'utf8');
    const imported = backend.importEntitlementAnchor(candidate);
    const stored = parseEntitlementAnchor(imported.toString('utf8'));
    if (JSON.stringify(stored) !== JSON.stringify(legacy)) {
      writeMigrationHint(home, 'entitlement-anchor', 'conflict');
      throw new CredentialStoreError(
        'malformed',
        'The entitlement anchor in Credential Manager conflicts with the legacy file; the file was preserved.'
      );
    }
    fs.rmSync(legacyFile, { force: true });
    writeMigrationHint(home, 'entitlement-anchor', 'migrated');
    return legacy;
  }
  if (canonical) {
    const stored = parseEntitlementAnchor(canonical.toString('utf8'));
    if (JSON.stringify(stored) !== JSON.stringify(legacy)) {
      writeMigrationHint(home, 'entitlement-anchor', 'conflict');
      throw new CredentialStoreError(
        'malformed',
        'The entitlement anchor in Credential Manager conflicts with the legacy file; the file was preserved.'
      );
    }
  } else {
    backend.put(target, Buffer.from(JSON.stringify(legacy), 'utf8'));
    const verified = backend.get(target);
    if (!verified || JSON.stringify(parseEntitlementAnchor(verified.toString('utf8'))) !== JSON.stringify(legacy)) {
      throw new CredentialStoreError('internal', 'Entitlement anchor migration verification failed.');
    }
  }
  fs.rmSync(legacyFile, { force: true });
  writeMigrationHint(home, 'entitlement-anchor', 'migrated');
  return legacy;
}

export function writeEntitlementAnchor(anchor: EntitlementAnchor, options: DeviceKeyOptions = {}): void {
  const valid = parseEntitlementAnchor(JSON.stringify(anchor));
  const home = options.home ?? applianceHome();
  const defaultHome = path.resolve(home) === path.resolve(applianceHome());
  if (!options.forceFile && defaultHome && (process.platform === 'darwin' || process.platform === 'win32')) {
    const backend = backendFor({ home });
    const target: StoreTarget = { kind: 'entitlement-anchor' };
    const value = Buffer.from(JSON.stringify(valid), 'utf8');
    backend.put(target, value);
    const verified = backend.get(target);
    if (!verified || JSON.stringify(parseEntitlementAnchor(verified.toString('utf8'))) !== JSON.stringify(valid)) {
      throw new CredentialStoreError('internal', 'Entitlement anchor verification failed after write.');
    }
    return;
  }
  writeOwnerOnlyFile(entitlementAnchorFile(home), Buffer.from(`${JSON.stringify(valid)}\n`, 'utf8'));
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
  parseEntitlementKeyWire(wire);
  const seed = Buffer.from(wire.slice('ed25519:'.length), 'base64url');
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

interface MigratingProfilesFile {
  version: 1;
  activeProfile: string | null;
  profiles: Record<string, Profile>;
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

export interface CredentialMigrationPaths {
  home: string;
  profilesFile: string;
  legacyCredentialsFile: string;
}

export interface CredentialMigrationReport {
  migrated: string[];
  conflicts: string[];
  missing: string[];
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CredentialStoreError('malformed', `Credential metadata is malformed: ${file}`, { cause });
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  writeOwnerOnlyFile(file, Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
}

function withCredentialStoreLock<T>(home: string, operation: () => T): T {
  ensurePrivateDirectory(home);
  const lock = path.join(home, 'credential-store.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new CredentialStoreError('denied', 'Could not acquire the credential-store migration lock.', { cause });
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new CredentialStoreError('denied', 'Timed out acquiring the credential-store migration lock.');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    restrictWindowsAcl(lock);
    return operation();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      // A stale empty lock directory is safely reaped on the next attempt.
    }
  }
}

function migrateWindowsCredentialFilesWithBackend(
  paths: CredentialMigrationPaths,
  backend: CredentialBackend
): CredentialMigrationReport {
  return withCredentialStoreLock(paths.home, () => {
    let profiles = readJsonFile<MigratingProfilesFile>(paths.profilesFile);
    const legacy = readJsonFile<LegacyCredentials>(paths.legacyCredentialsFile);
    if (!profiles && legacy?.apiUrl && legacy.keyId && legacy.secret) {
      profiles = {
        version: 1,
        activeProfile: 'default',
        profiles: {
          default: { ...legacy, managed: 'cli' },
        },
      };
    }
    if (!profiles) return { migrated: [], conflicts: [], missing: [] };

    const migrated: string[] = [];
    const conflicts: string[] = [];
    const missing: string[] = [];
    const states: Record<string, 'migrated' | 'conflict' | 'missing'> = {};
    let profilesChanged = false;
    let legacyChanged = false;

    const candidates = new Map<string, Array<{ source: 'profile' | 'legacy'; value: KeychainApiKey }>>();
    for (const [name, profile] of Object.entries(profiles.profiles)) {
      if (profile.keyId && profile.secret) {
        candidates.set(name, [{ source: 'profile', value: { keyId: profile.keyId, secret: profile.secret } }]);
      }
    }
    if (legacy?.keyId && legacy.secret) {
      const name = profiles.activeProfile ?? 'default';
      candidates.set(name, [
        ...(candidates.get(name) ?? []),
        { source: 'legacy', value: { keyId: legacy.keyId, secret: legacy.secret } },
      ]);
    }

    for (const [name, legacyValues] of candidates) {
      const target = encodedTarget('cluster', name);
      let canonical = backend.get(target);
      if (!canonical) {
        const first = encodeClusterCredential(legacyValues[0].value);
        backend.put(target, first);
        canonical = backend.get(target);
        if (!canonical || !canonical.equals(first)) {
          throw new CredentialStoreError('internal', `Credential migration verification failed for profile '${name}'.`);
        }
      }
      let conflict = false;
      for (const candidate of legacyValues) {
        const bytes = encodeClusterCredential(candidate.value);
        if (!canonical.equals(bytes)) {
          conflict = true;
          continue;
        }
        if (candidate.source === 'profile') {
          profiles.profiles[name].secret = '';
          profilesChanged = true;
        } else if (legacy) {
          legacy.secret = '';
          legacyChanged = true;
        }
      }
      if (conflict) {
        conflicts.push(name);
        states[name] = 'conflict';
      } else {
        migrated.push(name);
        states[name] = 'migrated';
      }
    }

    for (const [name, profile] of Object.entries(profiles.profiles)) {
      if (candidates.has(name)) continue;
      const canonical = backend.get(encodedTarget('cluster', name));
      if (canonical) {
        const parsed = parseKeychainPayload(canonical);
        if (!parsed)
          throw new CredentialStoreError('malformed', `Credential Manager entry for '${name}' is malformed.`);
        migrated.push(name);
        states[name] = 'migrated';
      } else if (profile.keyId) {
        missing.push(name);
        states[name] = 'missing';
      }
    }

    profiles.credentialStore = { schema: CREDENTIAL_STORE_SCHEMA, profiles: states };
    profilesChanged = true;
    if (profilesChanged) atomicWriteJson(paths.profilesFile, profiles);
    if (legacyChanged && legacy) atomicWriteJson(paths.legacyCredentialsFile, legacy);
    return { migrated, conflicts, missing };
  });
}

export function migrateWindowsCredentialFiles(
  paths: CredentialMigrationPaths,
  options: BackendOptions = {}
): CredentialMigrationReport {
  if ((options.platform ?? process.platform) !== 'win32') return { migrated: [], conflicts: [], missing: [] };
  return migrateWindowsCredentialFilesWithBackend(paths, backendFor({ ...options, home: paths.home }));
}

function writeMigrationHint(home: string, key: string, state: 'migrated' | 'conflict'): void {
  const file = path.join(home, 'credential-store-state.json');
  let current: { schema: typeof CREDENTIAL_STORE_SCHEMA; states: Record<string, string> } = {
    schema: CREDENTIAL_STORE_SCHEMA,
    states: {},
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof current;
    if (parsed?.schema === CREDENTIAL_STORE_SCHEMA && parsed.states) current = parsed;
  } catch {
    // The marker is a hint only. It never gates import, scrub, or trust.
  }
  current.states[key] = state;
  atomicWriteJson(file, current);
}

/** Test-only seams. Backends remain private to this module. */
export const __testing = {
  migrateWindowsCredentialFilesWithBackend,
  encodeClusterCredential,
  securityValue,
  WindowsBackend,
  migrateWindowsAgent,
  migrateWindowsEntitlementKey,
  migrateWindowsEntitlementAnchor,
};
