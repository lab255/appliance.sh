import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { ableAccount, ableAccountStatusJson } from './able-account.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('./credential-helper.js', () => ({ resolveCredHelperPath: () => '/trusted/appliance-credhelper' }));
const signedOut = { signedIn: false, email: null, subject: null, revocationFailed: false };
const run = vi.mocked(execFile);
beforeEach(() => vi.clearAllMocks());
describe('able native helper boundary', () => {
  it('passes only action and explicit switch confirmation in argv', async () => {
    run.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
      callback(null, JSON.stringify(signedOut), '');
      return {} as ReturnType<typeof execFile>;
    });
    expect(await ableAccount('sign-in', true)).toEqual(signedOut);
    expect(run.mock.calls[0].slice(0, 2)).toEqual([
      '/trusted/appliance-credhelper',
      ['account', 'sign-in', '--switch-account'],
    ]);
  });
  it('propagates a retryable native failure without serializing exec errors', async () => {
    run.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
      callback(new Error('exec details'), '', 'Sign-in port 43103 is in use. Close the process using it and retry.');
      return {} as ReturnType<typeof execFile>;
    });
    await expect(ableAccount('sign-in')).rejects.toThrow(
      'Sign-in port 43103 is in use. Close the process using it and retry.'
    );
  });
  it('preserves native status JSON whitespace and trailing newline verbatim', async () => {
    const json = JSON.stringify(signedOut, null, 2) + '\n';
    run.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
      callback(null, json, '');
      return {} as ReturnType<typeof execFile>;
    });
    expect(await ableAccountStatusJson()).toBe(json);
    expect(run.mock.calls[0].slice(0, 2)).toEqual(['/trusted/appliance-credhelper', ['account', 'status']]);
  });
  it('rejects malformed helper output', async () => {
    run.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
      callback(null, '{}', '');
      return {} as ReturnType<typeof execFile>;
    });
    await expect(ableAccount('status')).rejects.toThrow('Invalid account status');
  });
});
