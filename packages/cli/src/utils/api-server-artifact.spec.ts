import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PINNED_RELEASE_TRUST, VERSION, signReleaseEnvelope, type ReleaseEnvelope } from '@appliance.sh/sdk';

import { ensureApiServerArtifacts, guestAssetsDir, stageFromRelease } from './api-server-artifact.js';

// Redirect the guest-assets dir (~/.appliance/vm/images/guest-assets)
// into a per-test temp home.
const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => state.home };
});

const GUEST_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

describe('ensureApiServerArtifacts with APPLIANCE_API_SERVER_BINARY', () => {
  let home: string;
  let work: string;

  const staged = () => path.join(guestAssetsDir(), 'appliance-api-server');
  const stagedConsole = () => path.join(guestAssetsDir(), 'appliance-console.tar.gz');
  const stampFile = () => path.join(guestAssetsDir(), 'appliance-api-server.version');

  function overrideBinary(content: string): string {
    const p = path.join(work, `appliance-api-server-linux-${GUEST_ARCH}`);
    fs.writeFileSync(p, content);
    return p;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'api-server-artifact-home-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'api-server-artifact-work-'));
    state.home = home;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.APPLIANCE_API_SERVER_BINARY;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('warns and falls back when the override points at a missing file', async () => {
    // A stale export in a shell profile must not brick bring-up when
    // valid staged artifacts exist — the override is ignored and the
    // matching VERSION stamp short-circuits.
    fs.mkdirSync(guestAssetsDir(), { recursive: true });
    fs.writeFileSync(staged(), 'previously-staged');
    fs.writeFileSync(stampFile(), `${VERSION}:${GUEST_ARCH}`);
    process.env.APPLIANCE_API_SERVER_BINARY = path.join(work, 'nope');

    await expect(ensureApiServerArtifacts()).resolves.toBeUndefined();

    expect(fs.readFileSync(staged(), 'utf8')).toBe('previously-staged');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path.join(work, 'nope')));
  });

  it('restages over a VERSION-stamped staged binary (stamp bypass)', async () => {
    // A previous release/repo staging left a matching VERSION stamp —
    // without the override-aware stamp this would short-circuit and
    // keep the stale binary.
    fs.mkdirSync(guestAssetsDir(), { recursive: true });
    fs.writeFileSync(staged(), 'stale-release-build');
    fs.writeFileSync(stampFile(), `${VERSION}:${GUEST_ARCH}`);
    process.env.APPLIANCE_API_SERVER_BINARY = overrideBinary('fresh-dev-build');

    await ensureApiServerArtifacts();

    expect(fs.readFileSync(staged(), 'utf8')).toBe('fresh-dev-build');
    expect(fs.readFileSync(stampFile(), 'utf8')).toMatch(/^override:/);
  });

  it('short-circuits on an unchanged override, restages on a changed one', async () => {
    const bin = overrideBinary('build-one');
    process.env.APPLIANCE_API_SERVER_BINARY = bin;
    await ensureApiServerArtifacts();

    // Drift the staged copy: an unchanged override must not rewrite it.
    fs.chmodSync(staged(), 0o600);
    fs.writeFileSync(staged(), 'tampered');
    await ensureApiServerArtifacts();
    expect(fs.readFileSync(staged(), 'utf8')).toBe('tampered');

    // A rebuilt override (new size + mtime) restages.
    fs.writeFileSync(bin, 'build-two!');
    fs.utimesSync(bin, new Date(), new Date(Date.now() + 5000));
    await ensureApiServerArtifacts();
    expect(fs.readFileSync(staged(), 'utf8')).toBe('build-two!');
  });

  it('stages a console tarball shipped next to the override binary', async () => {
    fs.writeFileSync(path.join(work, 'appliance-console.tar.gz'), 'tar-bytes');
    process.env.APPLIANCE_API_SERVER_BINARY = overrideBinary('bin');

    await ensureApiServerArtifacts();

    expect(fs.readFileSync(stagedConsole(), 'utf8')).toBe('tar-bytes');
  });

  it('drops a previously staged console tarball when the override has no sibling', async () => {
    // A release download left a console tar behind — keeping it would
    // pair an old web console with the new override server.
    fs.mkdirSync(guestAssetsDir(), { recursive: true });
    fs.writeFileSync(stagedConsole(), 'old-release-console');
    process.env.APPLIANCE_API_SERVER_BINARY = overrideBinary('bin');

    await ensureApiServerArtifacts();

    expect(fs.existsSync(stagedConsole())).toBe(false);
  });

  it('restages on a console-only rebuild (unchanged override binary)', async () => {
    const tar = path.join(work, 'appliance-console.tar.gz');
    fs.writeFileSync(tar, 'console-one');
    process.env.APPLIANCE_API_SERVER_BINARY = overrideBinary('bin');
    await ensureApiServerArtifacts();

    // Only the tarball changes (new size + mtime) — the binary stamp
    // alone would short-circuit and keep the stale console.
    fs.writeFileSync(tar, 'console-two!');
    fs.utimesSync(tar, new Date(), new Date(Date.now() + 5000));
    await ensureApiServerArtifacts();

    expect(fs.readFileSync(stagedConsole(), 'utf8')).toBe('console-two!');
  });
});

describe('stageFromRelease signed metadata gate', () => {
  let destination: string;
  const releaseDevFixturePrivateKey = new Uint8Array(32).fill(42);
  const binary = Buffer.from('signed-x64-binary');
  const armBinary = Buffer.from('signed-arm64-binary');
  const consoleBundle = Buffer.from('signed-console-tarball');

  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

  function payload(): ReleaseEnvelope {
    return {
      kind: 'control-plane-release',
      version: '1.57.0',
      generation: 225,
      notBefore: '2026-08-29T00:00:00Z',
      expires: '2027-08-29T00:00:00Z',
      artifacts: [
        {
          name: 'appliance-api-server-linux-x64',
          arch: 'x64',
          sha256: digest(binary),
          size: binary.length,
        },
        {
          name: 'appliance-api-server-linux-arm64',
          arch: 'arm64',
          sha256: digest(armBinary),
          size: armBinary.length,
        },
        {
          name: 'appliance-console.tar.gz',
          arch: 'any',
          sha256: digest(consoleBundle),
          size: consoleBundle.length,
        },
      ],
      image: {
        repository: 'ghcr.io/appliance-sh/api-server',
        manifestDigest: `sha256:${'d'.repeat(64)}`,
      },
    };
  }

  function fakeFetcher(files: Record<string, BodyInit>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const pathname = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname;
      const name = pathname.slice(pathname.lastIndexOf('/') + 1);
      return name in files ? new Response(files[name], { status: 200 }) : new Response('missing', { status: 404 });
    }) as typeof fetch;
  }

  beforeEach(() => {
    destination = fs.mkdtempSync(path.join(os.tmpdir(), 'api-server-release-stage-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(destination, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('stages a signed release only after binding version, arch, size, and sha256', async () => {
    const release = payload();
    const envelope = await signReleaseEnvelope(release, releaseDevFixturePrivateKey);
    const fetcher = fakeFetcher({
      'control-plane-release.json': JSON.stringify(release),
      'control-plane-release.sig.json': JSON.stringify(envelope),
      'appliance-api-server-linux-x64': binary,
      'appliance-console.tar.gz': consoleBundle,
    });

    await stageFromRelease({
      version: '1.57.0',
      arch: 'x64',
      destinationDir: destination,
      fetcher,
      trust: PINNED_RELEASE_TRUST,
      now: new Date('2026-08-30T00:00:00Z'),
    });

    expect(fs.readFileSync(path.join(destination, 'appliance-api-server'))).toEqual(binary);
    expect(fs.readFileSync(path.join(destination, 'appliance-console.tar.gz'))).toEqual(consoleBundle);
    expect(fs.readFileSync(path.join(destination, 'appliance-api-server.sha256'), 'utf8')).toContain(digest(binary));
    expect(JSON.parse(fs.readFileSync(path.join(destination, 'control-plane-release.sig.json'), 'utf8'))).toMatchObject(
      {
        keyId: envelope.keyId,
      }
    );
  });

  it('refuses an unsigned pre-MV0 release without touching staged assets', async () => {
    fs.writeFileSync(path.join(destination, 'appliance-api-server'), 'existing');
    await expect(
      stageFromRelease({
        version: '1.56.0',
        arch: 'x64',
        destinationDir: destination,
        fetcher: fakeFetcher({ 'appliance-api-server-linux-x64': binary }),
      })
    ).rejects.toThrow('unsigned (pre-MV0 release)');
    expect(fs.readFileSync(path.join(destination, 'appliance-api-server'), 'utf8')).toBe('existing');
  });

  it('--allow-unsigned warns loudly in a dev build', async () => {
    await stageFromRelease({
      version: '1.56.0',
      arch: 'x64',
      destinationDir: destination,
      fetcher: fakeFetcher({ 'appliance-api-server-linux-x64': binary }),
      allowUnsigned: true,
      cliVersion: '0.0.0-dev',
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('UNSIGNED DEV STAGING ENABLED'));
    expect(fs.readFileSync(path.join(destination, 'appliance-api-server'))).toEqual(binary);
  });

  it('refuses --allow-unsigned in a release build', async () => {
    await expect(
      stageFromRelease({
        version: '1.56.0',
        arch: 'x64',
        destinationDir: destination,
        fetcher: fakeFetcher({ 'appliance-api-server-linux-x64': binary }),
        allowUnsigned: true,
        cliVersion: 'v1.57.0',
      })
    ).rejects.toThrow('--allow-unsigned is refused by release build');
  });

  it('rejects tampered release bytes before replacing the staged binary', async () => {
    fs.writeFileSync(path.join(destination, 'appliance-api-server'), 'existing');
    const release = payload();
    const envelope = await signReleaseEnvelope(release, releaseDevFixturePrivateKey);
    await expect(
      stageFromRelease({
        version: '1.57.0',
        arch: 'x64',
        destinationDir: destination,
        fetcher: fakeFetcher({
          'control-plane-release.json': JSON.stringify(release),
          'control-plane-release.sig.json': JSON.stringify(envelope),
          'appliance-api-server-linux-x64': Buffer.from('tampered'),
          'appliance-console.tar.gz': consoleBundle,
        }),
        trust: PINNED_RELEASE_TRUST,
        now: new Date('2026-08-30T00:00:00Z'),
      })
    ).rejects.toThrow('failed signed size/SHA-256 verification');
    expect(fs.readFileSync(path.join(destination, 'appliance-api-server'), 'utf8')).toBe('existing');
  });
});
