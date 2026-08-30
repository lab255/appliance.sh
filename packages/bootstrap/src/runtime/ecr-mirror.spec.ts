import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  images: new Map<string, string>(),
  platformDigest: `sha256:${'b'.repeat(64)}`,
  sourceDigest: `sha256:${'a'.repeat(64)}`,
  pushImage: vi.fn(),
  tagImage: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@aws-sdk/client-ecr', () => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class GetAuthorizationTokenCommand extends Command {}
  class DescribeImagesCommand extends Command {}
  class ECRClient {
    send = harness.send;
  }
  return { DescribeImagesCommand, ECRClient, GetAuthorizationTokenCommand };
});

vi.mock('./container', () => ({
  hostDockerPlatform: () => 'linux/arm64',
  imageRepoDigest: () => `ghcr.io/appliance-sh/api-server@${harness.sourceDigest}`,
  login: vi.fn(),
  pullImage: vi.fn(),
  tagImage: harness.tagImage,
  pushImage: harness.pushImage,
}));

import { mirrorImageToEcr, sourceDigest, sourceProvenanceTag } from './ecr-mirror';

const repository = '123456789012.dkr.ecr.us-east-1.amazonaws.com/appliance';

describe('legacy ECR mirror immutable tags', () => {
  beforeEach(() => {
    harness.images.clear();
    harness.pushImage.mockReset().mockImplementation((image: string) => {
      harness.images.set(image.slice(image.lastIndexOf(':') + 1), harness.platformDigest);
    });
    harness.tagImage.mockReset();
    harness.send
      .mockReset()
      .mockImplementation(
        async (command: { constructor: { name: string }; input: { imageIds?: Array<{ imageTag?: string }> } }) => {
          if (command.constructor.name === 'GetAuthorizationTokenCommand') {
            return {
              authorizationData: [
                {
                  authorizationToken: Buffer.from('AWS:password').toString('base64'),
                  proxyEndpoint: 'https://ecr.test',
                },
              ],
            };
          }
          const imageTag = command.input.imageIds?.[0]?.imageTag;
          if (!imageTag) throw new Error('DescribeImages test command omitted imageTag');
          const imageDigest = harness.images.get(imageTag);
          if (!imageDigest) throw Object.assign(new Error('not found'), { name: 'ImageNotFoundException' });
          return { imageDetails: [{ imageDigest }] };
        }
      );
  });

  it('skips when the target manifest matches source provenance', async () => {
    harness.images.set('1.57.0', harness.platformDigest);
    harness.images.set(sourceProvenanceTag(harness.sourceDigest), harness.platformDigest);

    await expect(mirror('1.57.0')).resolves.toBe(`${repository}@${harness.platformDigest}`);
    expect(harness.pushImage).not.toHaveBeenCalled();
  });

  it('fails actionably when a mutable target tag maps to a different manifest', async () => {
    harness.images.set('latest', `sha256:${'c'.repeat(64)}`);

    await expect(mirror('latest')).rejects.toThrow(
      'tag latest already exists with a different digest; use --image <ref>@sha256:… or a new tag'
    );
    expect(harness.pushImage).toHaveBeenCalledTimes(1);
    expect(harness.pushImage.mock.calls[0]?.[0]).toContain(':src-sha256-');
  });

  it('re-runs the same version by reusing the manifest recorded on the first push', async () => {
    await expect(mirror('1.57.0')).resolves.toBe(`${repository}@${harness.platformDigest}`);
    await expect(mirror('1.57.0')).resolves.toBe(`${repository}@${harness.platformDigest}`);

    expect(harness.pushImage).toHaveBeenCalledTimes(2);
    expect(harness.images.get('1.57.0')).toBe(harness.images.get(sourceProvenanceTag(harness.sourceDigest)));
  });

  it('uses sha256-<hex> as the target tag for digest sources', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(sourceDigest(`ghcr.io/appliance-sh/api-server@${digest}`)?.replace(':', '-')).toBe(
      `sha256-${'a'.repeat(64)}`
    );
  });

  it('does not mistake mutable tags for digest-pinned sources', () => {
    expect(sourceDigest('ghcr.io/appliance-sh/api-server:latest')).toBeUndefined();
    expect(sourceDigest('ghcr.io/appliance-sh/api-server:dev')).toBeUndefined();
  });
});

function mirror(tag: string): Promise<string> {
  return mirrorImageToEcr({
    sourceImage: `ghcr.io/appliance-sh/api-server:${tag}`,
    ecrRepositoryUrl: repository,
    tag,
    region: 'us-east-1',
  });
}
