import * as React from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { useHost } from '@/providers/host-provider';
import type { AbleAccountStatus } from '@/lib/host';

export function AccountSection() {
  const { account } = useHost();
  const [status, setStatus] = React.useState<AbleAccountStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  React.useEffect(() => {
    let active = true;
    const read = () =>
      account
        ?.status()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch(() => {
          if (active) setError('Could not read your account. Please retry.');
        });
    void read();
    // Reflect CLI sign-out without persisting identity or tokens in webview storage.
    const timer = setInterval(() => void read(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [account]);
  async function run(action: 'signIn' | 'signOut') {
    if (!account) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await account[action]();
      setStatus(next);
      if (next.revocationFailed)
        setNotice('Credentials erased from this host. able could not confirm upstream revocation.');
    } catch (cause) {
      setError(typeof cause === 'string' ? cause : 'Sign-in could not finish. Please retry.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <SectionCard title="Account" description="Your optional able identity, shared with the CLI on this host.">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Apps work without an account. Signing in does not activate grants or restore history.
        </p>
        <p className="text-sm">{status?.signedIn ? `Signed in as ${status.email}` : 'Signed out'}</p>
        {busy ? (
          <p role="status" className="text-sm text-muted-foreground">
            Finish sign-in in your browser. This expires after five minutes.
          </p>
        ) : null}
        <div className="flex gap-2">
          {!status?.signedIn ? (
            <Button disabled={busy || !status} onClick={() => void run('signIn')}>
              Sign in with able
            </Button>
          ) : null}
          {status?.signedIn || busy ? (
            <Button variant="outline" onClick={() => void run('signOut')}>
              {busy ? 'Cancel sign-in' : 'Sign out'}
            </Button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}
