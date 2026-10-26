# GLA-281 overlay motion evidence

Baseline: 42e77d1. Candidate: feat/polish-overlay-motion-language.

Each changed surface class has a before/after full-cycle GIF and an interruption
GIF: dialog, confirm, tooltip, popover, dropdown menu. Dialog/confirm/popover/menu
interruption uses Escape; tooltip uses pointer-away during enter.

Before: CSS DevTools playback 0.1 (10x). After: native playback, screenshot frames
held 800ms for inspection (approximately 10x frame decode, not a timing reference).
Do not compare GIF wall time: screenshots have variable capture latency. The
JSON records native requestAnimationFrame samples, state, computed opacity and
transform, plus the requested dismissal timestamp. Before timing values are
normalized by ten in measured-times.csv. Opacity >= .999 defines observed enter;
exit measures first closed frame to first unmounted frame. Frame scheduling and
presence cleanup are included, so these differ from the named token durations.

| Surface  | Named enter / exit ms, before and after | Observed before enter / unmount ms | Observed after enter / unmount ms |
| -------- | --------------------------------------- | ---------------------------------- | --------------------------------- |
| Dialog   | 160 / 120                               | 136.2 / 121.7                      | 138.9 / 152.1                     |
| Confirm  | 160 / 120                               | 136.1 / 122.9                      | 146.8 / 148.1                     |
| Tooltip  | 80 / 60                                 | 67.8 / 61.7                        | 64.8 / 66.9                       |
| Popover  | 80 / 60                                 | 67.7 / 61.4                        | 62.1 / 85.1                       |
| Dropdown | 80 / 60                                 | 67.9 / 63.3                        | 46.7 / 83.1                       |

Before dialog interruption: last sampled entering opacity .446, first closed
opacity 1.000. After: .325 entering, .484 first closed (another animation frame
elapsed), then .237, .158, .091, .040, .007, 0. No reset to 1. Confirm: .559 first
closed then descending. Fast overlays likewise start exits below 1 (.884 tooltip,
.871 popover, .898 menu) and descend to zero. Tooltip pointer-away takes a browser
input frame to reach Radix; dismissal request time may precede first open sample.

Native browser checks in browser-check.txt cover open-close-open DOM identity,
Escape, outside-pointer dismissal one frame after opening, focus return, body
pointer-lock cleanup, toast dismiss during enter, reduced motion, no page errors.
The critical-damping base scale approaches 1 without overshoot; the hairline panel
settles cleanly. Slow remains unused and has no first-consumer design claim.

Reproduction: install dependencies in the candidate/baseline checkout; copy
harness.html to packages/ui/gla281.html and harness.tsx to packages/ui/gla281.tsx;
run `pnpm --filter @appliance.sh/ui exec vite --host 127.0.0.1 --port 4281`.
Use a separate temporary npm install of Playwright 1.58.2 and adjust the Chromium
path in capture.cjs/check.cjs for the host. Run `node capture.cjs before` against
the baseline and `node capture.cjs after` against the candidate; `node check.cjs`
checks the candidate. Restart Vite after swapping source: this host's sandbox
file watcher did not invalidate modules reliably. Remove the temporary harness
before running repository verification. Evidence tooling is not shipped in main.
