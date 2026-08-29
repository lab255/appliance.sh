import * as React from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/ui/banner';
import type { EntitlementGrantPrompt } from '@/lib/host';

export function GrantDialog({
  prompt,
  busy = false,
  platform,
  wslMode = 'strict',
  onCancel,
  onGrant,
}: {
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
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const invokingElementRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    invokingElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => invokingElementRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="grant-dialog-title"
        aria-describedby="grant-dialog-description"
        className="w-full max-w-xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-overlay)] p-5 shadow-xl"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--color-success-border)] bg-[var(--color-success-background)] text-[var(--color-success-foreground)]">
            <ShieldCheck className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h2 id="grant-dialog-title" className="text-sm font-semibold">
              {prompt.upgrade ? 'Approve new controls' : 'Grant app controls'}
            </h2>
            <p id="grant-dialog-description" className="mt-1 text-sm text-[var(--color-muted-foreground)]">
              {prompt.appId} {prompt.version} ({prompt.license}) asks for the controls below. Required controls are
              needed to install; mounts can be declined.
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-4">
          {wslEgressWarning ? (
            <Banner tone="warning" title="WSL cooperative mode is bypassable">
              Runtime apps can ignore HTTP(S)_PROXY and use direct TCP, UDP, raw IP, or their own DNS. Grants are
              unioned across apps in this VM.
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
                    <input
                      id={`grant-${grant.id}`}
                      type="checkbox"
                      className="mt-0.5"
                      checked={selected.has(grant.id)}
                      disabled={busy}
                      aria-describedby={`grant-${grant.id}-detail`}
                      onChange={() => toggle(grant.id)}
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
      </div>
    </div>
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
