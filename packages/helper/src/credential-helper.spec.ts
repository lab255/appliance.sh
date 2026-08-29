import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCredHelperSibling } from './credential-helper.js';

describe('resolveCredHelperPath sibling contract', () => {
  it('returns the absolute Windows sibling of the running executable', () => {
    const executable = String.raw`C:\Program Files\Appliance\appliance-bin.exe`;
    expect(resolveCredHelperSibling(executable, 'win32')).toBe(
      String.raw`C:\Program Files\Appliance\appliance-credhelper.exe`
    );
  });

  it('is structured per target without consulting PATH or cwd', () => {
    const executable = path.resolve('/opt/appliance/appliance-bin');
    expect(resolveCredHelperSibling(executable, 'darwin')).toBe(
      path.join(path.dirname(executable), 'appliance-credhelper')
    );
    expect(resolveCredHelperSibling(executable, 'linux')).toBe(
      path.join(path.dirname(executable), 'appliance-credhelper')
    );
  });

  it('rejects a relative executable instead of resolving it through cwd', () => {
    expect(() => resolveCredHelperSibling('appliance-bin.exe', 'win32')).toThrow(/non-absolute/);
  });
});
