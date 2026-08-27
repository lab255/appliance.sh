/**
 * Small shared runnable-bundle API for the CLI and Runtime sibling:
 *   readBundleManifest(path, limits)
 *   unpackBundle(path, dest, limits)
 *   verifyBundle(path) -> { digest, signature?: { keyId, valid } }
 *
 * All three entry points inspect the ZIP central directory first and enforce
 * RFC 0001 bounds and path/type safety before reading or writing entry data.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { applianceV2Input, type ApplianceV2, type ApplianceV2Service } from '@appliance.sh/sdk';
import { canonicalJsonBytes, computeBundleDigest } from './bundle-digest.js';
import { validateEnvelope, verifyEnvelope, type SignatureEnvelope, type DevSigningKey } from './bundle-sign.js';

export interface BundleLimits {
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxEntryBytes: number;
  maxEntries: number;
  maxManifestBytes: number;
  maxPathBytes: number;
  maxExpansionRatio: number;
  expansionRatioThresholdBytes: number;
}

export const DEFAULT_BUNDLE_LIMITS: Readonly<BundleLimits> = {
  maxCompressedBytes: 2 * 1024 ** 3,
  maxExpandedBytes: 8 * 1024 ** 3,
  maxEntryBytes: 4 * 1024 ** 3,
  maxEntries: 4096,
  maxManifestBytes: 256 * 1024,
  maxPathBytes: 240,
  maxExpansionRatio: 100,
  expansionRatioThresholdBytes: 64 * 1024 ** 2,
};

export type BundleClassification = 'source' | 'runnable';

export interface ReadBundleManifestResult {
  classification: BundleClassification;
  manifest: Record<string, unknown>;
}

export interface VerifyBundleOptions {
  publicKey?: string | DevSigningKey['publicKey'];
  resolvePublicKey?: (keyId: string) => string | DevSigningKey['publicKey'] | undefined;
  limits?: Partial<BundleLimits>;
}

export interface VerifyBundleResult {
  digest: `sha256:${string}`;
  manifest: ApplianceV2;
  signature?: { keyId: string; valid: boolean };
}

interface ZipEntry {
  name: string;
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

interface InspectedZip {
  filePath: string;
  archiveSize: number;
  dataEndOffset: number;
  entries: ZipEntry[];
  byName: Map<string, ZipEntry>;
  limits: BundleLimits;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const CRC_TABLE = makeCrcTable();

export function readBundleManifest(filePath: string, limits: Partial<BundleLimits> = {}): ReadBundleManifestResult {
  const zip = inspectZip(filePath, limits);
  return readManifestFromZip(zip);
}

export function unpackBundle(filePath: string, destination: string, limits: Partial<BundleLimits> = {}): void {
  const zip = inspectZip(filePath, limits);
  fs.mkdirSync(path.resolve(destination), { recursive: true });
  const root = fs.realpathSync(path.resolve(destination));
  for (const entry of zip.entries) {
    const outputPath = path.resolve(root, ...entry.name.replace(/\/$/, '').split('/'));
    if (outputPath !== root && !outputPath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Bundle entry escapes destination: ${entry.name}`);
    }
    if (entry.isDirectory) {
      ensureSafeDirectory(root, outputPath);
      continue;
    }
    ensureSafeDirectory(root, path.dirname(outputPath));
    if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite during bundle unpack: ${entry.name}`);
    fs.writeFileSync(outputPath, readEntry(zip, entry), { mode: 0o600, flag: 'wx' });
  }
}

export function verifyBundle(filePath: string, options: VerifyBundleOptions = {}): VerifyBundleResult {
  const zip = inspectZip(filePath, options.limits);
  const bounded = readManifestFromZip(zip);
  if (bounded.classification !== 'runnable') throw new Error('Expected a manifest v2 runnable bundle.');

  const manifestEntry = requiredEntry(zip, 'appliance.json');
  const manifestBytes = readEntry(zip, manifestEntry);
  if (!manifestBytes.equals(canonicalJsonBytes(bounded.manifest))) {
    throw new Error('Runnable appliance.json must be RFC 8785 canonical JSON with no trailing newline.');
  }
  const parsed = applianceV2Input.safeParse(bounded.manifest);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid runnable manifest: ${issues}`);
  }

  const digestBytes = readEntry(zip, requiredEntry(zip, 'digest'));
  const digestText = decodeUtf8(digestBytes, 'digest');
  if (!/^sha256:[0-9a-f]{64}\n$/.test(digestText)) throw new Error('Bundle digest metadata is malformed.');
  const recordedDigest = digestText.slice(0, -1) as `sha256:${string}`;
  const digestEntries = zip.entries
    .filter((entry) => !entry.isDirectory && entry.name !== 'digest' && entry.name !== 'signature.sig')
    .map((entry) => ({ path: entry.name, data: readEntry(zip, entry) }));
  const actualDigest = computeBundleDigest(digestEntries);
  if (actualDigest !== recordedDigest) {
    throw new Error(`Bundle digest mismatch: expected ${recordedDigest}, computed ${actualDigest}.`);
  }
  validateReferencedPayloads(parsed.data, zip.byName);

  const result: VerifyBundleResult = { digest: actualDigest, manifest: parsed.data };
  const signatureEntry = zip.byName.get('signature.sig');
  if (!signatureEntry) return result;

  const signatureText = decodeUtf8(readEntry(zip, signatureEntry), 'signature.sig');
  if (!signatureText.endsWith('\n') || signatureText.slice(0, -1).includes('\n')) {
    throw new Error('signature.sig must contain one canonical JSON envelope followed by one LF.');
  }
  let signatureValue: unknown;
  try {
    signatureValue = JSON.parse(signatureText.slice(0, -1));
  } catch {
    throw new Error('signature.sig is not valid JSON.');
  }
  const envelope = validateEnvelope(signatureValue, 'bundle');
  if (`${canonicalJsonBytes(envelope).toString('utf8')}\n` !== signatureText) {
    throw new Error('signature.sig must use RFC 8785 canonical JSON.');
  }
  if (parsed.data.publisher.keyId !== envelope.keyId) {
    throw new Error('Signature keyId does not match appliance.json publisher.keyId.');
  }
  const publicKey = options.publicKey ?? options.resolvePublicKey?.(envelope.keyId);
  result.signature = {
    keyId: envelope.keyId,
    valid: publicKey ? verifyEnvelope({ digest: actualDigest }, 'bundle', envelope, publicKey) : false,
  };
  return result;
}

export function classifyBundleManifest(manifest: unknown): BundleClassification {
  if (!isRecord(manifest)) throw new Error('Root appliance.json must contain a JSON object.');
  if (manifest.manifest === 'v1') return 'source';
  if (manifest.manifest === 'v2' && manifest.kind === 'runnable') {
    if (manifest.type !== 'container' && manifest.type !== 'binary' && manifest.type !== 'compound') {
      throw new Error('Runnable appliance.json has an unknown type.');
    }
    return 'runnable';
  }
  throw new Error('Invalid bundle discriminator: expected manifest "v1" source or manifest "v2" runnable.');
}

function inspectZip(filePath: string, overrides: Partial<BundleLimits> = {}): InspectedZip {
  const limits = { ...DEFAULT_BUNDLE_LIMITS, ...overrides };
  const absolute = path.resolve(filePath);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error(`Bundle is not a regular file: ${absolute}`);
  if (stat.size > limits.maxCompressedBytes) throw new Error('Bundle exceeds the compressed size limit.');

  const descriptor = fs.openSync(absolute, 'r');
  try {
    const tailLength = Math.min(stat.size, 65_557);
    const tail = Buffer.allocUnsafe(tailLength);
    readExactly(descriptor, tail, stat.size - tail.length, 'ZIP EOCD');
    const eocdOffsetInTail = lastSignatureOffset(tail, EOCD_SIGNATURE);
    if (eocdOffsetInTail < 0 || eocdOffsetInTail + 22 > tail.length) throw new Error('Invalid ZIP: EOCD not found.');
    const commentLength = tail.readUInt16LE(eocdOffsetInTail + 20);
    if (eocdOffsetInTail + 22 + commentLength !== tail.length)
      throw new Error('Invalid ZIP: trailing data after EOCD.');
    if (tail.readUInt16LE(eocdOffsetInTail + 4) !== 0 || tail.readUInt16LE(eocdOffsetInTail + 6) !== 0) {
      throw new Error('Multi-disk ZIP archives are not supported.');
    }
    const diskEntries = tail.readUInt16LE(eocdOffsetInTail + 8);
    const entryCount = tail.readUInt16LE(eocdOffsetInTail + 10);
    if (diskEntries !== entryCount) throw new Error('Invalid ZIP entry count.');
    if (entryCount === 0xffff) throw new Error('ZIP64 entry counts are not supported.');
    if (entryCount > limits.maxEntries) throw new Error(`Bundle exceeds the ${limits.maxEntries}-entry limit.`);
    const centralSize = tail.readUInt32LE(eocdOffsetInTail + 12);
    const centralOffset = tail.readUInt32LE(eocdOffsetInTail + 16);
    const absoluteEocdOffset = stat.size - tail.length + eocdOffsetInTail;
    if (centralOffset + centralSize > absoluteEocdOffset) throw new Error('Invalid ZIP central directory bounds.');
    const central = Buffer.allocUnsafe(centralSize);
    readExactly(descriptor, central, centralOffset, 'ZIP central directory');

    const entries: ZipEntry[] = [];
    const byName = new Map<string, ZipEntry>();
    const caseFolded = new Set<string>();
    let cursor = 0;
    let expandedTotal = 0;
    let compressedTotal = 0;
    while (cursor < central.length) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        throw new Error('Invalid ZIP central directory entry.');
      }
      const flags = central.readUInt16LE(cursor + 8);
      if ((flags & 0x1) !== 0) throw new Error('Encrypted ZIP entries are not allowed.');
      const compression = central.readUInt16LE(cursor + 10);
      if (compression !== 0 && compression !== 8) throw new Error('ZIP entries must use store or deflate compression.');
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentSize = central.readUInt16LE(cursor + 32);
      const recordLength = 46 + nameLength + extraLength + commentSize;
      if (cursor + recordLength > central.length) throw new Error('Truncated ZIP central directory entry.');
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
        throw new Error('ZIP64 expanded entries are not supported.');
      }
      const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = decodeUtf8(nameBytes, 'ZIP entry name');
      validateEntryPath(name, limits.maxPathBytes);
      const folded = name.toLocaleLowerCase('en-US');
      if (byName.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
      if (caseFolded.has(folded)) throw new Error(`Case-colliding ZIP entry: ${name}`);
      caseFolded.add(folded);

      const madeBy = central.readUInt16LE(cursor + 4) >>> 8;
      const externalAttributes = central.readUInt32LE(cursor + 38);
      const mode = madeBy === 3 ? externalAttributes >>> 16 : 0;
      const kind = mode & 0o170000;
      const isDirectory = name.endsWith('/');
      if (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) {
        throw new Error(`ZIP entry is not a regular file or directory: ${name}`);
      }
      if ((kind === 0o040000) !== isDirectory && kind !== 0) {
        throw new Error(`ZIP entry type disagrees with its path: ${name}`);
      }
      if (uncompressedSize > limits.maxEntryBytes) throw new Error(`ZIP entry exceeds expanded limit: ${name}`);
      expandedTotal += uncompressedSize;
      compressedTotal += compressedSize;
      if (expandedTotal > limits.maxExpandedBytes) throw new Error('Bundle exceeds the total expanded size limit.');

      const entry: ZipEntry = {
        name,
        compression,
        crc32: central.readUInt32LE(cursor + 16),
        compressedSize,
        uncompressedSize,
        localHeaderOffset: central.readUInt32LE(cursor + 42),
        isDirectory,
      };
      if (entry.localHeaderOffset === 0xffffffff || entry.localHeaderOffset + 30 > centralOffset) {
        throw new Error(`Invalid local ZIP header offset: ${name}`);
      }
      entries.push(entry);
      byName.set(name, entry);
      cursor += recordLength;
    }
    if (entries.length !== entryCount) throw new Error('ZIP central directory entry count mismatch.');
    if (
      expandedTotal > limits.expansionRatioThresholdBytes &&
      expandedTotal / Math.max(1, compressedTotal) > limits.maxExpansionRatio
    ) {
      throw new Error(`Bundle exceeds the ${limits.maxExpansionRatio}:1 expansion-ratio limit.`);
    }
    const manifest = byName.get('appliance.json');
    if (!manifest || manifest.isDirectory) throw new Error('Bundle is missing root appliance.json.');
    if (manifest.uncompressedSize > limits.maxManifestBytes) {
      throw new Error(`appliance.json exceeds the ${limits.maxManifestBytes}-byte limit.`);
    }
    return { filePath: absolute, archiveSize: stat.size, dataEndOffset: centralOffset, entries, byName, limits };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readManifestFromZip(zip: InspectedZip): ReadBundleManifestResult {
  const bytes = readEntry(zip, requiredEntry(zip, 'appliance.json'));
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
    throw new Error('appliance.json must not have a BOM.');
  const text = decodeUtf8(bytes, 'appliance.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`appliance.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const classification = classifyBundleManifest(manifest);
  return { classification, manifest: manifest as Record<string, unknown> };
}

function readEntry(zip: InspectedZip, entry: ZipEntry): Buffer {
  if (entry.isDirectory) return Buffer.alloc(0);
  const descriptor = fs.openSync(zip.filePath, 'r');
  try {
    const header = Buffer.allocUnsafe(30);
    readExactly(descriptor, header, entry.localHeaderOffset, `local ZIP header for ${entry.name}`);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`Invalid local ZIP header: ${entry.name}`);
    if ((header.readUInt16LE(6) & 0x1) !== 0) throw new Error(`Encrypted ZIP entry: ${entry.name}`);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const nameBytes = Buffer.allocUnsafe(nameLength);
    readExactly(descriptor, nameBytes, entry.localHeaderOffset + 30, `local ZIP name for ${entry.name}`);
    if (decodeUtf8(nameBytes, 'local ZIP entry name') !== entry.name) {
      throw new Error(`ZIP local/central path mismatch: ${entry.name}`);
    }
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    if (dataOffset + entry.compressedSize > zip.dataEndOffset || dataOffset + entry.compressedSize > zip.archiveSize) {
      throw new Error(`ZIP entry data exceeds archive bounds: ${entry.name}`);
    }
    const compressed = Buffer.allocUnsafe(entry.compressedSize);
    readExactly(descriptor, compressed, dataOffset, `ZIP entry data for ${entry.name}`);
    const data =
      entry.compression === 0
        ? compressed
        : inflateRawSync(compressed, {
            maxOutputLength: Math.min(entry.uncompressedSize + 1, zip.limits.maxEntryBytes + 1),
          });
    if (data.length !== entry.uncompressedSize) throw new Error(`ZIP entry size mismatch: ${entry.name}`);
    if (crc32(data) !== entry.crc32) throw new Error(`ZIP entry CRC mismatch: ${entry.name}`);
    return data;
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateReferencedPayloads(manifest: ApplianceV2, entries: Map<string, ZipEntry>): void {
  const requireFile = (entryPath: string) => {
    const entry = entries.get(entryPath);
    if (!entry || entry.isDirectory) throw new Error(`Manifest references a missing regular file: ${entryPath}`);
  };
  const requireTarget = (root: string, entrypoint: string) => {
    const prefix = `${root}/`;
    if (![...entries.keys()].some((name) => name.startsWith(prefix) && !entries.get(name)!.isDirectory)) {
      throw new Error(`Binary target root has no files: ${root}`);
    }
    requireFile(`${root}/${entrypoint}`);
  };
  const visit = (node: ApplianceV2 | ApplianceV2Service) => {
    if (node.type === 'container') {
      for (const image of Object.values(node.payload.images)) requireFile(image.path);
    } else if (node.type === 'binary') {
      for (const target of Object.values(node.payload.targets)) requireTarget(target.root, target.entrypoint);
    } else {
      for (const service of Object.values(node.services)) visit(service);
    }
  };
  visit(manifest);
  if (manifest.assets?.icon) requireFile(manifest.assets.icon);
  if (manifest.assets?.readme) requireFile(manifest.assets.readme);
}

function validateEntryPath(entryPath: string, maxBytes: number): void {
  const directory = entryPath.endsWith('/');
  const logical = directory ? entryPath.slice(0, -1) : entryPath;
  const segments = logical.split('/');
  if (
    Buffer.byteLength(entryPath, 'utf8') === 0 ||
    Buffer.byteLength(entryPath, 'utf8') > maxBytes ||
    logical.length === 0 ||
    entryPath.startsWith('/') ||
    entryPath.includes('\\') ||
    entryPath.includes('\0') ||
    /^[A-Za-z]:/.test(entryPath) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe ZIP entry path: ${JSON.stringify(entryPath)}`);
  }
}

function requiredEntry(zip: InspectedZip, name: string): ZipEntry {
  const entry = zip.byName.get(name);
  if (!entry || entry.isDirectory) throw new Error(`Bundle is missing ${name}.`);
  return entry;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function lastSignatureOffset(buffer: Buffer, signature: number): number {
  for (let offset = buffer.length - 4; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function readExactly(descriptor: number, buffer: Buffer, position: number, label: string): void {
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, position + offset);
    if (read === 0) throw new Error(`Truncated ${label}.`);
    offset += read;
  }
}

function ensureSafeDirectory(root: string, directory: string): void {
  const relative = path.relative(root, directory);
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current);
      continue;
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Bundle unpack destination contains a non-directory or symlink: ${current}`);
    }
  }
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
