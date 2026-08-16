import { createHash } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { mirrorImageToEcr } from './ecr-mirror.js';

const TARGET = '111111111111.dkr.ecr.us-east-1.amazonaws.com/appliance';
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const digest = (value: Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

interface RegistryFixtureOptions {
  multiArch?: boolean;
  missingArchitecture?: boolean;
  existingConfig?: boolean;
  expireToken?: boolean;
  corruptLayer?: boolean;
  largeLayer?: boolean;
}

function registryFixture(options: RegistryFixtureOptions = {}) {
  const config = Buffer.from('config');
  const normalLayer = Buffer.from(options.corruptLayer ? 'corrupt-source' : 'layer-data');
  const layerSize = options.largeLayer ? 8 * 1024 * 1024 : normalLayer.byteLength;
  const largeChunk = Buffer.alloc(64 * 1024, 7);
  const largeHash = createHash('sha256');
  if (options.largeLayer) for (let i = 0; i < layerSize / largeChunk.length; i++) largeHash.update(largeChunk);
  const expectedLayerDigest = options.largeLayer
    ? `sha256:${largeHash.digest('hex')}`
    : digest(Buffer.from('layer-data'));
  const configDescriptor = {
    mediaType: 'application/vnd.oci.image.config.v1+json',
    digest: digest(config),
    size: config.length,
  };
  const layerDescriptor = {
    mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
    digest: expectedLayerDigest,
    size: layerSize,
  };
  const manifests = new Map<string, Buffer>();
  for (const arch of ['amd64', 'arm64']) {
    const body = jsonBytes({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: configDescriptor,
      layers: [layerDescriptor],
      annotations: { arch },
    });
    manifests.set(arch, body);
  }
  const amd64 = manifests.get('amd64')!;
  const arm64 = manifests.get('arm64')!;
  const index = jsonBytes({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: options.missingArchitecture
      ? [
          {
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            digest: digest(amd64),
            size: amd64.length,
            platform: { os: 'windows', architecture: 'amd64' },
          },
        ]
      : [
          {
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            digest: digest(amd64),
            size: amd64.length,
            platform: { os: 'linux', architecture: 'amd64' },
          },
          {
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            digest: digest(arm64),
            size: arm64.length,
            platform: { os: 'linux', architecture: 'arm64' },
          },
        ],
  });
  let tokenRequests = 0;
  let blobRequests = 0;
  let patchCalls = 0;
  let maxChunk = 0;
  let pushedManifest = Buffer.alloc(0);

  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    if (url.hostname === 'auth.test') {
      tokenRequests += 1;
      return Response.json({ token: `token-${tokenRequests}` });
    }
    if (url.hostname === 'ghcr.io') {
      const auth = headers.get('authorization');
      const expectedToken = options.expireToken && blobRequests > 0 ? 'Bearer token-2' : 'Bearer token-1';
      if (auth !== expectedToken) {
        return new Response(null, {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://auth.test/token",service="ghcr.io",scope="repository:org/app:pull"',
          },
        });
      }
      if (url.pathname.includes('/manifests/')) {
        const reference = decodeURIComponent(url.pathname.split('/').pop()!);
        const body =
          reference === 'latest' ? (options.multiArch ? index : amd64) : reference === digest(arm64) ? arm64 : amd64;
        const mediaType =
          reference === 'latest' && options.multiArch
            ? 'application/vnd.oci.image.index.v1+json'
            : 'application/vnd.oci.image.manifest.v1+json';
        return new Response(body as never, {
          headers: { 'content-type': mediaType, 'docker-content-digest': digest(body) },
        });
      }
      if (url.pathname.includes('/blobs/')) {
        blobRequests += 1;
        if (options.expireToken && auth === 'Bearer token-1') {
          return new Response(null, {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer realm="https://auth.test/token",service="ghcr.io",scope="repository:org/app:pull"',
            },
          });
        }
        const requested = decodeURIComponent(url.pathname.split('/').pop()!);
        if (requested === configDescriptor.digest)
          return new Response(config as never, { headers: { 'content-length': String(config.length) } });
        if (options.largeLayer) {
          let remaining = layerSize;
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (remaining === 0) return controller.close();
                const chunk = largeChunk.subarray(0, Math.min(remaining, largeChunk.length));
                remaining -= chunk.length;
                controller.enqueue(chunk);
              },
            }) as never,
            { headers: { 'content-length': String(layerSize) } }
          );
        }
        return new Response(normalLayer as never, { headers: { 'content-length': String(normalLayer.length) } });
      }
    }
    if (url.hostname.endsWith('amazonaws.com')) {
      if (method === 'HEAD') {
        const isConfig = decodeURIComponent(url.pathname.split('/').pop()!) === configDescriptor.digest;
        return new Response(null, { status: options.existingConfig && isConfig ? 200 : 404 });
      }
      if (method === 'POST') return new Response(null, { status: 202, headers: { location: '/upload/session' } });
      if (method === 'PATCH') {
        patchCalls += 1;
        for await (const chunk of init.body as AsyncIterable<Uint8Array>)
          maxChunk = Math.max(maxChunk, chunk.byteLength);
        return new Response(null, { status: 202, headers: { location: '../upload/session-final' } });
      }
      if (method === 'PUT' && url.pathname.includes('/manifests/')) {
        pushedManifest = Buffer.from(await new Response(init.body).arrayBuffer());
        return new Response(null, { status: 201, headers: { 'docker-content-digest': digest(pushedManifest) } });
      }
      if (method === 'PUT') return new Response(null, { status: 201 });
    }
    throw new Error(`Unhandled mock registry request: ${method} ${url}`);
  };
  return {
    fetch,
    stats: () => ({ tokenRequests, patchCalls, maxChunk, pushedManifest }),
    manifests,
    expectedLayerDigest,
  };
}

const run = (fixture: ReturnType<typeof registryFixture>, architecture: 'x86_64' | 'arm64' = 'x86_64') =>
  mirrorImageToEcr({
    sourceImage: 'ghcr.io/org/app:latest',
    targetRepositoryUrl: TARGET,
    architecture,
    targetCredentials: { username: 'AWS', password: 'secret' },
    fetch: fixture.fetch,
  });

describe('registry HTTP ECR mirror', () => {
  it('handles anonymous bearer auth and streams a single-platform image', async () => {
    const fixture = registryFixture();
    const result = await run(fixture);
    expect(result.imageUri).toMatch(`${TARGET}@sha256:`);
    expect(result.uploadedBlobs).toBe(2);
    expect(fixture.stats().tokenRequests).toBe(1);
    expect(fixture.stats().patchCalls).toBe(2);
  });

  it.each([
    ['x86_64', 'amd64'],
    ['arm64', 'arm64'],
  ] as const)('selects linux/%s from a multi-arch index', async (architecture, annotation) => {
    const fixture = registryFixture({ multiArch: true });
    await run(fixture, architecture);
    expect(JSON.parse(fixture.stats().pushedManifest.toString()).annotations.arch).toBe(annotation);
  });

  it('reuses target blobs and follows relative upload locations', async () => {
    const fixture = registryFixture({ existingConfig: true });
    const result = await run(fixture);
    expect(result.reusedBlobs).toBe(1);
    expect(result.uploadedBlobs).toBe(1);
  });

  it('refreshes an expired bearer token', async () => {
    const fixture = registryFixture({ expireToken: true });
    await run(fixture);
    expect(fixture.stats().tokenRequests).toBeGreaterThanOrEqual(2);
  });

  it('rejects a digest mismatch before finalizing the blob', async () => {
    await expect(run(registryFixture({ corruptLayer: true }))).rejects.toThrow('digest/size mismatch');
  });

  it('refuses an index without a Lambda-compatible platform', async () => {
    await expect(run(registryFixture({ multiArch: true, missingArchitecture: true }))).rejects.toThrow(
      'no Lambda-compatible linux/amd64'
    );
  });

  it('streams a large layer in bounded chunks', async () => {
    const fixture = registryFixture({ largeLayer: true });
    await run(fixture);
    expect(fixture.stats().maxChunk).toBeLessThanOrEqual(64 * 1024);
  });
});
