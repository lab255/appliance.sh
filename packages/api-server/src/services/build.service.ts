import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { BuildType, isKubernetesBase } from '@appliance.sh/sdk';
import type { ApplianceBaseConfig, ApplianceContainer, ApplianceFrameworkApp } from '@appliance.sh/sdk';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildUploadService } from './build-upload.service';
import { scopePath } from './tenant-context';
import { assertSupportedBase } from './deployment-backend';
import {
  buildImageWithBuildKit,
  ensureDockerfile,
  extractZipSafely,
  readBuildManifest,
  resolveKubernetesUpload,
} from './image-build.service';
import { logger } from '../logger';
import { requireBaseConfigSnapshot } from './base-config.service';

export interface ResolvedBuild {
  imageUri?: string;
  codeS3Key?: string;
  runtime?: string;
  handler?: string;
  layers?: string[];
  architectures?: string[];
  // Resolver-owned env — system correctness keys (AWS_LWA_PORT,
  // AWS_LAMBDA_EXEC_WRAPPER). Manifest-declared env vars travel
  // through the deploy payload's `environment` parameter (rendered
  // client-side at deploy time with full ManifestContext); the
  // executor merges them under these resolver values.
  environment?: Record<string, string>;
  memory?: number;
  timeout?: number;
  storage?: number;
  // Pre-existing IAM role ARN injected by the executor for system
  // appliances (project=`system`). Threaded through to ApplianceStack
  // so the dogfood-deployed api-server / worker bind to the
  // base-pre-created roles instead of getting per-deploy roles.
  lambdaRoleArn?: string;
  // Container port to expose on the LOCAL runtime's k8s Service.
  // Threaded through from the appliance manifest at build time so
  // local deploys don't need a separate "what port does this serve
  // on" lookup. AWS deploys ignore this — Lambda's exec wrapper sets
  // the port for the framework path, and container builds embed it
  // via the LWA env variables.
  localPort?: number;
}

function getBaseConfig(): ApplianceBaseConfig {
  return requireBaseConfigSnapshot();
}

const LAMBDA_ADAPTER_LAYER: Record<string, string> = {
  'linux/amd64': 'arn:aws:lambda:${region}:753240598075:layer:LambdaAdapterLayerX86:26',
  'linux/arm64': 'arn:aws:lambda:${region}:753240598075:layer:LambdaAdapterLayerArm64:26',
};

// AWS-specific: the Lambda Web Adapter image whose extension gets
// grafted onto container builds targeting Lambda. Lives here — in the
// cloud resolver — so generic packaging carries no AWS coupling.
const LWA_IMAGE = 'public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1';

export function cloudBuildImageTag(tag: string): string {
  return `build-${tag}`;
}

const FRAMEWORK_RUNTIMES: Record<string, string> = {
  node: 'nodejs22.x',
  python: 'python3.13',
  auto: 'nodejs22.x',
  other: 'nodejs22.x',
};

const FRAMEWORK_ARCHITECTURES: Record<string, string> = {
  'linux/amd64': 'x86_64',
  'linux/arm64': 'arm64',
};

export class BuildService {
  async resolve(buildId: string, tag: string): Promise<ResolvedBuild> {
    const config = getBaseConfig();
    // The single base fork (deployment-backend.ts) rejects the
    // removed docker base with migration guidance.
    assertSupportedBase(config);

    // Kubernetes bases (the microVM local runtime and generic k8s
    // clusters): remote-image builds pass through verbatim, and
    // upload builds are built server-side — extract source, generate
    // a Dockerfile if needed, build with the base's buildkitd, push
    // to the base's registry. The same mechanism as the cloud path:
    // the CLI uploads source, the server produces the image.
    if (isKubernetesBase(config)) {
      const stored = await buildUploadService.get(buildId);
      if (!stored) throw new Error(`Build not found: ${buildId}`);
      if (stored.type === BuildType.RemoteImage) {
        // The declared port rides on the build record (remote images
        // have no manifest to read it from) and becomes the Service
        // target port.
        return { imageUri: stored.source, localPort: stored.port };
      }
      const k8s = config.kubernetes;
      if (!k8s?.registry?.url || !k8s.buildkit?.addr) {
        throw new Error(
          'This base cannot build uploads server-side (kubernetes.registry + kubernetes.buildkit required). ' +
            'Use a remote-image build referencing a container image.'
        );
      }
      return resolveKubernetesUpload({
        buildId,
        dataDir: k8s.dataDir,
        registry: k8s.registry,
        buildkitAddr: k8s.buildkit.addr,
      });
    }

    if (!config.aws?.dataBucketName) throw new Error('Data bucket not configured');
    const aws = config.aws;

    // Look up the Build record. `remote-image` builds short-circuit
    // straight to an imageUri — no zip download, no manifest parse.
    // The `upload` flow falls through to the zip-extract path below.
    // (A missing record implies an older upload-flow build created
    // before build-record persistence; tolerate by treating it as
    // upload-flow with the derived S3 key.)
    const stored = await buildUploadService.get(buildId);
    if (stored?.type === BuildType.RemoteImage) {
      return { imageUri: stored.source };
    }

    // A stored `source` was already tenant-scoped at upload time; only
    // the legacy-fallback key (no build record) needs scoping applied
    // here so it matches what an upload would have written (Quinn #2).
    const s3Key = stored?.source ?? scopePath(`builds/${buildId}.zip`);
    const s3 = new S3Client({ region: aws.region });

    // Download the build zip
    const result = await s3.send(new GetObjectCommand({ Bucket: aws.dataBucketName, Key: s3Key }));
    const body = await result.Body?.transformToByteArray();
    if (!body) throw new Error('Empty build');

    // Extract to temp dir
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-build-'));
    const zipPath = path.join(tmpDir, 'appliance.zip');
    fs.writeFileSync(zipPath, body);

    try {
      extractZipSafely(zipPath, tmpDir);
      const manifest = readBuildManifest(tmpDir);

      // The build artifact is environment-invariant: per-environment
      // runtime config (env, memory, timeout, storage) is stripped at
      // archive time and rendered fresh per-deploy from the source
      // manifest, then forwarded on the deploy payload. Anything in
      // appliance.json beyond the build-time schema is ignored here.
      return manifest.type === 'container'
        ? await this.resolveContainer(manifest, tmpDir, tag, config)
        : manifest.type === 'framework'
          ? this.resolveFramework(manifest, s3Key, config)
          : { codeS3Key: s3Key };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Framework builds are fully pre-processed by the CLI (dependencies installed,
   * run.sh generated). The server resolves the platform-specific Lambda wiring
   * from the manifest (runtime, handler, adapter layer, architecture). Memory /
   * timeout / storage are runtime configuration — they travel through the
   * deploy payload, not the build artifact.
   */
  private resolveFramework(
    manifest: ApplianceFrameworkApp,
    s3Key: string,
    config: ReturnType<typeof getBaseConfig>
  ): ResolvedBuild {
    if (!config.aws) throw new Error('Framework resolution requires an aws-typed base config');
    const port = manifest.port ?? 8080;
    const framework = manifest.framework ?? 'auto';
    const runtime = FRAMEWORK_RUNTIMES[framework] ?? FRAMEWORK_RUNTIMES['node'];

    const platform = manifest.platform;
    const layerArn = LAMBDA_ADAPTER_LAYER[platform]?.replace('${region}', config.aws.region);
    if (!layerArn) throw new Error(`No Lambda Web Adapter layer for platform: ${platform}`);
    const architecture = FRAMEWORK_ARCHITECTURES[platform];
    if (!architecture) throw new Error(`No Lambda architecture for platform: ${platform}`);

    return {
      codeS3Key: s3Key,
      runtime,
      handler: 'run.sh',
      layers: [layerArn],
      architectures: [architecture],
      environment: {
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
        AWS_LWA_PORT: String(port),
      },
    };
  }

  /**
   * Container builds on the cloud base. Two artifact generations:
   *
   *   - Source zips (current CLI): the zip carries the Dockerfile +
   *     source. Built server-side with the base's BuildKit instance
   *     (`aws.buildkit.addr`) in two steps — the app image, then a
   *     thin wrapper grafting the Lambda Web Adapter extension on top
   *     — and pushed to ECR. Same mechanism as the Kubernetes bases.
   *
   *   - Legacy image.tar zips (older CLIs, docker-built host-side with
   *     the LWA already injected): pushed to ECR verbatim with crane.
   *
   * All subprocess calls use array args to prevent shell injection.
   */
  private async resolveContainer(
    manifest: ApplianceContainer,
    tmpDir: string,
    tag: string,
    config: ReturnType<typeof getBaseConfig>
  ): Promise<ResolvedBuild> {
    if (!config.aws) throw new Error('Container build requires an aws-typed base config');
    const aws = config.aws;
    const ecrRepositoryUrl = aws.ecrRepositoryUrl;
    if (!ecrRepositoryUrl) throw new Error('ECR repository not configured');
    const buildTag = cloudBuildImageTag(tag);

    const registryHost = ecrRepositoryUrl.split('/')[0];
    const { username, password } = await this.getEcrAuth(aws.region);

    const imageTarPath = path.join(tmpDir, 'image.tar');
    if (fs.existsSync(imageTarPath)) {
      return this.pushLegacyImageTar(imageTarPath, ecrRepositoryUrl, tag, registryHost, username, password);
    }

    const buildkitAddr = aws.buildkit?.addr;
    if (!buildkitAddr) {
      throw new Error(
        'Container builds need a builder, and this base has none configured (aws.buildkit.addr). ' +
          'Deploy a pre-built image with --image-uri instead.'
      );
    }

    // buildctl authenticates to registries via the docker config file —
    // write a scoped one from the ECR token and point DOCKER_CONFIG at it.
    const dockerConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-ecr-auth-'));
    try {
      fs.writeFileSync(
        path.join(dockerConfigDir, 'config.json'),
        JSON.stringify({
          auths: { [registryHost]: { auth: Buffer.from(`${username}:${password}`).toString('base64') } },
        })
      );
      const env = { DOCKER_CONFIG: dockerConfigDir };

      // Step 1: the app image, exactly as the user's Dockerfile builds it.
      ensureDockerfile(tmpDir, manifest);
      const baseRef = await buildImageWithBuildKit({
        contextDir: tmpDir,
        ref: `${ecrRepositoryUrl}:${buildTag}-base`,
        addr: buildkitAddr,
        platform: manifest.platform,
        env,
      });
      logger.info('container app image built', { tag, baseRef });

      // Step 2: graft the Lambda Web Adapter extension on top so the
      // container runs behind Lambda's Function URL / API Gateway.
      const wrapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appliance-lwa-wrap-'));
      try {
        fs.writeFileSync(
          path.join(wrapDir, 'Dockerfile'),
          [
            `FROM ${LWA_IMAGE} AS adapter`,
            `FROM ${baseRef}`,
            'COPY --from=adapter /lambda-adapter /opt/extensions/lambda-adapter',
            `ENV AWS_LWA_PORT=${manifest.port}`,
            '',
          ].join('\n')
        );
        const imageUri = await buildImageWithBuildKit({
          contextDir: wrapDir,
          ref: `${ecrRepositoryUrl}:${buildTag}`,
          addr: buildkitAddr,
          platform: manifest.platform,
          env,
        });
        logger.info('container image built', { tag, imageUri });
        return { imageUri };
      } finally {
        fs.rmSync(wrapDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dockerConfigDir, { recursive: true, force: true });
    }
  }

  private async getEcrAuth(region: string): Promise<{ username: string; password: string }> {
    const ecr = new ECRClient({ region });
    const authResult = await ecr.send(new GetAuthorizationTokenCommand({}));
    const authData = authResult.authorizationData?.[0];
    if (!authData?.authorizationToken || !authData?.proxyEndpoint) {
      throw new Error('Failed to get ECR auth');
    }
    const decoded = Buffer.from(authData.authorizationToken, 'base64').toString();
    const [username, password] = decoded.split(':');
    return { username, password };
  }

  /** Legacy path: push a CLI-produced image.tar to ECR with crane. */
  private pushLegacyImageTar(
    imageTarPath: string,
    ecrRepositoryUrl: string,
    tag: string,
    registryHost: string,
    username: string,
    password: string
  ): ResolvedBuild {
    execFileSync('crane', ['auth', 'login', registryHost, '-u', username, '--password-stdin'], {
      input: password,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const remoteTag = `${ecrRepositoryUrl}:${cloudBuildImageTag(tag)}`;
    execFileSync('crane', ['push', imageTarPath, remoteTag], { stdio: 'pipe' });

    // Get digest for immutable image reference
    let imageUri: string;
    try {
      const digest = execFileSync('crane', ['digest', remoteTag], { encoding: 'utf-8' }).trim();
      imageUri = `${ecrRepositoryUrl}@${digest}`;
    } catch {
      imageUri = remoteTag;
    }

    return { imageUri };
  }
}

export const buildService = new BuildService();
