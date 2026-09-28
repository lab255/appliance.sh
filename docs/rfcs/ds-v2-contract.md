# RFC: Design system v2 contract

- **Status:** Proposed decision; extraction and adoption follow in separate PRs
- **Created:** 2026-09-28
- **Owner:** Avery; manager Morgan
- **Scope:** Package boundary, dual consumers, motion, distribution, and build contract

## Summary

Extract the 19 UI primitives into `packages/ui`, published as `@appliance.sh/ui`.
Keep app imports stable through forwarding modules. Ship ESM with per-file
client boundaries, compiled CSS and standalone tokens, and use `motion` with
`LazyMotion`. Join the existing fixed Nx release train. Prove the published
artifact in appliance-internal's `www.appliance.cloud` placeholder before
migrating its other Next apps. This spike changes documentation only.

[Design-system foundations](../design-system-spec.md), especially A1–A4, remain
the source of truth for colors, tone taxonomy, contrast, and type roles. This
RFC changes their implementation location, not their meaning, and does not
repeat their token values. [UX journeys](../ux-journey-spec.md), Q4 and P2 item
11, govern LongOperation behavior and the ledger success-flip.

## Verified baseline

Inventory is against `origin/main` at `bd7a195c4939431b5e10ab89b062314121d58257`.
Paths below are repository-relative; line numbers are discovery anchors.

- `packages/app` has 19 primitive modules plus `design-system.test.tsx`.
  `LogPane` also imports the app's host-independent `useTailAutoscroll` hook.
- The app builds with Vite library mode and Tailwind v4's Vite plugin. Its
  dependencies include CVA, clsx, tailwind-merge 2.x, Radix Slot only,
  lucide-react 0.468.x, and both Geist fontsource packages. There is no Motion
  dependency yet. Do not assume a full Radix component suite is installed.
- Desktop and console both import `@appliance.sh/app/styles.css` from their
  `src/main.tsx`. Fonts currently enter through `packages/app/src/App.tsx`.
- Read-only inspection of `~/Workspaces/appliance-internal` confirms three
  Next apps with handwritten `app/styles.css`, Turbo orchestration, and no
  Tailwind or `@appliance.sh/*` entries in the lockfile. The target compatibility
  baseline is Next 15.5.24 / React 19.2.8; manifests use broader 15.x / 19.x
  ranges. The cloud placeholder currently uses Arial and a light page.
- `nx.json` uses `projectsRelationship: fixed`, conventional commits, and
  `v{version}` tags. `.github/workflows/release.yml` runs under the `release`
  environment with `id-token: write`, public npm access, and provenance.

## 1. Package boundary and exact moves

Each row moves the implementation from
`packages/app/src/components/ui/<file>` to
`packages/ui/src/components/<file>`. Leave an explicit named value/type
re-export at the old path, forwarding to the corresponding public package
subpath. The last column is the extraction's per-file `'use client'` policy.

| File                  | Public subpath after `@appliance.sh/ui/` | Client directive                   |
| --------------------- | ---------------------------------------- | ---------------------------------- |
| `banner.tsx`          | `banner`                                 | Yes: dismissal; later animation    |
| `button.tsx`          | `button`                                 | Yes: ref/Slot interaction boundary |
| `command-snippet.tsx` | `command-snippet`                        | Yes: clipboard and state           |
| `confirm-dialog.tsx`  | `confirm-dialog`                         | Yes: context, focus, events        |
| `empty-state.tsx`     | `empty-state`                            | No                                 |
| `entity-label.tsx`    | `entity-label`                           | No                                 |
| `field.tsx`           | `field`                                  | No                                 |
| `input.tsx`           | `input`                                  | Yes: interactive/ref boundary      |
| `key-value-list.tsx`  | `key-value-list`                         | No                                 |
| `live-url.tsx`        | `live-url`                               | Yes: clipboard and state           |
| `log-pane.tsx`        | `log-pane`                               | Yes: disclosure and scrolling      |
| `long-operation.tsx`  | `long-operation`                         | Yes: timer and state               |
| `page-shell.tsx`      | `page-shell`                             | No; includes `PageHeader`          |
| `section-card.tsx`    | `section-card`                           | No                                 |
| `skeleton.tsx`        | `skeleton`                               | No; includes `ListSkeleton`        |
| `status-dot.tsx`      | `status-dot`                             | No; CSS activity only              |
| `status-pill.tsx`     | `status-pill`                            | No; CSS activity only              |
| `tag.tsx`             | `tag`                                    | No                                 |
| `toast.tsx`           | `toast`                                  | Yes: provider, timers, events      |

Supporting moves and generated assets:

| Source                                                                         | Destination / treatment                                                                                                                                     |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/lib/utils.ts`                                                | `packages/ui/src/lib/utils.ts`; export `cn` through `/utils` and root; retain app shim and existing micro-type merge behavior                               |
| `packages/app/src/hooks/use-tail-autoscroll.ts`                                | `packages/ui/src/hooks/use-tail-autoscroll.ts`, with client directive; expose `/use-tail-autoscroll` for the app compatibility shim                         |
| `packages/app/src/components/ui/design-system.test.tsx`                        | `packages/ui/src/components/design-system.test.tsx`; adjust imports, exclude from published output                                                          |
| `packages/app/src/styles.css` `@theme` block (6–53)                            | `packages/ui/src/theme.css`, using `@theme static`; token values remain governed by foundations A1–A4                                                       |
| Same file, interaction/type `@layer base` (begins 76; extends beyond 89 today) | `packages/ui/src/base.css`; move the entire block, including heading tracking and mono figures                                                              |
| Same file, body typography/colors and scrollbar base block                     | `packages/ui/src/base.css`; preserve dark-first baseline; leave root-height layout app-local                                                                |
| `packages/app/src/App.tsx` Geist and Geist Mono CSS imports                    | `packages/ui/src/styles.css` CSS imports; move both fontsource dependencies and emit font assets with local URLs                                            |
| New CSS build entry                                                            | `packages/ui/src/styles.css` composes theme, fonts, base, reset, primitive utilities, and reduced-motion rules; emits `dist/styles.css`                     |
| Generated tokens-only entry                                                    | `packages/ui/dist/tokens.css`: plain CSS custom properties generated from `src/theme.css`; no reset, font loading, utility classes, or global element rules |

The kit cannot import SDK, router, host adapters, app aliases, xterm, or app
providers. Replace its `@/` imports with package-relative imports. Domain state
resolvers, operation plans, duration estimates, transport and polling stay with
the consumer; LongOperation accepts data and render slots. Toast and confirm
providers move because they are UI-only.

**Stay app-local:** all `components/layout/*` (app-shell, switchers, terminal
dock), all pages and routes, host-coupled providers, `lib/host`, polyfills,
`html/body/#root` height rules, terminal behavior and
`@xterm/xterm/css/xterm.css` in `terminal-sessions-provider.tsx`. `PageShell`
moves because it is a width/layout primitive, not the app shell.

Add `@appliance.sh/ui: workspace:*` to app. Preserve existing named exports,
props and types through the forwarding modules; no bulk page-import rewrite
in extraction. Keep `@appliance.sh/app/styles.css` as the shell compatibility
entry, composing built UI CSS and app-only CSS exactly once. Desktop/console
entry imports remain unchanged. New consumers import UI directly; app's root
export stays the application API, not a second public UI barrel. Retain shims
through initial adoption; removing them is a separate migration PR.

Move CVA, clsx, tailwind-merge, Slot and fonts to UI ownership. Keep any dependency
also directly imported by app (notably lucide-react) declared there too. Preserve
current versions for parity; evaluate tailwind-merge's v4-compatible major in a
separate compatibility change with class-conflict tests.

## 2. Dual-consumer and CSS contract

React and React DOM are external peer dependencies `^19.0.0`, with matching
local development dependencies. No React copy, router, Next runtime or
framework provider is bundled. Browser APIs run in effects or event handlers,
never at module evaluation. Server renders must be deterministic: stabilize
LongOperation's initial elapsed display and start its live clock after hydration.

Put `'use client'` first in each marked implementation file, never as a banner
on the entire library or its root barrel. Hook/provider and future motion files
also carry it. Static primitives and `cn` remain server-compatible. Export named
symbols from a directive-free root and explicit per-component subpaths. A Next
Server Component may render a client primitive with serializable props; event
handlers and function-valued icon props belong in a client wrapper. Do not
mark the whole Next root layout client just to mount UI providers.

| Export                                             | Consumer contract                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `@appliance.sh/ui` and explicit component subpaths | ESM JS plus corresponding declarations; importing JS does not silently import CSS                                                             |
| `@appliance.sh/ui/styles.css`                      | One built stylesheet: emitted token variables, fonts, base/reset, all kit class recipes and motion fallbacks; usable without running Tailwind |
| `@appliance.sh/ui/tokens.css`                      | Standalone browser-readable variables for handwritten CSS consumers; no Tailwind requirement and no component styling                         |
| `@appliance.sh/ui/theme.css`                       | Additional build-time source export with `@theme static`, for consumers generating their own semantic Tailwind utilities                      |

Compile CSS at package build time with explicit source detection limited to UI
sources (including every CVA variant); do not depend on consumers scanning
`node_modules`. Emit all declared tokens even when no primitive references them.
Raw `@theme` is a Tailwind build instruction, so it must not be the only contents
of the browser-facing `tokens.css`. The `static` option retains otherwise unused
variables. [Tailwind theme documentation](https://tailwindcss.com/docs/theme)
describes this distinction.

**Decision: internal apps adopting the full kit add Tailwind v4** using
`@tailwindcss/postcss` and PostCSS in each Next build, following the
[Next integration guide](https://tailwindcss.com/docs/installation/framework-guides/nextjs).
This is the standard adoption path for page composition, not a runtime
prerequisite of compiled kit CSS or tokens-only use. Keep Turbo; Nx does not
cross the package boundary. No Next `transpilePackages` should be needed for
published ESM; verify with the packed artifact.

Import `styles.css` once from the Next root layout, before page styles. Consumer
Tailwind input imports `tailwindcss/theme.css`, then UI `theme.css`, then
`tailwindcss/utilities.css`, with its own source paths. Omit consumer Preflight:
UI's built sheet owns the single reset. Use layer order
`theme, base, components, utilities`; put intentional application overrides
after the kit. Do not import tokens-only CSS as well as the full sheet. The Vite
app uses the same theme/utility split with its existing Vite plugin and explicit
app source paths. Do not retain a second full `@import 'tailwindcss'` that emits
duplicate reset/base rules. Tailwind supports separate imports and explicit
sources in its [Preflight](https://tailwindcss.com/docs/preflight) and
[source detection](https://tailwindcss.com/docs/detecting-classes-in-source-files)
documentation.

Class names supplied by consumers require their own Tailwind build or handwritten
CSS; the kit guarantees only its own class recipes. Token-only adopters use
`var(--color-…)` directly. Fonts are self-hosted in the full sheet, with no network
font service; tokens-only adopters choose whether to load Geist. The initial
cloud adoption deliberately changes its light/Arial placeholder to the shared
dark/Geist baseline; other pages must review global reset/typography effects.

## 3. Motion contract

**Decision: use the `motion` package**, not a separate `framer-motion` dependency.
Declare it as a compatible-major peer (and dev dependency) when implemented;
consumers install one tested version. Export a client `MotionProvider` from
`/motion-provider`, used once around the app's interactive subtree. It nests
`MotionConfig reducedMotion="user"` and `LazyMotion strict`, with an async feature
loader importing a separate module that exports `domAnimation`. Use
`import * as m from 'motion/react-m'` and `m.div` etc.; forbid plain `motion.*`
imports in UI and its adopted flows. Keep `AnimatePresence` at the owner of
mount/unmount state. No `domMax`, drag, or layout projection by default. This
uses Motion's documented [lazy feature loading](https://motion.dev/docs/react-lazy-motion);
measure actual consumer bundles rather than promising a fixed byte saving.

Add these new tokens to the package `@theme static` source. Existing color/type
values remain in foundations A1–A4. Generate the JS transition constants from
these values at build time: CSS uses milliseconds, Motion uses seconds and
numeric cubic-bezier tuples. Do not parse computed browser styles during SSR.
Use `duration-(--duration-fast)` (or explicit variable CSS), not an assumed
Tailwind `duration-fast` namespace mapping.

| Token              | Value                           | Role                                         |
| ------------------ | ------------------------------- | -------------------------------------------- |
| `--duration-fast`  | `120ms`                         | Dismissal, hover, short fades                |
| `--duration-base`  | `200ms`                         | Dialog/banner/toast entry, content swap      |
| `--duration-slow`  | `320ms`                         | Wizard transition and ledger acknowledgement |
| `--ease-out-quart` | `cubic-bezier(0.25, 1, 0.5, 1)` | Entry and settling                           |
| `--ease-in-out`    | `cubic-bezier(0.4, 0, 0.2, 1)`  | Content replacement                          |

| Surface                        | Normal motion                                                                                           | Reduced-motion result                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Toast                          | Base fade and ≤8px entry; fast exit                                                                     | Immediate show/dismiss; announcement retained                |
| Confirm dialog                 | Base opacity and 0.98→1 scale; fast scrim fade                                                          | Immediate dialog/scrim; focus trapping/restoration unchanged |
| Banner                         | Base opacity and ≤4px entry; fast dismissal                                                             | Immediate state; alert/status semantics retained             |
| Skeleton → content             | Base crossfade in a new client swap wrapper; keep static Skeleton server-compatible                     | Immediate content; disable CSS pulse                         |
| Wizard steps                   | Slow crossfade and ≤12px directional offset; page owns navigation and focus                             | Immediate step with heading focus; no delayed advance        |
| Capability ledger success-flip | One slow status replacement when hosting actually changes to On; subtle opacity/≤4px offset, no 3D spin | Immediate final label/icon/tone plus existing announcement   |

Wizard orchestration and ledger state remain app-local; reusable transition
wrappers can live in UI. Never animate log lines, elapsed seconds, polling
refreshes or every rerender. LongOperation's seconds/minutes/long classes and
30s/90s/180s stall thresholds remain the UX contract, not animation durations.
Success is driven by observed engine state; animation completion never triggers
business logic, retry, navigation, or the declaration of readiness. Reserve
success green for the existing semantic meaning.

**Reduced motion is mandatory.** `MotionConfig` disables transform/layout motion
under the user preference but leaves some properties such as opacity animating;
therefore wrappers also use `useReducedMotion` to select immediate transitions
and remove exit waits. See [MotionConfig](https://motion.dev/docs/react-motion-config)
and [useReducedMotion](https://motion.dev/docs/react-use-reduced-motion).
Ship a `prefers-reduced-motion: reduce` media query in built CSS to disable kit
pulse/spin/ping, smooth scrolling, button translation and decorative transitions,
including pseudo-elements. Scope rules to kit roots/activity classes so they do
not disable unrelated consumer animations. Loading labels and static indicators
remain visible. Initial SSR/no-JS output must be readable (`initial={false}` for
initial content); delayed feature loading cannot leave content transparent or
block an action. Respond to preference changes during the session. Dialog focus,
Escape, inert background, and announcement behavior are acceptance requirements
independent of animation.

## 4. npm distribution and upgrades

Publish public `@appliance.sh/ui` from `lab255/appliance.sh` with repository
metadata and provenance, through the existing `release.yml` trusted-publisher
OIDC flow and protected `release` environment. **First publish is owner-gated:**
the npm scope owner bootstraps the package and configures its trusted publisher
for owner `lab255`, repository `appliance.sh`, workflow `release.yml`, environment
`release`. Verify that package-specific configuration before enabling unattended
subsequent releases. This spike performs no publish or credential changes. The
[npm trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/)
describes the repository/workflow identity and supported runner/CLI requirements;
check the release runner against those requirements during enablement.

**Ride the fixed Nx train**, starting at that train's release version rather
than an independent UI 0.x or 2.x number. “DS v2” names the design initiative,
not npm's major. Keep UI in the existing `@appliance.sh/*` release project set;
add build-before-publish wiring and public `publishConfig`. Breaking UI export,
prop or token changes require a breaking conventional commit and coordinated
train major; additive APIs are minor, fixes patch. This docs-only spike does
not itself request a release bump.

In appliance-internal, pin an exact published version in each adopting app and
commit its lockfile. Use Renovate-style grouped bump PRs across the three apps,
including changelog review, builds/typechecks/tests, and visual/a11y/reduced-motion
smokes. Automatic merging is off initially. Roll back by reverting the bump and
lockfile; never edit a published version. No git dependency, copied source,
workspace link across repositories or dependency on the private app package.

## 5. Nx and build tooling

Use Vite library mode, consistent with app, plus `tsc --emitDeclarationOnly`.
Create the package's `build`, `typecheck`, `test`, and `clean` scripts as Nx-inferred
targets; retain the workspace `^build` dependency and `dist` caching rules. Ensure
app's workspace dependency places UI before app, console and desktop.

- ESM only (`type: module`, `formats: ['es']`); export `.`, the explicit subpaths
  listed above, provider/wrapper subpaths when added, and three CSS entries.
  Each JS export has a `types` target; no `require` condition or public `src/*`.
- Use Rollup `preserveModules: true` and `preserveModulesRoot: 'src'` with
  `rollup-plugin-preserve-directives`. Its
  [upstream documentation](https://github.com/Ephem/rollup-plugin-preserve-directives)
  requires preserved modules; a bundle-wide client banner would erase the
  intended server boundary. Verify final output after minification, which must
  also retain directive prologues. Keep the lazy feature module separate.
- Externalize React/React DOM and all their subpaths, Motion and subpaths, and
  declared runtime dependencies. Avoid embedding dependency modules into the
  preserved-module tree. Mark CSS as side effects (`sideEffects: ['**/*.css']`)
  while retaining JS tree shaking. Export helpers such as `buttonVariants` from
  directive-free utility modules if needed by server code; client exports are
  render boundaries, not functions a Server Component may call.
- Build full CSS with `@tailwindcss/vite`, emit tokens-only CSS from the same
  theme source, copy the build-time theme export, and retain local font assets.
  Publish `dist` plus license/readme only. Package tests and app internals are
  excluded. Check declarations contain no app aliases or private source paths.
- Validate an actual `pnpm pack` tarball in isolated Vite and Next 15 fixtures.
  Check every export, per-file directives, fonts, complete CSS variants,
  server-only primitive usage, interactive hydration, and Motion chunking.
  Report initial and lazy JS sizes versus the pre-motion consumer baseline;
  a static primitive import must not pull Motion/provider code into its client
  bundle. Package artifacts, not workspace resolution, are the acceptance unit.

## Migration plan and PR boundaries

The following sequence maps the brief's epic workstreams to reviewable PRs.
Board sub-issue IDs were not supplied; Morgan attaches the actual IDs rather
than this RFC inventing them. The board remains manager-owned.

| Order / sub-issue workstream              | PR shape and exit criteria                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contract spike                         | This RFC only; local `pnpm verify`; no new package or runtime dependencies                                                                                                                                                                                                            |
| 2. UI extraction / package boundary       | All 19 moves, hook/test/helper moves, explicit shims, CSS/fonts split, package/build/exports, and app workspace dependency together; preserve visible behavior and old shell CSS imports; packed Vite and Next smoke fixtures establish the dual boundary                             |
| 3. Motion foundations / accessibility     | Add Motion peer, lazy provider/features, duration/easing generation, reduced-motion CSS and hooks; measure packed consumer bundles and validate OS preference toggling                                                                                                                |
| 4. Primitive motion                       | Toast, confirm dialog, dismissible banner and skeleton swap; verify keyboard/focus/live regions and reduced motion in both consumers                                                                                                                                                  |
| 5. Journey motion / UX P2 item 11         | App-local wizard transitions and one-shot ledger success-flip; keep Q4 operation timing/leave-safety and observed-state semantics; no SDK logic in UI                                                                                                                                 |
| 6. Distribution enablement                | Release metadata/build wiring, tarball audit, owner first publish and trusted publisher setup; no consumer rollout until a version is available                                                                                                                                       |
| 7. Proving consumer: www.appliance.cloud  | Separate appliance-internal PR: exact npm version, Next PostCSS/Tailwind integration, root CSS/client provider, replace placeholder using PageShell/SectionCard/Button and an interactive motion example; production build, hydration, font/offline, visual and reduced-motion checks |
| 8. Remaining internal adoption / upgrades | www.appliance.sh and account.appliance.sh in separately reviewable migrations; review handwritten CSS conflicts, group future exact-version bumps, remove app shims only after an explicit follow-up                                                                                  |

Do not bundle page redesign, new domain APIs, framework upgrades, or the
Tailwind-merge major upgrade into extraction. Steps 3–5 can be reviewed before
the first owner publish; every published feature still requires packed dual-
consumer validation. Cloud is the proving consumer because its placeholder has
little existing UI coupling, not because it is representative of account auth.

## Open questions with recommended defaults

| Question                                              | Recommended default / owner                                                                                                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact epic sub-issue IDs and implementer assignment?  | Morgan maps the ordered workstreams above before implementation; no architectural decision is blocked                                                                                    |
| Motion package version and durable bundle budget?     | Pin the implementation-time tested stable major in fixtures, use that major peer range, record measured gzip initial/lazy deltas in PR 3, and set a regression budget from that baseline |
| First npm publish timing and responsible owner?       | Existing npm scope/release owner bootstraps after packed dual-consumer checks; keep the protected release environment and do not bypass it                                               |
| Are standalone legacy pages ready for the full reset? | Tokens-only until explicitly migrated; full-kit adopters use one reset and accept dark/Geist defaults, beginning with the cloud placeholder                                              |

## Verification and acceptance

For this spike, run `pnpm verify` locally in the foreground after formatting;
record the actual result in the PR. Future implementation PRs additionally prove
all exports from a tarball, SSR/hydration under Next 15.5.24 / React 19.2.8,
Vite desktop/console parity with unchanged CSS imports, local font URLs,
CSS completeness without a Tailwind consumer, standalone tokens without resets,
keyboard behavior and both reduced-motion states. No board mutation, feature
code, publication, cross-repo edit, or merge is part of this spike.
