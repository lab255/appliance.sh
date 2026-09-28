import { Check, CircleX, Loader2, Radio } from 'lucide-react';

/** The agent's run status, rendered as a glyph badge DISTINCT from the PTY
 *  connection dot (`StatusDot`): a check when it finished, an x when it
 *  errored, and for a live run a STEADY "live" glyph for an interactive
 *  (attached TTY) agent vs a spinner for a genuinely-working autonomous run.
 *  An interactive agent isn't "working on a task", so a perpetual spinner
 *  would mislead it as stuck (Devon). */
export function AgentStatusBadge({
  status,
  mode,
}: {
  status: 'running' | 'done' | 'error';
  mode?: 'interactive' | 'autonomous';
}) {
  if (status === 'done') return <Check aria-hidden className="h-3 w-3 shrink-0 text-[var(--color-muted-foreground)]" />;
  if (status === 'error')
    return <CircleX aria-hidden className="h-3 w-3 shrink-0 text-[var(--color-destructive-foreground)]" />;
  if (mode === 'interactive')
    return <Radio aria-hidden className="h-3 w-3 shrink-0 text-[var(--color-info-foreground)]" />;
  return <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin text-[var(--color-info-foreground)]" />;
}
