import * as React from 'react';
import { Link, useNavigate } from 'react-router';
import { Plug, Wand, Laptop, Stethoscope } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  const getStarted = () => {
    // The Dev Machine is an isolated VM. /setup/bootstrap/run boots the
    // default VM with live core phases (media → booting → network → ready).
    const values: WizardValues = { mode: 'microvm' };
    navigate('/setup/bootstrap/run', { state: values });
  };
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center space-y-7 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <Laptop className="h-6 w-6 text-[var(--color-foreground)]" />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Appliance</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Run your apps right on this computer — no cloud account needed. One click boots your isolated machine; the
          app-deploy layer is added when you first deploy.
        </p>
      </div>
      <div className="flex flex-col items-center gap-3">
        <Button size="lg" className="w-full sm:w-auto sm:min-w-56" onClick={getStarted}>
          Get started
        </Button>
        <Button variant="ghost" onClick={onLater}>
          Set up later
        </Button>
      </div>
      <button
        type="button"
        onClick={onMore}
        className="mx-auto text-xs text-[var(--color-muted-foreground)] underline-offset-4 hover:underline"
      >
        More options
      </button>
    </div>
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
    <div className="mx-auto max-w-3xl space-y-6 pt-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Appliance</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Pick where your apps should run: on this computer, on your own AWS account, or somewhere your team already set
          up. Invited by a teammate? Just open the link they sent you — no setup needed here.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {caps.any ? (
          <ActionCard
            icon={Laptop}
            title="On this computer"
            body="The recommended start: everything runs in a safe, isolated space on this machine, and your apps get local web addresses. Free — no cloud account needed."
            cta="Set up"
            to="/cloud/bootstrap?mode=local"
            primary
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
    </div>
  );
}

function ActionCard({
  icon: Icon,
  title,
  body,
  cta,
  to,
  primary,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  cta: string;
  to: string;
  primary?: boolean;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <Icon className="h-5 w-5 text-[var(--color-muted-foreground)]" />
      <h2 className="mt-3 text-sm font-semibold">{title}</h2>
      <p className="mt-1 flex-1 text-xs text-[var(--color-muted-foreground)]">{body}</p>
      <Button asChild variant={primary ? 'default' : 'outline'} className="mt-4 self-start">
        <Link to={to}>{cta}</Link>
      </Button>
    </div>
  );
}
