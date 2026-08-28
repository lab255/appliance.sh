import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/ui/banner';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Tag } from '@/components/ui/tag';
import { FriendlyError } from '@/components/friendly-error';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { NETSTACK_BAKED_ALLOWLIST } from '@/lib/host';
import { relativeAge } from '@/lib/time';
import type { EgressEvent, EgressPolicy, MicroVmInstanceHost } from '@/lib/host';

// Guest egress firewall surface (egress-firewall F4): show whether the
// VM's egress is the host-enforced boundary (net_link=Netstack →
// default-DENY + allowlist) or the cooperative NAT proxy, the effective
// policy (baked + operator rules), the denied attempts, and a one-click
// allow for a blocked host. The engine enforces it (packages/vm
// egress.rs / netstack); this is read + incremental edits only — it never
// writes the whole effective policy back (see the host bridge's addRule).
//
// The egress POLICY query is LIFTED to the ② cluster-detail container
// (docs/desktop-ia.md): EgressPanel and CredentialsPanel used to each
// register their own 15 s `['microvm', name, 'egress']` poll. The container
// now owns the single poll and passes `policy` down here (and `mitm` to the
// credentials panel) — one observer, one source of truth. Edits still go
// through `queryClient.invalidateQueries(['microvm', name, 'egress'])`, which
// the lifted query observes. The live traffic feed (a separate key) stays
// local to this panel.
export function EgressPanel({
  vm,
  name,
  policy,
  policyError,
}: {
  vm: MicroVmInstanceHost;
  name: string;
  policy: EgressPolicy | undefined;
  policyError: unknown;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const egress = vm.egress;
  const [host_, setHost] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [resetConfirm, setResetConfirm] = React.useState(false);
  const [clearPending, setClearPending] = React.useState(false);
  const clearTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [trafficAnnouncement, setTrafficAnnouncement] = React.useState('');
  const announcedCount = React.useRef(0);

  React.useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    []
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['microvm', name, 'egress'] });

  // Live traffic feed — the boundary records every request decision
  // (allow/deny/mitm). The denied-attempts view rolls up the deny records.
  const trafficQuery = useQuery({
    queryKey: ['microvm', name, 'egress', 'log'],
    queryFn: () => egress.log(200),
    refetchInterval: 4_000,
  });
  const events = trafficQuery.data ?? [];

  React.useEffect(() => {
    if (events.length <= announcedCount.current) return;
    const added = events.slice(announcedCount.current);
    const timer = window.setTimeout(() => {
      setTrafficAnnouncement(
        `${added.length} new request${added.length === 1 ? '' : 's'}, ${added.filter((item) => item.decision === 'deny').length} blocked`
      );
      announcedCount.current = events.length;
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [events]);

  const enforced = !!policy?.enforced;
  // For a Netstack VM the effective `allow` merges the baked allowlist with
  // the operator's rules; partition it back so the UI shows what's inherited
  // (always-on) vs what the operator added — mirrors render_effective_policy.
  const operatorAllow = React.useMemo(() => {
    if (!policy) return [] as string[];
    return policy.enforced ? policy.allow.filter((h) => !isBaked(h)) : policy.allow;
  }, [policy]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const addRule = (action: 'allow' | 'deny') => {
    const h = host_.trim();
    if (!h) return;
    setHost('');
    void act(() => egress.addRule(action, h));
  };

  // Allow a host. On the ENFORCED (Netstack) boundary a one-click allow
  // silently WIDENS the boundary, and the engine's `egress allow` also
  // drops an EXACT-match operator deny (deny.retain) — so confirm first
  // and name the deny removal when one will actually be deleted. The
  // cooperative/NAT proxy is already bypassable, so it stays one-click.
  const allowHost = async (host: string) => {
    if (policy && enforced) {
      const removesDeny = policy.deny.includes(host);
      const ok = await confirm({
        title: `Allow egress to ${host}?`,
        description:
          `This widens the enforced boundary` + (removesDeny ? `, and removes your deny rule for ${host}` : '') + '.',
        confirmLabel: 'Allow',
        // Widening egress is a deliberate-but-not-destructive action — render
        // the primary (non-red) confirm style rather than the delete style.
        destructive: false,
      });
      if (!ok) return;
    }
    void act(() => egress.addRule('allow', host));
  };

  // Per-rule remove (the "×" on a rule): incremental drop of one host from
  // the persisted policy — never a whole effective-policy write-back.
  // "Reset rules" stays the clear-everything path.
  const removeHost = (host: string) => void act(() => egress.removeRule(host));

  // Distinct denied destinations — surfaced as a badge on the collapsed
  // summary so a hung install (everything blocked) self-advertises.
  const deniedCount = React.useMemo(() => aggregateDenied(events).length, [events]);

  const scheduleClear = () => {
    setClearPending(true);
    clearTimer.current = setTimeout(() => {
      setClearPending(false);
      void egress
        .clearLog()
        .then(() => queryClient.invalidateQueries({ queryKey: ['microvm', name, 'egress', 'log'] }));
    }, 5_000);
  };

  const undoClear = () => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = null;
    setClearPending(false);
  };

  return (
    <div className="space-y-4">
      {policy ? (
        <>
          <SectionCard
            title="Internet access"
            description={`${deniedCount} blocked destination${deniedCount === 1 ? '' : 's'} in recent traffic`}
          >
            <Banner tone={enforced ? 'info' : 'warning'} title={enforced ? 'Protection enforced' : 'Monitoring only'}>
              {enforced
                ? 'The Sandbox can reach only approved services. Block rules take priority.'
                : 'Rules are applied through a proxy, but software inside the Sandbox may bypass them.'}
            </Banner>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]">
                Technical details
              </summary>
              <div className="mt-2 space-y-2 text-xs leading-4 text-[var(--color-muted-foreground)]">
                <p>
                  Network mode: <code className="font-mono">{policy.netLink ?? (enforced ? 'netstack' : 'nat')}</code>.
                  Default: <code className="font-mono">{policy.default}</code>. Secure inspection:{' '}
                  {policy.mitm ? 'on' : 'off'}.
                </p>
                {policy.mitm && policy.caPath ? (
                  <Banner tone="info">
                    Certificate path: <code className="font-mono">{policy.caPath}</code>
                  </Banner>
                ) : null}
              </div>
            </details>
          </SectionCard>

          <SectionCard title="Rules">
            <div className="space-y-3">
              <div role="radiogroup" aria-label="Default internet access" className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">Default</span>
                {enforced ? (
                  <StatusPill tone="warning" label="Block · enforced by host" />
                ) : (
                  (['allow', 'deny'] as const).map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={policy.default === value ? 'default' : 'outline'}
                      role="radio"
                      aria-checked={policy.default === value}
                      disabled={busy}
                      onClick={() => policy.default !== value && void act(() => egress.setDefault(value))}
                    >
                      {value === 'allow' ? 'Allow' : 'Block'}
                    </Button>
                  ))
                )}
              </div>
              <label className="inline-flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={policy.mitm}
                  disabled={busy}
                  onChange={(e) => void act(() => egress.setMitm(e.target.checked))}
                />
                Inspect secure traffic for credential rules
              </label>
              <Field
                label="Host suffix"
                htmlFor="egress-host"
                hint="For example, github.com also matches api.github.com."
              >
                <div className="flex gap-2">
                  <Input
                    id="egress-host"
                    mono
                    value={host_}
                    onChange={(e) => setHost(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addRule('allow');
                    }}
                  />
                  <Button variant="outline" size="sm" disabled={busy || !host_.trim()} onClick={() => addRule('allow')}>
                    Allow
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy || !host_.trim()} onClick={() => addRule('deny')}>
                    Block
                  </Button>
                </div>
              </Field>
              {enforced ? <BakedAllowlist deny={policy.deny} /> : null}
              <RuleList
                label={enforced ? 'Your allow rules' : 'Allowed'}
                hosts={operatorAllow}
                tone="allow"
                busy={busy}
                onRemove={removeHost}
              />
              <RuleList
                label={enforced ? 'Your block rules' : 'Blocked'}
                hosts={policy.deny}
                tone="block"
                busy={busy}
                onRemove={removeHost}
              />
              {resetConfirm ? (
                <Banner
                  tone="warning"
                  action={
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          setResetConfirm(false);
                          void act(() => egress.reset());
                        }}
                      >
                        Reset
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setResetConfirm(false)}>
                        Cancel
                      </Button>
                    </>
                  }
                >
                  Remove {operatorAllow.length + policy.deny.length} custom rule
                  {operatorAllow.length + policy.deny.length === 1 ? '' : 's'}? The default remains{' '}
                  {enforced ? 'Block (host enforced)' : policy.default}.
                </Banner>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setResetConfirm(true)}>
                  Reset rules
                </Button>
              )}
            </div>
          </SectionCard>

          <SectionCard title="Blocked requests">
            <DeniedAttempts events={events} policy={policy} busy={busy} onAllow={allowHost} />
          </SectionCard>
          <SectionCard
            title="Recent traffic"
            action={
              events.length > 0 && !clearPending ? (
                <Button size="sm" variant="ghost" onClick={scheduleClear}>
                  Clear
                </Button>
              ) : undefined
            }
          >
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {trafficAnnouncement}
            </div>
            {clearPending ? (
              <Banner
                className="mb-3"
                action={
                  <Button size="sm" variant="outline" onClick={undoClear}>
                    Undo
                  </Button>
                }
              >
                Visible traffic will be cleared in 5 seconds.
              </Banner>
            ) : null}
            {trafficQuery.isError ? (
              <Banner tone="error">Failed to load traffic: {errMessage(trafficQuery.error)}</Banner>
            ) : (
              <TrafficView
                events={events}
                policy={policy}
                busy={busy}
                onAllow={allowHost}
                onBlock={(h) => void act(() => egress.addRule('deny', h))}
                onClear={scheduleClear}
                hideClear
              />
            )}
          </SectionCard>
        </>
      ) : policyError ? (
        // Don't spin on "Loading policy…" forever when egress.get() rejects.
        <FriendlyError error={policyError} headline="Couldn't load the egress policy" className="mt-2 text-xs" />
      ) : (
        <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">Loading policy…</p>
      )}

      {err ? <FriendlyError error={err} headline="That change didn't apply" className="mt-2 text-xs" /> : null}
    </div>
  );
}

/** Is `host` one of the baked, always-on Netstack allowlist entries? Used
 *  to partition the effective `allow` into baked vs operator rules. */
function isBaked(host: string): boolean {
  const h = host.trim().replace(/\.$/, '').toLowerCase();
  return NETSTACK_BAKED_ALLOWLIST.some((b) => b.toLowerCase() === h);
}

/** The baked allowlist for a Netstack VM — always-on (§5 of the design),
 *  shown read-only. A baked host an operator deny rule overrides is struck
 *  through, mirroring the engine's effective-policy report. */
function BakedAllowlist({ deny }: { deny: string[] }) {
  const overridden = (h: string) => deny.some((d) => hostMatches(h, d));
  return (
    <div>
      <div className="mb-1 text-micro font-medium uppercase tracking-[0.08em] text-[var(--color-muted-foreground)]">
        Built-in allowlist <span className="normal-case opacity-70">(always on with enforced protection)</span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {NETSTACK_BAKED_ALLOWLIST.map((h) => {
          const off = overridden(h);
          return (
            <li key={h} title={off ? 'overridden by your block rule' : undefined}>
              <Tag className={cn('font-mono', off && 'line-through')}>
                {h}
                {/* The strikethrough is visual-only; spell the state out for
                  screen readers (CSS line-through isn't announced). */}
                {off ? <span className="sr-only"> (overridden by your block rule)</span> : null}
              </Tag>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One destination's denied-egress roll-up — mirrors DeniedHost in
 *  packages/vm/src/traffic.rs. */
interface DeniedHost {
  host: string;
  port: number;
  count: number;
  lastSeen: number;
}

/** Aggregate the `deny` records in the traffic feed into per-(host, port)
 *  summaries, most-recently-seen first. Mirror of traffic.rs::aggregate_denied
 *  so the desktop roll-up matches the CLI's `egress denied` view. */
function aggregateDenied(events: EgressEvent[]): DeniedHost[] {
  const byDest = new Map<string, DeniedHost>();
  for (const e of events) {
    if (e.decision !== 'deny') continue;
    // Explicit `|` separator (a hostname has neither a space nor a pipe)
    // — never a raw NUL byte, which reads as file corruption to tooling.
    const key = `${e.host}|${e.port}`;
    const cur = byDest.get(key);
    if (cur) {
      cur.count += 1;
      cur.lastSeen = Math.max(cur.lastSeen, e.ts);
    } else {
      byDest.set(key, { host: e.host, port: e.port, count: 1, lastSeen: e.ts });
    }
  }
  return [...byDest.values()].sort((a, b) => b.lastSeen - a.lastSeen || a.host.localeCompare(b.host));
}

// Denied-attempts view (egress-firewall F4): the blocked→allow loop in the
// GUI. Rolls up the boundary's deny records into host:port / count / last-
// seen, most-recent-first, each with a one-click Allow that adds an
// incremental allow rule (never a whole-policy write-back).
function DeniedAttempts({
  events,
  policy,
  busy,
  onAllow,
}: {
  events: EgressEvent[];
  policy: EgressPolicy;
  busy: boolean;
  onAllow: (host: string) => void;
}) {
  const denied = aggregateDenied(events);
  return (
    <div className="space-y-1.5">
      {denied.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-muted-foreground)]">
          Nothing blocked yet. Traffic the boundary denies will show up here — allow a host in one click.
        </p>
      ) : (
        <ul className="max-h-44 space-y-0.5 overflow-auto rounded-md border border-[var(--color-border)] p-1">
          {denied.map((d) => {
            // Deny-first (ruledStatus): a broader suffix deny keeps a host
            // denied even when an allow rule matches, so only a TRUE
            // 'allowed' shows the green badge — otherwise keep the Allow
            // affordance (a still-denied row must not read as allowed).
            const status = ruledStatus(policy, d.host);
            return (
              <li key={`${d.host}:${d.port}`} className="flex items-center gap-2 px-1 py-0.5 text-micro">
                <span className="w-8 shrink-0 text-right font-mono text-micro tabular-nums text-[var(--color-muted-foreground)]">
                  {relativeAge(new Date(d.lastSeen).toISOString())}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {d.host}
                  <span className="text-[var(--color-muted-foreground)]">:{d.port}</span>
                </span>
                <span className="shrink-0 font-mono text-micro tabular-nums text-[var(--color-muted-foreground)]">
                  ×{d.count}
                </span>
                {status === 'allowed' ? (
                  <StatusPill tone="neutral" label="Allowed" />
                ) : (
                  <>
                    {status === 'denied' ? (
                      <span
                        className="shrink-0 text-micro text-[var(--color-destructive-foreground)]"
                        title="A deny rule still blocks this host — remove it below to allow"
                      >
                        deny rule
                      </span>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Allow egress to ${d.host}:${d.port}`}
                      onClick={() => onAllow(d.host)}
                      className="shrink-0 rounded border border-[var(--color-border)] px-1.5 text-micro hover:bg-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:opacity-50"
                    >
                      Allow
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Docker-Desktop-style live traffic feed: most-recent requests the
// proxy saw, each allow/deny/mitm-tagged, with one-click allow or block
// per host that updates the policy live.
function TrafficView({
  events,
  policy,
  busy,
  onAllow,
  onBlock,
  onClear,
  hideClear = false,
}: {
  events: EgressEvent[];
  policy: EgressPolicy;
  busy: boolean;
  onAllow: (host: string) => void;
  onBlock: (host: string) => void;
  onClear: () => void;
  hideClear?: boolean;
}) {
  // Newest first, capped so the panel stays compact.
  const rows = [...events].reverse().slice(0, 40);
  const decisionLabel = (d: EgressEvent['decision']) =>
    d === 'deny' ? 'Blocked' : d === 'mitm' ? 'Inspected' : 'Allowed';
  const ruled = (host: string) => ruledStatus(policy, host);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-micro font-medium uppercase tracking-[0.08em] text-[var(--color-muted-foreground)]">
          Requests
        </div>
        {events.length > 0 && !hideClear ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          >
            Clear
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-muted-foreground)]">
          No traffic yet. Requests appear here as workloads make them.
        </p>
      ) : (
        <ul className="max-h-56 space-y-0.5 overflow-auto rounded-md border border-[var(--color-border)] p-1">
          {rows.map((e, i) => {
            const status = ruled(e.host);
            return (
              <li key={`${e.ts}-${i}`} className="flex items-center gap-2 px-1 py-0.5 text-micro">
                <span className="w-8 shrink-0 text-right font-mono text-micro tabular-nums text-[var(--color-muted-foreground)]">
                  {relativeAge(new Date(e.ts).toISOString())}
                </span>
                <span className="w-14 shrink-0">{decisionLabel(e.decision)}</span>
                <span className="min-w-0 flex-1 truncate font-mono">
                  <span className="text-[var(--color-muted-foreground)]">{e.method} </span>
                  {e.host}
                  {e.path ? <span className="text-[var(--color-muted-foreground)]">{e.path}</span> : null}
                </span>
                {status === 'allowed' ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Block egress to ${e.host}:${e.port}`}
                    onClick={() => onBlock(e.host)}
                    className="shrink-0 rounded border border-[var(--color-border)] px-1.5 text-micro hover:bg-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:opacity-50"
                  >
                    Block
                  </button>
                ) : status === 'denied' ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Allow egress to ${e.host}:${e.port}`}
                    onClick={() => onAllow(e.host)}
                    className="shrink-0 rounded border border-[var(--color-border)] px-1.5 text-micro hover:bg-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:opacity-50"
                  >
                    Allow
                  </button>
                ) : (
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Allow egress to ${e.host}:${e.port}`}
                      onClick={() => onAllow(e.host)}
                      className="rounded border border-[var(--color-border)] px-1.5 text-micro hover:bg-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:opacity-50"
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Block egress to ${e.host}:${e.port}`}
                      onClick={() => onBlock(e.host)}
                      className="rounded border border-[var(--color-border)] px-1.5 text-micro hover:bg-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:opacity-50"
                    >
                      Block
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Mirror of the Rust host-suffix match (egress.rs): exact host or a
 *  dot-suffix. Used to show whether a row's host is already ruled. */
function hostMatches(host: string, suffix: string): boolean {
  const h = host.trim().replace(/\.$/, '').toLowerCase();
  const s = suffix.trim().replace(/^\./, '').replace(/\.$/, '').toLowerCase();
  return s !== '' && (h === s || h.endsWith('.' + s));
}

/** Deny-first effective status of a host against the policy — deny WINS
 *  over allow, mirroring the engine's `EgressPolicy::allows`. A broader
 *  suffix deny keeps a host denied even when an allow rule also matches
 *  (the engine's `egress allow` only drops an EXACT-match deny), so the
 *  denied-attempts row must use this rather than `allow.some(...)` alone
 *  or it would show a still-blocked host as green "allowed". */
function ruledStatus(policy: EgressPolicy, host: string): 'denied' | 'allowed' | null {
  if (policy.deny.some((s) => hostMatches(host, s))) return 'denied';
  if (policy.allow.some((s) => hostMatches(host, s))) return 'allowed';
  return null;
}

/** Best-effort message from an unknown thrown/rejected value. */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Compact allow/deny chip list with a per-rule remove (×) — the
 *  incremental counterpart of "Reset rules" (which clears every rule). */
function RuleList({
  label,
  hosts,
  tone,
  busy,
  onRemove,
}: {
  label: string;
  hosts: string[];
  tone: 'allow' | 'block';
  busy?: boolean;
  onRemove?: (host: string) => void;
}) {
  if (hosts.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-micro font-medium uppercase tracking-[0.08em] text-[var(--color-muted-foreground)]">
        {label}
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {hosts.map((h) => (
          <li key={h} className="inline-flex items-center gap-1">
            <Tag className="font-mono">
              {h}
              {onRemove ? (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${tone === 'allow' ? 'allow' : 'block'} rule ${h}`}
                  title="Remove this rule"
                  onClick={() => onRemove(h)}
                  className="rounded text-micro leading-none text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:opacity-50"
                >
                  ×
                </button>
              ) : null}
            </Tag>
          </li>
        ))}
      </ul>
    </div>
  );
}
