# Appliance repository decisions

## Fluid Functionalism

GLA-271 decision, 2026-10-26: adopt [Fluid Functionalism](https://www.fluidfunctionalism.com)
as the motion/interaction doctrine layered on DS v2. This spike changes registry
wiring and compatibility policy only; **no visual change**. Font, token, and hover
migrations below are owner rulings for follow-up implementation, not shipped here.

### Registry and ownership

- Install lane: `packages/ui` (`@appliance.sh/ui`), consumed by `packages/app`.
  App `src/components/ui/*` remain re-export shims.
- Flavor: **radix**, using bare `@fluid/<name>` names, never `base/` names or
  `@base-ui`. Existing Radix dependencies are authoritative.
- `packages/ui/components.json` maps both components and ui to `src/components`,
  lib to `src/lib`, hooks to the existing `src/hooks`, and Tailwind v4 CSS to
  `src/theme.css`. No `tailwind.config` is needed. Its aliases resolve through
  `@/* -> ./src/*` in the UI tsconfig.
- Registry: `"@fluid": "https://www.fluidfunctionalism.com/r/{name}.json"`.
  From `packages/ui`, run `npx --yes shadcn@latest add @fluid/springs --yes`.
  The spike actually ran this command: one file landed at `src/lib/springs.ts`;
  no package or lockfile change, no primitive installation. It is not wired into
  production components or exported as a new feature.
- Never use `--overwrite`: every existing DS v2 component and test is locally
  authored. Inspect registry files and dependencies before each install.
- Preserve upstream files for `upgrade.mjs` comparisons. Springs is excluded from
  Prettier. The CLI dropped its leading 11 comment lines: the upstream checker
  reported `DIFFERS (-0 +11)`. Restoring the registry's exact `files[0].content`
  mechanically (JSON parse + file write, no code edits) made it report
  `CURRENT springs src/lib/springs.ts`. Check future installs for this CLI issue;
  a pristine policy alone cannot guarantee a buggy CLI preserves upstream text.

### LazyMotion: two options evaluated

**Choose (a): remove `strict`, keep asynchronous features and existing `m.*`.**
`MotionConfig reducedMotion="user"` and readiness behavior remain intact. FF's
`motion.*` can coexist with our `m.*` without strict-mode runtime exceptions.
Installed FF files retain upstream source, making upgrades reviewable without a
local Motion transform. Removing strict is a compatibility allowance, not an
instruction to replace existing `m.*` or eagerly load features.

**Reject (b): keep strict and generate an install-time `motion.* -> m.*` codemod.**
This can enforce lazy feature usage but requires a committed, reproducible
transform covering imports, aliases, component factories, and future upstream
syntax, plus upgrade-time regeneration and tests. Transformed files differ from
upstream and lose straightforward `CURRENT` results. It also requires validating
FF behavior before asynchronous features become ready. No handwritten conversion
or unused codemod is shipped because this option is not selected.

Bundle measurement on the same worktree and dependency lockfile, Vite 6.4.2:
build UI before app for each provider variant; compare all `packages/app/dist/*.js`
(exclude source maps), summing file bytes and Node `gzipSync` bytes per chunk.

| App library output         |    Strict | Non-strict | Delta |
| -------------------------- | --------: | ---------: | ----: |
| All JS, bytes              | 1,813,749 |  1,813,737 |   -12 |
| All JS, gzip bytes         |   441,540 |    441,535 |    -5 |
| Lazy features chunk, bytes |    58,356 |     58,356 |     0 |

Commands: `pnpm exec nx run @appliance.sh/app:build --skip-nx-cache` for the
baseline (builds dependencies), then `pnpm --filter @appliance.sh/ui run build`
and `pnpm --filter @appliance.sh/app run build` after removing strict. Gzip numbers
include chunk-hash/build-time noise. There is no meaningful cost from removing
the flag itself. **This is not a zero-cost claim for future FF components:**
importing full `motion` can put features into the eager graph and reduce lazy
splitting. Measure each adoption's consumer bundle. Springs has no Motion import.

### Mechanical compatibility guard

`packages/ui/src/components/fluid-policy.test.ts` reads every non-test JS/TS source
under UI, including all future FF installs, and rejects Motion's full `motion.*`
usage while the provider has `strict`. TypeScript parsing distinguishes imports,
aliases, comments, and unrelated objects; scanner coverage is intentionally broader
than a registry filename list. The existing design-system test still checks
reduced motion, the provider location, and asynchronous feature loading.

Red/green demonstration: temporarily create `src/lib/fluid-policy-probe.tsx` with
`import { motion } from 'motion/react'; export const Probe = () => <motion.div />;`.
With `<LazyMotion strict features={loadFeatures}>`, the scan failed and named
`lib/fluid-policy-probe.tsx` (31 passed, 1 failed in the full UI suite). Removing
strict with the same probe passed both guard tests. Remove the probe afterward.
Run `pnpm --filter @appliance.sh/ui exec vitest run src/components/fluid-policy.test.ts`
to repeat; temporarily restore strict to reproduce red. Final acceptance is
`pnpm verify` in the foreground, including builds before consumer typechecks.

### DS v2 constraints and owner rulings (2026-10-26)

- **Dark-only** (DS v2 rule 4). Deliberately ignore FF light-mode guidance.
- Interaction colors must be **named tokens** (DS v2 §A1), never `/5`, `/10`,
  `/15` opacity recipes. Hover must use a named hover token, never `--color-accent`.
- **Inter Variable with `opsz` replaces Geist sans.** This spike records the
  ruling; it does not change the current font assets or typography.
- Retime motion tokens to FF spring tiers: **fast 0.08s, moderate 0.16s, slow
  0.24s**, with named exits **0.06s / 0.12s / 0.16s** respectively. Future migration
  must reconcile existing DS v2 generated tokens rather than add ad hoc durations.
- **Fluid hover everywhere, including the sidebar.** Preserve reduced-motion
  behavior and named interaction tokens during adoption.

Proposed review gate: **code (Quinn)**, because the provider compatibility change
is non-trivial. Environment/configuration: none beyond repository registry wiring.

### GLA-281 overlay continuity (2026-10-27)

- Dialog/confirm content uses the **base** spring (160ms, bounce 0) and named
  base exit (120ms); the scrim keeps fast (80ms / 60ms). Tooltip, dropdown and
  popover use fast (80ms / 60ms). JS presence owns unmount, Radix owns interaction.
  This replaces CSS state-keyed animations whose interrupted exits restart at
  opacity 1. No hover motion is introduced; menu hover-glide remains deferred.
- Base wraps moderate, already consumed by toast. Dialog-on-base deliberately
  avoids introducing slow's bounce character. **Slow has no current consumer**;
  its first consumer requires a design pass. Registry springs remain pristine.
- Terminal and pod-log drawers deliberately remain still (0ms enter/exit).
  Their view lifecycle immediately detaches/reattaches xterm or aborts log
  streaming and restores focus. Deferring unmount for a decorative exit would
  retain those live effects and custom keyboard handlers after dismissal.
  A future animated drawer should separate presentation lifetime from session,
  stream and focus lifetime first; this task preserves immediate dismissal.
