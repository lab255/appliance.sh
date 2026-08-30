import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getPublicKeyAsync } from '@noble/ed25519';
import {
  signReleaseEnvelope,
  type ReleaseEnvelope,
  type ReleaseTrustPolicy,
} from '@appliance.sh/sdk';
import {
  updateMicroVm,
  type MicroVmUpdateTransport,
} from './microvm-update.js';

describe('microVM in-place control-plane update', () => {
  const privateKey = new Uint8Array(32).fill(51);
  const binary = Buffer.from('signed-x64-update');
  const armBinary = Buffer.from('signed-arm64-update');
  const consoleBundle = Buffer.from('signed-console-update');
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  let trust: ReleaseTrustPolicy;
  let destination: string;

  beforeAll(async () => {
    const publicKey = await getPublicKeyAsync(privateKey);
    const keyId = `ed25519:sha256:${digest(publicKey)}`;
    trust = { keys: { [keyId]: `ed25519:${Buffer.from(publicKey).toString('base64url')}` }, generationFloor: 1 };
  });

  beforeEach(() => {
    destination = fs.mkdtempSync(path.join(os.tmpdir(), 'microvm-update-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(destination, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function payload(): ReleaseEnvelope {
    return {
      kind: 'control-plane-release',
      version: '1.58.0',
      generation: 226,
      notBefore: '2026-08-29T00:00:00Z',
      expires: '2027-08-29T00:00:00Z',
      artifacts: [
        { name: 'appliance-api-server-linux-x64', arch: 'x64', sha256: digest(binary), size: binary.length },
        { name: 'appliance-api-server-linux-arm64', arch: 'arm64', sha256: digest(armBinary), size: armBinary.length },
        { name: 'appliance-console.tar.gz', arch: 'any', sha256: digest(consoleBundle), size: consoleBundle.length },
      ],
      image: { repository: 'ghcr.io/appliance-sh/api-server', manifestDigest: `sha256:${'d'.repeat(64)}` },
    };
  }

  async function fetcher(release: ReleaseEnvelope = payload()): Promise<typeof fetch> {
    const envelope = await signReleaseEnvelope(release, privateKey);
    const files: Record<string, BodyInit> = {
      'control-plane-release.json': JSON.stringify(release),
      'control-plane-release.sig.json': JSON.stringify(envelope),
      'appliance-api-server-linux-x64': binary,
      'appliance-api-server-linux-arm64': armBinary,
      'appliance-console.tar.gz': consoleBundle,
    };
    return (async (input: string | URL | Request) => {
      const pathname = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname;
      const name = pathname.slice(pathname.lastIndexOf('/') + 1);
      return name in files ? new Response(files[name], { status: 200 }) : new Response('missing', { status: 404 });
    }) as typeof fetch;
  }

  function transport(capable = true): MicroVmUpdateTransport & { swaps: string[] } {
    let versionReads = 0;
    return {
      swaps: [],
      async capability() {
        return { ok: capable, detail: capable ? 'transport=wsl' : 'missing' };
      },
      async runningVersion() {
        return versionReads++ === 0 ? '1.57.0' : '1.58.0';
      },
      async swap(request) {
        this.swaps.push(request.binary.sha256);
        return { ok: true, detail: 'success 1.58.0' };
      },
    };
  }

  it('verifies signed bytes before transport and advances the running version', async () => {
    const channel = transport();
    await expect(updateMicroVm({
      name: 'appliance', version: '1.58.0', arch: 'x64', destinationDir: destination,
      trust, now: new Date('2026-08-30T00:00:00Z'), fetcher: await fetcher(), transport: channel,
    })).resolves.toMatchObject({ oldVersion: '1.57.0', newVersion: '1.58.0' });
    expect(channel.swaps).toEqual([digest(binary)]);
  });

  it('refuses while the production trust pin is empty', async () => {
    const channel = transport();
    await expect(updateMicroVm({
      name: 'appliance', destinationDir: destination,
      trust: { keys: {}, generationFloor: 1 }, fetcher: vi.fn() as unknown as typeof fetch, transport: channel,
    })).rejects.toThrow('self-update disabled until the production key is pinned (AP-226)');
    expect(channel.swaps).toEqual([]);
  });

  it('refuses an unsupported/wrong host architecture before transport', async () => {
    const channel = transport();
    await expect(updateMicroVm({
      name: 'appliance', version: '1.58.0', arch: 'mips' as 'x64', destinationDir: destination,
      trust, now: new Date('2026-08-30T00:00:00Z'), fetcher: await fetcher(), transport: channel,
    })).rejects.toThrow(/linux-mips|architecture/u);
    expect(channel.swaps).toEqual([]);
  });

  it('tells old launchers to restage and reboot instead of opening the artifact channel', async () => {
    const channel = transport(false);
    await expect(updateMicroVm({
      name: 'legacy', version: '1.58.0', arch: 'x64', destinationDir: destination,
      trust, now: new Date('2026-08-30T00:00:00Z'), fetcher: await fetcher(), transport: channel,
    })).rejects.toThrow('appliance vm up --name legacy --cluster');
    expect(channel.swaps).toEqual([]);
  });
});
