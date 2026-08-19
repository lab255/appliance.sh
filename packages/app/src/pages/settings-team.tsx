import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2, Loader2, Trash2, UserPlus } from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useApplianceClient } from '@/hooks/use-appliance-client';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useKeyRole } from '@/hooks/use-key-role';
import { relativeTime, relativeUntil } from '@/lib/time';

/**
 * ⑤ Settings → Team. The zero-terminal onboarding surface: an admin
 * types a teammate's name, gets a link, sends it however they like.
 * Opening the link signs the teammate in with their own key — no
 * server URL, no secret to paste. Below the composer: everyone with
 * access (revocable) and any invite links that haven't been used yet.
 *
 * Admin keys only — members don't see this section at all, and the
 * API refuses their calls (403) even if they find the routes.
 */
export function TeamSection() {
  const client = useApplianceClient();
  const { cluster } = useSelectedCluster();
  const { role, isLoading: roleLoading } = useKeyRole();

  if (!client || !cluster || roleLoading || role !== 'admin') return null;

  return (
    <SectionCard
      title="Team"
      description={
        <>
          Give teammates access to <span className="font-medium text-[var(--color-foreground)]">{cluster.name}</span>{' '}
          with a one-time sign-in link.
        </>
      }
    >
      <div className="space-y-5">
        <section aria-labelledby="invite-someone-heading">
          <h3 id="invite-someone-heading" className="mb-2 text-xs font-medium">
            Invite someone
          </h3>
          <InviteComposer />
        </section>
        <PendingInvites />
        <MembersList />
      </div>
    </SectionCard>
  );
}

/** Where invite links should land. Prefer the operator-configured
 *  console URL (hardened deployments host it separately); fall back to
 *  the api-server, which serves the console itself. */
function useInviteLinkBase(): string | null {
  const client = useApplianceClient();
  const { cluster } = useSelectedCluster();

  const { data: info } = useQuery({
    queryKey: ['cluster-info', cluster?.id],
    enabled: Boolean(client && cluster),
    staleTime: 300_000,
    queryFn: async () => {
      const result = await client!.getClusterInfo();
      // Older servers 404 this route — invite links then fall back to
      // the api-server URL, which is also where the console lives.
      return result.success ? result.data : null;
    },
  });

  if (!cluster) return null;
  return (info?.consoleUrl ?? cluster.apiServerUrl).replace(/\/+$/, '');
}

function buildInviteLink(base: string, token: string, apiServerUrl: string): string {
  const params = new URLSearchParams();
  params.set('token', token);
  // The console derives same-origin servers itself, but carrying the
  // server explicitly keeps the link working from a separately-hosted
  // console too. Fragment, not query: never sent to any server.
  params.set('server', apiServerUrl.replace(/\/+$/, ''));
  return `${base}/invite#${params.toString()}`;
}

function InviteComposer() {
  const client = useApplianceClient();
  const { cluster } = useSelectedCluster();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const linkBase = useInviteLinkBase();

  const [name, setName] = React.useState('');
  const [link, setLink] = React.useState<string | null>(null);
  const [invitedName, setInvitedName] = React.useState('');
  const [copyMessage, setCopyMessage] = React.useState('');
  const [copyError, setCopyError] = React.useState('');

  const create = useMutation({
    mutationFn: async (inviteeName: string) => {
      const result = await client!.createInvite({ name: inviteeName });
      if (!result.success) throw result.error;
      return result.data;
    },
    onSuccess: (invite) => {
      setInvitedName(invite.name);
      setLink(buildInviteLink(linkBase!, invite.token, cluster!.apiServerUrl));
      setName('');
      queryClient.invalidateQueries({ queryKey: ['invites', cluster?.id] });
    },
  });

  const copyLink = async () => {
    if (!link) return;
    setCopyError('');
    try {
      await navigator.clipboard.writeText(link);
      setCopyMessage(`Invite link for ${invitedName} copied`);
      toast(`Invite link for ${invitedName} copied — send it to them`);
    } catch {
      setCopyError('Couldn’t copy the link. It is still shown below so you can copy it manually.');
    }
  };

  return (
    <div className="space-y-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && linkBase) create.mutate(name.trim());
        }}
      >
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Teammate's name"
          aria-label="Teammate's name"
          className="max-w-xs"
          disabled={create.isPending}
        />
        <Button type="submit" size="sm" disabled={!name.trim() || !linkBase || create.isPending}>
          {create.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <UserPlus className="h-4 w-4" aria-hidden />
          )}
          Create invite link
        </Button>
      </form>

      {create.error ? (
        <Banner
          tone="error"
          action={
            <Button variant="outline" size="sm" onClick={() => name.trim() && create.mutate(name.trim())}>
              Retry
            </Button>
          }
        >
          Couldn&rsquo;t create an invite for {name || 'this teammate'}.
        </Banner>
      ) : null}

      {link ? (
        <div className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] p-3">
          <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
            <Link2 className="h-3.5 w-3.5" aria-hidden />
            Send this link to {invitedName}. It signs them in once, then expires — shown only now.
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-[var(--color-surface)] px-2 py-1 font-mono text-xs">
              {link}
            </code>
            <Button size="sm" variant="outline" onClick={copyLink}>
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
          </div>
        </div>
      ) : null}
      {copyError ? <Banner tone="error">{copyError}</Banner> : null}
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {link ? `Invite created for ${invitedName}. ${copyMessage}` : ''}
      </span>
    </div>
  );
}

function PendingInvites() {
  const client = useApplianceClient();
  const { cluster } = useSelectedCluster();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [revokeError, setRevokeError] = React.useState<{ id: string; name: string; message: string } | null>(null);

  const { data: invites } = useQuery({
    queryKey: ['invites', cluster?.id],
    enabled: Boolean(client && cluster),
    queryFn: async () => {
      const result = await client!.listInvites();
      if (!result.success) throw result.error;
      return result.data;
    },
  });

  const pending = (invites ?? []).filter((i) => !i.redeemedAt && new Date(i.expiresAt).getTime() > Date.now());
  if (pending.length === 0) return null;

  const revoke = async (id: string, name: string) => {
    const ok = await confirm({
      title: `Cancel the invite for ${name}?`,
      description: 'Their link stops working immediately. Anyone who already joined keeps their access.',
      confirmLabel: 'Cancel invite',
    });
    if (!ok) return;
    setRevokingId(id);
    setRevokeError(null);
    const result = await client!.deleteInvite(id);
    if (!result.success) {
      setRevokingId(null);
      setRevokeError({ id, name, message: result.error.message });
      return;
    }
    setRevokingId(null);
    queryClient.invalidateQueries({ queryKey: ['invites', cluster?.id] });
  };

  return (
    <section className="space-y-1.5" aria-labelledby="pending-invites-heading">
      <h3 id="pending-invites-heading" className="text-xs font-medium">
        Pending invites
      </h3>
      {pending.map((invite) => (
        <div key={invite.id} className="flex items-center justify-between gap-3 text-sm">
          <span>{invite.name}</span>
          <span className="text-xs text-[var(--color-muted-foreground)]">
            expires {relativeUntil(invite.expiresAt)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => revoke(invite.id, invite.name)}
            aria-label={
              revokingId === invite.id ? `Cancelling invite for ${invite.name}…` : `Cancel invite for ${invite.name}`
            }
            disabled={revokingId === invite.id}
          >
            {revokingId === invite.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            )}
          </Button>
        </div>
      ))}
      {revokeError ? (
        <Banner
          tone="error"
          action={
            <Button variant="outline" size="sm" onClick={() => void revoke(revokeError.id, revokeError.name)}>
              Retry
            </Button>
          }
        >
          Couldn&rsquo;t cancel the invite for {revokeError.name}.
        </Banner>
      ) : null}
    </section>
  );
}

function MembersList() {
  const client = useApplianceClient();
  const { cluster } = useSelectedCluster();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [revokeError, setRevokeError] = React.useState<{ id: string; name: string } | null>(null);

  const { data: self } = useQuery({
    queryKey: ['keys', 'self', 'identity', cluster?.id],
    enabled: Boolean(client && cluster),
    staleTime: 60_000,
    queryFn: async () => {
      const result = await client!.whoami();
      return result.success ? result.data : null;
    },
  });

  const { data: keys } = useQuery({
    queryKey: ['keys', 'list', cluster?.id],
    enabled: Boolean(client && cluster),
    queryFn: async () => {
      const result = await client!.listKeys();
      if (!result.success) throw result.error;
      return result.data;
    },
  });

  if (!keys || keys.length === 0) return null;

  const revoke = async (id: string, name: string) => {
    const ok = await confirm({
      title: `Remove ${name}'s access?`,
      description: 'They are signed out everywhere immediately. You can invite them again later.',
      confirmLabel: 'Remove access',
    });
    if (!ok) return;
    setRevokingId(id);
    setRevokeError(null);
    const result = await client!.deleteKey(id);
    if (!result.success) {
      setRevokingId(null);
      setRevokeError({ id, name });
      return;
    }
    setRevokingId(null);
    queryClient.invalidateQueries({ queryKey: ['keys', 'list', cluster?.id] });
  };

  return (
    <section className="space-y-1.5" aria-labelledby="people-access-heading">
      <h3 id="people-access-heading" className="text-xs font-medium">
        People with access
      </h3>
      {keys.map((key) => (
        <div key={key.id} className="flex items-center gap-3 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {key.name}
            {self?.id === key.id ? <span className="text-[var(--color-muted-foreground)]"> (you)</span> : null}
          </span>
          <span className="text-xs text-[var(--color-muted-foreground)]">
            {key.role === 'admin' ? 'admin' : 'member'}
            {key.lastUsedAt ? ` · active ${relativeTime(key.lastUsedAt)}` : ''}
          </span>
          {self?.id !== key.id ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => revoke(key.id, key.name)}
              aria-label={revokingId === key.id ? `Removing ${key.name}…` : `Remove ${key.name}’s access`}
              disabled={revokingId === key.id}
            >
              {revokingId === key.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              )}
            </Button>
          ) : null}
        </div>
      ))}
      {revokeError ? (
        <Banner
          tone="error"
          action={
            <Button variant="outline" size="sm" onClick={() => void revoke(revokeError.id, revokeError.name)}>
              Retry
            </Button>
          }
        >
          Couldn&rsquo;t remove {revokeError.name}&rsquo;s access.
        </Banner>
      ) : null}
    </section>
  );
}
