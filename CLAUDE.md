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
- Preserve upstream files byte-pristine for upgrade comparisons against the live
  registry (see the drift-manifest section below). Springs is excluded from
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

`motion.*` under the recorded non-strict provider is legal. Inline synthetic
sources exercise this same checker with a strict provider and require reports for
both direct and aliased Motion imports, independently of production policy.

`packages/ui/ff-manifest.json` records each installed FF file's registry item,
URL, registry date, and SHA-256 of its exact bytes. The drift test checks these
committed hashes without network access; the on-demand live check is fetching the
item's registry URL from the manifest and diffing `files[0].content` (no committed
tooling for this yet). The initial registry date records the spike's upstream comparison.
Sanctioned refresh: **legitimate upstream release → re-install the item via shadcn,
regenerate the manifest hash, note the registry version/date**. Follow the install
precautions above, including the CLI comment-loss check, and keep springs.ts
registry-pristine. Compute the hash from local file bytes with
`shasum -a 256 packages/ui/src/lib/springs.ts` and update that manifest entry;
keep the assertion when upgrading.

Run `pnpm --filter @appliance.sh/ui exec vitest run src/components/fluid-policy.test.ts`
for both checks. Final acceptance is `pnpm verify` in the foreground, including
builds before consumer typechecks.

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

### GLA-277: selection weight without reflow (2026-10-27)

Registry checked: `/r/registry.json` and `/r/font-weight.json`. There is no
standalone ghost-width label item. The nearest helper, `font-weight`, deliberately
pins `opsz` to compensate width, selects at 550, and documents residual shifts
of ±0.4px (semibold) / ±0.7px (bold). Option A: install that helper pristine and
wrap it; this cannot satisfy automatic optical sizing or exact zero reflow.
Option B (recommended and implemented): local `WeightLabel`, ghost reserving 600,
visible `wght` 400 → 600, `opsz` automatic, CSS fast token (80ms), instant reduced
motion. No registry file or manifest change. Sidebar route labels and terminal
titles adopt it; settings has no separate navigation. Button variants stay intact.
