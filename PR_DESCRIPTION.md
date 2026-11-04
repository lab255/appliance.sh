## Problem

GLA-304: a running Sandbox shows instructions to start it; target-switcher item text has inconsistent left edges; inactive Setup looks permanently focused.

## Solution

R8 uses the existing sandbox-running state for the helper condition, preserving copy. R9 reserves a consistent icon column and aligns the empty-cloud note and footer with item text. R10 removes Setup's permanent prominence ring, preserving foreground, active/focus/press treatment, WeightLabel, and HoverGlide.

## Before / After

Desktop mock host, dark, 1100×780, fresh browser contexts. Base: origin/main a8cdb21. Captures under `_captures/GLA-304/` are local and deliberately uncommitted. Base built before edits; branch rebuilt after edits; no source swap needed, so branch source remains restored on every path.

| Text left edge (CSS px)           | Before | After |
| --------------------------------- | -----: | ----: |
| Group headers                     |    249 |   249 |
| Core sandbox title/body           |    265 |   273 |
| Hosting/cloud title/body          |    273 |   273 |
| Footer                            |    277 |   273 |
| None paired yet (default fixture) |    249 |   273 |

Measured text bounding boxes `(x, y, width, height)`, in CSS pixels, rounded to two decimals; stale-clusters unless marked default:

| Content                   | Before                 | After                  |
| ------------------------- | ---------------------- | ---------------------- |
| This computer header      | (249, 60, 102.55, 14)  | (249, 60, 102.55, 14)  |
| Core title                | (265, 88, 140.91, 17)  | (273, 88, 140.91, 17)  |
| Core description          | (265, 107, 251.19, 15) | (273, 107, 251.19, 15) |
| Hosting title             | (273, 140, 87.23, 17)  | (273, 140, 87.23, 17)  |
| Cloud title               | (273, 221, 74.08, 17)  | (273, 221, 74.08, 17)  |
| Pair a cloud              | (277, 282, 77.84, 17)  | (273, 282, 77.84, 17)  |
| None paired yet (default) | (249, 220, 90.28, 15)  | (273, 220, 90.28, 15)  |

Inline badges and continuation text within a line are not independent alignment edges. The baseline reproduced four edges in stale-clusters and three in default; the audit's 277 body edge is the footer in this build.

- R8 — Legibility: PASS; running/ready state no longer contradicts the start instruction.
- R9 — Precision: PASS; exactly two text alignment edges (249/273), including the empty note at item indent.
- R10 — Restraint: PASS; inactive Setup loses the persistent outline while Machine retains its active treatment.

Capture pairs: `R8-before.png` / `R8-after.png`; `R9-before.png` / `R9-after.png`; `R10-before.png` / `R10-after.png`; supplemental default-fixture pairs use `before-empty` / `after-empty`. R9 JSON files preserve text bounding boxes.

## Test procedure

New tests render RuntimeDetail for stopped, running core-only, and hosting-ready engine states, and AppShell with Setup inactive/active. Baseline: four failures and one pass; fixed branch: five passes. Full `pnpm verify`: GREEN (Nx cache disabled). Builds: 11 projects; typechecks: 6; design-token, ESLint and Prettier checks passed; TypeScript: 1,431 passed / 1 skipped across 149 files and 10 projects; Rust: 362 passed / 1 ignored, with build and clippy passing for all three crates. The initial run failed VM fixture writes under the filesystem sandbox. The next run hit an unrelated API environment-delete test flake (focused retry: 17/17 passed). The final complete run with fixture access passed; all logs retained with captures.

## Operational notes

Capture runner assertions verify running state, absent helper, absent permanent ring, and item alignment. Vite required restart after rebuilding to discard stale base transforms; final captures use the rebuilt branch. No push. Registry springs and ff-manifest.json untouched; no raw motion imports or new opacity recipes. Deliberately retain existing timing, disabled opacity, helper copy, and navigation weight/glide behavior. Exact doc-07 source was unavailable locally; the five-section structure follows the existing GLA-272 PR description. Self-check: 0 off-token motion durations and 0 opacity-derived color recipes in the three touched production files; 6 existing disabled/mode-choice opacity utilities retained. No motion or async transition change, so input-latency/CLS measurements are not applicable.
