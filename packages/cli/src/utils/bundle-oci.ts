import { createHash } from 'node:crypto';

interface TarEntry {
  data: Buffer;
}

/** Validate an OCI image-layout tar and its config platform. */
export function validateOciImageTar(data: Uint8Array, declaredPlatform: string): void {
  const entries = parseTar(Buffer.from(data));
  const layout = parseJson(required(entries, 'oci-layout'), 'OCI oci-layout');
  if (!isRecord(layout) || layout.imageLayoutVersion !== '1.0.0') {
    throw new Error('OCI tar has an invalid oci-layout version.');
  }
  const index = parseJson(required(entries, 'index.json'), 'OCI index.json');
  if (!isRecord(index) || !Array.isArray(index.manifests) || index.manifests.length === 0) {
    throw new Error('OCI tar index.json must contain image manifests.');
  }

  let sawImageManifest = false;
  for (const descriptor of index.manifests) {
    if (!isRecord(descriptor) || typeof descriptor.digest !== 'string') continue;
    const manifestBytes = blobForDigest(entries, descriptor.digest);
    const imageManifest = parseJson(manifestBytes, 'OCI image manifest');
    if (
      !isRecord(imageManifest) ||
      !isRecord(imageManifest.config) ||
      typeof imageManifest.config.digest !== 'string'
    ) {
      continue;
    }
    sawImageManifest = true;
    const config = parseJson(blobForDigest(entries, imageManifest.config.digest), 'OCI image config');
    if (!isRecord(config) || typeof config.os !== 'string' || typeof config.architecture !== 'string') {
      throw new Error('OCI image config must declare os and architecture.');
    }
    const actualPlatform = `${config.os}/${config.architecture}${typeof config.variant === 'string' ? `/${config.variant}` : ''}`;
    if (actualPlatform === declaredPlatform) return;
  }
  if (!sawImageManifest) throw new Error('OCI tar contains no readable image manifest.');
  throw new Error(`OCI image config platform does not match ${declaredPlatform}.`);
}

function parseTar(data: Buffer): Map<string, TarEntry> {
  const entries = new Map<string, TarEntry>();
  const seenPaths = new Set<string>();
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (data.subarray(offset).some((byte) => byte !== 0)) throw new Error('OCI tar has data after its end marker.');
      return entries;
    }
    validateTarChecksum(header);
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const type = header[156];
    const isDirectory = type === 0x35;
    const entryPath = isDirectory && archivePath.endsWith('/') ? archivePath.slice(0, -1) : archivePath;
    validateTarPath(entryPath);
    const size = parseTarOctal(header.subarray(124, 136), `size for ${entryPath}`);
    const dataOffset = offset + 512;
    const nextOffset = dataOffset + Math.ceil(size / 512) * 512;
    if (nextOffset > data.length) throw new Error(`OCI tar entry is truncated: ${entryPath}`);
    if (seenPaths.has(entryPath)) throw new Error(`OCI tar has a duplicate entry: ${entryPath}`);
    seenPaths.add(entryPath);
    if (type === 0 || type === 0x30) entries.set(entryPath, { data: data.subarray(dataOffset, dataOffset + size) });
    else if (type !== 0x35) throw new Error(`OCI tar entry is not a regular file or directory: ${entryPath}`);
    offset = nextOffset;
  }
  throw new Error('OCI tar is missing its end marker.');
}

function blobForDigest(entries: Map<string, TarEntry>, digest: string): Buffer {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`OCI descriptor digest is malformed: ${digest}`);
  const hex = digest.slice('sha256:'.length);
  const bytes = required(entries, `blobs/sha256/${hex}`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== hex) throw new Error(`OCI blob digest mismatch: ${digest}`);
  return bytes;
}

function required(entries: Map<string, TarEntry>, entryPath: string): Buffer {
  const entry = entries.get(entryPath);
  if (!entry) throw new Error(`OCI tar is missing ${entryPath}.`);
  return entry.data;
}

function parseJson(data: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON.`);
  }
}

function validateTarChecksum(header: Buffer): void {
  const expected = parseTarOctal(header.subarray(148, 156), 'header checksum');
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error('OCI tar header checksum mismatch.');
}

function parseTarOctal(field: Uint8Array, label: string): number {
  const value = tarString(field).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error(`OCI tar has an invalid ${label}.`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error(`OCI tar ${label} exceeds the safe integer range.`);
  return parsed;
}

function tarString(field: Uint8Array): string {
  const end = field.indexOf(0);
  const bytes = end < 0 ? field : field.subarray(0, end);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('OCI tar header contains invalid UTF-8.');
  }
}

function validateTarPath(entryPath: string): void {
  if (
    !entryPath ||
    entryPath.startsWith('/') ||
    entryPath.includes('\\') ||
    entryPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`OCI tar has an unsafe path: ${entryPath}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
