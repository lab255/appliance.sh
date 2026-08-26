import * as React from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { useHost } from '@/providers/host-provider';
import { DEFAULT_MICROVM_NAME, microVmClusterId } from '@/lib/host';
import { RuntimeDetail } from './runtime-detail';

// The Machine area — THE Dev Machine page. One managed local VM
// (`appliance`) is the normal case, so the page renders its management
// detail directly (lifecycle / egress / credentials / facts / workloads).
// When extra VMs exist (or are being added) a small picker appears at the
// top; the selection rides in `?vm=` so the old `/clusters/:id` deep links
// can redirect here without losing which VM they meant. Desktop-only
// (host.vm) — the web shell gets a short note instead of dead controls.
export function MachinePage() {
  const host = useHost();
  const supported = Boolean(host.vm);
  const [searchParams, setSearchParams] = useSearchParams();
  // Not-yet-created VMs the user just named — they don't exist on the
  // engine until their first Start, but must be selectable right away.
  const [pending, setPending] = React.useState<string[]>([]);

  const vmListQuery = useQuery({
    queryKey: ['microvm', 'list'],
    enabled: supported,
    queryFn: () => host.vm!.list(),
    refetchInterval: 8_000,
  });
  const vms = vmListQuery.data ?? [];

  // Always surface the default `appliance` VM (even before it's created,
  // so the first-run Start is reachable), then any VMs the engine
  // reports, then still-pending additions.
  const names = React.useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const n of [DEFAULT_MICROVM_NAME, ...vms.map((v) => v.name), ...pending]) {
      if (!seen.has(n)) {
        seen.add(n);
        ordered.push(n);
      }
    }
    return ordered;
  }, [vms, pending]);

  const requested = searchParams.get('vm');
  const selected = requested && names.includes(requested) ? requested : DEFAULT_MICROVM_NAME;
  const selectVm = (name: string) => {
    setSearchParams(name === DEFAULT_MICROVM_NAME ? {} : { vm: name }, { replace: true });
  };

  if (!supported) {
    return (
      <PageShell rail="detail">
        <PageHeader
          title="Dev Machine"
          description="The Sandbox runs coding agents and shells on this computer. It is available in the desktop app."
        />
      </PageShell>
    );
  }

  return (
    <PageShell rail="detail" className="space-y-5">
      <PageHeader
        title="Dev Machine"
        description="A private Sandbox for coding agents and shells. Turn on App hosting when apps need live local URLs."
        action={
          <NewVmButton
            existing={names}
            onAdd={(n) => {
              setPending((p) => [...p, n]);
              // The VM doesn't exist on the engine until its Start boots it;
              // the detail below handles a not-yet-created VM.
              selectVm(n);
            }}
          />
        }
      />

      {names.length > 1 ? (
        <label className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
          Sandbox
          <select
            value={selected}
            onChange={(e) => selectVm(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1 font-mono text-xs"
          >
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
                {n === DEFAULT_MICROVM_NAME ? ' (default)' : ''}
                {vms.find((vm) => vm.name === n)?.running && !vms.find((vm) => vm.name === n)?.clusterProvisioned
                  ? ' — Sandbox ready'
                  : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <RuntimeDetail key={selected} name={selected} clusterId={microVmClusterId(selected)} />
    </PageShell>
  );
}

// Name a new VM, then manage it below. The VM doesn't exist on the engine
// until its Start boots it — this just validates the name.
function NewVmButton({ existing, onAdd }: { existing: string[]; onAdd: (name: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [err, setErr] = React.useState<string | null>(null);

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) {
      setErr('Use lowercase letters, digits, and dashes (e.g. "traffic").');
      return;
    }
    if (existing.includes(n)) {
      setErr(`A Sandbox named "${n}" already exists.`);
      return;
    }
    onAdd(n);
    setOpen(false);
    setName('');
    setErr(null);
  };

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden /> New Sandbox
      </Button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={name}
          onChange={(e) => {
            setName(e.target.value.toLowerCase());
            setErr(null);
          }}
          aria-label="Sandbox name"
          placeholder="name, e.g. traffic"
          className="w-40"
          mono
          invalid={Boolean(err)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') setOpen(false);
          }}
        />
        <Button size="sm" disabled={!name.trim()} onClick={submit}>
          Add
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {err ? (
        <p role="alert" className="text-xs leading-4 text-[var(--color-destructive-foreground)]">
          {err}
        </p>
      ) : null}
    </div>
  );
}
