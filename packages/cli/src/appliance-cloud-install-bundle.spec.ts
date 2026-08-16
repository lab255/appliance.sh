import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('standalone cloud installer bundle', () => {
  it('loads the embedded CloudFormation YAML outside the workspace', () => {
    const directory = mkdtempSync(join(tmpdir(), 'appliance-cloud-bundle-'));
    const binary = join(directory, process.platform === 'win32' ? 'appliance.exe' : 'appliance');
    try {
      execFileSync('bun', ['build', 'src/appliance.ts', '--compile', `--outfile=${binary}`], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });
      const help = execFileSync(binary, ['cloud', 'install', '--help'], {
        cwd: directory,
        encoding: 'utf8',
      });
      expect(help).toContain('install the Appliance control plane in AWS with CloudFormation');
      expect(help).toContain('--arch <architecture>');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
