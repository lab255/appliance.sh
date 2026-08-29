import * as path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_CREDENTIAL_IDENTIFIER_LENGTH = 64;
const HASH_SUFFIX_HEX_LENGTH = 12;

/**
 * Encode a free-form name before every credential-helper boundary.
 *
 * This is the TypeScript twin of credential-store's `encode_identifier`.
 * UTF-8 bytes are percent-encoded outside the store allowlist, with a stable
 * SHA-256 tail when the result would exceed 64 bytes.
 */
export function encodeCredentialIdentifier(value: string): string {
  const tokens: string[] = [];
  for (const [index, byte] of Buffer.from(value, 'utf8').entries()) {
    const allowed =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (index > 0 && (byte === 0x2e || byte === 0x5f || byte === 0x2d));
    tokens.push(allowed ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`);
  }

  const encoded = tokens.join('');
  if (encoded.length > 0 && encoded.length <= MAX_CREDENTIAL_IDENTIFIER_LENGTH) return encoded;

  const suffix = `-${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, HASH_SUFFIX_HEX_LENGTH)}`;
  const prefixBudget = MAX_CREDENTIAL_IDENTIFIER_LENGTH - suffix.length;
  let prefix = '';
  for (const token of tokens) {
    if (prefix.length + token.length > prefixBudget) break;
    prefix += token;
  }
  if (prefix.length === 0) prefix = 'id';
  return `${prefix}${suffix}`;
}

/**
 * Resolve the credential helper as a sibling of the running executable.
 *
 * This intentionally has no PATH, cwd, environment, or search fallback. A
 * missing sibling is a credential error for the card-2 caller, never a reason
 * to execute a same-named program from somewhere else.
 */
export function resolveCredHelperPath(): string {
  return resolveCredHelperSibling(process.execPath, process.platform);
}

/** Pure seam for platform-independent tests; not part of the package barrel. */
export function resolveCredHelperSibling(executablePath: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(executablePath)) {
    throw new Error('Cannot resolve appliance-credhelper from a non-absolute executable path.');
  }
  if (
    !['appliance-bin', 'appliance-bin.exe', 'appliance', 'appliance.exe'].includes(pathApi.basename(executablePath))
  ) {
    throw new Error('credential helper is unavailable outside a packaged CLI');
  }
  const extension = platform === 'win32' ? '.exe' : '';
  return pathApi.join(pathApi.dirname(executablePath), `appliance-credhelper${extension}`);
}
