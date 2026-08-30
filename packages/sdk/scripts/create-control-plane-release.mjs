import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { signReleaseEnvelope, verifyReleaseEnvelope } = require('../dist/cjs/models/release-trust.js');
const { getPublicKeyAsync } = require('@noble/ed25519');

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

function generationForVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.replace(/^v/, ''));
  if (!match) throw new Error(`RELEASE_VERSION is not semver: ${version}`);
  const [, majorRaw, minorRaw, patchRaw] = match;
  const [major, minor, patch] = [majorRaw, minorRaw, patchRaw].map(Number);
  if (minor >= 1000 || patch >= 1000) throw new Error('semver generation requires minor and patch below 1000');
  const generation = major * 1_000_000 + minor * 1_000 + patch;
  if (!Number.isSafeInteger(generation)) throw new Error('semver release generation exceeds JavaScript safe integer');
  return generation;
}

async function selfCheck() {
  const privateKey = new Uint8Array(randomBytes(32));
  const publicKey = await getPublicKeyAsync(privateKey);
  const keyId = `ed25519:sha256:${createHash('sha256').update(publicKey).digest('hex')}`;
  const payload = {
    kind: 'control-plane-release',
    version: '0.0.0-dev',
    generation: 1,
    notBefore: '2026-01-01T00:00:00Z',
    expires: '2026-01-02T00:00:00Z',
    artifacts: [
      { name: 'appliance-api-server-linux-x64', arch: 'x64', sha256: 'a'.repeat(64), size: 1 },
      { name: 'appliance-api-server-linux-arm64', arch: 'arm64', sha256: 'b'.repeat(64), size: 1 },
      { name: 'appliance-console.tar.gz', arch: 'any', sha256: 'c'.repeat(64), size: 1 },
    ],
    image: { repository: 'ghcr.io/appliance-sh/api-server', manifestDigest: `sha256:${'d'.repeat(64)}` },
  };
  const envelope = await signReleaseEnvelope(payload, privateKey);
  await verifyReleaseEnvelope(
    payload,
    envelope,
    { keys: { [keyId]: `ed25519:${Buffer.from(publicKey).toString('base64url')}` }, generationFloor: 1 },
    { now: new Date('2026-01-01T12:00:00Z') }
  );
  console.log('control-plane release signing self-check passed with a throwaway key');
}

if (process.argv.includes('--check')) {
  await selfCheck();
  process.exit(0);
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

const version = required('RELEASE_VERSION').replace(/^v/, '');
const expectedGeneration = generationForVersion(version);
const generation = Number(required('RELEASE_GENERATION'));
if (generation !== expectedGeneration) {
  throw new Error(`RELEASE_GENERATION ${generation} does not match semver-derived generation ${expectedGeneration}`);
}
const previousGenerationRaw = process.env.RELEASE_PREVIOUS_GENERATION?.trim();
if (previousGenerationRaw) {
  const previousGeneration = Number(previousGenerationRaw);
  if (!Number.isSafeInteger(previousGeneration) || generation <= previousGeneration) {
    throw new Error(
      `release generation ${generation} must exceed previously published generation ${previousGenerationRaw}`
    );
  }
}

const payload = {
  kind: 'control-plane-release',
  version,
  generation,
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
