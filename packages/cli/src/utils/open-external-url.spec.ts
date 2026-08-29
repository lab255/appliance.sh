import { describe, expect, it } from 'vitest';
import { EXTERNAL_URL_SPAWN_OPTIONS, externalUrlCommand } from './open-external-url';

describe('external URL command', () => {
  it('spawns directly without a shell', () => {
    expect(EXTERNAL_URL_SPAWN_OPTIONS).toMatchObject({ shell: false });
  });

  const urls = [
    ['ampersand', 'https://example.com/path?first=one&second=two'],
    ['percent pair', 'https://example.com/path?directory=%APPDATA%'],
    ['caret', 'https://example.com/path?value=left^right'],
  ] as const;

  it.each(urls)('preserves a URL containing an %s across the 3-platform argv', (_hazard, url) => {
    expect(externalUrlCommand(url, 'darwin')).toEqual({ command: 'open', args: [url] });
    expect(externalUrlCommand(url, 'win32')).toEqual({
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', url],
    });
    expect(externalUrlCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] });
  });
});
