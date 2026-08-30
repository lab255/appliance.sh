import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('api-server Dockerfile tooling pins', () => {
  it('checks both pinned crane architecture tarballs before extraction', () => {
    const dockerfile = readFileSync(join(__dirname, '../Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/ARG CRANE_VERSION=v0\.20\.6/);
    expect(dockerfile).toMatch(/ARG CRANE_SHA256_AMD64=[0-9a-f]{64}/);
    expect(dockerfile).toMatch(/ARG CRANE_SHA256_ARM64=[0-9a-f]{64}/);
    expect(dockerfile).toContain('sha256sum -c -');
    expect(dockerfile.indexOf('sha256sum -c -')).toBeLessThan(dockerfile.indexOf('tar -xzf /tmp/crane.tar.gz'));
  });
});
