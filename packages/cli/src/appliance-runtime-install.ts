import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import {
  PINNED_CATALOGUE_TRUST,
  freeCatalogueEntries,
  verifyCatalogueBlacklistPair,
  verifyCatalogueIndexPair,
  type CatalogueBlacklist,
  type CatalogueEntry,
  type CatalogueIndex,
  type CatalogueTrustPolicy,
  type InstalledApp,
  type VerifiedCatalogue,
} from '@appliance.sh/sdk';
import { verifyBundle } from './utils/bundle-read.js';
import {
  controlsSummaryForManifest,
  currentWorkspaceTarget,
  immutableBundlePath,
  installedAppDataDirectory,
  isBundleReferenced,
  listInstalledTargets,
  readInstalledApps,
  removeInstalledApp,
  removeImmutableFile,
  resolveImmutableBundlePath,
  resolveInstalledApp,
  upsertInstalledApp,
  writeInstalledApps,
} from './utils/installed-apps.js';
import { readRuntimeRegistry, runtimeRoot } from './utils/runtime-registry.js';
import {
  entitlementHomeForRuntimeRoot,
  grantManifestEntitlements,
  markEntitlementUninstalled,
} from './utils/entitlements.js';
import {
  EntitlementGrantRequiredError,
  entitlementGrantPrompt,
  promptForEntitlementGrants,
  type EntitlementGrantPromptDetails,
} from './appliance-runtime-entitlements.js';
import { describeRuntimeApp } from './appliance-runtime-open.js';

const DEFAULT_CATALOGUE_ORIGIN = 'https://www.appliance.sh';
const MAX_BUNDLE_BYTES = 2 * 1024 ** 3;
const UNKNOWN_WARNING_MS = 30 * 24 * 60 * 60 * 1000;
const BLACKLIST_REFRESH_MS = 6 * 60 * 60 * 1000;
const BLACKLIST_STALE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

export interface UnknownPublisherDetails {
  appId: string;
  name: string;
  version: string;
  license: string;
  source: string;
  digest: string;
  signature: 'valid' | 'unsigned' | 'invalid';
  publisher: string;
  controlsSummary: InstalledApp['controlsSummary'];
}

export class UnknownPublisherError extends Error {
  readonly code = 'UNKNOWN_PUBLISHER';

  constructor(readonly details: UnknownPublisherDetails) {
    super(`Unknown Publisher: ${details.publisher} (${details.signature})`);
    this.name = 'UnknownPublisherError';
  }

  serialise(): string {
    return `${this.code}:${JSON.stringify(this.details)}`;
  }
}

export class BlacklistedBundleError extends Error {
  constructor(
    readonly selector: string,
    readonly reason: string,
    readonly verifiedAt: string
  ) {
    super(`Install refused: ${selector} is on the verified unsafe-app blacklist (${reason}, verified ${verifiedAt}).`);
    this.name = 'BlacklistedBundleError';
  }
}

export interface InstallBundleOptions {
  target?: string;
  root?: string;
  acceptUnknownPublisher?: boolean;
  confirmUnknownPublisher?: (details: UnknownPublisherDetails) => Promise<boolean>;
  fetcher?: typeof fetch;
  catalogueOrigin?: string;
  policy?: CatalogueTrustPolicy;
  now?: Date;
  verifiedIndex?: VerifiedCatalogue<CatalogueIndex>;
  verifiedBlacklist?: VerifiedCatalogue<CatalogueBlacklist> | null;
  grantAll?: boolean;
  approvedGrantIds?: string[];
  confirmEntitlementGrants?: (details: EntitlementGrantPromptDetails) => Promise<string[] | null>;
  installer?: 'cli' | 'desktop';
}

export async function installBundle(source: string, options: InstallBundleOptions = {}): Promise<InstalledApp> {
  const now = options.now ?? new Date();
  const root = options.root ?? runtimeRoot();
  const entitlementHome = entitlementHomeForRuntimeRoot(root);
  const target = currentWorkspaceTarget(options.target, entitlementHome);
  const sourceUrl = parseSourceUrl(source);
  const staging = await stageSource(source, sourceUrl, root, options.fetcher ?? fetch);
  let keepStaging = false;
  try {
    const policy = options.policy ?? PINNED_CATALOGUE_TRUST;
    const index =
      options.verifiedIndex ??
      (sourceUrl
        ? await fetchVerifiedIndex(options.fetcher ?? fetch, options.catalogueOrigin, policy, now)
        : await readCachedIndex(policy, now, root));
    const expectedEntry = sourceUrl
      ? findCatalogueEntry(index, sourceUrl.toString())
      : findLocalEvidence(index, staging);
    const verified = verifyBundle(staging, {
      resolvePublicKey: (keyId) => policy.keys[keyId],
    });

    if (expectedEntry) assertIndexBinding(expectedEntry.entry, verified.digest, verified.manifest);
    if (sourceUrl && !expectedEntry) {
      throw new Error('Catalogue URL is not bound by the current verified free-app index.');
    }
    if (sourceUrl && (!verified.signature || !verified.signature.valid)) {
      throw new Error('Catalogue bundle signature could not be verified against its current index evidence.');
    }

    const blacklist =
      options.verifiedBlacklist === undefined
        ? await loadBlacklist({
            fetcher: options.fetcher ?? fetch,
            catalogueOrigin: options.catalogueOrigin,
            policy,
            now,
            root,
            networkInstall: Boolean(sourceUrl),
          })
        : options.verifiedBlacklist;
    if (blacklist)
      assertNotBlacklisted(
        blacklist,
        verified.manifest.name,
        verified.manifest.version,
        verified.digest,
        verified.manifest.publisher.keyId
      );

    const signature = verified.signature ? (verified.signature.valid ? 'valid' : 'invalid') : 'unsigned';
    const tier = expectedEntry && signature === 'valid' ? expectedEntry.entry.tier : 'unknown';
    const controlsSummary = controlsSummaryForManifest(verified.manifest);
    const unknownDetails: UnknownPublisherDetails = {
      appId: verified.manifest.name,
      name: expectedEntry?.entry.name ?? verified.manifest.name,
      version: verified.manifest.version,
      license: verified.manifest.license,
      source: sourceUrl?.toString() ?? 'file',
      digest: verified.digest,
      signature,
      publisher: verified.manifest.publisher.name,
      controlsSummary,
    };
    if (tier === 'unknown' && !options.acceptUnknownPublisher) {
      const accepted = await options.confirmUnknownPublisher?.(unknownDetails);
      if (!accepted) throw new UnknownPublisherError(unknownDetails);
    }

    const grantPrompt = entitlementGrantPrompt(verified.manifest, { home: entitlementHome, now });
    let approvedGrantIds: string[] = [];
    if (grantPrompt) {
      const approved = options.grantAll
        ? grantPrompt.grants.map((grant) => grant.id)
        : options.approvedGrantIds !== undefined
          ? options.approvedGrantIds
          : await options.confirmEntitlementGrants?.(grantPrompt);
      if (!approved) throw new EntitlementGrantRequiredError(grantPrompt);
      approvedGrantIds = approved;
    }

    const destination = immutableBundlePath(verified.digest, root);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (fs.existsSync(destination)) {
      const existing = verifyBundle(destination, { resolvePublicKey: (keyId) => policy.keys[keyId] });
      if (existing.digest !== verified.digest) throw new Error('Existing immutable bundle copy has the wrong digest.');
    } else {
      fs.renameSync(staging, destination);
      keepStaging = true;
      fs.chmodSync(destination, 0o400);
    }
    const immutable = verifyBundle(destination, { resolvePublicKey: (keyId) => policy.keys[keyId] });
    if (immutable.digest !== verified.digest) throw new Error('Immutable bundle copy changed during installation.');

    const installed: InstalledApp = {
      appId: verified.manifest.name,
      version: verified.manifest.version,
      name: expectedEntry?.entry.name ?? verified.manifest.name,
      license: verified.manifest.license,
      publisher: {
        name: verified.manifest.publisher.name,
        ...(verified.manifest.publisher.keyId ? { keyId: verified.manifest.publisher.keyId } : {}),
        tier,
      },
      digest: verified.digest,
      bundlePath: destination,
      installedAt: now.toISOString(),
      source: sourceUrl?.toString() ?? 'file',
      verification: {
        signature,
        ...(expectedEntry ? { indexBound: { generation: expectedEntry.generation } } : {}),
      },
      controlsSummary,
    };
    grantManifestEntitlements(verified.manifest, options.installer ?? 'cli', approvedGrantIds, {
      home: entitlementHome,
      now,
    });
    upsertInstalledApp(target, installed, root);
    return installed;
  } finally {
    if (!keepStaging) removeImmutableFile(staging);
  }
}

function parseSourceUrl(source: string): URL | null {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) return null;
  const url = new URL(source);
  if (url.protocol !== 'https:') throw new Error('Runtime install URLs must use HTTPS.');
  if (url.username || url.password) throw new Error('Runtime install URLs must not contain credentials.');
  return url;
}

async function stageSource(
  source: string,
  sourceUrl: URL | null,
  root: string,
  fetcher: typeof fetch
): Promise<string> {
  const directory = path.join(root, 'downloads');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const staging = path.join(
    directory,
    `install-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  );
  if (!sourceUrl) {
    const local = path.resolve(source);
    const stat = fs.statSync(local);
    if (!stat.isFile()) throw new Error(`Bundle is not a regular file: ${local}`);
    if (stat.size > MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds the compressed size limit.');
    fs.copyFileSync(local, staging, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(staging, 0o600);
    return staging;
  }

  const response = await fetcher(sourceUrl, { redirect: 'error', headers: { Accept: 'application/zip' } });
  if (!response.ok) throw new Error(`Bundle download failed (${response.status}).`);
  const descriptor = fs.openSync(staging, 'wx', 0o600);
  let received = 0;
  let failed = false;
  try {
    if (!response.body) throw new Error('Bundle download returned no body.');
    const reader = response.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds the compressed size limit.');
      fs.writeSync(descriptor, chunk.value);
    }
    fs.fsyncSync(descriptor);
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    fs.closeSync(descriptor);
    if (failed) removeImmutableFile(staging);
  }
  return staging;
}

function catalogueOrigin(value?: string): string {
  const url = new URL(value ?? process.env.APPLIANCE_CATALOGUE_URL?.trim() ?? DEFAULT_CATALOGUE_ORIGIN);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Catalogue origin must use HTTPS.');
  }
  return url.toString().replace(/\/$/, '');
}

async function responseBytes(response: Response, label: string): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`${label} request failed (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchVerifiedIndex(
  fetcher: typeof fetch,
  originValue: string | undefined,
  policy: CatalogueTrustPolicy,
  now: Date
): Promise<VerifiedCatalogue<CatalogueIndex>> {
  const origin = catalogueOrigin(originValue);
  const [index, signature] = await Promise.all([
    fetcher(`${origin}/catalogue/index.json`, { headers: { Accept: 'application/json' } }),
    fetcher(`${origin}/catalogue/index.json.sig`, { headers: { Accept: 'application/json' } }),
  ]);
  return verifyCatalogueIndexPair({
    indexBytes: await responseBytes(index, 'Catalogue index'),
    envelopeBytes: await responseBytes(signature, 'Catalogue index signature'),
    policy,
    now,
  });
}

function catalogueCacheDirectory(root: string): string {
  return path.join(path.dirname(root), 'catalogue');
}

export async function readCachedIndex(
  policy: CatalogueTrustPolicy,
  now: Date,
  root: string
): Promise<VerifiedCatalogue<CatalogueIndex> | undefined> {
  const file = path.join(catalogueCacheDirectory(root), 'verified-pair.json');
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      indexJson: string;
      signatureJson: string;
      highestGeneration?: number;
    };
    return await verifyCatalogueIndexPair({
      indexBytes: new TextEncoder().encode(cache.indexJson),
      envelopeBytes: new TextEncoder().encode(cache.signatureJson),
      policy: { ...policy, highestGeneration: cache.highestGeneration },
      now,
      allowExpired: true,
    });
  } catch {
    return undefined;
  }
}

function findCatalogueEntry(
  index: VerifiedCatalogue<CatalogueIndex> | undefined,
  url: string
): { entry: CatalogueEntry; generation: number } | undefined {
  if (!index || index.stale) return undefined;
  const entry = freeCatalogueEntries(index.payload).find((candidate) => candidate.url === url);
  return entry ? { entry, generation: index.payload.generation } : undefined;
}

export function findLocalEvidence(
  index: VerifiedCatalogue<CatalogueIndex> | undefined,
  stagedPath: string
): { entry: CatalogueEntry; generation: number } | undefined {
  if (!index || index.stale) return undefined;
  const prelim = verifyBundle(stagedPath);
  const entry = freeCatalogueEntries(index.payload).find(
    (candidate) => candidate.id === prelim.manifest.name && candidate.digest === prelim.digest
  );
  return entry ? { entry, generation: index.payload.generation } : undefined;
}

export function assertIndexBinding(
  entry: CatalogueEntry,
  digest: string,
  manifest: ReturnType<typeof verifyBundle>['manifest']
): void {
  if (entry.digest !== digest)
    throw new Error(`Catalogue digest mismatch: expected ${entry.digest}, received ${digest}.`);
  if (
    entry.id !== manifest.name ||
    entry.version !== manifest.version ||
    entry.license !== manifest.license ||
    entry.publisher.name !== manifest.publisher.name ||
    entry.publisher.keyId !== manifest.publisher.keyId
  ) {
    throw new Error('Bundle manifest does not match its current catalogue index entry.');
  }
}

interface BlacklistCache {
  blacklistJson: string;
  signatureJson: string;
  verifiedAt: string;
}

async function readCachedBlacklist(
  cacheFile: string,
  policy: CatalogueTrustPolicy,
  now: Date
): Promise<VerifiedCatalogue<CatalogueBlacklist> | null> {
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as BlacklistCache;
    if (!cache.verifiedAt || !Number.isFinite(Date.parse(cache.verifiedAt))) return null;
    const verified = await verifyCatalogueBlacklistPair({
      blacklistBytes: new TextEncoder().encode(cache.blacklistJson),
      envelopeBytes: new TextEncoder().encode(cache.signatureJson),
      policy,
      now,
      allowExpired: true,
    });
    return { ...verified, verifiedAt: cache.verifiedAt };
  } catch {
    return null;
  }
}

export function blacklistRefreshDue(verified: VerifiedCatalogue<CatalogueBlacklist>, now: Date): boolean {
  return now.getTime() - Date.parse(verified.verifiedAt) >= BLACKLIST_REFRESH_MS;
}

export function assertBlacklistStaleness(
  verified: VerifiedCatalogue<CatalogueBlacklist>,
  now: Date,
  networkInstall: boolean,
  preOpen = false
): void {
  const staleFor = now.getTime() - Date.parse(verified.payload.expiresAt);
  if ((networkInstall || preOpen) && staleFor > BLACKLIST_STALE_LIMIT_MS) {
    throw new Error(
      `Verified unsafe-app blacklist is more than seven days stale; ${networkInstall ? 'network install' : 'open'} stopped.`
    );
  }
}

export async function loadBlacklist(options: {
  fetcher: typeof fetch;
  catalogueOrigin?: string;
  policy: CatalogueTrustPolicy;
  now: Date;
  root: string;
  networkInstall: boolean;
  preOpen?: boolean;
}): Promise<VerifiedCatalogue<CatalogueBlacklist> | null> {
  const directory = catalogueCacheDirectory(options.root);
  const cacheFile = path.join(directory, 'verified-blacklist.json');
  const cached = await readCachedBlacklist(cacheFile, options.policy, options.now);
  if (cached && !cached.stale && !blacklistRefreshDue(cached, options.now)) {
    assertBlacklistStaleness(cached, options.now, options.networkInstall, options.preOpen);
    return cached;
  }
  try {
    const origin = catalogueOrigin(options.catalogueOrigin);
    const [payloadResponse, signatureResponse] = await Promise.all([
      options.fetcher(`${origin}/catalogue/blacklist.json`, { headers: { Accept: 'application/json' } }),
      options.fetcher(`${origin}/catalogue/blacklist.json.sig`, { headers: { Accept: 'application/json' } }),
    ]);
    const payloadBytes = await responseBytes(payloadResponse, 'Blacklist');
    const envelopeBytes = await responseBytes(signatureResponse, 'Blacklist signature');
    const verified = await verifyCatalogueBlacklistPair({
      blacklistBytes: payloadBytes,
      envelopeBytes,
      policy: options.policy,
      now: options.now,
    });
    atomicJson(cacheFile, {
      blacklistJson: new TextDecoder().decode(payloadBytes),
      signatureJson: new TextDecoder().decode(envelopeBytes),
      generation: verified.payload.generation,
      verifiedAt: verified.verifiedAt,
    });
    return verified;
  } catch (networkError) {
    if (cached) {
      assertBlacklistStaleness(cached, options.now, options.networkInstall, options.preOpen);
      if (cached.stale) {
        console.error(
          chalk.yellow(
            'Warning: unsafe-app blacklist refresh failed; evaluating the last verified stale blacklist for this operation.'
          )
        );
      }
      return cached;
    }
    if (options.networkInstall) {
      const detail = networkError instanceof Error ? networkError.message : '';
      throw new Error(
        `A current verified unsafe-app blacklist is required for network installation.${detail ? ` ${detail}` : ''}`
      );
    }
    console.error(chalk.yellow('Warning: no verified unsafe-app blacklist is available; local operation continues.'));
    return null;
  }
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function assertNotBlacklisted(
  verified: VerifiedCatalogue<CatalogueBlacklist>,
  appId: string,
  version: string,
  digest: string,
  publisherKeyId?: string
): void {
  for (const entry of verified.payload.entries) {
    const appMatch = entry.appId === appId && (!entry.version || entry.version === version);
    const digestMatch = entry.digest === digest;
    const publisherMatch = Boolean(publisherKeyId && entry.publisherKeyId === publisherKeyId);
    if (appMatch || digestMatch || publisherMatch) {
      const selector = digestMatch
        ? `digest ${digest}`
        : publisherMatch
          ? `publisher ${publisherKeyId}`
          : `app ${appId}`;
      throw new BlacklistedBundleError(selector, entry.reason, verified.verifiedAt);
    }
  }
}

export interface UninstallOptions {
  target?: string;
  root?: string;
  keepData?: boolean;
  stop?: (appId: string) => void | Promise<void>;
  revokePolicy?: (appId: string) => void | Promise<void>;
}

export async function uninstallInstalledApp(input: string, options: UninstallOptions = {}): Promise<InstalledApp> {
  const root = options.root ?? runtimeRoot();
  const target = currentWorkspaceTarget(options.target, entitlementHomeForRuntimeRoot(root));
  const app = resolveInstalledApp(input, target, root);
  if (!app) throw new Error(`Installed app '${input}' was not found for target '${target}'.`);
  const active = readRuntimeRegistry().some(
    (record) => record.appId === app.appId && ['starting', 'running'].includes(record.state)
  );
  if (active) {
    try {
      await options.stop?.(app.appId);
    } finally {
      // A failed guest stop must not preserve a usable host credential.
      await options.revokePolicy?.(app.appId);
    }
  } else {
    // Revoke even when the local registry says the app is already stopped: a
    // stale/missing record must not leave an effective policy or proxy bearer.
    await options.revokePolicy?.(app.appId);
  }
  const runtimeAppsRoot = path.resolve(root, 'apps');
  const extractedAppPath = path.resolve(runtimeAppsRoot, app.appId, app.version);
  if (!extractedAppPath.startsWith(`${runtimeAppsRoot}${path.sep}`)) {
    throw new Error('Installed app identity cannot address a runtime extraction outside the apps directory.');
  }
  const remainsInstalledElsewhere = listInstalledTargets(root).some(
    ({ target: candidateTarget, apps }) =>
      candidateTarget !== target && apps.some((candidate) => candidate.appId === app.appId)
  );
  if (!remainsInstalledElsewhere) {
    markEntitlementUninstalled(app.appId, { home: entitlementHomeForRuntimeRoot(root) });
  }
  const removed = removeInstalledApp(target, app.appId, root);
  if (!removed) throw new Error(`Installed app '${input}' disappeared during uninstall.`);
  if (!options.keepData)
    fs.rmSync(installedAppDataDirectory(target, app.appId, root), { recursive: true, force: true });
  const appStillInstalled = listInstalledTargets(root).some(({ apps }) =>
    apps.some((candidate) => candidate.appId === app.appId)
  );
  if (!appStillInstalled) {
    fs.rmSync(extractedAppPath, { recursive: true, force: true });
  }
  const expectedImmutablePath = resolveImmutableBundlePath(app.digest, root);
  if (
    path.resolve(app.bundlePath) === path.resolve(expectedImmutablePath) &&
    !isBundleReferenced(app.bundlePath, root)
  ) {
    removeImmutableFile(app.bundlePath);
  }
  return app;
}

export function formatInstalledAppsTable(rows: Array<{ target: string; app: InstalledApp }>): string {
  if (rows.length === 0) return 'No installed apps.';
  return [
    'TARGET\tAPP\tVERSION\tLICENSE\tPUBLISHER\tINSTALLED',
    ...rows.map(
      ({ target, app }) =>
        `${target}\t${app.name}\t${app.version}\t${app.license}\t${app.publisher.tier === 'unknown' ? 'Unknown Publisher' : app.publisher.name}\t${app.installedAt}`
    ),
  ].join('\n');
}

export function unknownPublisherWarningDue(app: InstalledApp, now = new Date()): boolean {
  if (app.publisher.tier !== 'unknown') return false;
  if (!app.lastWarnedAt) return true;
  return now.getTime() - Date.parse(app.lastWarnedAt) >= UNKNOWN_WARNING_MS;
}

export function markUnknownPublisherWarned(
  app: InstalledApp,
  target: string,
  root = runtimeRoot(),
  now = new Date()
): void {
  const apps = readInstalledApps(target, root).map((entry) =>
    entry.appId === app.appId ? { ...entry, lastWarnedAt: now.toISOString() } : entry
  );
  writeInstalledApps(target, apps, root);
}

export async function promptForUnknownPublisher(
  details: UnknownPublisherDetails,
  action: 'install' | 'open' = 'install'
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  console.error(chalk.yellow('Unknown Publisher'));
  console.error(`${details.name} ${details.version} · ${details.license} · ${details.digest.slice(0, 19)}…`);
  console.error(
    `Signature: ${details.signature === 'valid' ? 'valid; publisher evidence unavailable' : details.signature}`
  );
  console.error('Publisher identity and code origin could not be verified. Requested controls are shown separately.');
  printControlsSummary(details.controlsSummary, console.error);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${action === 'open' ? 'Open' : 'Install'} this exact bundle? [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export async function runRuntimeInstallCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: appliance runtime install <path|https-url> [--accept-unknown-publisher] [--grant-all] [--json]'
    );
    return;
  }
  const source = firstPositional(args, ['--target', '--grant-id']);
  if (!source) throw new Error('Usage: appliance runtime install <path|https-url>');
  const target = optionValue(args, '--target');
  let installed: InstalledApp;
  try {
    installed = await installBundle(source, {
      target,
      acceptUnknownPublisher: args.includes('--accept-unknown-publisher'),
      confirmUnknownPublisher: promptForUnknownPublisher,
      grantAll: args.includes('--grant-all'),
      approvedGrantIds:
        args.includes('--grant-selection') || args.includes('--grant-id')
          ? optionValues(args, '--grant-id')
          : undefined,
      confirmEntitlementGrants: promptForEntitlementGrants,
      installer: args.includes('--desktop') ? 'desktop' : 'cli',
    });
  } catch (cause) {
    if (cause instanceof UnknownPublisherError) throw new Error(cause.serialise());
    if (cause instanceof EntitlementGrantRequiredError) throw new Error(cause.serialise());
    throw cause;
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(installed));
    return;
  }
  console.log(
    `${chalk.green('✓')} installed ${installed.name} ${installed.version} for ${currentWorkspaceTarget(target)}`
  );
  console.log(`Publisher: ${installed.publisher.tier === 'unknown' ? 'Unknown Publisher' : installed.publisher.name}`);
  console.log(`Bundle: ${installed.bundlePath}`);
  printControlsSummary(installed.controlsSummary, console.log);
}

export async function runRuntimeUninstallCommand(
  args: string[],
  stop: (appId: string) => void | Promise<void>,
  revokePolicy: (appId: string) => void | Promise<void>
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: appliance runtime uninstall <app> [--keep-data]');
    return;
  }
  const input = firstPositional(args, ['--target']);
  if (!input) throw new Error('Usage: appliance runtime uninstall <app> [--keep-data]');
  const removed = await uninstallInstalledApp(input, {
    target: optionValue(args, '--target'),
    keepData: args.includes('--keep-data'),
    stop,
    revokePolicy,
  });
  console.log(
    `${chalk.green('✓')} uninstalled ${removed.name}${args.includes('--keep-data') ? '; app data kept' : ''}`
  );
}

export function runRuntimeListCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: appliance runtime list [--all-targets] [--json]');
    return;
  }
  const root = runtimeRoot();
  const target = currentWorkspaceTarget(optionValue(args, '--target'));
  const rows = args.includes('--all-targets')
    ? listInstalledTargets(root).flatMap((group) => group.apps.map((app) => ({ target: group.target, app })))
    : readInstalledApps(target, root).map((app) => ({ target, app }));
  if (args.includes('--json')) {
    const registry = readRuntimeRegistry();
    console.log(
      JSON.stringify(
        rows.map((row) => ({
          ...row,
          descriptor: describeRuntimeApp(row.app.appId, row.target, {
            installed: row.app,
            record: registry.find((record) => record.appId === row.app.appId),
          }),
        }))
      )
    );
    return;
  }
  console.log(formatInstalledAppsTable(rows));
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function optionValues(args: string[], option: string): string[] {
  return args.flatMap((value, index) => (value === option && args[index + 1] ? [args[index + 1]!] : []));
}

function firstPositional(args: string[], valueOptions: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (valueOptions.includes(args[index]!)) {
      index += 1;
      continue;
    }
    if (!args[index]!.startsWith('-')) return args[index];
  }
  return undefined;
}

function printControlsSummary(summary: InstalledApp['controlsSummary'], output: (line: string) => void): void {
  output('Controls summary:');
  output(`  services: ${summary.serviceCount}`);
  output(`  egress: ${summary.egressHosts.join(', ') || 'none'}`);
  output(
    `  mounts: ${summary.mounts.map((mount) => `${mount.name}:${mount.guest}${mount.readOnly ? ' (read-only)' : ''}`).join(', ') || 'none'}`
  );
  output(
    `  published ports: ${summary.publishedPorts.map((port) => `${port.name}:${port.guest}/${port.protocol}`).join(', ') || 'none'}`
  );
}
