import * as React from 'react';
import { cn } from '@/lib/utils';
import type { StatusTone } from './status-pill';

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  label: string;
  activity?: 'static' | 'pulse';
  size?: 'sm' | 'md';
}

interface LegacyStatusDotProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'aria-label'> {
  status: string;
  size?: 'sm' | 'md';
}

export interface ResolvedStatus {
  tone: StatusTone;
  activity: 'static' | 'pulse';
  label: string;
}

export function resolveStatusDot(status: string): ResolvedStatus {
  const normalized = status.toLowerCase().replaceAll('-', '_');
  if (['in_progress', 'deploying', 'running', 'connecting', 'open', 'starting'].includes(normalized)) {
    const label = normalized === 'connecting' ? 'Connecting…' : normalized === 'starting' ? 'Starting…' : 'Running';
    return { tone: 'info', activity: 'pulse', label };
  }
  if (['succeeded', 'deployed', 'ready', 'on'].includes(normalized)) {
    return {
      tone: 'success',
      activity: 'static',
      label:
        normalized === 'on'
          ? 'On'
          : normalized === 'ready'
            ? 'Ready'
            : normalized === 'succeeded'
              ? 'Succeeded'
              : 'Deployed',
    };
  }
  if (['destroying', 'degraded'].includes(normalized)) {
    return {
      tone: 'warning',
      activity: normalized === 'destroying' ? 'pulse' : 'static',
      label: normalized === 'destroying' ? 'Destroying…' : 'Degraded',
    };
  }
  if (['failed', 'error', 'unhealthy'].includes(normalized)) {
    return {
      tone: 'error',
      activity: 'static',
      label: normalized === 'failed' ? 'Failed' : normalized === 'unhealthy' ? 'Unhealthy' : 'Error',
    };
  }
  const neutralLabels: Record<string, string> = {
    done: 'Finished',
    exited: 'Ended',
    not_created: 'Not created',
  };
  const plain = normalized.replaceAll('_', ' ');
  return {
    tone: 'neutral',
    activity: 'static',
    label: neutralLabels[normalized] ?? (plain ? plain[0].toUpperCase() + plain.slice(1) : 'Unknown'),
  };
}

const dotTones: Record<StatusTone, string> = {
  neutral: 'bg-[var(--color-muted-foreground)]',
  info: 'bg-[var(--color-info-foreground)]',
  sandbox: 'bg-[var(--color-sandbox-foreground)]',
  success: 'bg-[var(--color-success-foreground)]',
  warning: 'bg-[var(--color-warning-foreground)]',
  error: 'bg-[var(--color-destructive-foreground)]',
};

export function StatusDot(props: StatusDotProps | LegacyStatusDotProps) {
  const { size = 'sm', className } = props;
  let resolved: ResolvedStatus;
  let htmlProps: React.HTMLAttributes<HTMLSpanElement>;
  if ('status' in props) {
    const { status, size: _size, className: _className, ...rest } = props;
    resolved = resolveStatusDot(status);
    htmlProps = rest;
  } else {
    const { tone, label, activity = 'static', size: _size, className: _className, ...rest } = props;
    resolved = { tone, label, activity };
    htmlProps = rest;
  }
  const dim = size === 'md' ? 'h-2.5 w-2.5' : 'h-2 w-2';
  const color = dotTones[resolved.tone];
  return (
    <span {...htmlProps} role="img" aria-label={resolved.label} className={cn('relative inline-flex', dim, className)}>
      {resolved.activity === 'pulse' ? (
        <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', color)} />
      ) : null}
      <span className={cn('relative inline-block h-full w-full rounded-full', color)} />
    </span>
  );
}
