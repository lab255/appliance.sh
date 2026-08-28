import { Code2, Grid2X2 } from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import { localMachineLabelInline, type AppMode, type HostPlatform } from '@/lib/host';

interface ModeChoicePageProps {
  savingMode: AppMode | null;
  error: unknown;
  platform: HostPlatform;
  onSelect(mode: AppMode): void;
}

function choices(platform: HostPlatform) {
  return [
    {
      mode: 'user' as const,
      title: 'Use apps',
      action: 'Continue as a user',
      description: `Install free, open-source apps from the catalogue and run them privately on ${localMachineLabelInline(platform)}. No terminal, no cluster jargon.`,
      bullets: [
        'Installed Apps · Catalogue · Settings',
        'Every app runs sandboxed with a per-app egress allowlist',
        'Licenses recorded at install time',
      ],
      icon: Grid2X2,
    },
    {
      mode: 'developer' as const,
      title: 'Build apps',
      action: 'Continue as a developer',
      description:
        'Deploy your own projects, run coding agents in the sandbox, manage the Dev Machine and cloud targets.',
      bullets: [
        'Adds Setup · Projects · Agents · Machine · Cloud',
        'Terminal dock, egress firewall, credential broker',
        'Everything in user mode is still here',
      ],
      icon: Code2,
    },
  ];
}

export function ModeChoicePage({ savingMode, error, platform, onSelect }: ModeChoicePageProps) {
  return (
    <PageShell rail="focused" className="max-w-[760px] pt-12">
      <PageHeader
        focused
        className="justify-center text-center"
        title="How will you use Appliance?"
        description="Pick a starting point. This only changes what the app shows you — both modes run the same sandboxed machine."
      />

      {error ? (
        <Banner tone="error" className="mb-4" title="Couldn't save your choice">
          Try again. No mode has been selected yet.
        </Banner>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2" role="group" aria-label="Choose how you will use Appliance">
        {choices(platform).map((choice) => (
          <button
            key={choice.mode}
            type="button"
            disabled={savingMode !== null}
            aria-label={`${choice.title}. ${choice.action}`}
            onClick={() => onSelect(choice.mode)}
            className={cn(
              'flex min-h-[250px] flex-col gap-3 rounded-md border border-[var(--color-border)] p-6 text-left',
              'hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)]',
              'disabled:pointer-events-none disabled:opacity-60'
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-muted-foreground)]">
                <choice.icon className="h-4 w-4" aria-hidden />
              </span>
              {choice.mode === 'user' ? <StatusPill tone="success" dot={false} label="Recommended" /> : null}
            </div>
            <h2 className="text-base font-semibold">{choice.title}</h2>
            <p className="text-sm leading-5 text-[var(--color-muted-foreground)]">{choice.description}</p>
            <ul className="list-disc space-y-1 pl-4 text-xs leading-4 text-[var(--color-muted-foreground)]">
              {choice.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
            <span
              className={cn(
                'mt-auto inline-flex h-9 w-full items-center justify-center rounded-md border px-4 text-sm font-medium',
                choice.mode === 'user'
                  ? 'border-transparent bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                  : 'border-[var(--color-border)] text-[var(--color-foreground)]'
              )}
            >
              {savingMode === choice.mode ? 'Saving…' : choice.action}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-5 text-center text-xs text-[var(--color-muted-foreground)]">
        You can change this anytime in{' '}
        <span className="font-medium text-[var(--color-foreground)]">Settings → Mode</span>.
      </p>
    </PageShell>
  );
}
