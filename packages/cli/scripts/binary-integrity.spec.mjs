import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  credentialHelperAssetName,
  credentialHelperInstallPath,
  expectedCredentialHelperDigest,
  verifyDownloadedSha256,
} from './binary-integrity.mjs';

const temporaryDirectories = [];

function candidate(bytes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-helper-digest-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'appliance-credhelper.exe.verifying');
  fs.writeFileSync(file, bytes);
  return file;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('credential helper digest verification', () => {
  it('accepts a byte-exact SHA-256 and keeps the candidate', () => {
    const file = candidate(Buffer.from('verified helper'));
    const digest = createHash('sha256').update('verified helper').digest('hex');
    expect(verifyDownloadedSha256(file, digest)).toBe(digest);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('deletes a candidate whose digest does not match', () => {
    const file = candidate(Buffer.from('swapped helper'));
    expect(() => verifyDownloadedSha256(file, '1'.repeat(64))).toThrow(/SHA-256 mismatch/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('fails closed when the published package lacks a baked digest', () => {
    expect(() => expectedCredentialHelperDigest({ digests: {} }, 'x86_64-pc-windows-msvc')).toThrow(
      /no valid baked SHA-256/
    );
    expect(expectedCredentialHelperDigest({ digests: { test: 'a'.repeat(64) } }, 'test')).toBe('a'.repeat(64));
  });
});

describe('credential helper npm and release layouts', () => {
  it('installs beside appliance-bin.exe and derives per-target release assets', () => {
    const packageDirectory = path.resolve('/npm/@appliance.sh/cli');
    const helper = credentialHelperInstallPath(packageDirectory, 'win32');
    const cli = path.join(packageDirectory, 'bin', 'appliance-bin.exe');
    expect(helper).toBe(path.join(packageDirectory, 'bin', 'appliance-credhelper.exe'));
    expect(path.dirname(helper)).toBe(path.dirname(cli));
    expect(credentialHelperAssetName('x86_64-pc-windows-msvc')).toBe('appliance-credhelper-x86_64-pc-windows-msvc.exe');
    expect(credentialHelperAssetName('aarch64-apple-darwin')).toBe('appliance-credhelper-aarch64-apple-darwin');

    const packageManifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf-8'));
    expect(packageManifest.files).toContain('scripts');
    expect(packageManifest.scripts.postinstall).toBe('node scripts/install-binary.mjs');
  });

  it('publishes every existing target with a sibling SHA-256 asset', () => {
    const workflow = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../.github/workflows/release-cli-binaries.yml'),
      'utf-8'
    );
    for (const triple of [
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
    ]) {
      expect(workflow).toContain(`triple: ${triple}`);
    }
    expect(workflow).toContain('appliance-credhelper-x86_64-pc-windows-msvc.exe');
    expect(workflow).toContain('uses: ./.github/workflows/credential-helper.yml');
    expect(workflow).toContain('needs: credential-helper');
    expect(workflow).toContain('name: credential-helper-canonical');
    expect(workflow).toContain('"$OUT/$ASSET.sha256"');
    expect(workflow).toContain('verify-credential-helper-digest.mjs');
  });

  it('guards the canonical desktop helper with the CLI baked digest', () => {
    const workflow = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../.github/workflows/release-desktop.yml'),
      'utf-8'
    );
    expect(workflow).toContain('uses: ./.github/workflows/credential-helper.yml');
    expect(workflow).toContain('needs: credential-helper');
    expect(workflow).toContain('name: credential-helper-canonical');
    expect(workflow).toContain('packages/cli/scripts/verify-credential-helper-digest.mjs');
    expect(workflow).toContain('packages/desktop/src-tauri/binaries/appliance-credhelper-x86_64-pc-windows-msvc.exe');
  });
});

describe('canonical Windows helper packaging', () => {
  function packageHelper(bytes) {
    const helper = candidate(bytes);
    const root = path.dirname(helper);
    for (const relative of ['packages/desktop/scripts', 'packages/cli/scripts', 'packages/cli/dist']) {
      fs.mkdirSync(path.join(root, relative), { recursive: true });
    }
    const repository = path.resolve(import.meta.dirname, '../../..');
    for (const relative of [
      'packages/desktop/scripts/copy-cli.mjs',
      'packages/cli/scripts/verify-credential-helper-digest.mjs',
    ]) {
      fs.copyFileSync(path.join(repository, relative), path.join(root, relative));
    }
    fs.writeFileSync(
      path.join(root, 'packages/cli/scripts/credential-helper-checksums.json'),
      JSON.stringify({
        digests: { 'x86_64-pc-windows-msvc': createHash('sha256').update('canonical helper').digest('hex') },
      })
    );
    fs.writeFileSync(path.join(root, 'packages/cli/dist/appliance.exe'), 'compiled CLI');
    const result = spawnSync(process.execPath, [path.join(root, 'packages/desktop/scripts/copy-cli.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: '',
        APPLIANCE_TARGET_TRIPLE: 'x86_64-pc-windows-msvc',
        APPLIANCE_CREDHELPER_BINARY: helper,
      },
    });
    return {
      result,
      destination: path.join(
        root,
        'packages/desktop/src-tauri/binaries/appliance-credhelper-x86_64-pc-windows-msvc.exe'
      ),
    };
  }

  it('copies the verified artifact unchanged without requiring a native builder', () => {
    const { result, destination } = packageHelper('canonical helper');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(fs.readFileSync(destination, 'utf8')).toBe('canonical helper');
  });

  it('refuses a substituted artifact before staging desktop sidecars', () => {
    const { result, destination } = packageHelper('substituted helper');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('do not match byte-for-byte');
    expect(fs.existsSync(destination)).toBe(false);
  });
});
