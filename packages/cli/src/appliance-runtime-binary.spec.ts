import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
const dockerReady =
  spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('docker', ['image', 'inspect', 'golang:1.22-alpine'], { stdio: 'ignore' }).status === 0;
const dockerElfTest = dockerReady ? it : it.skip;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('binary Runtime ELF fixture', () => {
  dockerElfTest(
    dockerReady
      ? 'generates a tiny static Linux ELF at test time'
      : 'generates a tiny static Linux ELF at test time (skipped: Docker or cached golang:1.22-alpine unavailable)',
    () => {
      // Docker Desktop may not share the host's private temporary directory;
      // keep this generated-only fixture under the already-shared checkout.
      const dir = fs.mkdtempSync(path.join(process.cwd(), '.runtime-elf-'));
      dirs.push(dir);
      fs.writeFileSync(path.join(dir, 'main.go'), 'package main\nfunc main() {}\n');
      const mountedDir = fs.realpathSync(dir);
      const result = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${mountedDir}:/work`,
          '-w',
          '/work',
          'golang:1.22-alpine',
          'sh',
          '-c',
          'GO111MODULE=off CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /tmp/tiny main.go && cat /tmp/tiny',
        ],
        { encoding: null, maxBuffer: 10 * 1024 * 1024 }
      );
      expect(result.status, result.stderr.toString('utf8')).toBe(0);
      fs.writeFileSync(path.join(dir, 'tiny'), result.stdout);
      expect(result.stdout.subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    }
  );
});
