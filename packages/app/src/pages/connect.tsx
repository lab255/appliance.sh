import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { createApplianceClient } from '@appliance.sh/sdk/client';
import { Button } from '@/components/ui/button';
import { FriendlyError } from '@/components/friendly-error';
import { clearAuthFailure } from '@/lib/auth-signal';
import { useHost } from '@/providers/host-provider';

// Adds a cluster: probes the URL, then calls host.addCluster() which
// persists the entry, stores the key in the OS keychain (Tauri) or
// sessionStorage (web), and selects it. On shells that can drive a
// local bootstrap (Tauri desktop) we link to the wizard instead.
export function ConnectPage() {
  const host = useHost();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canBootstrap = Boolean(host.bootstrap);

  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [keyId, setKeyId] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Auto-name the cluster from the URL hostname unless the user has
  // typed something. Stops once they edit the name field.
  const userTouchedName = React.useRef(false);
  React.useEffect(() => {
    if (userTouchedName.current) return;
    const derived = deriveNameFromUrl(url);
    if (derived) setName(derived);
  }, [url]);

  // No key-format gating here: ID/secret shapes have drifted before
  // (the server mints `apikey_…` IDs while old docs said `ak_…`) and a
  // prefix check that's wrong makes connecting impossible. The real
  // validation is the authenticated probe in onSubmit.
  const canSubmit =
    name.trim().length > 0 &&
    url.trim().length > 0 &&
    keyId.trim().length > 0 &&
    secret.trim().length > 0 &&
    !submitting;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const normalizedUrl = url.trim().replace(/\/+$/, '');
      const trimmedKeyId = keyId.trim();
      const trimmedSecret = secret.trim();
      await verifyApiServer(normalizedUrl);
      await verifyCredentials(normalizedUrl, trimmedKeyId, trimmedSecret);
      await host.addCluster({
        name: name.trim(),
        apiServerUrl: normalizedUrl,
        apiKey: { id: trimmedKeyId, secret: trimmedSecret },
      });
      await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });
      clearAuthFailure();
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  // Probe the unauthenticated bootstrap/status endpoint to confirm
  // we're actually talking to an Appliance api-server before
  // stashing credentials. 10s timeout catches silent hangs (slow
  // DNS, unreachable host) so the user doesn't get stuck on the
  // "Connecting…" button.
  async function verifyApiServer(serverUrl: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(`${serverUrl}/bootstrap/status`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error(`${serverUrl} did not respond within 10s`);
      }
      throw new Error(`could not reach ${serverUrl} — check the URL and your network`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`${serverUrl}/bootstrap/status returned ${response.status} ${response.statusText}`);
    }
    const body = (await response.json().catch(() => null)) as { initialized?: unknown } | null;
    if (!body || typeof body.initialized !== 'boolean') {
      throw new Error(`unexpected response from ${serverUrl}/bootstrap/status — is this an Appliance api-server?`);
    }
  }

  // Make one signed request before stashing the key. A typo'd secret
  // otherwise "connects" fine and then every page fails with opaque
  // 401s — failing here, with the fix in hand, is the kinder UX.
  async function verifyCredentials(serverUrl: string, id: string, secretValue: string): Promise<void> {
    const client = createApplianceClient({ baseUrl: serverUrl, credentials: { keyId: id, secret: secretValue } });
    const result = await client.listProjects();
    if (!result.success) {
      throw new Error(
        `the server is reachable but rejected these credentials (${result.error.message}). ` +
          'Double-check the access key ID and secret with whoever gave them to you. ' +
          '(If you use the CLI, `appliance whoami` shows the active key.)'
      );
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-6 pt-16">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Connect to your team&apos;s server</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Invited by a teammate? Just open the invite link they sent you and you&apos;re in — nothing to fill in here.
          {canBootstrap ? null : (
            <>
              {' '}
              Setting up from scratch instead? Run{' '}
              <code className="rounded bg-[var(--color-muted)] px-1.5 py-0.5">appliance vm up</code> for a local
              runtime, or <code className="rounded bg-[var(--color-muted)] px-1.5 py-0.5">appliance cloud install</code>{' '}
              for AWS.
            </>
          )}
        </p>
      </div>

      {/* The manual form is the exception, not the lead — collapsed by
          default so invite-link users aren't confronted with key fields. */}
      <details className="rounded-md border border-[var(--color-border)] p-4">
        <summary className="cursor-pointer select-none text-sm font-medium">Advanced: connect manually</summary>
        <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
          For connecting with a server address and access key an admin gave you.
        </p>
        <form onSubmit={onSubmit} className="mt-3 space-y-4">
          <Field label="API server URL" hint="e.g. https://api.example.appliance.sh">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.example.appliance.sh"
              className={inputCls}
            />
          </Field>

          <Field label="Cluster name" hint="how this cluster appears in the sidebar">
            <input
              type="text"
              value={name}
              onChange={(e) => {
                userTouchedName.current = true;
                setName(e.target.value);
              }}
              placeholder="production"
              className={inputCls}
            />
          </Field>

          <Field label="Access key ID" hint="apikey_…">
            <input
              type="text"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              placeholder="apikey_…"
              className={`${inputCls} font-mono`}
            />
          </Field>

          <Field label="Secret access key" hint="sk_…">
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="sk_…"
              className={`${inputCls} font-mono`}
            />
          </Field>

          {error ? (
            <FriendlyError error={error} fallbackHeadline="Couldn't connect to that server" hideReconnect />
          ) : null}

          <Button type="submit" disabled={!canSubmit} className="w-full">
            {submitting ? 'Connecting…' : 'Add cluster'}
          </Button>
        </form>
      </details>

      {canBootstrap ? (
        <div className="rounded-md border border-[var(--color-border)] p-4">
          <div className="text-sm">Nothing to connect to yet?</div>
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            Provision a new installation from this machine — uses your current AWS credentials.
          </p>
          <Button asChild variant="outline" className="mt-3">
            <Link to="/cloud/bootstrap">Bootstrap new installation</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function deriveNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    // Strip an "api." prefix so https://api.foo.example → "foo.example".
    return u.hostname.replace(/^api\./, '');
  } catch {
    return '';
  }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <div className="flex items-baseline justify-between">
        <span className="text-[var(--color-muted-foreground)]">{label}</span>
        {hint ? <span className="text-xs text-[var(--color-muted-foreground)]">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]';
