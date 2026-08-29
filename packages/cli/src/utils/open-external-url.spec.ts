import { describe, expect, it } from 'vitest';
import { externalUrlCommand } from './open-external-url';

describe('external URL command', () => {
  const url = 'https://example.com/path?first=one&second=two';

  it.each([
    ['darwin', { command: 'open', args: [url] }],
    ['win32', { command: 'cmd.exe', args: ['/C', 'start', '', 'https://example.com/path?first=one^&second=two'] }],
    ['linux', { command: 'xdg-open', args: [url] }],
  ] satisfies Array<[NodeJS.Platform, { command: string; args: string[] }]>)('builds %s argv', (platform, expected) => {
    expect(externalUrlCommand(url, platform)).toEqual(expected);
  });
});
