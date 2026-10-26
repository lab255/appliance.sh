# GLA-281 overlay motion audit

Baseline: `42e77d1`. Durations below are token parameters, not a promise that a
spring reaches mathematical rest at its nominal duration. CSS uses out-quart;
JS enters use the matching spring and JS exits the named tween.

| Surface            | Before source                              | After source                               | Enter / exit ms before → after |
| ------------------ | ------------------------------------------ | ------------------------------------------ | ------------------------------ |
| Dialog content     | `styles.css` ui-dialog-in / ui-overlay-out | `dialog.tsx`, selectTransition base        | 160 / 120 → 160 / 120          |
| Confirm dialog     | DialogContent                              | DialogContent                              | 160 / 120 → 160 / 120          |
| Dialog scrim       | `styles.css`, fast                         | `dialog.tsx`, selectTransition fast        | 80 / 60 → 80 / 60              |
| Dropdown menu      | `styles.css`, ui-overlay-fast              | `dropdown-menu.tsx`, selectTransition fast | 80 / 60 → 80 / 60              |
| Popover            | `styles.css`, ui-overlay-fast              | `popover.tsx`, selectTransition fast       | 80 / 60 → 80 / 60              |
| Tooltip            | `styles.css`, ui-overlay-fast              | `tooltip.tsx`, selectTransition fast       | 80 / 60 → 80 / 60              |
| Toast              | `toast.tsx`, useTransition base            | unchanged                                  | 160 / 120 → 160 / 120          |
| TerminalDrawerView | immediate conditional render               | deliberately unchanged                     | 0 / 0 → 0 / 0                  |
| PodLogsDrawer      | immediate conditional render               | deliberately unchanged                     | 0 / 0 → 0 / 0                  |

Off-token enter/exit duration occurrences: **0 → 0**. The change repairs
interruption, rather than replacing raw timings. Tooltip's 400ms hover intent
and 300ms skip window, toast's 4000/8000ms dwell and logs' 2000ms announcement
throttle are behavioral timers, not enter/exit durations. Activity indicators
inside drawers are not surface transitions.

App dialog consumers (`grant-dialog`, `unknown-publisher-dialog`, and the
confirmation provider) inherit the shared content. The cluster switcher uses
the shared dropdown; app UI shims do not introduce another animation source.
There is no drawer primitive in packages/ui. Banner/BannerPresence and
SkeletonSwap already use AnimatePresence and the same base enter/exit selector;
these and toast remain unchanged.

Dialogs are interruptible in practice: Escape and outside-pointer dismissal
remain enabled while entering. Before capture at 10x CSS playback measured
opacity 0.446 → 1.000 on dialog Escape, 0.418 → 1.000 on confirm Escape;
menus/popovers/tooltips exhibit the same reset. JS presence retains the same
DOM node through exit and reopening and targets the current animated value.
Base's critically damped short scale travel preserves the hairline appearance;
no slow/bouncy tier is introduced. See CLAUDE.md for the recorded drawer
stillness and first-slow-consumer decisions.

Evidence is stored only on `chore/artifacts`, under `pr-assets/GLA-281/`.
Baseline GIFs use DevTools 10x CSS playback. Candidate measurements use native
playback and decoded frames: DevTools animation slowdown does not also slow
Motion's JS completion clock, so it is not valid evidence for the JS lane.
Frame telemetry accompanies the GIFs; browser scheduling adds frame-sized
latency to observed mount/unmount times. Compare reversal, not the GIF wall time.
