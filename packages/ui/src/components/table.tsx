import * as React from 'react';
import { cn } from '../lib/utils.js';

/** Native table layout shares one column grid across the header and every row.
 * Set column widths on TableHead (or a colgroup); put wide tables in an overflow
 * container. Rows are deliberately still: actions belong to links/buttons.
 */
export function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <table
      className={cn('w-full table-fixed border-collapse text-left text-sm text-[var(--color-foreground)]', className)}
      {...props}
    />
  );
}

export function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead className={cn('text-xs text-[var(--color-muted-foreground)]', className)} {...props} />;
}

export function TableBody(props: React.ComponentProps<'tbody'>) {
  return <tbody {...props} />;
}

export function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr className={cn('border-b border-[var(--color-border)]', className)} {...props} />;
}

export function TableHead({ className, scope = 'col', ...props }: React.ComponentProps<'th'>) {
  return <th scope={scope} className={cn('px-3 py-2 text-left align-middle font-medium', className)} {...props} />;
}

export function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2 align-middle break-words', className)} {...props} />;
}

export function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return <caption className={cn('sr-only', className)} {...props} />;
}
