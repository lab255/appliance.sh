import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { signReleaseEnvelope } = require('../dist/cjs/models/release-trust.js');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function rawSigningKey() {
  const encoded = required('APPLIANCE_RELEASE_SIGNING_KEY');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('APPLIANCE_RELEASE_SIGNING_KEY must be standard base64');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('APPLIANCE_RELEASE_SIGNING_KEY must decode to a raw 32-byte Ed25519 seed');
  return new Uint8Array(key);
}

const assetDirectory = path.resolve(required('RELEASE_ASSET_DIR'));
const outputDirectory = path.resolve(required('RELEASE_OUTPUT_DIR'));
const assets = [
  ['appliance-api-server-linux-x64', 'x64'],
  ['appliance-api-server-linux-arm64', 'arm64'],
  ['appliance-console.tar.gz', 'any'],
];

const artifactRecords = await Promise.all(
  assets.map(async ([name, arch]) => {
    const file = path.join(assetDirectory, name);
    const [bytes, metadata] = await Promise.all([readFile(file), stat(file)]);
    if (!metadata.isFile() || metadata.size === 0) throw new Error(`${name} is missing or empty`);
    return {
      name,
      arch,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: metadata.size,
    };
  })
);

const payload = {
  kind: 'control-plane-release',
  version: required('RELEASE_VERSION').replace(/^v/, ''),
  generation: Number(required('RELEASE_GENERATION')),
  notBefore: required('RELEASE_NOT_BEFORE'),
  expires: required('RELEASE_EXPIRES'),
  artifacts: artifactRecords,
  image: {
    repository: required('RELEASE_IMAGE_REPOSITORY'),
    manifestDigest: required('RELEASE_IMAGE_MANIFEST_DIGEST'),
  },
};

const envelope = await signReleaseEnvelope(payload, rawSigningKey());
const checksums = artifactRecords.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join('\n') + '\n';
await Promise.all([
  writeFile(path.join(outputDirectory, 'SHA256SUMS'), checksums, { mode: 0o644 }),
  writeFile(path.join(outputDirectory, 'control-plane-release.json'), `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o644,
  }),
  writeFile(path.join(outputDirectory, 'control-plane-release.sig.json'), `${JSON.stringify(envelope, null, 2)}\n`, {
    mode: 0o644,
  }),
]);
console.log(`signed control-plane release ${payload.version} with ${envelope.keyId}`);
