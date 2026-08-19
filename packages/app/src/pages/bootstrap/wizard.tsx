import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Cloud, ChevronLeft, Laptop } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { Tag } from '@/components/ui/tag';
import { useHost } from '@/providers/host-provider';
import { localRuntimeCapabilities } from '@/lib/local-runtime';

const REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
];

/**
 * Discriminator on the WizardValues the run page dispatches on.
 *
 *   - 'aws'     : the existing 3-phase Pulumi flow (installer stack +
 *                 api-server + state promotion). Targets a cloud
 *                 install reachable from anywhere.
 *   - 'microvm' : the local runtime sandboxed in an isolated VM
 *                 Appliance boots itself (appliance-vm) — the sole local
 *                 runtime.
 *
 * The Local Runtime form always provisions a microVM. All values funnel
 * through `/bootstrap/run`, which dispatches on this field. The Local
 * Runtime form is reachable via `?mode=local` (the dashboard uses this)
 * or its `?mode=microvm` alias.
 */
export type WizardMode = 'aws' | 'microvm';

export interface AwsWizardValues {
  mode: 'aws';
  name: string;
  region: string;
  domain: string;
  createZone: boolean;
  deployApiServer: boolean;
  // When true, the bootstrap also runs phase 3 (promote installer
  // Pulumi state from local file backend → cluster S3 backend) so
  // the install isn't tied to this device. Only meaningful when
  // deployApiServer is true; phase-1-only runs leave the installer
  // local on purpose. Settings can run phase 3 later if it's
  // skipped or fails.
  promoteState: boolean;
  apiServerImageUri?: string;
  awsProfile?: string;
}

export interface MicroVmWizardValues {
  mode: 'microvm';
  /** VM name. Defaults to the canonical `appliance` VM. */
  name?: string;
  intent?: 'agent' | 'host';
}

export type WizardValues = AwsWizardValues | MicroVmWizardValues;

/** Top-level target the operator picks: the Local Runtime (a microVM)
 *  or an AWS cluster. */
type PickerChoice = 'aws' | 'local';

export function BootstrapWizardPage() {
  const host = useHost();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const caps = localRuntimeCapabilities(host);
  const bootstrapAvailable = Boolean(host.bootstrap);
  const localAvailable = caps.any;

  // Read `?mode=` once so deep-linking from the dashboard (e.g.
  // `/bootstrap?mode=local`) skips the picker. Default to the picker.
  const presetChoice = parseChoice(searchParams.get('mode'), {
    aws: bootstrapAvailable,
    local: localAvailable,
  });
  const [choice, setChoice] = React.useState<PickerChoice | null>(presetChoice);

  if (!bootstrapAvailable && !localAvailable) {
    return (
      <PageShell rail="focused" className="space-y-4 pt-16">
        <h1 className="text-2xl font-semibold">Setup unavailable</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          This shell can&apos;t drive a bootstrap locally. Run{' '}
          <code className="rounded bg-[var(--color-muted)] px-1.5 py-0.5">appliance cloud install</code> from the CLI,
          then connect to the server address it returns.
        </p>
      </PageShell>
    );
  }

  if (!choice) {
    return (
      <ModePicker
        awsAvailable={bootstrapAvailable}
        localAvailable={localAvailable}
        sandboxDefault={caps.canSandbox}
        onPick={(c) => setChoice(c)}
        onCancel={() => navigate('/')}
      />
    );
  }

  if (choice === 'aws') {
    return (
      <AwsForm
        onBack={presetChoice ? null : () => setChoice(null)}
        onSubmit={(values) => navigate('/cloud/bootstrap/run', { state: values })}
      />
    );
  }

  return (
    <LocalRuntimeForm
      onBack={presetChoice ? null : () => setChoice(null)}
      onSubmit={(values) => {
        if (values.mode === 'microvm' && values.intent) {
          localStorage.setItem('appliance.firstRunIntent', values.intent);
        }
        navigate('/cloud/bootstrap/run', { state: values });
      }}
    />
  );
}

// ---- mode picker ------------------------------------------------------

function ModePicker({
  awsAvailable,
  localAvailable,
  sandboxDefault,
  onPick,
  onCancel,
}: {
  awsAvailable: boolean;
  localAvailable: boolean;
  sandboxDefault: boolean;
  onPick: (choice: PickerChoice) => void;
  onCancel: () => void;
}) {
  return (
    <PageShell rail="focused" className="space-y-6 pt-12">
      <PageHeader
        focused
        title="New installation"
        description="Choose App hosting on this computer or create a cloud installation in AWS."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <ModeCard
          icon={Laptop}
          title="Dev Machine"
          body={
            <>
              Runs apps on this computer{sandboxDefault ? ', inside an isolated virtual machine' : ''}. Apps publish at{' '}
              <code className="font-mono text-xs">&lt;app&gt;-&lt;env&gt;.appliance.localhost</code>.
            </>
          }
          available={localAvailable}
          disabledReason="The Dev Machine needs the desktop app — the web shell can't drive it."
          onClick={() => onPick('local')}
        />
        <ModeCard
          icon={Cloud}
          title="AWS Cloud"
          body="Create an Appliance cloud installation in your AWS account. Requires AWS credentials."
          available={awsAvailable}
          disabledReason="Bootstrap to AWS needs the desktop app or the CLI."
          onClick={() => onPick('aws')}
        />
      </div>

      <Button variant="ghost" onClick={onCancel}>
        <ChevronLeft className="h-4 w-4" /> Cancel
      </Button>
    </PageShell>
  );
}

function ModeCard({
  icon: Icon,
  title,
  body,
  available,
  disabledReason,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: React.ReactNode;
  available: boolean;
  disabledReason: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={available ? onClick : undefined}
      disabled={!available}
      aria-describedby={!available ? `${title.toLowerCase().replaceAll(' ', '-')}-disabled` : undefined}
      className="flex flex-col items-start gap-2 rounded-md border border-[var(--color-border)] p-4 text-left transition-colors hover:bg-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-6 w-6 text-[var(--color-muted-foreground)]" aria-hidden />
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-[var(--color-muted-foreground)]">{body}</div>
      {!available ? (
        <div
          id={`${title.toLowerCase().replaceAll(' ', '-')}-disabled`}
          className="text-xs leading-4 text-[var(--color-warning-foreground)]"
        >
          {disabledReason}
        </div>
      ) : null}
    </button>
  );
}

function parseChoice(raw: string | null, capability: { aws: boolean; local: boolean }): PickerChoice | null {
  if (raw === 'aws' && capability.aws) return 'aws';
  // The unified Local Runtime form always provisions a microVM; both
  // `?mode=local` and `?mode=microvm` deep-link straight to it.
  if ((raw === 'local' || raw === 'microvm') && capability.local) return 'local';
  return null;
}

// ---- local runtime form ------------------------------------------------
//
// One form for the local runtime, which is always sandboxed in a microVM
// Appliance boots itself (the sole local engine — bare k3d is gone). The
// only optional input is the VM name; it's submittable immediately with
// defaults, so setup → connect is two clicks (open form → Set up).

function LocalRuntimeForm({
  onBack,
  onSubmit,
}: {
  onBack: (() => void) | null;
  onSubmit: (values: WizardValues) => void;
}) {
  // The microVM takes an optional VM name; everything else is defaulted.
  const [vmName, setVmName] = React.useState('');
  const [vmErr, setVmErr] = React.useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = vmName.trim();
    if (n && !/^[a-z0-9][a-z0-9-]*$/.test(n)) {
      setVmErr('Use lowercase letters, digits, and dashes (e.g. "traffic").');
      return;
    }
    onSubmit({ mode: 'microvm', name: n || undefined, intent: 'host' });
  };

  return (
    <PageShell rail="focused" className="space-y-6 pt-12">
      {onBack ? (
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" /> Back
        </Button>
      ) : null}

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Dev Machine</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Start a Sandbox on this computer, then turn on App hosting for live local URLs. Defaults are fine for most
          setups.
        </p>
      </div>

      <form className="space-y-5" onSubmit={handleSubmit}>
        <div className="rounded-md border border-[var(--color-border)] p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            Isolated virtual machine
            <Tag emphasis="sandbox">default</Tag>
          </div>
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            Everything runs inside a private Sandbox that Appliance starts itself. Your host stays clean beyond the
            Sandbox engine.
          </p>
        </div>

        <Field
          label="Sandbox name"
          htmlFor="sandbox-name"
          hint="Optional. The default is appliance; name a second Sandbox (for example, traffic) to run it alongside."
          error={vmErr}
        >
          <Input
            id="sandbox-name"
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={vmName}
            onChange={(e) => {
              setVmName(e.target.value.toLowerCase());
              setVmErr(null);
            }}
            placeholder="appliance"
            mono
            invalid={Boolean(vmErr)}
          />
        </Field>

        <Button type="submit" className="w-full">
          Set up hosting
        </Button>
      </form>
    </PageShell>
  );
}

// ---- aws form ---------------------------------------------------------

function AwsForm({ onBack, onSubmit }: { onBack: (() => void) | null; onSubmit: (values: AwsWizardValues) => void }) {
  const host = useHost();
  const [name, setName] = React.useState('appliance');
  const [region, setRegion] = React.useState('us-east-1');
  const [domain, setDomain] = React.useState('');
  const [createZone, setCreateZone] = React.useState(true);
  const [deployApiServer, setDeployApiServer] = React.useState(false);
  const [promoteState, setPromoteState] = React.useState(true);
  const [apiServerImageUri, setApiServerImageUri] = React.useState('');
  const [awsProfile, setAwsProfile] = React.useState('');
  const [nameTouched, setNameTouched] = React.useState(false);
  const [domainTouched, setDomainTouched] = React.useState(false);

  // List AWS profiles from ~/.aws/{config,credentials}. Tauri reads
  // the files; web shell omits the capability and the wizard falls
  // back to a free-text input.
  const profilesQuery = useQuery({
    queryKey: ['aws-profiles'],
    enabled: Boolean(host.bootstrap?.listAwsProfiles),
    queryFn: () => host.bootstrap!.listAwsProfiles!(),
  });
  const profiles = profilesQuery.data ?? [];
  const canEnumerateProfiles = Boolean(host.bootstrap?.listAwsProfiles);

  // Default to "default" if the user has it; otherwise leave empty
  // (operator's shell env wins as the credential source).
  React.useEffect(() => {
    if (awsProfile) return;
    if (profiles.some((p) => p.name === 'default')) setAwsProfile('default');
  }, [profiles, awsProfile]);

  // Image URI is fully optional — phase 2 falls back to the pinned
  // ghcr.io/appliance-sh/api-server:<version> default. If the user
  // types something, it must at least look like a registry reference.
  const imageUriValid = apiServerImageUri.length === 0 || apiServerImageUri.includes('/');
  const canSubmit = name.length > 0 && domain.includes('.') && imageUriValid;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      mode: 'aws',
      name,
      region,
      domain,
      createZone,
      deployApiServer,
      // Phase 3 only makes sense when an api-server is being deployed
      // — phase-1-only runs are explicitly local-state.
      promoteState: deployApiServer && promoteState,
      apiServerImageUri: deployApiServer && apiServerImageUri ? apiServerImageUri : undefined,
      awsProfile: awsProfile || undefined,
    });
  };

  return (
    <PageShell rail="focused" className="space-y-6 pt-12">
      {onBack ? (
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" /> Back
        </Button>
      ) : null}

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">AWS Cloud</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Create an Appliance cloud installation in your AWS account. Choose its region and domain, then keep this page
          open while AWS works.
        </p>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Prefer the CLI? <code className="font-mono">appliance cloud install</code> is the new CloudFormation-based
          path.
        </p>
      </div>

      <form className="space-y-4" onSubmit={handleSubmit}>
        <Field
          label="AWS profile"
          htmlFor="aws-profile"
          hint={canEnumerateProfiles ? '~/.aws/config + credentials' : 'shell env will be used'}
        >
          {canEnumerateProfiles ? (
            <select
              id="aws-profile"
              value={awsProfile}
              onChange={(e) => setAwsProfile(e.target.value)}
              className={inputCls}
            >
              <option value="">— shell environment —</option>
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                  {p.isSso ? '  (SSO)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <Input
              id="aws-profile"
              type="text"
              value={awsProfile}
              onChange={(e) => setAwsProfile(e.target.value)}
              placeholder="leave empty to use shell env"
              mono
            />
          )}
        </Field>

        <Field
          label="Base name"
          htmlFor="base-name"
          hint="Lowercase letters, digits, and dashes."
          error={
            nameTouched && !/^[a-z][a-z0-9-]*$/.test(name)
              ? 'Start with a lowercase letter and use only lowercase letters, digits, and dashes.'
              : undefined
          }
        >
          <Input
            id="base-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setNameTouched(true)}
            pattern="[a-z][a-z0-9\-]*"
            required
            invalid={nameTouched && !/^[a-z][a-z0-9-]*$/.test(name)}
          />
        </Field>

        <Field label="AWS region" htmlFor="aws-region">
          <select id="aws-region" value={region} onChange={(e) => setRegion(e.target.value)} className={inputCls}>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Domain"
          htmlFor="aws-domain"
          hint="For example, example.appliance.sh."
          error={
            domainTouched && !domain.includes('.') ? 'Enter a full domain such as example.appliance.sh.' : undefined
          }
        >
          <Input
            id="aws-domain"
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            onBlur={() => setDomainTouched(true)}
            placeholder="example.appliance.sh"
            required
            invalid={domainTouched && !domain.includes('.')}
          />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={createZone} onChange={(e) => setCreateZone(e.target.checked)} />
          <span>Create a new Route53 zone for this domain</span>
        </label>

        <details className="rounded-md border border-[var(--color-border)] p-3">
          <summary className="cursor-pointer text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
            Technical details
          </summary>
          <div className="mt-3 space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={deployApiServer} onChange={(e) => setDeployApiServer(e.target.checked)} />
              <span>Also install the Appliance service</span>
            </label>
            {deployApiServer ? (
              <>
                <Field
                  label="Service image override"
                  htmlFor="service-image"
                  hint="Optional. Uses the bundled service image by default."
                  error={!imageUriValid ? 'Enter a registry image reference that includes a slash.' : undefined}
                >
                  <Input
                    id="service-image"
                    type="text"
                    value={apiServerImageUri}
                    onChange={(e) => setApiServerImageUri(e.target.value)}
                    placeholder="ghcr.io/appliance-sh/api-server:latest"
                    mono
                  />
                </Field>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={promoteState}
                    onChange={(e) => setPromoteState(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>Make installer state available from other devices (recommended)</span>
                </label>
              </>
            ) : null}
          </div>
        </details>

        {!canSubmit ? (
          <p id="aws-submit-reason" className="text-xs leading-4 text-[var(--color-muted-foreground)]">
            Enter a valid base name and full domain, then correct any image override error.
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={!canSubmit}
          aria-describedby={!canSubmit ? 'aws-submit-reason' : undefined}
          className="w-full"
        >
          Create in AWS
        </Button>
      </form>
    </PageShell>
  );
}

const inputCls =
  'h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]';
