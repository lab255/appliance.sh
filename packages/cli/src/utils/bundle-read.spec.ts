import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import archiver from 'archiver';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJsonBytes, computeBundleDigest } from './bundle-digest.js';
import { isPathContained, readBundleManifest, unpackBundle, verifyBundle } from './bundle-read.js';
import { readDevSigningKey, signEnvelope } from './bundle-sign.js';
import { writeBundle } from './bundle-write.js';
import { tinyOciTar } from './bundle-oci-fixture.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-read-test-'));
  tempDirs.push(dir);
  return dir;
}

function containerManifest() {
  return {
    manifest: 'v2',
    kind: 'runnable',
    type: 'container',
    name: 'fixture',
    version: '1.0.0',
    license: 'MIT',
    publisher: { name: 'Fixture Publisher' },
    payload: { images: { 'linux/amd64': { path: 'payload/images/test.oci.tar' } } },
  } as const;
}

async function validBundle(dir: string, data: Uint8Array = tinyOciTar()): Promise<string> {
  const outputPath = path.join(dir, 'fixture.appliance.zip');
  await writeBundle({
    outputPath,
    manifest: containerManifest(),
    files: [{ path: 'payload/images/test.oci.tar', data }],
  });
  return outputPath;
}

async function sourceBundle(dir: string): Promise<string> {
  const outputPath = path.join(dir, 'source.appliance.zip');
  const output = fs.createWriteStream(outputPath);
  const archive = archiver('zip');
  const closed = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(output);
  archive.append(JSON.stringify({ manifest: 'v1', type: 'container', name: 'source' }), { name: 'appliance.json' });
  archive.append('FROM scratch', { name: 'Dockerfile' });
  await archive.finalize();
  await closed;
  return outputPath;
}

async function rawZip(
  dir: string,
  filename: string,
  entries: Array<{ name: string; data: string | Uint8Array }>
): Promise<string> {
  const outputPath = path.join(dir, filename);
  const output = fs.createWriteStream(outputPath);
  const archive = archiver('zip');
  const closed = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(output);
  for (const entry of entries) archive.append(Buffer.from(entry.data), { name: entry.name, store: true });
  await archive.finalize();
  await closed;
  return outputPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('bundle reading and verification', () => {
  it('discriminates source and runnable bundles from the root manifest', async () => {
    const dir = tempDir();
    expect(readBundleManifest(await sourceBundle(dir)).classification).toBe('source');
    expect(readBundleManifest(await validBundle(dir))).toMatchObject({
      classification: 'runnable',
      manifest: { manifest: 'v2', kind: 'runnable', type: 'container' },
    });
  });

  it('verifies the digest and safely unpacks regular files', async () => {
    const dir = tempDir();
    const bundle = await validBundle(dir);
    const verified = verifyBundle(bundle);
    expect(verified.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verified.signature).toBeUndefined();
    const unpacked = path.join(dir, 'unpacked');
    unpackBundle(bundle, unpacked);
    expect(fs.readFileSync(path.join(unpacked, 'payload/images/test.oci.tar'))).toEqual(tinyOciTar());
  });

  it('signs a bundle and verifies it with the matching public key', async () => {
    const dir = tempDir();
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = path.join(dir, 'dev-key.pem');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const outputPath = path.join(dir, 'signed.appliance.zip');
    const written = await writeBundle({
      outputPath,
      manifest: containerManifest(),
      files: [{ path: 'payload/images/test.oci.tar', data: tinyOciTar() }],
      signingKeyPath: keyPath,
    });
    const devKey = readDevSigningKey(keyPath);
    expect(verifyBundle(outputPath).signature).toEqual({ keyId: written.keyId, valid: false });
    expect(verifyBundle(outputPath, { publicKey: devKey.publicKeyWire }).signature).toEqual({
      keyId: written.keyId,
      valid: true,
    });
  });

  it('enforces count, manifest, and aggregate expansion limits before extraction', async () => {
    const dir = tempDir();
    const bundle = await validBundle(dir, Buffer.alloc(4096, 0x61));
    expect(() => readBundleManifest(bundle, { maxEntries: 2 })).toThrow('entry limit');
    expect(() => readBundleManifest(bundle, { maxManifestBytes: 10 })).toThrow('appliance.json exceeds');
    expect(() => readBundleManifest(bundle, { expansionRatioThresholdBytes: 1, maxExpansionRatio: 2 })).toThrow(
      'expansion-ratio'
    );
  });

  it.each([
    ['zip-slip', '../load/images/test.oci.tar'],
    ['absolute', '/ayload/images/test.oci.tar'],
  ])('rejects %s paths', async (_label, replacement) => {
    const dir = tempDir();
    const bundle = await validBundle(dir);
    replaceAllSameLength(bundle, 'payload/images/test.oci.tar', replacement);
    expect(() => readBundleManifest(bundle)).toThrow('Unsafe ZIP entry path');
  });

  it.each([
    'CON',
    'con',
    'nul.txt',
    'dir/COM1.log',
    'LPT9',
    'notes.txt:evil.exe',
    'sub/C:evil',
    'a<b',
    'q?.txt',
    'COM¹',
    'CONIN$',
    'conout$.txt',
    'trailing.',
    'trailing ',
    'a/b./c',
  ])('rejects the non-portable Windows path %j', async (entryPath) => {
    const dir = tempDir();
    const bundle = await rawZip(dir, 'unsafe-windows-path.zip', [
      { name: 'appliance.json', data: canonicalJsonBytes(containerManifest()) },
      { name: entryPath, data: 'unsafe' },
    ]);
    expect(() => readBundleManifest(bundle)).toThrow('Unsafe ZIP entry path');
  });

  it.each(['console.txt', 'null', 'COM0', 'LPT0', 'com10'])('accepts the portable path %j', async (entryPath) => {
    const dir = tempDir();
    const bundle = await rawZip(dir, 'portable-windows-path.zip', [
      { name: 'appliance.json', data: canonicalJsonBytes(containerManifest()) },
      { name: entryPath, data: 'portable' },
    ]);
    expect(readBundleManifest(bundle).classification).toBe('runnable');
  });

  it('compares Windows containment without drive-letter casing', () => {
    expect(isPathContained('C:\\x', 'c:\\x', 'win32')).toBe(true);
    expect(isPathContained('C:\\x', 'c:\\x\\child', 'win32')).toBe(true);
    expect(isPathContained('C:\\x', 'c:\\x-other', 'win32')).toBe(false);
  });

  it('rejects symlink entries from Unix ZIP metadata', async () => {
    const dir = tempDir();
    const bundle = await validBundle(dir);
    markCentralEntryAsSymlink(bundle, 'payload/images/test.oci.tar');
    expect(() => readBundleManifest(bundle)).toThrow('not a regular file or directory');
  });

  it('rejects ZIP64 entry counts', async () => {
    const dir = tempDir();
    const bundle = await validBundle(dir);
    markAsZip64EntryCount(bundle);
    expect(() => readBundleManifest(bundle)).toThrow('ZIP64 entry counts');
  });

  it('rejects encrypted entries', async () => {
    const dir = tempDir();
    const bundle = await validBundle(dir);
    markCentralEntryAsEncrypted(bundle, 'payload/images/test.oci.tar');
    expect(() => readBundleManifest(bundle)).toThrow('Encrypted ZIP entries');
  });

  it.each([
    ['duplicate', 'README.md', 'README.md', 'Duplicate ZIP entry'],
    ['case-colliding', 'README.md', 'readme.md', 'Case-colliding ZIP entry'],
  ])('rejects %s names', async (_label, firstName, secondName, expected) => {
    const dir = tempDir();
    const bundle = await rawZip(dir, 'colliding.zip', [
      { name: 'appliance.json', data: canonicalJsonBytes(containerManifest()) },
      { name: firstName, data: 'first' },
      { name: secondName, data: 'second' },
    ]);
    expect(() => readBundleManifest(bundle)).toThrow(expected);
  });

  it('rejects a signature keyId that differs from publisher.keyId', async () => {
    const dir = tempDir();
    const { privateKey } = generateKeyPairSync('ed25519');
    const keyPath = path.join(dir, 'mismatched-key.pem');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const devKey = readDevSigningKey(keyPath);
    const manifest = {
      ...containerManifest(),
      publisher: { name: 'Fixture Publisher', keyId: `ed25519:sha256:${'0'.repeat(64)}` },
    };
    const manifestBytes = canonicalJsonBytes(manifest);
    const image = tinyOciTar();
    const digest = computeBundleDigest([
      { path: 'appliance.json', data: manifestBytes },
      { path: 'payload/images/test.oci.tar', data: image },
    ]);
    const signature = signEnvelope({ digest }, 'bundle', devKey);
    const bundle = await rawZip(dir, 'mismatched-signature.zip', [
      { name: 'appliance.json', data: manifestBytes },
      { name: 'payload/images/test.oci.tar', data: image },
      { name: 'digest', data: `${digest}\n` },
      { name: 'signature.sig', data: `${canonicalJsonBytes(signature).toString('utf8')}\n` },
    ]);

    expect(() => verifyBundle(bundle)).toThrow('Signature keyId does not match appliance.json publisher.keyId');
  });

  it('does not traverse a symlink already present in the unpack destination', async () => {
    const dir = tempDir();
    const bundle = await validBundle(dir);
    const unpacked = path.join(dir, 'unpacked');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(unpacked);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(unpacked, 'payload'));
    expect(() => unpackBundle(bundle, unpacked)).toThrow('destination contains');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects an unpack destination that resolves through a filesystem alias', async () => {
    const dir = tempDir();
    const bundle = await validBundle(dir);
    const outside = path.join(dir, 'outside');
    const unpacked = path.join(dir, 'unpacked');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, unpacked, process.platform === 'win32' ? 'junction' : 'dir');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(() => unpackBundle(bundle, unpacked)).toThrow('destination contains');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'does not traverse a junction already present in the unpack destination',
    async () => {
      const dir = tempDir();
      const bundle = await validBundle(dir);
      const unpacked = path.join(dir, 'unpacked');
      const outside = path.join(dir, 'outside');
      fs.mkdirSync(unpacked);
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(unpacked, 'payload'), 'junction');
      expect(() => unpackBundle(bundle, unpacked)).toThrow('destination contains');
      expect(fs.readdirSync(outside)).toEqual([]);
    }
  );
});

function replaceAllSameLength(filePath: string, before: string, after: string): void {
  expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
  const data = fs.readFileSync(filePath);
  const needle = Buffer.from(before);
  const replacement = Buffer.from(after);
  let cursor = 0;
  while ((cursor = data.indexOf(needle, cursor)) >= 0) {
    replacement.copy(data, cursor);
    cursor += replacement.length;
  }
  fs.writeFileSync(filePath, data);
}

function markCentralEntryAsSymlink(filePath: string, name: string): void {
  const data = fs.readFileSync(filePath);
  const needle = Buffer.from(name);
  const first = data.indexOf(needle);
  const centralName = data.indexOf(needle, first + needle.length);
  expect(centralName).toBeGreaterThan(46);
  const central = centralName - 46;
  expect(data.readUInt32LE(central)).toBe(0x02014b50);
  data.writeUInt16LE((3 << 8) | 20, central + 4);
  data.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
  fs.writeFileSync(filePath, data);
}

function markCentralEntryAsEncrypted(filePath: string, name: string): void {
  const data = fs.readFileSync(filePath);
  const needle = Buffer.from(name);
  const first = data.indexOf(needle);
  const centralName = data.indexOf(needle, first + needle.length);
  expect(centralName).toBeGreaterThan(46);
  const central = centralName - 46;
  expect(data.readUInt32LE(central)).toBe(0x02014b50);
  data.writeUInt16LE(data.readUInt16LE(central + 8) | 0x1, central + 8);
  fs.writeFileSync(filePath, data);
}

function markAsZip64EntryCount(filePath: string): void {
  const data = fs.readFileSync(filePath);
  const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThanOrEqual(0);
  data.writeUInt16LE(0xffff, eocd + 8);
  data.writeUInt16LE(0xffff, eocd + 10);
  fs.writeFileSync(filePath, data);
}
