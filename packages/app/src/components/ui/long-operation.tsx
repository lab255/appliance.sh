import * as React from 'react';
import { AlertTriangle, Check, Circle, Loader2, X } from 'lucide-react';
import { Banner } from './banner';
import { LogPane, type LogPaneProps } from './log-pane';
import { StatusPill, type StatusTone } from './status-pill';
import { cn } from '@/lib/utils';

export interface LongOperationStep {
  key: React.Key;
  label: React.ReactNode;
  runningLabel?: React.ReactNode;
  detail?: React.ReactNode;
}

export interface LongOperationProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'title'> {
  title: React.ReactNode;
  status: 'running' | 'success' | 'error';
  steps?: readonly LongOperationStep[];
  activeStep?: number;
  nowLine?: React.ReactNode;
  timeClass: 'seconds' | 'minutes' | 'long';
  estimate: string;
  leaveSafety: 'resumable' | 'keep-page';
  startedAt?: number;
  lastActivityAt?: number;
  stalled?: boolean;
  stallMessage?: React.ReactNode;
  failure?: React.ReactNode;
  retry?: React.ReactNode;
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  successTone?: StatusTone;
  log?: React.ReactNode;
  logProps?: Omit<LogPaneProps, 'children'>;
}

const stallThresholds = { seconds: 30_000, minutes: 90_000, long: 180_000 } as const;

function formatElapsed(elapsedMs: number) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function LongOperation({
  title,
  status,
  steps = [],
  activeStep = 0,
  nowLine,
  timeClass,
  estimate,
  leaveSafety,
  startedAt,
  lastActivityAt,
  stalled: stalledOverride,
  stallMessage = 'This is taking longer than usual. Quiet periods can be normal while work continues.',
  failure,
  retry,
  primaryAction,
  secondaryAction,
  successTone = 'neutral',
  log,
  logProps,
  className,
  ...props
}: LongOperationProps) {
  const mountedAt = React.useRef(startedAt ?? Date.now());
  const [now, setNow] = React.useState(mountedAt.current);
  const [logForcedOpen, setLogForcedOpen] = React.useState(false);

  React.useEffect(() => {
    if (status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [status]);

  const activityAt = lastActivityAt ?? mountedAt.current;
  const stalled = status === 'running' && (stalledOverride ?? now - activityAt >= stallThresholds[timeClass]);
  const logOpen = status === 'error' || logForcedOpen || logProps?.open;
  const showElapsed = timeClass !== 'seconds';
  const elapsed = formatElapsed(now - mountedAt.current);
  const statusLabel =
    status === 'running' ? (
      <span className="tabular-nums">Running{showElapsed ? ` · ${elapsed}` : ''}</span>
    ) : status === 'success' ? (
      'Complete'
    ) : (
      'Failed'
    );
  const statusTone: StatusTone = status === 'running' ? 'info' : status === 'error' ? 'error' : successTone;

  return (
    <div className={cn('space-y-3', className)} {...props}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div role="status" aria-live="polite" aria-atomic="true">
          <StatusPill tone={statusTone} label={statusLabel} activity={status === 'running' ? 'spin' : 'static'} />
        </div>
      </div>

      {steps.length ? (
        <ol className="space-y-2" aria-label="Progress">
          {steps.map((step, index) => {
            const complete = status === 'success' || index < activeStep;
            const current = status !== 'success' && index === activeStep;
            const failed = status === 'error' && current;
            const label = current && status === 'running' && step.runningLabel ? step.runningLabel : step.label;
            return (
              <li key={step.key} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 text-sm leading-5">
                <span className="mt-0.5 flex h-4 w-4 items-center justify-center" aria-hidden>
                  {complete ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : failed ? (
                    <X className="h-3.5 w-3.5 text-[var(--color-destructive-foreground)]" />
                  ) : current ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-info-foreground)]" />
                  ) : (
                    <Circle className="h-2.5 w-2.5 text-[var(--color-muted-foreground)]" />
                  )}
                </span>
                <div className={cn(!current && !complete && 'text-[var(--color-muted-foreground)]')}>
                  <div>{label}</div>
                  {step.detail ? (
                    <div className="text-xs leading-4 text-[var(--color-muted-foreground)]">{step.detail}</div>
                  ) : null}
                  {current && nowLine ? (
                    <div
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                      className="mt-0.5 text-xs leading-4 text-[var(--color-muted-foreground)]"
                    >
                      {nowLine}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : nowLine ? (
        <div role="status" aria-live="polite" aria-atomic="true" className="text-sm leading-5">
          {nowLine}
        </div>
      ) : null}

      {stalled ? (
        <Banner
          tone="warning"
          role="status"
          icon={AlertTriangle}
          action={
            <button
              type="button"
              onClick={() => setLogForcedOpen(true)}
              className="rounded text-xs font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
            >
              Show log
            </button>
          }
        >
          {stallMessage}
        </Banner>
      ) : null}

      {status === 'error' && failure ? (
        <Banner tone="error" action={retry}>
          {failure}
        </Banner>
      ) : null}

      <LogPane
        {...logProps}
        open={logOpen ? true : logProps?.open}
        onOpenChange={(next) => {
          setLogForcedOpen(next);
          logProps?.onOpenChange?.(next);
        }}
      >
        {log}
      </LogPane>

      <p className="text-xs leading-4 text-[var(--color-muted-foreground)]">
        {estimate ? <span>{estimate}. </span> : null}
        {leaveSafety === 'resumable'
          ? 'Safe to visit other areas — this continues in the background.'
          : 'Keep this page open until it finishes.'}
      </p>

      {status === 'success' && (primaryAction || secondaryAction) ? (
        <div className="flex flex-wrap items-center gap-2">
          {primaryAction}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
