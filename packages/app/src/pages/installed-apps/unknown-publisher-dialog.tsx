import * as React from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { UnknownPublisherPrompt } from '@/lib/installed-apps';

export function UnknownPublisherDialog({
  prompt,
  action,
  busy = false,
  onCancel,
  onAccept,
  onRemember,
}: {
  prompt: UnknownPublisherPrompt;
  action: 'install' | 'open';
  busy?: boolean;
  onCancel: () => void;
  onAccept: () => void;
  onRemember?: () => void;
}) {
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
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unknown-publisher-title"
        aria-describedby="unknown-publisher-description"
        className="w-full max-w-lg rounded-lg border border-[var(--color-warning-border)] bg-[var(--color-surface-overlay)] p-5 shadow-xl"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--color-warning-border)] bg-[var(--color-warning-background)] text-[var(--color-warning-foreground)]">
            <ShieldAlert className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h2 id="unknown-publisher-title" className="text-sm font-semibold">
              Unknown Publisher
            </h2>
            <p id="unknown-publisher-description" className="mt-1 text-sm text-[var(--color-muted-foreground)]">
              Publisher identity and code origin could not be verified. This does not mean the app is malicious.
            </p>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs">
          <dt className="text-[var(--color-muted-foreground)]">App</dt>
          <dd>
            {prompt.name} {prompt.version}
          </dd>
          <dt className="text-[var(--color-muted-foreground)]">License</dt>
          <dd>{prompt.license}</dd>
          <dt className="text-[var(--color-muted-foreground)]">Signature</dt>
          <dd>
            {prompt.signature === 'unsigned'
              ? 'Unsigned'
              : prompt.signature === 'valid'
                ? 'Valid signature; publisher evidence unavailable'
                : 'Signature could not be verified'}
          </dd>
          <dt className="text-[var(--color-muted-foreground)]">Digest</dt>
          <dd className="truncate font-mono" title={prompt.digest}>
            {prompt.digest.slice(0, 27)}…
          </dd>
          <dt className="text-[var(--color-muted-foreground)]">Source</dt>
          <dd className="truncate" title={prompt.source}>
            {prompt.source}
          </dd>
        </dl>

        <div className="mt-3 rounded-md border border-[var(--color-border)] p-3">
          <h3 className="text-xs font-medium">Requested controls</h3>
          <p className="mt-1 text-xs leading-4 text-[var(--color-muted-foreground)]">
            {prompt.controlsSummary.serviceCount} service{prompt.controlsSummary.serviceCount === 1 ? '' : 's'} ·{' '}
            {prompt.controlsSummary.egressHosts.length
              ? `egress to ${prompt.controlsSummary.egressHosts.join(', ')}`
              : 'no network egress'}{' '}
            · {prompt.controlsSummary.mounts.length || 'no'} mounts
          </p>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={onAccept}>
            {busy ? 'Checking…' : action === 'open' ? 'Open once' : 'Install this bundle'}
          </Button>
          {action === 'open' && onRemember ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={onRemember}>
              Open and remember for 30 days
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
