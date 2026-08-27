import * as fs from 'node:fs';
import * as path from 'node:path';
import archiver from 'archiver';
import { applianceV2Input, type ApplianceV2 } from '@appliance.sh/sdk';
import { canonicalJsonBytes, computeBundleDigest, type BundleDigestEntry } from './bundle-digest.js';
import { readDevSigningKey, signEnvelope } from './bundle-sign.js';

export interface BundleFileInput {
  path: string;
  data?: Uint8Array;
  sourcePath?: string;
}

export interface WriteBundleOptions {
  outputPath: string;
  manifest: unknown;
  files: BundleFileInput[];
  signingKeyPath?: string;
}

export interface WriteBundleResult {
  outputPath: string;
  sizeBytes: number;
  digest: `sha256:${string}`;
  keyId?: `ed25519:sha256:${string}`;
  manifest: ApplianceV2;
}

/** Write the deterministic-content runnable layout from RFC 0001. */
export async function writeBundle(options: WriteBundleOptions): Promise<WriteBundleResult> {
  const signingKey = options.signingKeyPath ? readDevSigningKey(options.signingKeyPath) : undefined;
  const manifestWithPublisherKey = signingKey
    ? attachPublisherKeyId(options.manifest, signingKey.keyId)
    : options.manifest;
  const parsed = applianceV2Input.safeParse(manifestWithPublisherKey);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid runnable manifest: ${issues}`);
  }

  // Zod defaults leave optional properties present with value undefined in a
  // few transformed objects. Reduce to the strict JSON data model before JCS.
  const manifest = JSON.parse(JSON.stringify(parsed.data)) as ApplianceV2;
  const entries: BundleDigestEntry[] = [{ path: 'appliance.json', data: canonicalJsonBytes(manifest) }];
  const seen = new Set(['appliance.json', 'digest', 'signature.sig']);
  for (const file of options.files) {
    validateOutputPath(file.path);
    if (seen.has(file.path)) throw new Error(`Duplicate or reserved bundle path: ${file.path}`);
    seen.add(file.path);
    if ((file.data === undefined) === (file.sourcePath === undefined)) {
      throw new Error(`Bundle file ${file.path} must provide exactly one of data or sourcePath.`);
    }
    let data: Buffer;
    if (file.sourcePath !== undefined) {
      const stat = fs.lstatSync(file.sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`Bundle source must be a regular file: ${file.sourcePath}`);
      data = fs.readFileSync(file.sourcePath);
    } else {
      data = Buffer.from(file.data!);
    }
    entries.push({ path: file.path, data });
  }

  const digest = computeBundleDigest(entries);
  const signature = signingKey ? signEnvelope({ digest }, 'bundle', signingKey) : undefined;
  const outputPath = path.resolve(options.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const output = fs.createWriteStream(outputPath, { flags: 'w' });
  const archive = archiver('zip', { zlib: { level: 9 } });
  const complete = new Promise<void>((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
  });
  archive.pipe(output);
  for (const entry of entries) archive.append(Buffer.from(entry.data), { name: entry.path, mode: 0o600 });
  archive.append(`${digest}\n`, { name: 'digest', mode: 0o600 });
  if (signature) {
    archive.append(`${canonicalJsonBytes(signature).toString('utf8')}\n`, { name: 'signature.sig', mode: 0o600 });
  }
  await archive.finalize();
  await complete;

  return {
    outputPath,
    sizeBytes: fs.statSync(outputPath).size,
    digest,
    keyId: signingKey?.keyId,
    manifest,
  };
}

function attachPublisherKeyId(manifest: unknown, keyId: string): unknown {
  if (!isRecord(manifest) || !isRecord(manifest.publisher)) {
    throw new Error('Signed runnable manifests require publisher.name.');
  }
  if (manifest.publisher.keyId !== undefined && manifest.publisher.keyId !== keyId) {
    throw new Error(`Manifest publisher.keyId does not match signing key (${keyId}).`);
  }
  return { ...manifest, publisher: { ...manifest.publisher, keyId } };
}

function validateOutputPath(entryPath: string): void {
  const bytes = Buffer.byteLength(entryPath, 'utf8');
  const segments = entryPath.split('/');
  if (
    bytes === 0 ||
    bytes > 240 ||
    entryPath.startsWith('/') ||
    entryPath.includes('\\') ||
    entryPath.includes('\0') ||
    /^[A-Za-z]:/.test(entryPath) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe bundle path: ${JSON.stringify(entryPath)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
