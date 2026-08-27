import * as React from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { EntitlementGrantPrompt } from '@/lib/host';

export function GrantDialog({
  prompt,
  busy = false,
  onCancel,
  onGrant,
}: {
  prompt: EntitlementGrantPrompt;
  busy?: boolean;
  onCancel: () => void;
  onGrant: (grantIds: string[]) => void;
}) {
  const required = React.useMemo(() => new Set(prompt.requiredGrantIds), [prompt.requiredGrantIds]);
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
              {prompt.appId} {prompt.version} · {prompt.license}. Required controls are approved together; mounts may be
              declined individually.
            </p>
          </div>
        </div>

        <fieldset className="mt-4 space-y-2">
          <legend className="sr-only">Requested controls</legend>
          {prompt.grants.map((grant) => {
            const isRequired = required.has(grant.id);
            return (
              <label
                key={grant.id}
                className="flex items-start gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={selected.has(grant.id)}
                  disabled={busy || isRequired}
                  aria-describedby={`grant-${grant.id}-detail`}
                  onChange={() => toggle(grant.id)}
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium">
                    {grant.id} · {isRequired ? 'Required' : 'Optional mount'}
                  </span>
                  <span
                    id={`grant-${grant.id}-detail`}
                    className="mt-0.5 block text-xs text-[var(--color-muted-foreground)]"
                  >
                    {grant.control === 'egress-host'
                      ? `Network access to ${grant.value.host}:${grant.value.ports.join(', ')}`
                      : grant.control === 'mount'
                        ? `${grant.value.access} mount at ${grant.value.guest}`
                        : grant.control === 'published-port'
                          ? `Publish ${grant.value.guest}/${grant.value.protocol} to this device`
                          : `CPU, memory, and disk limit: ${Object.entries(grant.value)
                              .map(([key, value]) => `${key} ${value}`)
                              .join(', ')}`}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

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
