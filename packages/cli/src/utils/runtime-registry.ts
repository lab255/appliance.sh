import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type RuntimeState = 'starting' | 'running' | 'degraded' | 'stopped' | 'exited' | 'failed';

export interface RuntimeHostPort {
  name: string;
  host: number;
  guest: number;
  protocol: 'tcp';
}

export interface RuntimeRecord {
  appId: string;
  version: string;
  state: RuntimeState;
  principalIp: string;
  hostPorts: RuntimeHostPort[];
  startedAt: string;
  updatedAt: string;
  poolVm: string;
  poolRestartPending: boolean;
  exitCode?: number;
  bundlePath: string;
  installDir: string;
  shareTag: string;
  uid: number;
  signatureKeyId?: string;
  signatureValid?: boolean;
}

interface RuntimeRegistryFile {
  version: 1;
  apps: RuntimeRecord[];
}

export function runtimeRoot(): string {
  return path.join(os.homedir(), '.appliance', 'runtime');
}

export function runtimeRegistryFile(): string {
  return path.join(runtimeRoot(), 'registry.json');
}

export function readRuntimeRegistry(file = runtimeRegistryFile()): RuntimeRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RuntimeRegistryFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.apps)) return [];
    return parsed.apps.filter(isRuntimeRecord).sort((a, b) => a.appId.localeCompare(b.appId));
  } catch {
    return [];
  }
}

export function writeRuntimeRegistry(apps: RuntimeRecord[], file = runtimeRegistryFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body: RuntimeRegistryFile = { version: 1, apps: [...apps].sort((a, b) => a.appId.localeCompare(b.appId)) };
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function upsertRuntimeRecord(record: RuntimeRecord, file = runtimeRegistryFile()): void {
  const apps = readRuntimeRegistry(file).filter((entry) => entry.appId !== record.appId);
  apps.push(record);
  writeRuntimeRegistry(apps, file);
}

export function removeRuntimeRecord(appId: string, file = runtimeRegistryFile()): boolean {
  const before = readRuntimeRegistry(file);
  const after = before.filter((entry) => entry.appId !== appId);
  if (after.length === before.length) return false;
  writeRuntimeRegistry(after, file);
  return true;
}

export function updateRuntimeRecord(
  appId: string,
  update: Partial<Omit<RuntimeRecord, 'appId'>>,
  file = runtimeRegistryFile()
): RuntimeRecord | null {
  const apps = readRuntimeRegistry(file);
  const index = apps.findIndex((entry) => entry.appId === appId);
  if (index < 0) return null;
  apps[index] = { ...apps[index], ...update, appId, updatedAt: new Date().toISOString() };
  writeRuntimeRegistry(apps, file);
  return apps[index];
}

function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<RuntimeRecord>;
  return (
    typeof record.appId === 'string' &&
    typeof record.version === 'string' &&
    typeof record.state === 'string' &&
    typeof record.principalIp === 'string' &&
    Array.isArray(record.hostPorts) &&
    typeof record.startedAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    typeof record.poolVm === 'string' &&
    typeof record.poolRestartPending === 'boolean' &&
    typeof record.installDir === 'string' &&
    typeof record.shareTag === 'string' &&
    typeof record.uid === 'number' &&
    (record.signatureKeyId === undefined || typeof record.signatureKeyId === 'string') &&
    (record.signatureValid === undefined || typeof record.signatureValid === 'boolean')
  );
}
