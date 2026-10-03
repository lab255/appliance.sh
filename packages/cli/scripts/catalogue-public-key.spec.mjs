import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/catalogue-public-key.mjs', import.meta.url));
it('derives only public fields from an environment-only PKCS8 secret', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const secret = `ed25519-pkcs8:${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')}`;
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, APPLIANCE_INDEX_SIGNING_KEY: secret },
  });
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    publicKey: `ed25519:${raw.toString('base64url')}`,
    keyId: `ed25519:sha256:${createHash('sha256').update(raw).digest('hex')}`,
  });
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toContain(secret);
});
it('does not echo malformed private inputs or crypto errors', () => {
  const secret = 'ed25519-pkcs8:DISTINCTIVE_FAKE_SECRET';
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, APPLIANCE_INDEX_SIGNING_KEY: secret },
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain('DISTINCTIVE_FAKE_SECRET');
  expect(result.stderr).not.toContain('Error:');
});
