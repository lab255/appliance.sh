import * as React from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@appliance.sh/ui/dialog';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { UnknownPublisherPrompt } from '@/lib/installed-apps';

type UnknownPublisherDialogProps = Omit<
  React.ComponentProps<typeof UnknownPublisherDialogContent>,
  'open' | 'prompt'
> & {
  prompt: UnknownPublisherPrompt | null;
};

/** Retain the last prompt while DS presence owns the exit animation. */
export function UnknownPublisherDialog(props: UnknownPublisherDialogProps) {
  const last = React.useRef<(Omit<UnknownPublisherDialogProps, 'prompt'> & { prompt: UnknownPublisherPrompt }) | null>(
    null
  );
  if (props.prompt) last.current = { ...props, prompt: props.prompt };
  return last.current ? <UnknownPublisherDialogContent {...last.current} open={!!props.prompt} /> : null;
}

function UnknownPublisherDialogContent({
  open,
  prompt,
  action,
  busy = false,
  onCancel,
  onAccept,
  onRemember,
}: {
  open: boolean;
  prompt: UnknownPublisherPrompt;
  action: 'install' | 'open';
  busy?: boolean;
  onCancel: () => void;
  onAccept: () => void;
  onRemember?: () => void;
}) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const invokingElementRef = React.useRef<HTMLElement | null>(null);

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
        aria-labelledby="unknown-publisher-title"
        aria-describedby="unknown-publisher-description"
        className="max-w-lg border-[var(--color-warning-border)]"
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
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--color-warning-border)] bg-[var(--color-warning-background)] text-[var(--color-warning-foreground)]">
            <ShieldAlert className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <DialogTitle id="unknown-publisher-title" className="text-sm font-semibold">
              Unknown Publisher
            </DialogTitle>
            <DialogDescription
              id="unknown-publisher-description"
              className="mt-1 text-sm text-[var(--color-muted-foreground)]"
            >
              Publisher identity and code origin could not be verified. This does not mean the app is malicious.
            </DialogDescription>
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
      </DialogContent>
    </Dialog>
  );
}
