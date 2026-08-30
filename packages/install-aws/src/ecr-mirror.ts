import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { Readable } from 'node:stream';
import type { ImageArchitecture, RegistryArchitecture } from './types.js';

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const IMAGE_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);

interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: { architecture?: string; os?: string; variant?: string };
}
interface ImageIndex {
  mediaType: string;
  manifests: Descriptor[];
}
interface ImageManifest {
  schemaVersion: number;
  mediaType: string;
  config: Descriptor;
  layers: Descriptor[];
}

export interface RegistryCredentials {
  username: string;
  password: string;
}

export interface MirrorImageOptions {
  sourceImage: string;
  targetRepositoryUrl: string;
  architecture: ImageArchitecture;
  targetCredentials: RegistryCredentials;
  sourceCredentials?: RegistryCredentials;
  fetch?: typeof globalThis.fetch;
  onProgress?: (message: string) => void;
  /** AWS adapter uses ECR DescribeImages before writing an immutable tag. */
  describeTargetTag?: (tag: string) => Promise<string | undefined>;
}

export interface MirrorImageResult {
  imageUri: string;
  digest: string;
  uploadedBlobs: number;
  reusedBlobs: number;
}

interface ImageReference {
  registry: string;
  repository: string;
  reference: string;
}

function parseImageReference(value: string): ImageReference {
  const slash = value.indexOf('/');
  if (slash <= 0) throw new Error(`Image reference must include a registry and repository: ${value}`);
  const registry = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  const at = rest.lastIndexOf('@');
  if (at >= 0) return { registry, repository: rest.slice(0, at), reference: rest.slice(at + 1) };
  const colon = rest.lastIndexOf(':');
  return colon >= 0
    ? { registry, repository: rest.slice(0, colon), reference: rest.slice(colon + 1) }
    : { registry, repository: rest, reference: 'latest' };
}

function parseTargetRepository(value: string): Omit<ImageReference, 'reference'> {
  const parsed = parseImageReference(`${value}:placeholder`);
  return { registry: parsed.registry, repository: parsed.repository };
}

function registryUrl(registry: string, path: string): URL {
  return new URL(path, `https://${registry}`);
}

function basicAuth(credentials?: RegistryCredentials): string | undefined {
  if (!credentials) return undefined;
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
}

function bearerChallenge(header: string | null): { realm: string; params: URLSearchParams } | null {
  if (!header?.match(/^Bearer\s/i)) return null;
  const params = new URLSearchParams();
  for (const match of header.slice(7).matchAll(/([a-z]+)="([^"]*)"/gi)) params.set(match[1], match[2]);
  const realm = params.get('realm');
  if (!realm) return null;
  params.delete('realm');
  return { realm, params };
}

function registryArch(arch: ImageArchitecture): RegistryArchitecture {
  return arch === 'x86_64' ? 'amd64' : 'arm64';
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

function responseError(operation: string, response: Response): Error {
  return new Error(`${operation} failed: HTTP ${response.status} ${response.statusText}`.trim());
}

class SourceRegistry {
  private bearerToken?: string;

  constructor(
    private readonly image: ImageReference,
    private readonly request: typeof globalThis.fetch,
    private readonly credentials?: RegistryCredentials
  ) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const execute = async (): Promise<Response> => {
      const headers = new Headers(init.headers);
      const auth = this.bearerToken ? `Bearer ${this.bearerToken}` : basicAuth(this.credentials);
      if (auth) headers.set('authorization', auth);
      return this.request(registryUrl(this.image.registry, path), { ...init, headers, redirect: 'follow' });
    };

    let response = await execute();
    if (response.status !== 401) return response;
    const challenge = bearerChallenge(response.headers.get('www-authenticate'));
    if (!challenge) return response;
    this.bearerToken = await this.fetchBearerToken(challenge);
    response = await execute();
    if (response.status === 401) {
      // A cached token can expire between manifest and blob requests.
      const refreshed = bearerChallenge(response.headers.get('www-authenticate')) ?? challenge;
      this.bearerToken = await this.fetchBearerToken(refreshed);
      response = await execute();
    }
    return response;
  }

  private async fetchBearerToken(challenge: { realm: string; params: URLSearchParams }): Promise<string> {
    const headers = new Headers();
    const auth = basicAuth(this.credentials);
    if (auth) headers.set('authorization', auth);
    const response = await this.request(new URL(`?${challenge.params.toString()}`, challenge.realm), { headers });
    if (!response.ok) throw responseError('Registry bearer-token request', response);
    const body = (await response.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) throw new Error('Registry bearer-token response did not contain a token');
    return token;
  }
}

async function loadManifest(
  source: SourceRegistry,
  repository: string,
  reference: string
): Promise<{ bytes: Uint8Array; mediaType: string; manifest: ImageManifest | ImageIndex }> {
  const encodedReference = encodeURIComponent(reference).replace(/%3A/gi, ':');
  const response = await source.fetch(`/v2/${repository}/manifests/${encodedReference}`, {
    headers: { accept: MANIFEST_ACCEPT },
  });
  if (!response.ok) throw responseError(`Pull manifest ${reference}`, response);
  const bytes = await responseBytes(response);
  const declaredDigest = response.headers.get('docker-content-digest');
  if (declaredDigest && digestBytes(bytes) !== declaredDigest) {
    throw new Error(`Manifest digest mismatch: expected ${declaredDigest}, received ${digestBytes(bytes)}`);
  }
  const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as ImageManifest | ImageIndex;
  const mediaType = response.headers.get('content-type')?.split(';')[0] ?? manifest.mediaType;
  return { bytes, mediaType, manifest };
}

async function resolvePlatformManifest(
  source: SourceRegistry,
  image: ImageReference,
  architecture: ImageArchitecture
): Promise<{ bytes: Uint8Array; mediaType: string; manifest: ImageManifest; digest: string }> {
  let loaded = await loadManifest(source, image.repository, image.reference);
  if (image.reference.startsWith('sha256:') && digestBytes(loaded.bytes) !== image.reference) {
    throw new Error(`Manifest digest mismatch: expected ${image.reference}, received ${digestBytes(loaded.bytes)}`);
  }
  if (INDEX_TYPES.has(loaded.mediaType)) {
    const requested = registryArch(architecture);
    const descriptor = (loaded.manifest as ImageIndex).manifests?.find(
      (candidate) => candidate.platform?.os === 'linux' && candidate.platform.architecture === requested
    );
    if (!descriptor) {
      throw new Error(`Image index has no Lambda-compatible linux/${requested} manifest`);
    }
    loaded = await loadManifest(source, image.repository, descriptor.digest);
    const actual = digestBytes(loaded.bytes);
    if (actual !== descriptor.digest || loaded.bytes.byteLength !== descriptor.size) {
      throw new Error(
        `Selected manifest digest/size mismatch: expected ${descriptor.digest} (${descriptor.size}), received ${actual} (${loaded.bytes.byteLength})`
      );
    }
  }
  if (!IMAGE_TYPES.has(loaded.mediaType)) {
    throw new Error(`Lambda-incompatible image manifest media type: ${loaded.mediaType || 'unknown'}`);
  }
  const manifest = loaded.manifest as ImageManifest;
  if (!manifest.config?.digest || !Array.isArray(manifest.layers)) {
    throw new Error('Lambda-incompatible image manifest: config or layers are missing');
  }
  return { ...loaded, manifest, digest: digestBytes(loaded.bytes) };
}

function nextUploadUrl(response: Response, current: URL): URL {
  const location = response.headers.get('location');
  if (!location) throw new Error('Target registry upload response omitted Location');
  return new URL(location, current);
}

async function copyBlob(
  source: SourceRegistry,
  sourceImage: ImageReference,
  target: Omit<ImageReference, 'reference'>,
  descriptor: Descriptor,
  request: typeof globalThis.fetch,
  targetAuthorization: string
): Promise<'uploaded' | 'reused'> {
  const targetBlob = registryUrl(target.registry, `/v2/${target.repository}/blobs/${descriptor.digest}`);
  const exists = await request(targetBlob, { method: 'HEAD', headers: { authorization: targetAuthorization } });
  if (exists.ok) return 'reused';
  if (exists.status !== 404) throw responseError(`Check target blob ${descriptor.digest}`, exists);

  const sourceResponse = await source.fetch(`/v2/${sourceImage.repository}/blobs/${descriptor.digest}`);
  if (!sourceResponse.ok || !sourceResponse.body) throw responseError(`Pull blob ${descriptor.digest}`, sourceResponse);
  const declaredLength = Number(sourceResponse.headers.get('content-length') ?? descriptor.size);
  if (Number.isFinite(declaredLength) && declaredLength !== descriptor.size) {
    throw new Error(
      `Blob size mismatch for ${descriptor.digest}: expected ${descriptor.size}, source declared ${declaredLength}`
    );
  }

  const startUrl = registryUrl(target.registry, `/v2/${target.repository}/blobs/uploads/`);
  const started = await request(startUrl, { method: 'POST', headers: { authorization: targetAuthorization } });
  if (!started.ok) throw responseError(`Start target blob upload ${descriptor.digest}`, started);
  const uploadUrl = nextUploadUrl(started, startUrl);

  const hash = createHash('sha256');
  let size = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.byteLength;
      callback(null, chunk);
    },
  });
  const body = Readable.fromWeb(sourceResponse.body as never).pipe(verifier);
  const patched = await request(uploadUrl, {
    method: 'PATCH',
    headers: { authorization: targetAuthorization, 'content-type': 'application/octet-stream' },
    body: body as never,
    duplex: 'half',
  } as RequestInit);
  if (!patched.ok) throw responseError(`Stream target blob ${descriptor.digest}`, patched);

  const actualDigest = `sha256:${hash.digest('hex')}`;
  if (size !== descriptor.size || actualDigest !== descriptor.digest) {
    throw new Error(
      `Blob digest/size mismatch for ${descriptor.digest}: received ${actualDigest} (${size}), expected ${descriptor.digest} (${descriptor.size})`
    );
  }
  const finishUrl = nextUploadUrl(patched, uploadUrl);
  finishUrl.searchParams.set('digest', descriptor.digest);
  const finished = await request(finishUrl, { method: 'PUT', headers: { authorization: targetAuthorization } });
  if (!finished.ok) throw responseError(`Finish target blob upload ${descriptor.digest}`, finished);
  return 'uploaded';
}

/** Mirror a public GHCR image (or an image in the same ECR registry) without invoking Docker. */
export async function mirrorImageToEcr(options: MirrorImageOptions): Promise<MirrorImageResult> {
  const request = options.fetch ?? globalThis.fetch;
  const sourceImage = parseImageReference(options.sourceImage);
  const target = parseTargetRepository(options.targetRepositoryUrl);
  if (sourceImage.registry !== 'ghcr.io' && sourceImage.registry !== target.registry) {
    throw new Error('Only public ghcr.io and the destination account ECR registry are supported as image sources');
  }
  const source = new SourceRegistry(
    sourceImage,
    request,
    sourceImage.registry === target.registry ? options.targetCredentials : options.sourceCredentials
  );
  const resolved = await resolvePlatformManifest(source, sourceImage, options.architecture);
  const tag = sourceImage.reference.startsWith('sha256:') ? resolved.digest.replace(':', '-') : sourceImage.reference;
  const existingDigest = await options.describeTargetTag?.(tag);
  if (existingDigest) {
    if (existingDigest === resolved.digest) {
      options.onProgress?.(`target tag ${tag} already binds ${resolved.digest}; skipping mirror`);
      return {
        imageUri: `${options.targetRepositoryUrl}@${resolved.digest}`,
        digest: resolved.digest,
        uploadedBlobs: 0,
        reusedBlobs: 0,
      };
    }
    if (!sourceImage.reference.startsWith('sha256:')) {
      throw new Error(`tag ${tag} already exists with a different digest; use --image <ref>@sha256:… or a new tag`);
    }
    throw new Error(`digest-derived tag ${tag} already exists with a different digest; refusing immutable ECR write`);
  }
  const descriptors = [resolved.manifest.config, ...resolved.manifest.layers];
  const targetAuthorization = basicAuth(options.targetCredentials)!;
  let uploadedBlobs = 0;
  let reusedBlobs = 0;
  for (const descriptor of descriptors) {
    options.onProgress?.(`copying ${descriptor.digest} (${descriptor.size} bytes)`);
    const result = await copyBlob(source, sourceImage, target, descriptor, request, targetAuthorization);
    if (result === 'uploaded') uploadedBlobs += 1;
    else reusedBlobs += 1;
  }

  const manifestUrl = registryUrl(
    target.registry,
    `/v2/${target.repository}/manifests/${encodeURIComponent(tag).replace(/%3A/gi, ':')}`
  );
  const put = await request(manifestUrl, {
    method: 'PUT',
    headers: {
      authorization: targetAuthorization,
      'content-type': resolved.mediaType,
    },
    body: Buffer.from(resolved.bytes),
  });
  if (!put.ok) throw responseError('Push target manifest', put);
  const targetDigest = put.headers.get('docker-content-digest') ?? resolved.digest;
  if (targetDigest !== resolved.digest) {
    throw new Error(`Target manifest digest mismatch: expected ${resolved.digest}, received ${targetDigest}`);
  }
  return {
    imageUri: `${options.targetRepositoryUrl}@${resolved.digest}`,
    digest: resolved.digest,
    uploadedBlobs,
    reusedBlobs,
  };
}
