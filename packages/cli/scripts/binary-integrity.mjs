import { createHash, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function credentialHelperAssetName(triple) {
  const extension = triple.includes('windows') ? '.exe' : '';
  return `appliance-credhelper-${triple}${extension}`;
}

export function credentialHelperInstallPath(packageDirectory, platform) {
  const extension = platform === 'win32' ? '.exe' : '';
  return path.join(packageDirectory, 'bin', `appliance-credhelper${extension}`);
}

export function expectedCredentialHelperDigest(manifest, triple) {
  const digest = manifest?.digests?.[triple];
  if (typeof digest !== 'string' || !SHA256_PATTERN.test(digest) || /^0+$/.test(digest)) {
    throw new Error(`published package has no valid baked SHA-256 for appliance-credhelper-${triple}`);
  }
  return digest;
}

/**
 * Verify a fully downloaded helper before it reaches its canonical filename.
 * Every failure removes the candidate so a caller cannot accidentally execute
 * an unverified partial or mismatched binary.
 */
export function verifyDownloadedSha256(filePath, expectedDigest) {
  try {
    if (!SHA256_PATTERN.test(expectedDigest)) {
      throw new Error('expected credential-helper SHA-256 is malformed');
    }
    const actualDigest = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const actual = Buffer.from(actualDigest, 'hex');
    const expected = Buffer.from(expectedDigest, 'hex');
    if (!timingSafeEqual(actual, expected)) {
      throw new Error(`credential-helper SHA-256 mismatch (expected ${expectedDigest}, got ${actualDigest})`);
    }
    return actualDigest;
  } catch (error) {
    fs.rmSync(filePath, { force: true });
    throw error;
  }
}
