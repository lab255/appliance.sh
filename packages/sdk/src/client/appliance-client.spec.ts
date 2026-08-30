import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplianceClient } from './appliance-client';
import { VERSION } from '../version';
import type { ReleaseEnvelope, ReleaseSignatureEnvelope, SelfUpdatePublicJob } from '../models';

// The `x-appliance-client` tag must be context-sensitive: server-side
// callers (CLI, engine, tests — no `document` global) always send it,
// browser/webview callers NEVER do. Old deployed api-servers don't
// allow the header in their CORS preflight allow-list, so a browser
// client attaching it would lose every cross-origin request to a
// network-shaped TypeError — no 401, no heal, no banner.

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch() {
  const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  return (init.headers ?? {}) as Record<string, string>;
}

describe('x-appliance-client tagging', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends <product>/<version> from non-browser contexts', async () => {
    const fetchMock = stubFetch();
    const client = createApplianceClient({ baseUrl: 'http://api.test', product: 'cli' });

    await client.healthz();

    expect(sentHeaders(fetchMock)['x-appliance-client']).toBe(`cli/${VERSION}`);
  });

  it('defaults the product tag to sdk', async () => {
    const fetchMock = stubFetch();
    const client = createApplianceClient({ baseUrl: 'http://api.test' });

    await client.getBootstrapStatus();

    expect(sentHeaders(fetchMock)['x-appliance-client']).toBe(`sdk/${VERSION}`);
  });

  it('never sends the tag when a document global exists (browser/webview)', async () => {
    // Simulate a browser context: the constructor keys off `document`.
    vi.stubGlobal('document', {});
    const fetchMock = stubFetch();
    const client = createApplianceClient({ baseUrl: 'http://api.test', product: 'app' });

    await client.healthz();
    await client.getBootstrapStatus();

    for (const call of fetchMock.mock.calls) {
      const headers = ((call as unknown[])[1] as RequestInit).headers as Record<string, string>;
      expect(headers?.['x-appliance-client']).toBeUndefined();
    }
  });

  it('tags signed data-plane requests in non-browser contexts too', async () => {
    const fetchMock = stubFetch();
    const client = createApplianceClient({
      baseUrl: 'http://api.test',
      product: 'cli',
      credentials: { keyId: 'k1', secret: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=' },
    });

    await client.listProjects();

    const headers = sentHeaders(fetchMock);
    expect(headers['x-appliance-client']).toBe(`cli/${VERSION}`);
    // Signing still happened alongside the (unsigned) tag header.
    expect(headers['signature']).toBeDefined();
  });
});

describe('self-update client', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const digest = `sha256:${'a'.repeat(64)}`;
  const evidence = {
    payload: {
      kind: 'control-plane-release',
      version: '1.58.0',
      generation: 2,
      notBefore: '2026-08-01T00:00:00Z',
      expires: '2026-09-30T00:00:00Z',
      artifacts: [
        { name: 'appliance-api-server-linux-x64', arch: 'x64', sha256: '1'.repeat(64), size: 1 },
        { name: 'appliance-api-server-linux-arm64', arch: 'arm64', sha256: '2'.repeat(64), size: 1 },
        { name: 'appliance-console.tar.gz', arch: 'any', sha256: '3'.repeat(64), size: 1 },
      ],
      image: { repository: 'ghcr.io/lab255/appliance-api-server', manifestDigest: digest },
    } as ReleaseEnvelope,
    envelope: {
      alg: 'ed25519',
      keyId: `ed25519:sha256:${'4'.repeat(64)}`,
      role: 'control-plane-release',
      sig: 'AA',
    } as ReleaseSignatureEnvelope,
  };

  it.each([202, 409] as const)('returns a typed %s start response with the idempotency key', async (status) => {
    const fetchMock = vi.fn(async () =>
      jsonResponseFor(status, {
        jobId: 'selfupdate_1',
        ...(status === 202 ? { status: 'queued' } : {}),
        statusUrl: '/api/v1/self-update/selfupdate_1',
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createApplianceClient({
      baseUrl: 'https://api.test',
      credentials: { keyId: 'k1', secret: 'secret' },
    });

    const result = await client.selfUpdate.start({ targetDigest: digest, release: evidence, idempotencyKey: 'once' });

    expect(result).toMatchObject({ success: true, data: { httpStatus: status, jobId: 'selfupdate_1' } });
    expect(sentHeaders(fetchMock)['idempotency-key']).toBe('once');
    expect(sentHeaders(fetchMock).signature).toBeDefined();
  });

  it('polls phase changes and resolves on a terminal job', async () => {
    vi.useFakeTimers();
    const phases = ['mirroring', 'mirroring', 'probing-health', 'complete'] as const;
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const phase = phases[Math.min(call++, phases.length - 1)]!;
        return jsonResponseFor(200, job(phase, phase === 'complete' ? 'succeeded' : 'running'));
      })
    );
    const client = createApplianceClient({ baseUrl: 'https://api.test' });
    const seen: string[] = [];
    const watching = client.selfUpdate.watch('job/unsafe', {
      intervalMs: 10,
      onPhase: (value) => seen.push(value.phase),
    });
    await vi.runAllTimersAsync();

    await expect(watching).resolves.toMatchObject({ success: true, data: { status: 'succeeded' } });
    expect(seen).toEqual(['mirroring', 'probing-health', 'complete']);
  });
});

function jsonResponseFor(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function job(phase: SelfUpdatePublicJob['phase'], status: SelfUpdatePublicJob['status']): SelfUpdatePublicJob {
  return {
    jobId: 'selfupdate_1',
    status,
    phase,
    target: { digest: `sha256:${'a'.repeat(64)}`, version: '1.58.0', generation: 2, source: 'ghcr.io/x@y' },
    timestamps: {
      createdAt: '2026-08-30T00:00:00Z',
      updatedAt: '2026-08-30T00:00:01Z',
      heartbeatAt: '2026-08-30T00:00:01Z',
      leaseExpiresAt: '2026-08-30T00:01:01Z',
    },
  };
}
