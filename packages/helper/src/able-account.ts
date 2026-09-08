import { execFile } from 'node:child_process';
import { resolveCredHelperPath } from './credential-helper.js';

/** Redacted identity only. Credentials never cross this IPC boundary. */
export interface AbleAccountStatus {
  signedIn: boolean;
  email: string | null;
  subject: string | null;
  revocationFailed: boolean;
}

export function ableAccount(
  action: 'sign-in' | 'status' | 'refresh' | 'sign-out',
  switchAccount = false
): Promise<AbleAccountStatus> {
  return new Promise((resolve, reject) => {
    const args = ['account', action];
    if (action === 'sign-in' && switchAccount) args.push('--switch-account');
    execFile(resolveCredHelperPath(), args, { timeout: 340_000, maxBuffer: 16_384 }, (error, stdout, stderr) => {
      // The native helper emits fixed diagnostics, never server responses or URLs.
      if (error) return reject(new Error(stderr.trim() || 'Account operation failed. Please retry.'));
      try {
        const status = JSON.parse(stdout) as AbleAccountStatus;
        if (typeof status.signedIn !== 'boolean') throw new Error('Invalid account status');
        resolve(status);
      } catch {
        reject(new Error('Invalid account status from native helper.'));
      }
    });
  });
}
