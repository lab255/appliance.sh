import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const copyScript = readFileSync(resolve(here, '../scripts/copy-cli.mjs'), 'utf-8');
const tauriConfig = JSON.parse(readFileSync(resolve(here, '../src-tauri/tauri.conf.json'), 'utf-8')) as {
  bundle: { externalBin: string[] };
};

describe('desktop credential-helper resource layout', () => {
  it('builds a target-matched helper and stages it beside the CLI external binary', () => {
    expect(copyScript).toContain('`appliance-${triple}${ext}`');
    expect(copyScript).toContain('`appliance-credhelper-${triple}${ext}`');
    expect(copyScript).toContain("path.join(credhelperRoot, 'target', triple, 'release'");
  });

  it('declares both sibling executables as Tauri external binaries', () => {
    expect(tauriConfig.bundle.externalBin).toEqual(['binaries/appliance', 'binaries/appliance-credhelper']);
  });
});
