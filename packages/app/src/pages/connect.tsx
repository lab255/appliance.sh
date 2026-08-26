import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { createApplianceClient } from '@appliance.sh/sdk/client';
import { Button } from '@/components/ui/button';
import { FriendlyError } from '@/components/friendly-error';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { SectionCard } from '@/components/ui/section-card';
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
  const errorRef = React.useRef<HTMLDivElement>(null);
  const [connectedMessage, setConnectedMessage] = React.useState('');

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
      setConnectedMessage(`Connected to ${name.trim()}`);
      window.setTimeout(() => navigate('/'), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  React.useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

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
    <PageShell rail="focused" className="space-y-6 pt-16">
      <PageHeader
        focused
        title="Connect to your team&rsquo;s cloud"
        description={
          <>Invited by a teammate? Open the invite link they sent you. It signs you in without anything to type here.</>
        }
      />

      {/* The manual form is the exception, not the lead — collapsed by
          default so invite-link users aren't confronted with key fields. */}
      <details className="max-w-lg rounded-md border border-[var(--color-border)] p-4">
        <summary className="cursor-pointer select-none rounded text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
          Connect manually
        </summary>
        <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
          For connecting with a server address and access key an admin gave you.
        </p>
        <form onSubmit={onSubmit} className="mt-3 space-y-4">
          <Field label="Server address" htmlFor="connect-server-url">
            <Input
              id="connect-server-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.example.appliance.sh"
              disabled={submitting}
            />
          </Field>

          <Field label="Name on this computer" htmlFor="connect-name">
            <Input
              id="connect-name"
              type="text"
              value={name}
              onChange={(e) => {
                userTouchedName.current = true;
                setName(e.target.value);
              }}
              placeholder="production"
              disabled={submitting}
            />
          </Field>

          <Field label="Access key" htmlFor="connect-key-id">
            <Input
              id="connect-key-id"
              type="text"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              placeholder="apikey_…"
              mono
              disabled={submitting}
            />
          </Field>

          <Field label="Secret" htmlFor="connect-secret">
            <Input
              id="connect-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="sk_…"
              mono
              disabled={submitting}
            />
          </Field>

          <details className="text-xs text-[var(--color-muted-foreground)]">
            <summary className="cursor-pointer rounded font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
              Technical details
            </summary>
            <p className="mt-1">
              Server addresses normally use HTTPS. Access keys commonly begin with{' '}
              <code className="font-mono">apikey_</code> and secrets with <code className="font-mono">sk_</code>, but
              Appliance validates them by connecting rather than by prefix.
            </p>
          </details>

          {error ? (
            <div ref={errorRef} tabIndex={-1} className="focus:outline-none">
              <FriendlyError error={error} fallbackHeadline="Couldn't connect to that server" hideReconnect />
            </div>
          ) : null}

          <Button
            type="submit"
            disabled={!canSubmit}
            className="w-full"
            aria-describedby={error ? 'connect-error-link' : undefined}
          >
            {submitting ? 'Connecting…' : 'Connect'}
          </Button>
          {error ? (
            <span id="connect-error-link" className="sr-only">
              The connection error is shown above this button.
            </span>
          ) : null}
          <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {connectedMessage || (submitting ? 'Connecting' : '')}
          </span>
        </form>
      </details>

      {canBootstrap ? (
        <SectionCard
          className="max-w-lg"
          title="Nothing to connect to yet?"
          description="Create an Appliance cloud installation in your AWS account."
        >
          <Button asChild variant="outline" className="mt-3">
            <Link to="/cloud/bootstrap">Create in AWS</Link>
          </Button>
        </SectionCard>
      ) : null}
    </PageShell>
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
