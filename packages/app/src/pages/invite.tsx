import * as React from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { createApplianceClient } from '@appliance.sh/sdk/client';
import { Loader2, CheckCircle2, AlertTriangle, Server } from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { PageShell } from '@/components/ui/page-shell';
import { useHost } from '@/providers/host-provider';
import { runtimeConfig } from '@/lib/runtime-config';

/**
 * Invite landing — the page an invite link opens. The token rides the
 * URL FRAGMENT (never sent to any server or logged) as
 * `/invite#token=<inv_…>&server=<api-url>`. Redeeming mints this
 * person their own key; nothing is typed or pasted. On success the
 * cluster is stored and the app takes over.
 */

export interface InviteParams {
  token: string | null;
  server: string | null;
}

export function parseInviteHash(hash: string): InviteParams {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  // Tolerate both `#token=…` and the short `#invite=…` form.
  const params = new URLSearchParams(raw);
  const token = params.get('token') ?? params.get('invite');
  const server = params.get('server');
  return { token: token || null, server: server || null };
}

/** Pull the server's human message out of the SDK's `HTTP nnn: {json}` error string. */
function friendlyRedeemError(message: string): string {
  const jsonStart = message.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const body = JSON.parse(message.slice(jsonStart)) as { error?: string };
      if (body.error) return body.error;
    } catch {
      // fall through to the raw message
    }
  }
  return message;
}

type Phase = 'redeeming' | 'done' | 'error';

export function InvitePage() {
  const host = useHost();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [phase, setPhase] = React.useState<Phase>('redeeming');
  const [error, setError] = React.useState<string | null>(null);
  const started = React.useRef(false);
  const phaseHeadingRef = React.useRef<HTMLHeadingElement>(null);

  React.useEffect(() => {
    phaseHeadingRef.current?.focus();
  }, [phase]);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;

    const { token, server } = parseInviteHash(window.location.hash);
    const serverUrl = (server ?? runtimeConfig().apiServerUrl ?? window.location.origin).replace(/\/+$/, '');

    if (!token) {
      setPhase('error');
      setError('This invite link is incomplete — make sure the whole link was copied, then try it again.');
      return;
    }

    (async () => {
      const client = createApplianceClient({ baseUrl: serverUrl });
      const result = await client.redeemInvite(token);
      if (!result.success) {
        setPhase('error');
        setError(friendlyRedeemError(result.error.message));
        return;
      }

      await host.addCluster({
        name: deriveClusterName(serverUrl),
        apiServerUrl: serverUrl,
        apiKey: { id: result.data.id, secret: result.data.secret },
      });
      await queryClient.invalidateQueries({ queryKey: ['host', 'config'] });

      // Drop the token from the address bar so it can't be re-copied
      // or bookmarked (it's spent anyway, but a dead credential in a
      // bookmark still invites confusion).
      window.history.replaceState(null, '', window.location.pathname);

      setPhase('done');
      window.setTimeout(() => navigate('/', { replace: true }), 600);
    })().catch((err) => {
      setPhase('error');
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [host, navigate, queryClient]);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <PageShell rail="focused" className="max-w-md space-y-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-foreground)] text-[var(--color-background)]">
          <Server className="h-6 w-6" aria-hidden />
        </div>

        {phase === 'redeeming' ? (
          <div role="status" aria-live="polite" aria-atomic="true">
            <h1 ref={phaseHeadingRef} tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
              Joining your team…
            </h1>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Your invite is creating your own sign-in for this team. This usually takes a few seconds.
            </p>
            <Loader2 className="mx-auto mt-4 h-6 w-6 animate-spin text-[var(--color-muted-foreground)]" aria-hidden />
          </div>
        ) : null}

        {phase === 'done' ? (
          <div role="status" aria-live="polite" aria-atomic="true">
            <h1 ref={phaseHeadingRef} tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
              You&apos;re in
            </h1>
            <p className="text-sm text-[var(--color-muted-foreground)]">Taking you to your team&apos;s apps…</p>
            <CheckCircle2 className="mx-auto mt-4 h-6 w-6 text-[var(--color-success-foreground)]" aria-hidden />
          </div>
        ) : null}

        {phase === 'error' ? (
          <div>
            <h1 ref={phaseHeadingRef} tabIndex={-1} className="text-2xl font-semibold focus:outline-none">
              This invite didn&apos;t work
            </h1>
            <Banner tone="error" icon={AlertTriangle} className="mx-auto mt-4 text-left">
              {error}
            </Banner>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Invite links work once and expire after a while. Ask the person who invited you for a new invite.
            </p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => {
                window.history.replaceState(null, '', window.location.pathname);
                navigate('/');
              }}
            >
              Back to Appliance
            </Button>
          </div>
        ) : null}
      </PageShell>
    </div>
  );
}

function deriveClusterName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^api\./, '');
  } catch {
    return url;
  }
}

/**
 * Shown instead of the app when this origin is a bootstrap-only
 * console (APPLIANCE_CONSOLE_MODE=bootstrap): setup worked, day-to-day
 * management lives at the hardened console the operator configured.
 */
export function BootstrapHandoffPage() {
  const consoleUrl = runtimeConfig().consoleUrl ?? null;
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-foreground)] text-[var(--color-background)]">
          <Server className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-semibold">You&apos;re set up</h1>
        {consoleUrl ? (
          <>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              This page only handles sign-up. Your team&apos;s console lives at its own address — bookmark it and sign
              in there.
            </p>
            <Button asChild>
              <a href={consoleUrl}>Continue to the console</a>
            </Button>
          </>
        ) : (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            This page only handles sign-up. Ask your administrator where your team&apos;s console lives, or use the
            desktop app.
          </p>
        )}
      </div>
    </div>
  );
}
