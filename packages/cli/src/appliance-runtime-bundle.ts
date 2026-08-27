import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applianceV2Input, type ApplianceV2 } from '@appliance.sh/sdk';

export const BUNDLE_LIMITS = {
  compressedBytes: 2 * 1024 ** 3,
  expandedBytes: 8 * 1024 ** 3,
  entryBytes: 4 * 1024 ** 3,
  entries: 4096,
  manifestBytes: 256 * 1024,
  pathBytes: 240,
  ratioThresholdBytes: 64 * 1024 ** 2,
  maxRatio: 100,
} as const;

export interface BundleEntry {
  path: string;
  expandedBytes: number;
  compressedBytes: number;
  kind: 'file' | 'directory';
}

export interface LoadedRuntimeBundle {
  manifest: ApplianceV2;
  entries: BundleEntry[];
  digest: string;
}

/** Validate normalized names and RFC 0001's count/size/ratio limits. Pure for tests. */
export function validateBundleEntries(entries: BundleEntry[], archiveBytes: number): void {
  if (archiveBytes > BUNDLE_LIMITS.compressedBytes) throw new Error('bundle exceeds the 2 GiB compressed limit');
  if (entries.length > BUNDLE_LIMITS.entries) throw new Error('bundle exceeds the 4,096 entry limit');
  const exact = new Set<string>();
  const folded = new Set<string>();
  let expanded = 0;
  let compressed = 0;
  for (const entry of entries) {
    const name = entry.path;
    if (!name || Buffer.byteLength(name, 'utf8') > BUNDLE_LIMITS.pathBytes) {
      throw new Error(`unsafe bundle path length: ${name || '<empty>'}`);
    }
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.includes('\0') ||
      name.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error(`unsafe bundle path: ${name}`);
    }
    if (exact.has(name) || folded.has(name.toLocaleLowerCase('en-US'))) {
      throw new Error(`duplicate or case-colliding bundle path: ${name}`);
    }
    exact.add(name);
    folded.add(name.toLocaleLowerCase('en-US'));
    if (entry.expandedBytes > BUNDLE_LIMITS.entryBytes) throw new Error(`bundle entry exceeds 4 GiB: ${name}`);
    expanded += entry.expandedBytes;
    compressed += entry.compressedBytes;
  }
  if (expanded > BUNDLE_LIMITS.expandedBytes) throw new Error('bundle exceeds the 8 GiB expanded limit');
  if (expanded > BUNDLE_LIMITS.ratioThresholdBytes && expanded > Math.max(1, compressed) * BUNDLE_LIMITS.maxRatio) {
    throw new Error('bundle exceeds the 100:1 aggregate expansion ratio');
  }
  const manifest = entries.find((entry) => entry.path === 'appliance.json' && entry.kind === 'file');
  if (!manifest) throw new Error('bundle is missing root appliance.json');
  if (manifest.expandedBytes > BUNDLE_LIMITS.manifestBytes) throw new Error('appliance.json exceeds 256 KiB');
}

/** Read zip metadata without extracting. `zipinfo` exposes file kind plus compressed and expanded sizes. */
export function inspectBundle(bundlePath: string): BundleEntry[] {
  const stat = fs.statSync(bundlePath);
  if (!stat.isFile()) throw new Error(`bundle is not a regular file: ${bundlePath}`);
  if (stat.size > BUNDLE_LIMITS.compressedBytes) throw new Error('bundle exceeds the 2 GiB compressed limit');
  const result = spawnSync('zipinfo', ['-l', bundlePath], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0)
    throw new Error(`cannot inspect bundle zip: ${(result.stderr || '').trim() || 'zipinfo failed'}`);
  const entries: BundleEntry[] = [];
  for (const line of result.stdout.split('\n')) {
    // zipinfo -l: "-rw-r--r--  3.0 unx  12 tx  8 defN ... path"
    const match = line.match(/^([dl-])[rwxstST-]{9}\s+\S+\s+\S+\s+(\d+)\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
    if (!match) continue;
    if (match[1] === 'l') throw new Error(`bundle contains symlink: ${match[4]}`);
    entries.push({
      path: match[4].replace(/\/$/, ''),
      expandedBytes: Number(match[2]),
      compressedBytes: Number(match[3]),
      kind: match[1] === 'd' ? 'directory' : 'file',
    });
  }
  if (entries.length === 0) throw new Error('bundle zip contains no readable entries');
  validateBundleEntries(entries, stat.size);
  return entries;
}

function readZipEntry(bundlePath: string, name: string, maxBytes: number): Buffer {
  const result = spawnSync('unzip', ['-p', bundlePath, name], { encoding: null, maxBuffer: maxBytes + 1 });
  if (result.status !== 0) throw new Error(`cannot read ${name} from bundle`);
  const output = Buffer.from(result.stdout ?? []);
  if (output.length > maxBytes) throw new Error(`${name} exceeds its read limit`);
  return output;
}

export function loadRuntimeBundle(bundlePath: string): LoadedRuntimeBundle {
  const entries = inspectBundle(bundlePath);
  const rawManifest = readZipEntry(bundlePath, 'appliance.json', BUNDLE_LIMITS.manifestBytes);
  if (rawManifest[0] === 0xef && rawManifest[1] === 0xbb && rawManifest[2] === 0xbf) {
    throw new Error('appliance.json must be UTF-8 without a BOM');
  }
  let input: unknown;
  try {
    input = JSON.parse(rawManifest.toString('utf8'));
  } catch {
    throw new Error('appliance.json is not strict JSON');
  }
  const parsed = applianceV2Input.safeParse(input);
  if (!parsed.success) throw new Error(`invalid appliance.json: ${parsed.error.issues[0]?.message ?? 'schema error'}`);
  const expectedDigest = readZipEntry(bundlePath, 'digest', 128).toString('utf8').trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) throw new Error('bundle digest is missing or malformed');
  return { manifest: parsed.data, entries, digest: expectedDigest };
}

export function unpackRuntimeBundle(
  bundlePath: string,
  destination: string,
  loaded = loadRuntimeBundle(bundlePath)
): void {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = `${destination}.staging-${process.pid}-${Date.now()}`;
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    const result = spawnSync('unzip', ['-qq', bundlePath, '-d', staging], { stdio: 'pipe' });
    if (result.status !== 0) throw new Error('bundle extraction failed');
    verifyExtractedTree(staging, loaded.entries);
    const actualDigest = digestExtractedBundle(staging, loaded.entries);
    if (actualDigest !== loaded.digest)
      throw new Error(`bundle digest mismatch: expected ${loaded.digest}, got ${actualDigest}`);
    if (fs.existsSync(destination)) fs.renameSync(destination, `${destination}.previous-${Date.now()}`);
    fs.renameSync(staging, destination);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function verifyExtractedTree(root: string, entries: BundleEntry[]): void {
  for (const entry of entries) {
    const absolute = path.join(root, ...entry.path.split('/'));
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(`bundle path escaped extraction root: ${entry.path}`);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`bundle contains unsupported file kind: ${entry.path}`);
    }
  }
}

function digestExtractedBundle(root: string, entries: BundleEntry[]): string {
  const hash = createHash('sha256');
  const files = entries
    .filter((entry) => entry.kind === 'file' && entry.path !== 'digest' && entry.path !== 'signature.sig')
    .sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  for (const entry of files) {
    const bytes = fs.readFileSync(path.join(root, ...entry.path.split('/')));
    hash.update(entry.path);
    hash.update(Buffer.from([0]));
    hash.update(String(bytes.length));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}
