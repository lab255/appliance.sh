import * as React from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { LongOperation } from '@/components/ui/long-operation';
import { paintPending } from '@/lib/paint-pending';
import {
  UNSIGNED_PACKAGE_LABEL,
  type WorkbenchPackageHost,
  type WorkbenchPackageResult,
} from '@/lib/workbench-package';

/** Human-only entry: no effect, registry event or result handler starts packaging. */
export function PackageSection({
  directory,
  packageHost,
  filesChanging = false,
  readinessProposal = false,
}: {
  directory: string;
  packageHost?: WorkbenchPackageHost;
  filesChanging?: boolean;
  /** True only for an actual agent proposal, never inferred from done/exited. */
  readinessProposal?: boolean;
}) {
  const inFlight = React.useRef(false);
  const [status, setStatus] = React.useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [result, setResult] = React.useState<WorkbenchPackageResult>();
  const [error, setError] = React.useState('');
  const [copyLabel, setCopyLabel] = React.useState('Copy file path');
  const [logs, setLogs] = React.useState<string[]>([]);
  const [logOpen, setLogOpen] = React.useState(true);
  const [stage, setStage] = React.useState('');
  const [startedAt, setStartedAt] = React.useState(0);
  const [lastActivityAt, setLastActivityAt] = React.useState(0);

  React.useEffect(() => {
    if (status !== 'running') return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [status]);

  async function packageFromClick() {
    if (!packageHost || inFlight.current || filesChanging) return;
    inFlight.current = true;
    await paintPending(() => {
      setStatus('running');
      setResult(undefined);
      setError('');
      setCopyLabel('Copy file path');
      setLogs([]);
      setLogOpen(true);
      setStage('Starting packaging…');
      setStartedAt(Date.now());
      setLastActivityAt(Date.now());
    });
    try {
      const artifact = await packageHost.package(directory, (event) => {
        setLastActivityAt(Date.now());
        if (event.type === 'stage') setStage(event.message);
        setLogs((previous) => [...previous.slice(-999), event.message]);
      });
      setResult(artifact);
      setStatus('success');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setStatus('error');
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <section aria-label="Package for review" className="space-y-4 rounded-md border border-[var(--color-border)] p-4">
      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Package for review</h2>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Packaging creates an artifact; it does not install, publish or deploy it. You authorize each next step.
        </p>
        <p className="break-all font-mono text-xs">{directory}</p>
        <div className="h-24 overflow-auto" data-package-readiness="">
          {readinessProposal ? (
            <p className="text-sm">
              <strong>Agent proposal: Ready to package.</strong> Review the changes. You decide when to package; the
              agent cannot authorize this step. Select <strong>Package</strong> to start packaging.
            </p>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Review the changes before packaging. You can package without an agent proposal.
            </p>
          )}
        </div>
        {filesChanging && (
          <p className="text-sm">Files are still changing. Stop editing and review them before packaging.</p>
        )}
        {!packageHost && <p className="text-sm">Packaging requires the desktop host.</p>}
        <Button
          onClick={packageFromClick}
          disabled={!packageHost || filesChanging}
          aria-disabled={status === 'running'}
          className="min-w-32"
          aria-busy={status === 'running'}
        >
          {status === 'running' ? 'Packaging…' : status === 'error' ? 'Retry Package' : 'Package'}
        </Button>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Packaging reads the current folder; it does not pin the inspected snapshot.
        </p>
      </div>
      <div className="h-80 overflow-auto" data-package-operation="" aria-label="Packaging operation">
        {status === 'idle' ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">Package output and logs will appear here.</p>
        ) : (
          <LongOperation
            key={startedAt}
            title={status === 'running' ? 'Packaging…' : status === 'error' ? 'Package failed' : 'Package complete'}
            status={status}
            nowLine={status === 'running' ? stage : undefined}
            timeClass="minutes"
            estimate="Duration depends on the payload build."
            leaveSafety="keep-page"
            startedAt={startedAt}
            lastActivityAt={lastActivityAt}
            failure={error || undefined}
            log={<pre className="whitespace-pre-wrap break-all font-mono text-xs">{logs.join('\n')}</pre>}
            logProps={{
              open: logOpen,
              onOpenChange: setLogOpen,
              height: 'compact',
              copyText: logs.join('\n'),
              live: 'off',
            }}
          />
        )}
      </div>
      <div className="space-y-3" data-package-result="">
        <div className="h-56 space-y-2 overflow-auto rounded-md border border-[var(--color-border)] p-3">
          <h3 className="text-sm font-semibold">File</h3>
          {result ? (
            <>
              <p className="text-sm">
                {result.name} · {result.version}
              </p>
              <p className="text-sm">
                {result.signatureStatus === 'unsigned'
                  ? UNSIGNED_PACKAGE_LABEL
                  : 'Signed with your local developer key'}
              </p>
              <p className="break-all font-mono text-xs" aria-label="Artifact path">
                {result.outputPath}
              </p>
              <p className="break-all font-mono text-xs" aria-label="Bundle digest">
                {result.digest}
              </p>
              {result.keyId && <p className="break-all font-mono text-xs">Publisher key: {result.keyId}</p>}
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(result.outputPath);
                    setCopyLabel('Path copied');
                  } catch {
                    setCopyLabel('Select the path above to copy it');
                  }
                }}
              >
                {copyLabel}
              </Button>
              <Link to="/apps" className="block text-sm underline">
                Go to Apps to install from file
              </Link>
            </>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">No hand-off file from this attempt.</p>
          )}
        </div>
        <p className="text-sm">Catalogue — coming later</p>
        <div className="border-t border-[var(--color-border)] pt-3">
          <Link to="/projects/deploy" className="text-sm underline">
            Deploy source
          </Link>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Deploy is a separate action. Package promotion is not available yet.
          </p>
        </div>
      </div>
    </section>
  );
}
