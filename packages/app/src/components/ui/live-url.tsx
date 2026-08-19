import * as React from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A deployed URL the user will want to open or paste somewhere — the
 * single most-touched artifact in the whole console, so it gets a
 * dedicated affordance: click-through, plus one-click copy.
 */
export function LiveUrl({ url, className }: { url: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const onCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1_500);
    } catch {
      // clipboard unavailable — the link itself still works
    }
  };

  const label = url.replace(/^https?:\/\//, '');
  return (
    <span className={cn('group/url inline-flex min-w-0 items-center gap-1', className)}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex min-w-0 items-center gap-1 rounded text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
      >
        <span className="truncate">{label}</span>
        <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/url:opacity-100" />
      </a>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Copied' : `Copy ${url}`}
        className="shrink-0 rounded p-0.5 text-[var(--color-muted-foreground)] opacity-0 transition-opacity hover:text-[var(--color-foreground)] focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] group-hover/url:opacity-100"
      >
        {copied ? <Check className="h-3 w-3 text-[var(--color-success-foreground)]" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}
