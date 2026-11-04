import { Checkbox } from '@appliance.sh/ui';
import * as React from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@appliance.sh/ui/dialog';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/ui/banner';
import type { EntitlementGrantPrompt } from '@/lib/host';

type GrantDialogProps = Omit<React.ComponentProps<typeof GrantDialogContent>, 'open' | 'prompt'> & {
  prompt: EntitlementGrantPrompt | null;
};

/** Retain the last prompt while DS presence owns the exit animation. */
export function GrantDialog(props: GrantDialogProps) {
  const last = React.useRef<(Omit<GrantDialogProps, 'prompt'> & { prompt: EntitlementGrantPrompt }) | null>(null);
  if (props.prompt) last.current = { ...props, prompt: props.prompt };
  // The exiting content is rendered from a pre-exit presence snapshot, so
  // closed-state props never reach it. Route the grant through a stable
  // handler that re-checks the live prompt, keeping the retained content
  // inert during the exit animation.
  const liveRef = React.useRef(props);
  liveRef.current = props;
  const onGrant = React.useCallback((grantIds: string[]) => {
    if (liveRef.current.prompt) liveRef.current.onGrant(grantIds);
  }, []);
  if (!last.current) return null;
  return <GrantDialogContent {...last.current} onGrant={onGrant} open={!!props.prompt} />;
}

function GrantDialogContent({
  open,
  prompt,
  busy = false,
  platform,
  wslMode = 'strict',
  onCancel,
  onGrant,
}: {
  open: boolean;
  prompt: EntitlementGrantPrompt;
  busy?: boolean;
  platform?: 'macos' | 'windows' | 'linux';
  wslMode?: 'strict' | 'cooperative';
  onCancel: () => void;
  onGrant: (grantIds: string[]) => void;
}) {
  const required = React.useMemo(() => new Set(prompt.requiredGrantIds), [prompt.requiredGrantIds]);
  const requiredGrants = prompt.grants.filter((grant) => required.has(grant.id));
  const mounts = prompt.grants.filter((grant) => grant.control === 'mount' && !required.has(grant.id));
  const wslEgressWarning =
    platform === 'windows' &&
    wslMode === 'cooperative' &&
    prompt.grants.some((grant) => grant.control === 'egress-host');
  const [selected, setSelected] = React.useState(() => new Set(prompt.grants.map((grant) => grant.id)));
  React.useEffect(() => {
    if (open) setSelected(new Set(prompt.grants.map((grant) => grant.id)));
  }, [open, prompt]);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const invokingElementRef = React.useRef<HTMLElement | null>(null);

  const toggle = (id: string) => {
    if (required.has(id)) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <DialogContent
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="grant-dialog-title"
        aria-describedby={`grant-dialog-description${wslEgressWarning ? ' grant-wsl-egress-warning' : ''}`}
        className="max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          invokingElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          cancelRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          invokingElementRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--color-success-border)] bg-[var(--color-success-background)] text-[var(--color-success-foreground)]">
            <ShieldCheck className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <DialogTitle id="grant-dialog-title" className="text-sm font-semibold">
              {prompt.upgrade ? 'Approve new controls' : 'Grant app controls'}
            </DialogTitle>
            <DialogDescription
              id="grant-dialog-description"
              className="mt-1 text-sm text-[var(--color-muted-foreground)]"
            >
              {prompt.appId} {prompt.version} ({prompt.license}) asks for the controls below. Required controls are
              needed to install; mounts can be declined.
            </DialogDescription>
          </div>
        </div>

        <div className="mt-4 space-y-4">
          {wslEgressWarning ? (
            <Banner id="grant-wsl-egress-warning" tone="warning" title="WSL cooperative mode is bypassable">
              Runtime apps can ignore HTTP(S)_PROXY and use direct TCP, UDP (except DNS), or raw IP. DNS must go through
              proxy CONNECT by hostname; direct UDP 53 is dropped. Proxy-aware Runtime traffic keeps each app&apos;s
              granted hosts and TCP ports separate.
            </Banner>
          ) : null}
          {requiredGrants.length ? (
            <section aria-labelledby="grant-required-heading">
              <h3 id="grant-required-heading" className="mb-2 text-xs font-semibold tracking-wide uppercase">
                Required
              </h3>
              <div className="space-y-2">
                {requiredGrants.map((grant) => (
                  <div
                    key={grant.id}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
                  >
                    <div className="text-xs font-medium">{grant.id}</div>
                    <div className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">{grantDetail(grant)}</div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {mounts.length ? (
            <fieldset>
              <legend className="mb-2 text-xs font-semibold tracking-wide uppercase">Mounts</legend>
              <div className="space-y-2">
                {mounts.map((grant) => (
                  <label
                    key={grant.id}
                    htmlFor={`grant-${grant.id}`}
                    className="flex items-start gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
                  >
                    <Checkbox
                      id={`grant-${grant.id}`}
                      className="mt-0.5"
                      checked={selected.has(grant.id)}
                      disabled={busy}
                      aria-describedby={`grant-${grant.id}-detail`}
                      onCheckedChange={() => toggle(grant.id)}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">{grant.id}</span>
                      <span
                        id={`grant-${grant.id}-detail`}
                        className="mt-0.5 block text-xs text-[var(--color-muted-foreground)]"
                      >
                        {grantDetail(grant)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={() => onGrant([...selected])}>
            {busy ? 'Granting…' : prompt.upgrade ? 'Grant and upgrade' : 'Grant and install'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function grantDetail(grant: EntitlementGrantPrompt['grants'][number]): string {
  if (grant.control === 'egress-host') {
    return `Network access to ${grant.value.host}:${grant.value.ports.join(', ')}`;
  }
  if (grant.control === 'mount') return `${grant.value.access} mount at ${grant.value.guest}`;
  if (grant.control === 'published-port') {
    return `Publish ${grant.value.guest}/${grant.value.protocol} to this device`;
  }
  const labels: string[] = [];
  if (grant.value.cpus !== undefined) labels.push(`${grant.value.cpus} CPU${grant.value.cpus === 1 ? '' : 's'}`);
  if (grant.value.memoryMib !== undefined) labels.push(`${grant.value.memoryMib} MiB memory`);
  if (grant.value.diskGib !== undefined) labels.push(`${grant.value.diskGib} GiB disk`);
  return labels.join(' · ');
}
