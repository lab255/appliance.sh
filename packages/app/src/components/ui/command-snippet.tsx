import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A copyable one-line shell command. Used wherever the UI hands the
 * user off to the CLI (first deploys from the web shell, connect
 * hints) — if we're going to tell someone to run a command, the least
 * we can do is let them copy it without selecting text.
 */
export function CommandSnippet({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard can be unavailable (insecure context); selecting the
      // text manually still works, so stay quiet.
    }
  };

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2',
        className
      )}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{command}</code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Copied' : 'Copy command'}
        className="shrink-0 rounded p-1 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-[var(--color-success-foreground)]" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
