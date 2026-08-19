# Appliance Design-System Foundations

1. Replace raw Tailwind status colors with opaque semantic token triplets; blue means information/progress, cyan means Sandbox capability, and green means apps can run here.
2. Consolidate 31 source-level colored message recipes into one `Banner`, and seven status implementations into `StatusPill` plus the existing `StatusDot`.
3. Standardize operational output on `LogPane`, which is the log/disclosure half of the UX spec's `LongOperation`, across 12 current source locations.
4. Keep the true-black, hairline, Geist aesthetic; add only quiet surface tiers and an 11 px minimum dense role, with no light-mode UI in v1.
5. Migrate mechanically using the APIs, class recipes, state mappings, and file:line table below; delete raw status utilities and 10 px text after parity is reached.

Status: implementation specification. Scope: the React frontend in `packages/app`.
Binding source: `docs/ux-journey-spec.md`. Product copy in this document therefore uses **Sandbox**, **App hosting**, and **Set up hosting**. The Machine header is a two-row capability ledger. `LongOperation` remains the only long-running-work pattern.

## Audit baseline and counting rules

Counts are source occurrences, not rendered instances. The requested grep over `packages/app/src/pages` returns: `amber-500` 16, `cyan-500` 27, `green-500` 26, `red-500` 38, `violet-500` 1, `text-[10px]` 57, `text-[11px]` 27, and `bg-black/40` 7. There are also 230 legitimate `text-xs` occurrences. Two of the seven `bg-black/40` occurrences are modal scrims and one is an inline command, so raw-color count and log-pane count intentionally differ.

For the migration inventory:

- A **message container** is a non-interactive colored block or strip that communicates information, capability, success, warning, or error. There are 31 source-level recipes below. Destructive forms, selected controls, colored words, and action buttons are not banners.
- A **status treatment** is a label or dot whose color encodes lifecycle/run state. There are seven source-level implementations below. Categorical tags such as `default`, agent type, `capture`, and `inject` are not status.
- A **log pane** is scrollable preformatted operation output or raw diagnostic output. There are 12 source locations below. Terminal emulators are not log panes.
- Micro-type migration is representative, as requested; every 10 px occurrence must nevertheless be eliminated by the acceptance check.

## A. Token additions and changes

### A1. Exact `styles.css` `@theme` block changes

Keep every existing neutral token unless explicitly replaced below. Replace `--color-info` and the two destructive declarations at current lines 21–23, and insert the remaining declarations in `@theme`. Values are opaque by design: component recipes must not synthesize semantic backgrounds with `/5`, `/10`, `/15`, or `/40` opacity utilities.

```css
@theme {
  /* Existing base neutrals remain unchanged. */
  --color-background: hsl(0 0% 4%);
  --color-foreground: hsl(0 0% 93%);
  --color-surface: hsl(0 0% 7%);
  --color-surface-raised: hsl(0 0% 9%);
  --color-surface-overlay: hsl(0 0% 11%);
  --color-muted: hsl(0 0% 10%);
  --color-muted-foreground: hsl(0 0% 63%);
  --color-border: hsl(0 0% 18%);
  --color-border-strong: hsl(0 0% 33%);
  --color-accent: hsl(0 0% 14%);
  --color-accent-foreground: hsl(0 0% 98%);
  --color-primary: hsl(0 0% 93%);
  --color-primary-foreground: hsl(0 0% 4%);

  /* Neutral informational/progress blue. Never means Sandbox capability. */
  --color-info: hsl(211 90% 72%);
  --color-info-foreground: hsl(211 90% 72%);
  --color-info-background: hsl(211 45% 9%);
  --color-info-border: hsl(211 45% 29%);

  /* Cyan is reserved for the Sandbox capability and its readiness. */
  --color-sandbox: hsl(189 85% 70%);
  --color-sandbox-foreground: hsl(189 85% 70%);
  --color-sandbox-background: hsl(189 40% 9%);
  --color-sandbox-border: hsl(189 45% 28%);

  /* Green is reserved for "apps can run here" and completed app deploys. */
  --color-success: hsl(142 65% 68%);
  --color-success-foreground: hsl(142 65% 68%);
  --color-success-background: hsl(142 35% 9%);
  --color-success-border: hsl(142 35% 27%);

  --color-warning: hsl(42 90% 72%);
  --color-warning-foreground: hsl(42 90% 72%);
  --color-warning-background: hsl(42 40% 9%);
  --color-warning-border: hsl(42 45% 28%);

  --color-destructive: hsl(0 85% 75%);
  --color-destructive-foreground: hsl(0 85% 75%);
  --color-destructive-background: hsl(0 40% 9%);
  --color-destructive-border: hsl(0 45% 30%);

  /* Dense telemetry/status is the only role below text-xs. */
  --text-micro: 0.6875rem;
  --text-micro--line-height: 1rem;
}
```

`surface-raised` is for cards and menus above the page; `surface-overlay` is for dialogs. Do not add elevation shadows to ordinary cards. Keep `shadow-lg`/`shadow-xl` only on menus, toasts, and dialogs. `bg-black/60` remains valid for a modal scrim; scrims are not surfaces.

### A2. Contrast and theme policy

The semantic foreground/background pairs above have these WCAG contrast ratios: info 8.45:1, Sandbox 11.22:1, success 10.79:1, warning 11.79:1, destructive 7.83:1. Existing muted foreground on muted is 6.74:1. All exceed AA for normal text. Borders are not relied on to communicate state.

Dark-only is a v1 product decision, not a component assumption. Components may reference only semantic or neutral custom properties. They may not reference `white`, `black` (except modal scrims), Tailwind hue utilities, or hex colors. A future light theme is additive: override the same custom properties under `[data-theme='light']`; do not add `dark:` branches to primitives.

### A3. Semantic taxonomy

| Tone      | Meaning                                             | Color   | Allowed examples                                              | Disallowed examples                                                  |
| --------- | --------------------------------------------------- | ------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `neutral` | Metadata, inactive, ended, unknown                  | neutral | Stopped, Not created, default, cloud kind                     | Any success or warning                                               |
| `info`    | Explanatory information or generic work in progress | blue    | No builder configured, deployment Running, Connecting         | Sandbox readiness                                                    |
| `sandbox` | Sandbox capability exists/is becoming ready         | cyan    | Sandbox Ready, starting the Sandbox, this-computer capability | Generic selected tab, generic info, agent brand                      |
| `success` | Apps can run here or an app deploy completed        | green   | App hosting On, cloud Ready, deploy Succeeded/Deployed        | Agent signed in, shell connected, VM merely running, baseline update |
| `warning` | Degraded, blocked, attention or safe delay          | amber   | hosting not set up, auth expired, stall reassurance           | In-flight by default                                                 |
| `error`   | Failed action/state requiring attention             | red     | deploy failed, unreachable, invalid input                     | Destructive intent before failure                                    |

Machine lifecycle `Running` is `neutral` with a success-border exception in the capability ledger only, as bound by the UX spec. Its fill and text remain neutral; the separate **App hosting · On** row owns solid green meaning.

### A4. Type roles

Use these roles, not arbitrary sizes:

| Role          | Exact classes                                            | Use                                                          |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| Page title    | `text-xl font-semibold tracking-tight`                   | Area/page h1; use `text-2xl` only for focused setup progress |
| Section title | `text-sm font-semibold`                                  | Card/section h2                                              |
| Body          | `text-sm leading-5`                                      | Explanations and banner body                                 |
| Supporting    | `text-xs leading-4 text-[var(--color-muted-foreground)]` | Secondary metadata, field hints                              |
| Label         | `text-xs font-medium leading-4`                          | Field and compact control labels                             |
| Overline      | `text-micro font-medium uppercase tracking-[0.08em]`     | Session strip and compact group headings only                |
| Dense status  | `text-micro font-medium leading-4`                       | StatusPill and categorical Tag only                          |
| Code          | `font-mono text-xs leading-4 tabular-nums`               | IDs, URLs, commands, values                                  |
| Log           | `font-mono text-xs leading-relaxed tabular-nums`         | All LogPane output                                           |

`text-[10px]` is forbidden. Existing 11 px uses become `text-micro`; ordinary hints become `text-xs`. Mono is for machine-readable strings (IDs, paths, URLs, ports, durations, log output), not headings or action labels. Add `tabular-nums` to elapsed time, CPU/memory, ports, counts, and timestamps; the existing base `font-feature-settings` remains the fallback for mono runs.

## B. Component inventory and exact recipes

All primitives live in `packages/app/src/components/ui/`. Use `cn` and the already-installed `class-variance-authority`; do not add a variants dependency and do not use CSS-in-JS.

### B1. `Banner` (new; no separate `Callout` component)

“Banner” is the single implementation. “Callout” is a placement: a Banner inside page flow. Top-of-page and inline uses share markup and tones.

```ts
export type BannerTone = 'neutral' | 'info' | 'sandbox' | 'success' | 'warning' | 'error';

export interface BannerProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: BannerTone; // default 'neutral'
  title?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  action?: React.ReactNode; // Button/link group, rendered at end
  onDismiss?: () => void; // adds labeled X button
  children: React.ReactNode;
}
```

Base recipe:

```ts
const bannerVariants = cva('flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm leading-5', {
  variants: {
    tone: {
      neutral: 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)]',
      info: 'border-[var(--color-info-border)] bg-[var(--color-info-background)] text-[var(--color-info-foreground)]',
      sandbox:
        'border-[var(--color-sandbox-border)] bg-[var(--color-sandbox-background)] text-[var(--color-sandbox-foreground)]',
      success:
        'border-[var(--color-success-border)] bg-[var(--color-success-background)] text-[var(--color-success-foreground)]',
      warning:
        'border-[var(--color-warning-border)] bg-[var(--color-warning-background)] text-[var(--color-warning-foreground)]',
      error:
        'border-[var(--color-destructive-border)] bg-[var(--color-destructive-background)] text-[var(--color-destructive-foreground)]',
    },
  },
  defaultVariants: { tone: 'neutral' },
});
```

Structure: icon `mt-0.5 h-4 w-4 shrink-0`; content `min-w-0 flex-1`; title `font-medium`; body below title `mt-0.5 text-xs leading-4 opacity-90`; action `ml-auto flex shrink-0 items-center gap-1.5`; dismiss button `rounded p-1 opacity-70 hover:opacity-100`, `aria-label="Dismiss"`. Root role is `alert` for `error`, `status` for `success`, and absent otherwise unless the caller supplies one. Never infer an icon; callers choose one when it adds meaning. Do not put a large log inside Banner.

Change `FriendlyError` to render `Banner tone="error"`; preserve its plain-language classification, details disclosure, and actions. Change auth and compatibility banners to the same primitive. Reuse existing `Button` for actions.

### B2. `StatusPill` and `StatusDot` (new/changed)

```ts
export type StatusTone = 'neutral' | 'info' | 'sandbox' | 'success' | 'warning' | 'error';

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  label: React.ReactNode;
  activity?: 'static' | 'pulse' | 'spin'; // default 'static'
  dot?: boolean; // default true
}

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  label: string; // required accessible name
  activity?: 'static' | 'pulse';
  size?: 'sm' | 'md'; // 8 px / 10 px
}
```

StatusPill base: `inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-micro font-medium leading-4`. Tone recipes:

```ts
neutral: 'border-[var(--color-border)] bg-[var(--color-muted)] text-[var(--color-muted-foreground)]';
info: 'border-[var(--color-info-border)] bg-[var(--color-info-background)] text-[var(--color-info-foreground)]';
sandbox: 'border-[var(--color-sandbox-border)] bg-[var(--color-sandbox-background)] text-[var(--color-sandbox-foreground)]';
success: 'border-[var(--color-success-border)] bg-[var(--color-success-background)] text-[var(--color-success-foreground)]';
warning: 'border-[var(--color-warning-border)] bg-[var(--color-warning-background)] text-[var(--color-warning-foreground)]';
error: 'border-[var(--color-destructive-border)] bg-[var(--color-destructive-background)] text-[var(--color-destructive-foreground)]';
```

Dot: `h-1.5 w-1.5 rounded-full bg-current`; `pulse` adds `animate-pulse`; `spin` replaces the dot with `Loader2` at `h-3 w-3 animate-spin`. The visible label is mandatory, so color is never the only signal. `StatusDot` uses the same tone-to-`bg-*` mapping, a relative ping child only for `pulse`, and `role="img" aria-label={label}`.

Keep domain-string mapping outside the primitive in named resolver functions. Required canonical mappings:

| Domain state                                                                         | Label                                       | Tone/activity                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------- |
| Sandbox capability `starting`                                                        | Starting…                                   | `sandbox`, `spin` for pill or `pulse` for dot            |
| Generic operation `running`, terminal `connecting`                                   | Running / Connecting…                       | `info`, `spin` for pill or `pulse` for dot               |
| Sandbox capability ready                                                             | Ready                                       | `sandbox`, `static`                                      |
| Machine lifecycle running                                                            | Running                                     | `neutral`, `static` (ledger applies success border only) |
| App hosting `on`, cloud `ready`, deploy `succeeded`/`deployed`                       | On / Ready / Succeeded / Deployed           | `success`, `static`                                      |
| `pending`, `stopped`, `not created`, `destroyed`, `ended`, `done`, `exited`, unknown | Plain-language label                        | `neutral`, `static`                                      |
| `destroying`, `degraded`, hosting absent where required                              | Destroying… / Degraded / Hosting not set up | `warning`; pulse only while active                       |
| `failed`, `error`, `unhealthy`                                                       | Failed / Error / Unhealthy                  | `error`, `static`                                        |
| Agent run `running` or shell `open`                                                  | Running / Live                              | `info`, `pulse`; never green                             |

`StatusDot` may retain a compatibility `status` resolver during migration, but the exported final API is tone-based. Delete page-local components named `StatusBadge`, `RunStatusBadge`, and `StatusPill`.

### B3. `Tag` (new categorical pill)

Do not force identity/kind labels into status semantics.

```ts
export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  emphasis?: 'quiet' | 'sandbox'; // default 'quiet'
  children: React.ReactNode;
}
```

Base: `inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-micro font-medium leading-4`. Quiet: `bg-[var(--color-muted)] text-[var(--color-muted-foreground)]`. Sandbox: `bg-[var(--color-sandbox-background)] text-[var(--color-sandbox-foreground)]`. Sandbox emphasis is allowed only for labels that identify the Sandbox/this-computer capability. Agent brands, `default`, cloud, helper, capture, and inject are quiet; use an icon or words, not green/cyan, to distinguish categories.

### B4. `LogPane` (new; subordinate to `LongOperation`)

`LogPane` owns only the log header/disclosure/viewport/empty state. `LongOperation` owns ladder, now-line, status, elapsed time, stall reassurance, estimate, leave-safety, retry, and success. `LongOperation` composes `LogPane`; a page must not place the two as sibling competing patterns.

```ts
export interface LogPaneProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'onScroll'> {
  label?: string; // default 'Details (log)'
  children?: React.ReactNode; // preformatted lines/nodes
  empty?: React.ReactNode; // default 'Waiting…'
  open?: boolean; // controlled when supplied
  defaultOpen?: boolean; // default false
  onOpenChange?: (open: boolean) => void;
  viewportRef?: React.Ref<HTMLDivElement>;
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
  height?: 'compact' | 'default' | 'fill'; // 10rem / 18rem / flex-1
  copyText?: string; // adds Copy button when supplied
  live?: 'off' | 'polite'; // default 'off'
}
```

Root: `overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-background)]`. Header button: `flex w-full items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]`; use `ChevronRight`, rotating 90° when open; `aria-expanded`; label stays sentence case, never uppercase.

Viewport base: `overflow-auto border-t border-[var(--color-border)] px-3 py-2 font-mono text-xs leading-relaxed tabular-nums whitespace-pre-wrap text-[var(--color-foreground)]`. Height recipes: compact `max-h-40`; default `h-72`; fill `min-h-0 flex-1`. Empty: `text-[var(--color-muted-foreground)]`. Callers render line tones with semantic foreground tokens only: warning, destructive, info. Do not render nested `<div>` children inside `<pre>`; the viewport is a `<div role="log">` with line `<div>` elements. With `live="polite"`, set `aria-live="polite" aria-relevant="additions"`; otherwise no live region. Copy uses the same feedback idiom as `CommandSnippet`.

Healthy stepped operations default closed; failures and stall-link activation force `open=true`; deploy build defaults open because its output is primary. Auto-scroll remains the caller's hook via `viewportRef` and `onViewportScroll`.

### B5. `SectionCard` (new)

```ts
export interface SectionCardProps extends React.HTMLAttributes<HTMLElement> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  tone?: 'neutral' | 'danger'; // default neutral; danger is destructive intent, not an error
  as?: 'section' | 'div'; // default section
  children: React.ReactNode;
}
```

Root base: `rounded-md border p-4`; neutral `border-[var(--color-border)] bg-transparent`; danger `border-[var(--color-destructive-border)] bg-transparent`. Header, when present: `mb-3 flex items-start justify-between gap-3`; title `text-sm font-semibold`; danger title `text-[var(--color-destructive-foreground)]`; description `mt-1 text-xs leading-4 text-[var(--color-muted-foreground)]`; body `min-w-0`; action `shrink-0`. Cards do not use semantic filled backgrounds. Preserve `EmptyState` for zero-object guidance; it is not a SectionCard variant.

### B6. `KeyValueList` (new)

```ts
export interface KeyValueItem {
  key: React.Key;
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
}
export interface KeyValueListProps extends React.HTMLAttributes<HTMLDListElement> {
  items: readonly KeyValueItem[];
  columns?: 'compact' | 'wide'; // labels 7rem / 10rem; default compact
}
```

Root: `grid gap-x-4 gap-y-1 text-sm`; compact `grid-cols-[7rem_minmax(0,1fr)]`; wide `grid-cols-[10rem_minmax(0,1fr)]`. Each `dt`: `text-xs leading-5 text-[var(--color-muted-foreground)]`. Each `dd`: `min-w-0 text-sm leading-5`; mono adds `truncate font-mono text-xs tabular-nums`. No internal border/padding: compose inside SectionCard when enclosure is needed.

### B7. `Field` and `Input` (new)

The repeated forms in Apps deploy, Apps index, Cloud panels, Machine panels, and bootstrap warrant primitives.

```ts
export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  htmlFor: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  optional?: boolean;
  children: React.ReactNode;
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  invalid?: boolean;
}
```

Field root `space-y-1`; label `block text-xs font-medium leading-4`; optional suffix `font-normal text-[var(--color-muted-foreground)]`; hint `text-xs leading-4 text-[var(--color-muted-foreground)]`; error `text-xs leading-4 text-[var(--color-destructive-foreground)]` with `role="alert"`. Error replaces hint while present. Input base: `h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 text-sm text-[var(--color-foreground)] placeholder:text-[var(--color-muted-foreground)] focus-visible:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-50`; mono adds `font-mono text-xs tabular-nums`; invalid adds `border-[var(--color-destructive-border)]` and sets `aria-invalid=true`.

### B8. Existing primitive changes

- `Button`: destructive recipe becomes `border border-[var(--color-destructive-border)] bg-transparent text-[var(--color-destructive-foreground)] hover:bg-[var(--color-destructive-background)]`; all variants keep the existing focus/active/disabled behavior.
- `Toast`: `variant` becomes `success | info | warning | error`; use semantic borders/icons. Success is allowed for completed user actions but its toast must not imply hosting capability in persistent UI. Keep current timing and roles.
- `EmptyState`, `Skeleton`, `CommandSnippet`, `LiveUrl`, `EntityLabel`, and `ConfirmDialog`: retain APIs and geometry. Replace their green/red feedback icons with semantic foreground variables. Dialog surface becomes `surface-overlay`; cluster menu becomes `surface-raised`.
- `FriendlyError`: keep its error classification and recovery API; delegate visual shell to Banner and raw details to compact LogPane.
- `StatusDot`: adopt the API/resolvers in B2. App cards may remain dot-only because adjacent app/environment copy supplies context; its accessible label is still required.

## C. Migration map

Line numbers describe the audited tree and are anchors, not permanent identifiers.

### C1. Message containers — exhaustive (31 source recipes)

| Current file:line                             | Current meaning                       | Replacement                                                                                                                          |
| --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `components/agent-login.tsx:488`              | credential-refresh warning            | `Banner tone="warning"`; supporting text becomes `text-xs`                                                                           |
| `components/cluster-compat-banner.tsx:56`     | incompatible target warning           | `Banner tone="warning"`; preserve component wrapper/API                                                                              |
| `components/friendly-error.tsx:144`           | shared error shell                    | `Banner tone="error"`; details use compact LogPane                                                                                   |
| `components/layout/app-shell.tsx:138`         | expired authentication                | `Banner tone="warning" action={...} onDismiss={...}`                                                                                 |
| `pages/agents/index.tsx:97`                   | no agent signed in                    | neutral `Banner tone="info"`; cyan is not agent/auth branding                                                                        |
| `pages/apps/deploy.tsx:592`                   | selected target unavailable mid-flow  | `Banner tone="warning"`                                                                                                              |
| `pages/apps/deploy.tsx:617`                   | old Sandbox control plane             | `Banner tone="warning"`; vocabulary uses Sandbox/App hosting                                                                         |
| `pages/apps/deploy.tsx:629`                   | target lacks builder                  | `Banner tone="info"` with CommandSnippet child                                                                                       |
| `pages/apps/deploy.tsx:640`                   | preset deploy destination             | `Banner tone="info"`; KeyValueList is unnecessary for one value                                                                      |
| `pages/apps/deploy.tsx:934`                   | hosting setup required                | UX-bound inline `LongOperation` when active; before start use `Banner tone="warning"`, copy “Sandbox … App hosting … Set up hosting” |
| `pages/apps/deploy.tsx:1256`                  | folder/manifest error                 | `Banner tone="error"` or `FriendlyError` when remediation exists                                                                     |
| `pages/apps/deploy.tsx:1263`                  | multi-service CLI handoff             | `Banner tone="info"` with CommandSnippet                                                                                             |
| `pages/apps/deploy.tsx:1484`                  | app deployed/live URL                 | `Banner tone="success"`; use LiveUrl                                                                                                 |
| `pages/bootstrap/progress.tsx:328`            | cloud credential handoff failed       | `Banner tone="error"`                                                                                                                |
| `pages/bootstrap/progress.tsx:688`            | stalled-operation reassurance         | stall slot owned by `LongOperation`; internally use `Banner tone="warning" role="status"`                                            |
| `pages/deployments/detail.tsx:70`             | load failure                          | `FriendlyError` / Banner error shell                                                                                                 |
| `pages/deployments/detail.tsx:101`            | successful live deployment link       | `Banner tone="success"`; use LiveUrl; remove hover-fill color                                                                        |
| `pages/deployments/list.tsx:55`               | list load failure                     | `FriendlyError` / Banner error shell                                                                                                 |
| `pages/environments/detail.tsx:151`           | environment load failure              | `FriendlyError` / Banner error shell                                                                                                 |
| `pages/environments/detail.tsx:211`           | deployment load failure               | `FriendlyError` / Banner error shell                                                                                                 |
| `pages/invite.tsx:127`                        | invite failure                        | `Banner tone="error"`                                                                                                                |
| `pages/local-runtime/terminal-drawer.tsx:138` | terminal error strip                  | borderless placement of `Banner tone="error"`; override only `rounded-none border-x-0 border-t-0`                                    |
| `pages/machine/credentials-panel.tsx:82`      | certificate restart warning           | `Banner tone="warning"`; supporting role, minimum `text-xs`                                                                          |
| `pages/machine/egress-panel.tsx:137`          | enforced/cooperative security posture | `Banner tone={enforced ? 'info' : 'warning'}`; green is not hosting readiness                                                        |
| `pages/machine/egress-panel.tsx:218`          | proxy diagnostic address              | `Banner tone="info"`; machine string stays mono                                                                                      |
| `pages/machine/runtime-detail.tsx:337`        | engine unavailable                    | `Banner tone="warning"`                                                                                                              |
| `pages/machine/runtime-detail.tsx:426`        | “Core sandbox ready” card             | delete; its content becomes permanent two-row capability ledger; Sandbox row cyan, App hosting row neutral/green per UX spec         |
| `pages/projects/detail.tsx:115`               | app load failure                      | `FriendlyError` / Banner error shell                                                                                                 |
| `pages/projects/detail.tsx:150`               | environment load failure              | `FriendlyError` / Banner error shell                                                                                                 |
| `pages/setup/doctor.tsx:139`                  | all checks ready                      | neutral SectionCard plus inline neutral completion text; do not use green because this is not app-hosting readiness                  |
| `pages/setup/doctor.tsx:151`                  | checks need attention                 | `Banner tone="warning"` around remediation actions                                                                                   |

The conditional check cards at `setup/doctor.tsx:252`, destructive form at `cloud/panels.tsx:968`, and policy/action chips in `machine/egress-panel.tsx` are deliberately excluded: migrate them to SectionCard, status text, Tag, or Button as appropriate, not Banner.

### C2. Status pills and dots — exhaustive (seven source implementations)

| Current file:line                            | Current states                | Replacement mapping                                                                                                                                                                                |
| -------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/ui/status-dot.tsx:5`             | deploy/environment string map | keep component, replace raw map with canonical resolver: in-progress→info/pulse; succeeded/deployed→success; destroying→warning/pulse; failed→error; pending/destroyed/unknown→neutral             |
| `pages/machine/runtime-detail.tsx:232`       | Machine lifecycle pill        | `StatusPill`; starting→info/spin, failed→error, stopped/not-created→neutral, running→neutral. Delete “core ready”; capability is expressed by the ledger                                           |
| `pages/apps/deploy.tsx:1111`                 | TargetRow plain `stateLabel`  | `StatusPill`: Sandbox ready→sandbox, hosting On/cloud ready→success, starting→info/spin, failed→error, stopped/not-created/hosting-not-set-up→neutral or warning when it blocks the current deploy |
| `pages/apps/deploy.tsx:1540`                 | deploy run StatusBadge        | delete local component; idle→neutral, running→info/spin, succeeded→success, failed→error                                                                                                           |
| `pages/agents/index.tsx:458`                 | agent RunStatusBadge          | delete local component; running→info/pulse, error→error, done/exited→neutral. Running agent is not green                                                                                           |
| `pages/local-runtime/terminal-drawer.tsx:29` | terminal StatusPill           | delete local component; open/Live→info/pulse, connecting→info/spin, error→error, closed→neutral                                                                                                    |
| `pages/environments/workloads-panel.tsx:341` | pod-log phase pill            | `StatusPill`: live→info/pulse, connecting→info/spin, error→error, ended→neutral                                                                                                                    |

Also route terminal-tab dots through the same resolver used by the terminal StatusPill (`components/layout/terminal-tab-bar.tsx:27` and `providers/terminal-sessions-provider.tsx:41`). Bootstrap ladder states remain part of `LongOperation`, not free-standing pills. The agent type chip at `agents/index.tsx:437`, Sandbox identity chips at `runtime-detail.tsx:264` and `cluster-switcher.tsx:24`, and `default` chips become `Tag`.

### C3. Log panes — exhaustive (12 source locations)

| Current file:line                            | Context                                                 | Replacement/configuration                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `components/friendly-error.tsx:158`          | raw error details                                       | `LogPane height="compact" label="Technical details" defaultOpen={false}`; no live region                                               |
| `components/start-machine-recovery.tsx:158`  | Sandbox start recovery                                  | `LongOperation` for work; its `LogPane height="compact"`                                                                               |
| `pages/apps/deploy.tsx:948`                  | inline Set up hosting output                            | UX-bound `LongOperation timeClass="minutes"`; LogPane compact, closed healthy/open failed                                              |
| `pages/apps/deploy.tsx:1444`                 | build/deploy output                                     | `LongOperation timeClass="minutes"`; LogPane default height, `defaultOpen`, preserve tail-autoscroll                                   |
| `pages/bootstrap/progress.tsx:269`           | AWS event log                                           | `LongOperation timeClass="long"`; LogPane default, closed healthy/open failed, keep-page safety                                        |
| `pages/bootstrap/progress.tsx:709`           | first-run Sandbox bring-up log                          | existing ladder migrates to LongOperation; LogPane default, controlled open, preserve stall click and tail-autoscroll                  |
| `pages/cloud/panels.tsx:365`                 | baseline update                                         | `LongOperation` composed with compact LogPane; generic success/failure is info/error, not green                                        |
| `pages/cloud/panels.tsx:638`                 | API server update                                       | same compact LogPane composition                                                                                                       |
| `pages/cloud/panels.tsx:853`                 | state migration (component renders for both directions) | same compact LogPane composition                                                                                                       |
| `pages/cloud/panels.tsx:1036`                | cloud destroy output                                    | `LongOperation` within danger SectionCard; compact LogPane; error lines destructive                                                    |
| `pages/environments/workloads-panel.tsx:377` | pod logs                                                | standalone `LogPane height="fill" defaultOpen copyText={text}`; modal owns header, no second disclosure header if `open` is fixed true |
| `pages/machine/runtime-detail.tsx:465`       | Set up hosting output                                   | UX-bound inline `LongOperation timeClass="minutes"`; compact LogPane, closed healthy/open failed                                       |

`cloud/panels.tsx:793`, `settings.tsx:165`, `settings-team.tsx:140`, and `setup/doctor.tsx:297` are single code/value displays, not logs; migrate their background to neutral surface tokens or CommandSnippet as appropriate. Modal scrims at terminal/workload drawers keep a black alpha overlay and are not LogPane migrations.

### C4. Section/card, key-value, and form consolidation

| Current file:line                                           | Replace with                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pages/apps/deploy.tsx:881`, `1206`, `1336`, `1438`         | SectionCard; RunStep body becomes LongOperation                                                   |
| `pages/apps/deploy.tsx:981`, `1273`                         | KeyValueList inside SectionCard                                                                   |
| `pages/apps/deploy.tsx:992`, `1562`, `1572`                 | Field + Input; delete local Field/TextInput/Row                                                   |
| `pages/apps/index.tsx:175`, `198`                           | Input and SectionCard/Field; keep EmptyState for no apps                                          |
| `pages/machine/runtime-detail.tsx:610`                      | KeyValueList; capability header becomes dedicated ledger composition, not a generic card          |
| `pages/bootstrap/progress.tsx:294`, `745`                   | SectionCard + KeyValueList for terminal result; LongOperation owns operation success presentation |
| `pages/cloud/panels.tsx:83`, `284`, `380–651`, `785`, `968` | SectionCard; danger only for destroy; Field/Input for all profile/version/confirmation controls   |
| `components/ui/confirm-dialog.tsx:77`                       | retain dialog, switch background to surface-overlay                                               |
| `components/layout/cluster-switcher.tsx:114`                | retain menu, switch background to surface-raised                                                  |

### C5. Micro-type — representative migrations

| Current file:line                                                    | Current role                   | Replacement                                                                                             |
| -------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `components/layout/terminal-tab-bar.tsx:263`                         | overline                       | `text-micro ... tracking-[0.08em]`                                                                      |
| `pages/apps/deploy.tsx:1009`, `1062`, `1352`, `1389`, `1475`, `1567` | hints/error metadata           | `text-xs leading-4`; mono only around machine strings                                                   |
| `pages/apps/deploy.tsx:1026`, `1235`                                 | dense selectable token         | `text-micro`, or Input/Tag where applicable                                                             |
| `pages/apps/deploy.tsx:1224`                                         | overline                       | `text-micro` overline role                                                                              |
| `pages/machine/runtime-detail.tsx:621`                               | fact labels/values             | KeyValueList (`text-xs` labels, `text-sm` values)                                                       |
| `pages/machine/credentials-panel.tsx:69–186`                         | hints, protocol metadata, tags | hints→`text-xs`; dense protocol/tag rows→`text-micro`; machine strings mono                             |
| `pages/machine/egress-panel.tsx:309–608`                             | dense traffic telemetry        | group headings/timestamps/actions→`text-micro`; prose/empty states→`text-xs`; counts/times mono+tabular |
| `pages/agents/index.tsx:144`, `259`, `437`                           | compact pickers/tag            | controls use `text-xs`; agent tag uses Tag `text-micro`                                                 |
| `pages/agents/launch-agent-button.tsx:189`, `317`, `333`, `355`      | note/hints                     | `text-xs leading-4`                                                                                     |
| `pages/bootstrap/wizard.tsx:211`, `272`, `491`                       | disabled reason/tag/hint       | reason+hint→`text-xs`; tag→Tag `text-micro`                                                             |
| `pages/setup/doctor.tsx:273–315`                                     | diagnostics and command        | errors/hints→`text-xs`; command→CommandSnippet/code role                                                |

Acceptance grep after migration: `rg "text-\[10px\]|text-\[11px\]" packages/app/src` returns zero. `text-micro` may occur only in Tag, StatusPill, overlines, and genuinely dense telemetry rows.

## D. Deletions and enforcement

Delete these patterns after all call sites migrate:

1. Raw status hue utilities in page/component markup: `amber-*`, `yellow-*`, `cyan-*`, `green-*`, `emerald-*`, `red-*`, and `violet-*`. Semantic component files may reference only the custom properties above. Brand illustrations are out of scope; there are none in the audited primitives.
2. Opacity-built message recipes such as `border-*-500/40 bg-*-500/5 text-*-200`, including their `/10`, `/15`, `/30`, and `/50` variants.
3. Page-local `StatusBadge`, `RunStatusBadge`, `StatusPill`, state-tone maps, and duplicated pulsing-dot markup. Keep named domain resolvers and the two shared renderers only.
4. The overloaded Machine `core ready`/`running` green pill and the transient “Core sandbox ready” card. Replace with lifecycle pill plus the permanent Sandbox/App hosting ledger.
5. User-facing “core”, “core ready”, “deployment layer”, “cluster provisioning”, “provision”, and upgrade verbs other than **Set up hosting**, except inside Technical details.
6. Raw operational `<pre>` blocks and `bg-black/20|30|40` log containers. Single inline `<code>` remains valid; modal scrims are exempt.
7. `text-[10px]` and `text-[11px]`; use named roles. Do not replace them mechanically with `text-xs` without applying the role table.
8. Green for machine-alive, shell-live, agent-running/signed-in, generic check completion, selected control, or security-policy state. Green persists only for App hosting/cloud/deploy readiness and deployed-app success.
9. Cyan for generic info, progress, selected controls, agent branding, capture/inject categories, and cloud metadata. Cyan persists only for Sandbox capability.
10. Hand-built input classes and local `Field`, `TextInput`, and `Row` helpers once shared Field/Input/KeyValueList are adopted.

Add a CI lint script (implementation follow-up, not part of this document change) that fails on raw status hue utilities under `packages/app/src/pages` and `packages/app/src/components`, except an explicit allowlist for temporary migration files. Remove the allowlist at completion. Required visual/accessibility checks: keyboard focus on every dismiss/disclosure/copy control; status has visible text or accessible label; Banner error uses `role=alert`; no nested interactive control; all semantic text/background pairs retain at least 4.5:1; and both controlled and uncontrolled LogPane disclosure modes are tested.
