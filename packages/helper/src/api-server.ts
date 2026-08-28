import { sleep } from './exec.js';

// Client-side helpers for the appliance api-server: URL derivation,
// readiness polling, and bootstrap-token key minting. The api-server
// itself runs as a guest binary inside the microVM (launched by the
// appliance-vm engine's boot provisioning) or as cloud compute — there
// is no host-side bootstrap or manifest rendering anymore.

/** Hostname the local runtime's api-server is routed on (via the VM's
 *  ingress) — the URL shape every saved profile uses. */
export const IN_CLUSTER_API_SERVER_HOSTNAME = 'api.appliance.localhost';

export function apiServerUrlForHostPort(hostPort: number): string {
  return hostPort === 80
    ? `http://${IN_CLUSTER_API_SERVER_HOSTNAME}`
    : `http://${IN_CLUSTER_API_SERVER_HOSTNAME}:${hostPort}`;
}

/**
 * Poll until `<url>/bootstrap/status` answers 2xx, or the timeout
 * elapses — i.e. the api-server is up and reachable via its ingress.
 */
export async function waitForApiServerUrl(url: string, maxWaitMs: number): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  const target = `${url.replace(/\/+$/, '')}/bootstrap/status`;
  for (;;) {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return;
    } catch {
      // unreachable — keep polling until the deadline
    }
    if (Date.now() >= deadline) {
      throw new Error(`api-server did not become reachable at ${url} within ${Math.round(maxWaitMs / 1000)}s`);
    }
    await sleep(500);
  }
}

export interface MintedApiKey {
  id: string;
  secret: string;
}

/** Mint an initial API key via `/bootstrap/create-key`. */
export async function mintApiKey(apiServerUrl: string, token: string, name = 'Local Runtime'): Promise<MintedApiKey> {
  const url = `${apiServerUrl.replace(/\/+$/, '')}/bootstrap/create-key`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Bootstrap-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`mint api key failed: HTTP ${res.status} ${body.trim()}`);
  }
  const parsed = (await res.json()) as Partial<MintedApiKey>;
  if (typeof parsed.id !== 'string' || typeof parsed.secret !== 'string') {
    throw new Error('mint api key failed: response missing id/secret');
  }
  return { id: parsed.id, secret: parsed.secret };
}
