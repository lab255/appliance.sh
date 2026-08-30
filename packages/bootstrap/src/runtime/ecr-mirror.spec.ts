import { describe, expect, it } from 'vitest';
import { sourceDigest } from './ecr-mirror';

describe('legacy ECR mirror immutable-tag helpers', () => {
  it('extracts a digest source so callers use sha256-<hex> as the target tag', () => {
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
