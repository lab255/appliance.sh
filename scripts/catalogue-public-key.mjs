// Owner-run: APPLIANCE_INDEX_SIGNING_KEY must already be in the environment.
// Outputs public material only. Errors intentionally omit crypto inputs/causes.
import { createPrivateKey, createPublicKey, createHash } from 'node:crypto';
try {
  const value = process.env.APPLIANCE_INDEX_SIGNING_KEY;
  if (!value || !/^ed25519-pkcs8:[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const key = createPrivateKey({ key: Buffer.from(value.slice(14), 'base64url'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error();
  const publicKey = createPublicKey(key).export({ format: 'jwk' }).x;
  const keyId = `ed25519:sha256:${createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex')}`;
  console.log(JSON.stringify({ publicKey: `ed25519:${publicKey}`, keyId }));
} catch {
  console.error('Invalid APPLIANCE_INDEX_SIGNING_KEY; expected an Ed25519 PKCS#8 environment secret.');
  process.exitCode = 1;
}
