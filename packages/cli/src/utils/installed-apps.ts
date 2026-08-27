import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApplianceV2, InstalledApp, InstalledAppControlsSummary } from '@appliance.sh/sdk';
import { installedAppsStoreSchema } from '@appliance.sh/sdk';
import { readProfiles } from './profile-store.js';
import { runtimeRoot } from './runtime-registry.js';

export const INSTALLED_APPS_SCHEMA = 'appliance.installed-apps/v1' as const;

export function currentWorkspaceTarget(explicit?: string): string {
  const target = explicit?.trim() || process.env.APPLIANCE_PROFILE?.trim() || readProfiles().activeProfile?.trim() || 'local';
  if (!target) throw new Error('The current workspace target is empty.');
  return target;
}

export function installedTargetDirectory(target: string, root = runtimeRoot()): string {
  const trimmed = target.trim();
  if (!trimmed) throw new Error('Installed-app target must not be empty.');
  const directory =
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed) && trimmed !== '.' && trimmed !== '..'
      ? trimmed
      : `target-${createHash('sha256').update(trimmed).digest('hex').slice(0, 24)}`;
  return path.join(root, 'installed', directory);
}

export function installedAppsFile(target: string, root = runtimeRoot()): string {
  return path.join(installedTargetDirectory(target, root), 'apps.json');
}

export function immutableBundlesDirectory(root = runtimeRoot()): string {
  return path.join(root, 'bundles');
}

export function immutableBundlePath(digest: string, root = runtimeRoot()): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('Cannot address a bundle with an invalid digest.');
  return path.join(immutableBundlesDirectory(root), `${digest}.appliance.zip`);
}

export function installedAppDataDirectory(target: string, appId: string, root = runtimeRoot()): string {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(appId)) throw new Error('Cannot address app data with an invalid app id.');
  return path.join(installedTargetDirectory(target, root), 'data', appId);
}

export function readInstalledApps(target: string, root = runtimeRoot()): InstalledApp[] {
  const file = installedAppsFile(target, root);
  if (!fs.existsSync(file)) return [];
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Installed-app store is unreadable: ${file}`);
  }
  const parsed = installedAppsStoreSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Installed-app store is invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return [...parsed.data.apps].sort((a, b) => a.name.localeCompare(b.name) || a.appId.localeCompare(b.appId));
}

export function writeInstalledApps(target: string, apps: InstalledApp[], root = runtimeRoot()): void {
  const file = installedAppsFile(target, root);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const body = installedAppsStoreSchema.parse({
    schema: INSTALLED_APPS_SCHEMA,
    apps: [...apps].sort((a, b) => a.name.localeCompare(b.name) || a.appId.localeCompare(b.appId)),
  });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function upsertInstalledApp(target: string, app: InstalledApp, root = runtimeRoot()): void {
  const apps = readInstalledApps(target, root).filter((entry) => entry.appId !== app.appId);
  apps.push(app);
  writeInstalledApps(target, apps, root);
}

export function removeInstalledApp(target: string, appId: string, root = runtimeRoot()): InstalledApp | null {
  const apps = readInstalledApps(target, root);
  const removed = apps.find((entry) => entry.appId === appId) ?? null;
  if (!removed) return null;
  writeInstalledApps(
    target,
    apps.filter((entry) => entry.appId !== appId),
    root
  );
  return removed;
}

export function listInstalledTargets(root = runtimeRoot()): Array<{ target: string; apps: InstalledApp[] }> {
  const directory = path.join(root, 'installed');
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, 'apps.json')))
    .map((entry) => ({ target: entry.name, apps: readInstalledApps(entry.name, root) }))
    .sort((a, b) => a.target.localeCompare(b.target));
}

export function isBundleReferenced(bundlePath: string, root = runtimeRoot()): boolean {
  const exact = path.resolve(bundlePath);
  return listInstalledTargets(root).some(({ apps }) => apps.some((app) => path.resolve(app.bundlePath) === exact));
}

export function resolveInstalledApp(input: string, target: string, root = runtimeRoot()): InstalledApp | null {
  const needle = input.toLocaleLowerCase();
  return (
    readInstalledApps(target, root).find(
      (app) => app.appId.toLocaleLowerCase() === needle || app.name.toLocaleLowerCase() === needle
    ) ?? null
  );
}

export function controlsSummaryForManifest(manifest: ApplianceV2): InstalledAppControlsSummary {
  const egressHosts = new Set<string>();
  const mounts = new Map<string, InstalledAppControlsSummary['mounts'][number]>();
  const publishedPorts = new Map<string, InstalledAppControlsSummary['publishedPorts'][number]>();
  let serviceCount = 0;

  const collect = (value: unknown, prefix: string): void => {
    if (!value || typeof value !== 'object') return;
    const service = value as Record<string, unknown>;
    const network = service.network as { egress?: Array<{ host: string }> } | undefined;
    for (const rule of network?.egress ?? []) egressHosts.add(rule.host);
    for (const mount of (service.mounts as InstalledAppControlsSummary['mounts'] | undefined) ?? []) {
      mounts.set(`${prefix}${mount.name}`, mount);
    }
    for (const port of
      (service.ports as Array<InstalledAppControlsSummary['publishedPorts'][number] & { expose?: string }> | undefined) ??
      []) {
      if (port.expose === 'host') {
        publishedPorts.set(`${prefix}${port.name}`, { name: port.name, guest: port.guest, protocol: port.protocol });
      }
    }
    if (service.type === 'compound' && service.services && typeof service.services === 'object') {
      for (const [name, child] of Object.entries(service.services as Record<string, unknown>)) {
        collect(child, `${prefix}${name}.`);
      }
    } else {
      serviceCount += 1;
    }
  };

  collect(manifest, '');
  return {
    egressHosts: [...egressHosts].sort(),
    mounts: [...mounts.values()],
    publishedPorts: [...publishedPorts.values()],
    resources: { ...(manifest.resources ?? {}) },
    serviceCount: Math.max(1, serviceCount),
  };
}
