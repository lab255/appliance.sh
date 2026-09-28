import { cn } from '../lib/utils.js';

/**
 * Render a named entity reference. Shows the human name when known,
 * falls back to the last 8 characters of the id in a monospace pill.
 * The full id is always available in the tooltip so it's still
 * copy-pasteable when someone hovers.
 */
export function EntityLabel({ id, name, className }: { id: string; name?: string | null; className?: string }) {
  if (name) {
    return (
      <span className={className} title={id}>
        {name}
      </span>
    );
  }
  const short = id.length > 10 ? `…${id.slice(-8)}` : id;
  return (
    <code className={cn('font-mono text-xs', className)} title={id}>
      {short}
    </code>
  );
}
