import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { Bot, Plug, Rocket, Wand, Laptop, Stethoscope } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { SectionCard } from '@/components/ui/section-card';
import { useHost } from '@/providers/host-provider';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useDevMachineTargets } from '@/hooks/use-dev-machine-targets';
import {
  localRuntimeCapabilities,
  onboardingDismissed,
  dismissOnboarding,
  type LocalRuntimeCapabilities,
} from '@/lib/local-runtime';
import type { WizardValues } from '@/pages/bootstrap/wizard';
import { durationEstimates } from '@/lib/duration-estimates';

// ① Setup — the onboarding hub, extracted out of the old DashboardPage so
// `/setup` and `/projects` stop sharing one adaptive component. Two modes:
//   · FirstRunWelcome — the very first launch on a desktop shell (one
//     button boots the Dev Machine).
//   · GetStarted — the full menu (Dev Machine / AWS / join / doctor).
// `/setup` stays routable once configured (it shows the hub, so an operator
// can always add another destination from here).
export function SetupPage() {
  const host = useHost();
  const caps = localRuntimeCapabilities(host);
  const canBootstrap = Boolean(host.bootstrap);
  const { config, cluster, isLoading } = useSelectedCluster();
  const devMachine = useDevMachineTargets(config?.clusters ?? []);
  // "More options" reveals the full first-run menu without dismissing
  // the simple welcome — that's what "Set up later" does (and persists).
  const [showAll, setShowAll] = React.useState(false);

  if (isLoading || (!cluster && devMachine.isLoading)) return null;
  // First launch on a shell that can run the Dev Machine: a single,
  // friendly setup step (Set up / Set up later) — no menu to parse.
  if (!cluster && devMachine.state === 'none' && caps.any && !showAll && !onboardingDismissed()) {
    return (
      <FirstRunWelcome
        onLater={() => {
          dismissOnboarding();
          setShowAll(true);
        }}
        onMore={() => setShowAll(true)}
      />
    );
  }
  return <GetStarted caps={caps} canBootstrap={canBootstrap} />;
}

// The very first launch: one decision, one button. "Get started" boots the
// Dev Machine in a single press, routing straight into the live
// bring-up phase ladder (/setup/bootstrap/run) so a new operator watches the
// core boot stages and lands ready — no menu to read, no
// further clicks. "Set up later" and "More options" fall back to the full
// GetStarted menu.
function FirstRunWelcome({ onLater, onMore }: { onLater: () => void; onMore: () => void }) {
  const navigate = useNavigate();
  const getStarted = (intent: 'agent' | 'host') => {
    const values: WizardValues = { mode: 'microvm', intent };
    localStorage.setItem('appliance.firstRunIntent', intent);
    navigate('/setup/bootstrap/run', { state: values });
  };
  return (
    <PageShell rail="focused" className="flex min-h-[60vh] flex-col justify-center space-y-7 py-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <Laptop className="h-6 w-6 text-[var(--color-foreground)]" aria-hidden />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Appliance</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Your computer, with a safe machine-in-a-machine: run coding agents in a Sandbox or host apps with live local
          URLs — no cloud account needed.
        </p>
      </div>
      <div>
        <h2 className="mb-3 text-sm font-semibold">What do you want to do first?</h2>
        <div className="grid gap-3 text-left sm:grid-cols-2">
          <IntentCard
            icon={Bot}
            title="Run a coding agent"
            body="Claude Code and friends work in an isolated Sandbox. Your files stay yours and their internet access is guarded."
            duration={`Ready in ${durationEstimates.coreBoot}`}
            action="Start the Sandbox"
            onClick={() => getStarted('agent')}
          />
          <IntentCard
            icon={Rocket}
            title="Host an app"
            body="Deploy an app to this computer and get a live local URL. Free, private, and available while this computer is on."
            duration="First-time setup takes a few minutes"
            action="Set up hosting"
            onClick={() => getStarted('host')}
          />
        </div>
        <p className="mt-3 text-xs leading-4 text-[var(--color-muted-foreground)]">
          Either way you get both — this just picks what we set up first.
        </p>
      </div>
      <div className="flex items-center justify-center gap-2">
        <Button variant="ghost" onClick={onLater}>
          Set up later
        </Button>
        <span aria-hidden className="text-[var(--color-muted-foreground)]">
          ·
        </span>
        <Button variant="ghost" onClick={onMore}>
          More options
        </Button>
      </div>
    </PageShell>
  );
}

function IntentCard({
  icon: Icon,
  title,
  body,
  duration,
  action,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  body: string;
  duration: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <SectionCard
      className="flex h-full flex-col"
      title={
        <span className="inline-flex items-center gap-2">
          <Icon className="h-4 w-4" aria-hidden />
          {title}
        </span>
      }
    >
      <p className="text-sm leading-5 text-[var(--color-muted-foreground)]">{body}</p>
      <p className="mt-3 text-xs font-medium leading-4">{duration}</p>
      <Button className="mt-4 w-full" onClick={onClick}>
        {action}
      </Button>
    </SectionCard>
  );
}

function GetStarted({ caps, canBootstrap }: { caps: LocalRuntimeCapabilities; canBootstrap: boolean }) {
  // ① Setup hub — the single get-started doorway. Each path links to a
  // canonical child (the /cloud/bootstrap wizard, Connect, Doctor): one
  // wizard, one add-cloud form, one Doctor — no parallel entry points. The
  // Dev Machine is the recommended starting point on desktop (zero cloud
  // cost, no AWS credentials); on the web shell only Connect is available,
  // so it leads.
  return (
    <PageShell rail="focused" className="space-y-6 pt-8">
      <PageHeader
        focused
        title="Welcome to Appliance"
        description="Choose what to set up first. You can run agents in a Sandbox, host apps on this computer, or pair a cloud."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {caps.any ? (
          <ActionCard
            icon={Rocket}
            title="Host apps on this computer"
            body="Start a Sandbox, turn on App hosting, and give apps private local web addresses. Free — no cloud account needed."
            cta="Set up hosting"
            to="/setup/bootstrap/run"
            state={{ mode: 'microvm', intent: 'host' } satisfies WizardValues}
            primary
          />
        ) : null}
        {caps.any ? (
          <ActionCard
            icon={Bot}
            title="Run coding agents in a Sandbox"
            body="Start an isolated workspace with guarded internet access, ready for agents and shells."
            cta="Start the Sandbox"
            to="/setup/bootstrap/run"
            state={{ mode: 'microvm', intent: 'agent' } satisfies WizardValues}
          />
        ) : null}
        {canBootstrap ? (
          <ActionCard
            icon={Wand}
            title="On your AWS account"
            body="For developers: creates the cloud infrastructure your team shares. Needs AWS credentials on this machine. Teammates then join via invite links — they never see this step."
            cta="Start wizard"
            to="/cloud/bootstrap?mode=aws"
            primary={!caps.any}
          />
        ) : null}
        <ActionCard
          icon={Plug}
          title="Join an existing setup"
          body="Your team already runs Appliance somewhere? The easiest way in is an invite link from an admin. You can also connect manually with a server address and access key."
          cta="Connect"
          to="/setup/connect"
          primary={!canBootstrap && !caps.any}
        />
        {/* Doctor — the prerequisite preflight, desktop-only (it checks the
            Dev Machine toolchain). Reachable from the hub so a failing
            prereq is a first-class setup step, not a buried banner. */}
        {caps.any ? (
          <ActionCard
            icon={Stethoscope}
            title="Check this computer"
            body="Something not working? This checks that this computer is ready to run the isolated Dev Machine — everything it needs installed and running — and fixes what it safely can in one click."
            cta="Run checks"
            to="/setup/doctor"
          />
        ) : null}
      </div>
    </PageShell>
  );
}

function ActionCard({
  icon: Icon,
  title,
  body,
  cta,
  to,
  primary,
  state,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  cta: string;
  to: string;
  primary?: boolean;
  state?: WizardValues;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <Icon className="h-5 w-5 text-[var(--color-muted-foreground)]" aria-hidden />
      <h2 className="mt-3 text-sm font-semibold">{title}</h2>
      <p className="mt-1 flex-1 text-xs text-[var(--color-muted-foreground)]">{body}</p>
      <Button asChild variant={primary ? 'default' : 'outline'} className="mt-4 self-start">
        <Link
          to={to}
          state={state}
          onClick={() =>
            state?.mode === 'microvm' && state.intent && localStorage.setItem('appliance.firstRunIntent', state.intent)
          }
        >
          {cta}
        </Link>
      </Button>
    </div>
  );
}
