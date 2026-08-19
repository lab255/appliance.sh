import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/ui/banner';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { Tag } from '@/components/ui/tag';
import { FriendlyError } from '@/components/friendly-error';
import type { MicroVmInstanceHost } from '@/lib/host';

// Per-host credential capture/injection (apiKeyHelper): the proxy can
// lift a credential header off a workload's request into a host-side
// store and/or inject it onto outbound requests, so secrets live
// outside the VM. Requires TLS interception (the proxy must see
// decrypted headers).
//
// `mitmOn` is passed in by the ② cluster-detail container from the SINGLE
// lifted egress-policy query (docs/desktop-ia.md §5.5) — this panel used to
// run its own `['microvm', name, 'egress']` 15 s poll only to read
// `policy.mitm`, doubling the egress fetch. It no longer fetches the policy;
// the credentials list (a separate key) stays local.
export function CredentialsPanel({ vm, name, mitmOn }: { vm: MicroVmInstanceHost; name: string; mitmOn: boolean }) {
  const queryClient = useQueryClient();
  const creds = vm.creds;
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // New-rule form.
  const [ruleHost, setRuleHost] = React.useState('');
  const [capture, setCapture] = React.useState(true);
  const [inject, setInject] = React.useState(true);
  const [header, setHeader] = React.useState('authorization');
  const [helper, setHelper] = React.useState('');
  const [formOpen, setFormOpen] = React.useState(false);
  const [forgetConfirm, setForgetConfirm] = React.useState(false);
  const [pendingRemoval, setPendingRemoval] = React.useState<string | null>(null);
  const removalTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (removalTimer.current) clearTimeout(removalTimer.current);
    },
    []
  );

  const credsQuery = useQuery({
    queryKey: ['microvm', name, 'creds'],
    queryFn: () => creds.list(),
    refetchInterval: 15_000,
  });
  const data = credsQuery.data;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['microvm', name, 'creds'] });

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const addRule = async () => {
    const h = ruleHost.trim();
    if (!h) return;
    const helperCmd = helper.trim();
    const added = await act(() =>
      creds.add({ host: h, capture, inject, header: header.trim() || 'authorization', helper: helperCmd || undefined })
    );
    if (added) {
      setRuleHost('');
      setHelper('');
      setFormOpen(false);
    }
  };

  const scheduleRemoval = (host: string) => {
    if (removalTimer.current) clearTimeout(removalTimer.current);
    setPendingRemoval(host);
    removalTimer.current = setTimeout(() => {
      setPendingRemoval(null);
      void act(() => creds.remove(host));
    }, 5_000);
  };

  const undoRemoval = () => {
    if (removalTimer.current) clearTimeout(removalTimer.current);
    removalTimer.current = null;
    setPendingRemoval(null);
  };

  return (
    <SectionCard
      title="Credential rules"
      description={
        data
          ? `${data.rules.length} rule${data.rules.length === 1 ? '' : 's'} · ${data.secrets.length} stored credential${data.secrets.length === 1 ? '' : 's'}`
          : 'Loading…'
      }
      action={
        !formOpen ? (
          <Button size="sm" variant="outline" onClick={() => setFormOpen(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add credential rule
          </Button>
        ) : undefined
      }
    >
      <p className="text-sm leading-5 text-[var(--color-muted-foreground)]">
        Keep app credentials outside the Sandbox and add them only for approved services.
      </p>
      {!mitmOn ? (
        <Banner className="mt-3" tone="warning">
          Turn on secure traffic inspection under Internet access before credential rules can work.
        </Banner>
      ) : null}
      {pendingRemoval ? (
        <Banner
          className="mt-3"
          action={
            <Button size="sm" variant="outline" onClick={undoRemoval}>
              Undo
            </Button>
          }
        >
          Rule for {pendingRemoval} will be removed in 5 seconds.
        </Banner>
      ) : null}

      {formOpen ? (
        <form
          className="mt-3 space-y-3 rounded-md border border-[var(--color-border)] p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void addRule();
          }}
        >
          <Field label="Approved service host" htmlFor="credential-host" hint="For example, api.openai.com.">
            <Input
              id="credential-host"
              mono
              value={ruleHost}
              onChange={(e) => setRuleHost(e.target.value)}
              aria-describedby={!mitmOn ? 'credential-tls-note' : undefined}
            />
          </Field>
          <details className="rounded-md border border-[var(--color-border)] p-3">
            <summary className="cursor-pointer text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
              Technical details
            </summary>
            <div className="mt-3 space-y-3" id={!mitmOn ? 'credential-tls-note' : undefined}>
              <Field
                label="Header override"
                htmlFor="credential-header"
                hint="The request header that carries the credential."
              >
                <Input id="credential-header" mono value={header} onChange={(e) => setHeader(e.target.value)} />
              </Field>
              <Field
                label="Helper command"
                htmlFor="credential-helper"
                hint="Optional. Its standard output becomes the credential."
              >
                <Input id="credential-helper" mono value={helper} onChange={(e) => setHelper(e.target.value)} />
              </Field>
              <div className="flex flex-wrap gap-4">
                <label className="inline-flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={capture} onChange={(e) => setCapture(e.target.checked)} />
                  Save a credential seen in this header
                </label>
                <label className="inline-flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={inject} onChange={(e) => setInject(e.target.checked)} />
                  Add the saved credential to requests
                </label>
              </div>
              {!mitmOn ? (
                <p className="text-xs leading-4 text-[var(--color-warning-foreground)]">
                  Secure traffic inspection is required for these controls.
                </p>
              ) : null}
            </div>
          </details>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !ruleHost.trim()}>
              Add rule
            </Button>
          </div>
        </form>
      ) : null}

      <div className="mt-3 space-y-3">
        {/* Rules */}
        {data && data.rules.length > 0 ? (
          <ul className="space-y-1">
            {data.rules
              .filter((r) => r.host !== pendingRemoval)
              .map((r) => (
                <li
                  key={r.host}
                  className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2 py-1 text-micro"
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{r.host}</span>
                  <span className="shrink-0 font-mono text-micro text-[var(--color-muted-foreground)]">{r.header}</span>
                  {r.capture ? <Tag>save</Tag> : null}
                  {r.inject ? <Tag>add to requests</Tag> : null}
                  {r.helper ? <Tag>helper</Tag> : null}
                  <button
                    type="button"
                    aria-label={`Remove ${r.host}`}
                    disabled={busy}
                    onClick={() => scheduleRemoval(r.host)}
                    className="shrink-0 rounded p-0.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:opacity-50"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
          </ul>
        ) : null}

        {/* Stored secrets */}
        {data && data.secrets.length > 0 ? (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-micro font-medium uppercase tracking-[0.08em] text-[var(--color-muted-foreground)]">
                Stored secrets
              </span>
              {forgetConfirm ? (
                <div className="flex items-center gap-2 text-xs">
                  <span>
                    Forget {data.secrets.length} stored credential{data.secrets.length === 1 ? '' : 's'}? Future
                    requests may ask you to sign in again. Rules stay in place.
                  </span>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      setForgetConfirm(false);
                      void act(() => creds.forget());
                    }}
                  >
                    Forget
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setForgetConfirm(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setForgetConfirm(true)}
                  className="rounded text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-destructive-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
                >
                  Forget stored credentials
                </button>
              )}
            </div>
            <ul className="space-y-0.5">
              {data.secrets.map((s) => (
                <li key={`${s.host}:${s.header}`} className="flex items-center gap-2 px-1 text-micro">
                  <span className="min-w-0 flex-1 truncate font-mono">{s.host}</span>
                  <span className="font-mono text-micro text-[var(--color-muted-foreground)]">{s.header}</span>
                  <span className="font-mono text-micro text-[var(--color-muted-foreground)]">{s.masked}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {err ? <FriendlyError error={err} headline="That change didn't apply" className="mt-2 text-xs" /> : null}
    </SectionCard>
  );
}
