import { DescribeImagesCommand, ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { BootstrapEvent } from '../types';
import { hostDockerPlatform, imageRepoDigest, login, pullImage, pushImage, tagImage } from './container';

interface MirrorOptions {
  /** Source image (e.g. `ghcr.io/appliance-sh/api-server:1.29.0`). */
  sourceImage: string;
  /** Cluster's ECR repository URL (from base config, e.g. `<acct>.dkr.ecr.<region>.amazonaws.com/<base>`). */
  ecrRepositoryUrl: string;
  /** Tag to push under in the cluster's ECR (e.g. the version). */
  tag: string;
  region: string;
  /**
   * AWS profile to use for the ECR API calls. When provided, the SDK
   * resolves credentials from `~/.aws/{config,credentials}` for that
   * profile (SSO-aware via the standard provider chain). When omitted,
   * the SDK's default chain runs (env vars → shared config → IMDS).
   * Passed explicitly so callers don't have to mutate `process.env`.
   */
  awsProfile?: string;
  emit?: (e: BootstrapEvent) => void;
}

/**
 * Lambda's container image source must be in ECR — public registries
 * like GHCR aren't supported. The bootstrap orchestrator pulls the
 * api-server image from GHCR onto the operator's machine (where the
 * local api-server container runs from the same image), then mirrors
 * it into the cluster's ECR so the cloud Lambdas can pull it.
 *
 * Returns the immutable digest URI (preferred) or the tag URI if the
 * runtime doesn't expose a digest after push.
 */
export async function mirrorImageToEcr(opts: MirrorOptions): Promise<string> {
  const { sourceImage, ecrRepositoryUrl, tag, region, awsProfile, emit } = opts;
  const digestSource = sourceDigest(sourceImage);
  const targetTag = digestSource ? digestSource.replace(':', '-') : tag;

  // Pin to the host's native platform so we end up with a
  // single-platform local image. Containerd image-store users would
  // otherwise see `docker pull` cache the full multi-arch manifest
  // list, which `docker push` then re-uploads to ECR — Lambda
  // rejects that as `media type ... not supported` since it only
  // accepts single image manifests, not OCI indexes.
  pullImage(sourceImage, emit, hostDockerPlatform());
  const locallyResolvedDigest = digestSource ?? digestFromUri(imageRepoDigest(sourceImage));
  if (!locallyResolvedDigest) {
    throw new Error(`could not resolve the pulled source digest for ${sourceImage}; use --image <ref>@sha256:…`);
  }

  emit?.({ type: 'log', level: 'info', message: `requesting ECR auth in ${region}` });
  // Constructing credentials explicitly when a profile is set keeps
  // the SDK from picking up unrelated env vars (notably stale
  // AWS_ACCESS_KEY_ID values that would otherwise win in the default
  // chain). Without a profile we let the default chain run — that's
  // what gives us Lambda role auth in-cluster and shell-env auth
  // locally.
  const ecr = new ECRClient({
    region,
    credentials: awsProfile ? fromNodeProviderChain({ profile: awsProfile }) : undefined,
  });
  const authResult = await ecr.send(new GetAuthorizationTokenCommand({}));
  const authData = authResult.authorizationData?.[0];
  if (!authData?.authorizationToken || !authData?.proxyEndpoint) {
    throw new Error('Failed to obtain ECR authorization token');
  }
  const decoded = Buffer.from(authData.authorizationToken, 'base64').toString();
  const sep = decoded.indexOf(':');
  if (sep === -1) throw new Error('Malformed ECR authorization token');
  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  const registryHost = authData.proxyEndpoint.replace(/^https?:\/\//, '');

  login(registryHost, username, password);

  const repositoryName = parseEcrRepositoryName(ecrRepositoryUrl);
  if (!repositoryName) throw new Error(`Malformed ECR repository URL: ${ecrRepositoryUrl}`);
  const describeTag = async (imageTag: string): Promise<string | undefined> => {
    try {
      const existing = await ecr.send(new DescribeImagesCommand({ repositoryName, imageIds: [{ imageTag }] }));
      return existing.imageDetails?.[0]?.imageDigest;
    } catch (error) {
      if ((error as { name?: string }).name === 'ImageNotFoundException') return undefined;
      throw error;
    }
  };

  // ECR stores the single-platform manifest digest produced by `docker
  // push --platform`, not the source index digest. A source-derived
  // auxiliary tag records that mapping without relying on the two
  // different digest domains being equal. It also repairs a first run
  // that pushed the target tag but was interrupted before recording
  // provenance.
  const provenanceTag = sourceProvenanceTag(locallyResolvedDigest);
  const remoteProvenanceTag = `${ecrRepositoryUrl}:${provenanceTag}`;
  let provenanceDigest = await describeTag(provenanceTag);
  if (!provenanceDigest) {
    tagImage(sourceImage, remoteProvenanceTag);
    pushImage(remoteProvenanceTag, emit, hostDockerPlatform());
    provenanceDigest = await describeTag(provenanceTag);
    if (!provenanceDigest) throw new Error(`ECR did not report the pushed provenance tag ${provenanceTag}`);
  }

  const existingDigest = await describeTag(targetTag);
  if (existingDigest) {
    return resolveExistingMirror({
      ecrRepositoryUrl,
      targetTag,
      existingDigest,
      provenanceDigest,
      digestSource: Boolean(digestSource),
      emit,
    });
  }

  const remoteTag = `${ecrRepositoryUrl}:${targetTag}`;
  tagImage(sourceImage, remoteTag);
  // Push a single-platform manifest. With containerd image store
  // enabled, the local image may be wrapped in an OCI index even
  // for "single-platform" builds; explicit `--platform` tells docker
  // push to upload just one manifest, which is what Lambda accepts.
  pushImage(remoteTag, emit, hostDockerPlatform());

  // Prefer the digest-pinned URI (`<repo>@sha256:...`) so Lambda
  // resolves to this exact push's content. Tag-only URIs leave the
  // Lambda holding whatever digest the *first* deploy resolved —
  // subsequent pushes that overwrite the tag don't trigger Pulumi
  // to update the function's image (the URI string didn't change),
  // and the Lambda can keep running the stale digest. CU2 repositories are
  // immutable, so we preflight the target tag above and never overwrite it.
  //
  // Source of truth is ECR itself, not local docker: with containerd
  // image store + multi-arch local images, `docker inspect`'s
  // `RepoDigests` can list the local *index* digest, which doesn't
  // exist in ECR after a single-platform push. Asking ECR via
  // DescribeImages always returns the digest of the manifest we
  // actually uploaded.
  let pushedDigest: string | undefined;
  try {
    pushedDigest = await describeTag(targetTag);
  } catch (err) {
    emit?.({
      type: 'log',
      level: 'warn',
      message: `failed to query ECR for digest of ${remoteTag}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (pushedDigest) {
    if (pushedDigest !== provenanceDigest) {
      throw new Error(
        `ECR returned ${pushedDigest} for ${targetTag}, but source provenance resolved to ${provenanceDigest}; refusing an ambiguous mirror`
      );
    }
    const digestUri = `${ecrRepositoryUrl}@${pushedDigest}`;
    emit?.({ type: 'log', level: 'info', message: `ECR digest URI: ${digestUri}` });
    return digestUri;
  }

  // Fallback to docker's local view if ECR query failed (e.g. IAM
  // missing ecr:DescribeImages — system roles have admin so this
  // shouldn't happen, but the fallback keeps things working in
  // unusual setups).
  const dockerDigestUri = imageRepoDigest(remoteTag, ecrRepositoryUrl);
  if (dockerDigestUri) {
    emit?.({
      type: 'log',
      level: 'warn',
      message: `using docker-local digest URI ${dockerDigestUri} (ECR query unavailable; may not match ECR if local image is multi-arch)`,
    });
    return dockerDigestUri;
  }
  emit?.({
    type: 'log',
    level: 'warn',
    message: `could not resolve digest for ${remoteTag}; falling back to tag-only URI`,
  });
  return remoteTag;
}

export function sourceDigest(image: string): string | undefined {
  const match = image.match(/@(sha256:[0-9a-f]{64})$/);
  return match?.[1];
}

export function sourceProvenanceTag(digest: string): string {
  return `src-${digest.replace(':', '-')}`;
}

export function resolveExistingMirror(input: {
  ecrRepositoryUrl: string;
  targetTag: string;
  existingDigest: string;
  provenanceDigest: string;
  digestSource: boolean;
  emit?: (e: BootstrapEvent) => void;
}): string {
  if (input.existingDigest === input.provenanceDigest) {
    const digestUri = `${input.ecrRepositoryUrl}@${input.existingDigest}`;
    input.emit?.({
      type: 'log',
      level: 'info',
      message: `ECR tag ${input.targetTag} already matches the source manifest; using ${digestUri}`,
    });
    return digestUri;
  }
  if (!input.digestSource) {
    throw new Error(
      `tag ${input.targetTag} already exists with a different digest; use --image <ref>@sha256:… or a new tag`
    );
  }
  throw new Error(
    `digest-derived tag ${input.targetTag} already exists with a different digest; refusing immutable ECR write`
  );
}

function digestFromUri(uri: string | null): string | undefined {
  const match = uri?.match(/@(sha256:[0-9a-f]{64})$/);
  return match?.[1];
}

/**
 * Extract the repository name from an ECR repository URL of the form
 * `<account>.dkr.ecr.<region>.amazonaws.com/<repo>`. Returns null
 * when the URL is malformed.
 */
function parseEcrRepositoryName(repositoryUrl: string): string | null {
  const slash = repositoryUrl.indexOf('/');
  if (slash === -1 || slash === repositoryUrl.length - 1) return null;
  return repositoryUrl.slice(slash + 1);
}
