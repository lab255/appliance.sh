import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  entitlementRecordPayloadSchema,
  entitlementStoreSchema,
  type ApplianceV2,
  type EntitlementGrant,
  type EntitlementRecord,
  type EntitlementRecordPayload,
  type EntitlementStore,
  type EntitlementSuggestion,
} from '@appliance.sh/sdk';
import { canonicalJsonBytes } from './bundle-digest.js';
import { signEnvelope, verifyEnvelope, type DevSigningKey, type SignatureEnvelope } from './bundle-sign.js';
import { getOrCreateDeviceSigningKey } from './keychain.js';
import { runtimeRoot } from './runtime-registry.js';

export const ENTITLEMENTS_SCHEMA = 'appliance.entitlements/v1' as const;
export const DEFAULT_SUGGESTION_DAYS = 30;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const MAX_CAS_ATTEMPTS = 5;

export interface EntitlementOptions {
  home?: string;
  key?: DevSigningKey;
  now?: Date;
  lockTimeoutMs?: number;
}

type EntitlementRecordInput = Omit<EntitlementRecordPayload, 'sequence' | 'previousRecordHash'>;

export interface GrantDelta {
  requested: EntitlementGrant[];
  unchanged: EntitlementGrant[];
  additions: EntitlementGrant[];
}

export class EntitlementIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntitlementIntegrityError';
  }
}

export class UngrantedControlError extends Error {
  constructor(readonly grant: EntitlementGrant) {
    super(`Runtime start refused: required control is not granted: ${describeGrant(grant)} (${grant.id}).`);
    this.name = 'UngrantedControlError';
  }
}

export function applianceHome(): string {
  return path.join(os.homedir(), '.appliance');
}

/** Production runtimeRoot is ~/.appliance/runtime; isolated test roots remain isolated. */
export function entitlementHomeForRuntimeRoot(root: string): string {
  return path.resolve(root) === path.resolve(runtimeRoot()) ? path.dirname(root) : root;
}

export function entitlementsFile(home = applianceHome()): string {
  return path.join(home, 'entitlements.json');
}

export function entitlementLockFile(home = applianceHome()): string {
  return path.join(home, 'entitlements.json.lock');
}

export function requestedGrantsForManifest(
  manifest: ApplianceV2,
  approvedAt = new Date().toISOString()
): EntitlementGrant[] {
  const egress = new Map<string, Set<number>>();
  const mounts = new Map<string, EntitlementGrant>();
  const ports = new Map<string, EntitlementGrant>();

  const collect = (value: unknown, prefix: string): void => {
    if (!value || typeof value !== 'object') return;
    const service = value as Record<string, unknown>;
    const network = service.network as { egress?: Array<{ host: string; ports: number[] }> } | undefined;
    for (const rule of network?.egress ?? []) {
      const current = egress.get(rule.host) ?? new Set<number>();
      for (const port of rule.ports) current.add(port);
      egress.set(rule.host, current);
    }
    for (const mount of (service.mounts as
      | Array<{ name: string; source: 'volume' | 'host'; guest: string; readOnly: boolean }>
      | undefined) ?? []) {
      const name = `${prefix}${mount.name}`;
      mounts.set(name, {
        id: `mount:${name}`,
        control: 'mount',
        value: {
          name,
          source: mount.source,
          guest: mount.guest,
          access: mount.readOnly ? 'read-only' : 'read-write',
        },
        approvedAt,
      });
    }
    for (const port of (service.ports as
      | Array<{ name: string; guest: number; protocol: 'tcp' | 'udp'; expose?: string }>
      | undefined) ?? []) {
      if (port.expose !== 'host') continue;
      const name = `${prefix}${port.name}`;
      ports.set(name, {
        id: `port:${name}`,
        control: 'published-port',
        value: { name, guest: port.guest, protocol: port.protocol },
        approvedAt,
      });
    }
    if (service.type === 'compound' && service.services && typeof service.services === 'object') {
      for (const [name, child] of Object.entries(service.services as Record<string, unknown>)) {
        collect(child, `${prefix}${name}.`);
      }
    }
  };
  collect(manifest, '');

  const grants: EntitlementGrant[] = [
    ...[...egress.entries()].map(
      ([host, values]): EntitlementGrant => ({
        id: `egress:${host}`,
        control: 'egress-host',
        value: { host, ports: [...values].sort((a, b) => a - b) },
        approvedAt,
      })
    ),
    ...mounts.values(),
    ...ports.values(),
  ];
  if (manifest.resources && Object.keys(manifest.resources).length > 0) {
    grants.push({ id: 'resources:runtime', control: 'resources', value: { ...manifest.resources }, approvedAt });
  }
  return grants.sort((a, b) => a.id.localeCompare(b.id));
}

export function computeGrantDelta(requested: EntitlementGrant[], current?: EntitlementRecord | null): GrantDelta {
  const active = current?.state === 'installed' ? new Map(current.grants.map((grant) => [grant.id, grant])) : new Map();
  const unchanged: EntitlementGrant[] = [];
  const additions: EntitlementGrant[] = [];
  for (const request of requested) {
    const prior = active.get(request.id);
    if (prior && grantMeaning(prior) === grantMeaning(request)) unchanged.push(prior);
    else additions.push(request);
  }
  return { requested, unchanged, additions };
}

export function requiredGrantIds(grants: EntitlementGrant[]): string[] {
  return grants.filter((grant) => grant.control !== 'mount').map((grant) => grant.id);
}

export function latestEntitlement(records: EntitlementRecord[], appId: string): EntitlementRecord | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]!.appId === appId) return records[index]!;
  }
  return null;
}

export function readEntitlementStore(options: EntitlementOptions = {}): EntitlementStore {
  const home = options.home ?? applianceHome();
  const key = options.key ?? getOrCreateDeviceSigningKey({ home, forceFile: home !== applianceHome() });
  return readAndVerify(entitlementsFile(home), key);
}

export function grantManifestEntitlements(
  manifest: ApplianceV2,
  installer: 'cli' | 'desktop',
  approvedDeltaIds: readonly string[],
  options: EntitlementOptions = {}
): EntitlementRecord {
  const now = options.now ?? new Date();
  const approvedAt = now.toISOString();
  return mutateStore(options, (store) => {
    const current = latestEntitlement(store.records, manifest.name);
    const requested = requestedGrantsForManifest(manifest, approvedAt);
    const delta = computeGrantDelta(requested, current);
    const approved = new Set(approvedDeltaIds);
    const missingRequired = requiredGrantIds(delta.additions).filter((id) => !approved.has(id));
    if (missingRequired.length > 0) {
      const grant = delta.additions.find((entry) => entry.id === missingRequired[0])!;
      throw new UngrantedControlError(grant);
    }
    const unchanged = new Map(delta.unchanged.map((grant) => [grant.id, grant]));
    const grants = requested
      .flatMap((request) => {
        const prior = unchanged.get(request.id);
        if (prior) return [prior];
        return approved.has(request.id) ? [request] : [];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const retainedUsage = Object.fromEntries(
      Object.entries(current?.usage ?? {}).filter(([id]) => grants.some((grant) => grant.id === id))
    );
    const payload: EntitlementRecordInput = {
      appId: manifest.name,
      version: manifest.version,
      license: manifest.license,
      grantedAt: approvedAt,
      installerId: `${installer}:${randomUUID()}`,
      state: 'installed',
      grants,
      usage: retainedUsage,
    };
    return appendRecord(store, payload, resolveKey(options, store.devicePublicKey));
  });
}

export function markEntitlementUninstalled(appId: string, options: EntitlementOptions = {}): EntitlementRecord | null {
  return mutateStore(options, (store) => {
    const current = latestEntitlement(store.records, appId);
    if (!current || current.state === 'uninstalled') return null;
    const { signature: _signature, sequence: _sequence, previousRecordHash: _previousRecordHash, ...payload } = current;
    return appendRecord(
      store,
      { ...payload, state: 'uninstalled', uninstalledAt: (options.now ?? new Date()).toISOString() },
      resolveKey(options, store.devicePublicKey)
    );
  });
}

export function revokeEntitlementGrant(
  appId: string,
  grantId: string,
  options: EntitlementOptions = {}
): EntitlementRecord {
  return mutateStore(options, (store) => {
    const current = latestEntitlement(store.records, appId);
    if (!current || current.state !== 'installed') throw new Error(`No active entitlement exists for '${appId}'.`);
    if (!current.grants.some((grant) => grant.id === grantId)) {
      throw new Error(`Grant '${grantId}' is not active for '${appId}'.`);
    }
    const { signature: _signature, sequence: _sequence, previousRecordHash: _previousRecordHash, ...payload } = current;
    return appendRecord(
      store,
      {
        ...payload,
        grants: payload.grants.filter((grant) => grant.id !== grantId),
        usage: Object.fromEntries(Object.entries(payload.usage).filter(([id]) => id !== grantId)),
      },
      resolveKey(options, store.devicePublicKey)
    );
  });
}

export function stampEntitlementUsage(
  appId: string,
  grantIds: readonly string[],
  options: EntitlementOptions = {}
): EntitlementRecord | null {
  if (grantIds.length === 0) return latestEntitlement(readEntitlementStore(options).records, appId);
  return mutateStore(options, (store) => {
    const current = latestEntitlement(store.records, appId);
    if (!current || current.state !== 'installed') return null;
    const active = new Set(current.grants.map((grant) => grant.id));
    const usedAt = (options.now ?? new Date()).toISOString();
    const usage = { ...current.usage };
    let changed = false;
    for (const id of new Set(grantIds)) {
      if (!active.has(id)) continue;
      const previous = usage[id];
      if (previous && Date.parse(previous.lastUsedAt) >= Date.parse(usedAt)) continue;
      usage[id] = {
        lastUsedAt: usedAt,
        useCount: Math.min(Number.MAX_SAFE_INTEGER, (previous?.useCount ?? 0) + 1),
      };
      changed = true;
    }
    if (!changed) return current;
    const { signature: _signature, sequence: _sequence, previousRecordHash: _previousRecordHash, ...payload } = current;
    return appendRecord(store, { ...payload, usage }, resolveKey(options, store.devicePublicKey));
  });
}

export function assertManifestEntitled(manifest: ApplianceV2, record: EntitlementRecord | null): EntitlementGrant[] {
  const requested = requestedGrantsForManifest(manifest);
  const active = record?.state === 'installed' ? new Map(record.grants.map((grant) => [grant.id, grant])) : new Map();
  for (const request of requested) {
    if (request.control === 'mount') continue;
    const grant = active.get(request.id);
    if (!grant || grantMeaning(grant) !== grantMeaning(request)) throw new UngrantedControlError(request);
  }
  return requested.filter((request) => {
    const grant = active.get(request.id);
    return Boolean(grant && grantMeaning(grant) === grantMeaning(request));
  });
}

export function suggestedRevocations(
  records: EntitlementRecord[],
  now = new Date(),
  thresholdDays = DEFAULT_SUGGESTION_DAYS
): EntitlementSuggestion[] {
  if (!Number.isInteger(thresholdDays) || thresholdDays < 1)
    throw new Error('Suggestion threshold must be a whole day (minimum 1).');
  const cutoff = now.getTime() - thresholdDays * 24 * 60 * 60 * 1000;
  const latest = new Map<string, EntitlementRecord>();
  for (const record of records) latest.set(record.appId, record);
  return [...latest.values()]
    .filter((record) => record.state === 'installed')
    .flatMap((record) =>
      record.grants.flatMap((grant) => {
        const lastUsedAt = record.usage[grant.id]?.lastUsedAt;
        const reference = lastUsedAt ?? grant.approvedAt;
        if (Date.parse(reference) > cutoff) return [];
        return [
          {
            appId: record.appId,
            version: record.version,
            license: record.license,
            grant,
            ...(lastUsedAt ? { lastUsedAt } : {}),
            reason: lastUsedAt ? ('unused' as const) : ('never-used' as const),
            revokeCommand: `appliance runtime entitlements revoke ${shellWord(record.appId)} ${shellWord(grant.id)}`,
          },
        ];
      })
    )
    .sort((a, b) => a.appId.localeCompare(b.appId) || a.grant.id.localeCompare(b.grant.id));
}

export function describeGrant(grant: EntitlementGrant): string {
  switch (grant.control) {
    case 'egress-host':
      return `egress ${grant.value.host}:${grant.value.ports.join(',')}`;
    case 'mount':
      return `mount ${grant.value.name} at ${grant.value.guest} (${grant.value.access})`;
    case 'published-port':
      return `published port ${grant.value.name} ${grant.value.guest}/${grant.value.protocol}`;
    case 'resources':
      return `resources ${Object.entries(grant.value)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}`;
  }
}

function mutateStore<T>(options: EntitlementOptions, mutation: (store: EntitlementStore) => T): T {
  const home = options.home ?? applianceHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const key = options.key ?? getOrCreateDeviceSigningKey({ home, forceFile: home !== applianceHome() });
  const lock = acquireLock(entitlementLockFile(home), options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  try {
    const file = entitlementsFile(home);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const beforeBytes = readBytes(file);
      const beforeHash = hashBytes(beforeBytes);
      const store = beforeBytes ? parseAndVerify(beforeBytes, key) : emptyStore(key);
      const result = mutation(store);
      store.revision += 1;
      const currentHash = hashBytes(readBytes(file));
      if (currentHash !== beforeHash) continue;
      writeAtomic(file, store);
      return result;
    }
    throw new Error('Entitlement store changed during a locked mutation; retry the operation.');
  } finally {
    releaseLock(lock, entitlementLockFile(home));
  }
}

function readAndVerify(file: string, key: DevSigningKey): EntitlementStore {
  const bytes = readBytes(file);
  return bytes ? parseAndVerify(bytes, key) : emptyStore(key);
}

function parseAndVerify(bytes: Buffer, key: DevSigningKey): EntitlementStore {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new EntitlementIntegrityError('Entitlement store is unreadable; controls remain denied pending review.');
  }
  const parsed = entitlementStoreSchema.safeParse(value);
  if (!parsed.success) {
    throw new EntitlementIntegrityError(
      `Entitlement store is invalid; controls remain denied pending review: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
    );
  }
  if (parsed.data.devicePublicKey !== key.publicKeyWire) {
    throw new EntitlementIntegrityError(
      'The entitlement store device key is unavailable or changed; controls remain denied pending review.'
    );
  }
  let previous: EntitlementRecord | null = null;
  for (const [index, record] of parsed.data.records.entries()) {
    const expectedPrevious = previous ? recordHash(previous) : null;
    if (record.sequence !== index + 1 || record.previousRecordHash !== expectedPrevious) {
      throw new EntitlementIntegrityError(
        `Entitlement history chain verification failed at sequence ${index + 1}; controls remain denied pending review.`
      );
    }
    const { signature, ...payload } = record;
    let valid = false;
    try {
      valid = verifyEnvelope(payload, 'entitlement', signature as SignatureEnvelope, parsed.data.devicePublicKey);
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new EntitlementIntegrityError(
        `Entitlement signature verification failed for '${record.appId}'; controls remain denied pending review.`
      );
    }
    previous = record;
  }
  return parsed.data;
}

function emptyStore(key: DevSigningKey): EntitlementStore {
  return { schema: ENTITLEMENTS_SCHEMA, revision: 0, devicePublicKey: key.publicKeyWire, records: [] };
}

function signRecord(payload: EntitlementRecordPayload, key: DevSigningKey): EntitlementRecord {
  const valid = entitlementRecordPayloadSchema.parse(payload);
  return { ...valid, signature: signEnvelope(valid, 'entitlement', key) as EntitlementRecord['signature'] };
}

function appendRecord(store: EntitlementStore, input: EntitlementRecordInput, key: DevSigningKey): EntitlementRecord {
  const previous = store.records[store.records.length - 1];
  const record = signRecord(
    {
      sequence: store.records.length + 1,
      previousRecordHash: previous ? recordHash(previous) : null,
      ...input,
    },
    key
  );
  store.records.push(record);
  return record;
}

function recordHash(record: EntitlementRecord): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJsonBytes(record)).digest('hex')}`;
}

function resolveKey(options: EntitlementOptions, expectedPublicKey: string): DevSigningKey {
  const home = options.home ?? applianceHome();
  const key = options.key ?? getOrCreateDeviceSigningKey({ home, forceFile: home !== applianceHome() });
  if (key.publicKeyWire !== expectedPublicKey)
    throw new EntitlementIntegrityError('The entitlement device key changed during mutation.');
  return key;
}

function grantMeaning(grant: EntitlementGrant): string {
  return Buffer.from(canonicalJsonBytes({ control: grant.control, value: grant.value })).toString('base64url');
}

function readBytes(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}

function hashBytes(bytes: Buffer | null): string {
  return bytes ? createHash('sha256').update(bytes).digest('hex') : 'missing';
}

function writeAtomic(file: string, store: EntitlementStore): void {
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  try {
    const directory = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } catch {
    // Windows cannot fsync a directory; rename remains atomic there.
  }
}

function acquireLock(file: string, timeoutMs: number): number {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return fs.openSync(file, 'wx', 0o600);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      if (Date.now() >= deadline) {
        throw new Error('Could not acquire the entitlement store lock; no mutation was attempted unlocked.');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function releaseLock(descriptor: number, file: string): void {
  try {
    fs.closeSync(descriptor);
  } finally {
    fs.unlinkSync(file);
  }
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
