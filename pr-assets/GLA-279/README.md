# GLA-279 — onboarding composition

Baseline: origin/main 42e77d1, rebuilt after pnpm install. After: 5d18d62 (feat/polish-journey-composition), app rebuilt and Vite restarted with --force. Desktop mock host, Chromium 1223, 1280×900, DPR 1, normal motion; fresh browser state for each recording. Flow: first-run audience chooser → developer → journey fixture welcome → Start the Sandbox → all boot phases → Sandbox ready → Run your first agent → Agents. The mock's first-run scenario includes an existing machine, so the recording explicitly loads its separate empty-machine journey fixture after choosing developer. Interruption: bootstrap picker → Dev Machine → Back after 80 ms → repeat at normal pace. No live machine is provisioned.

Measurements are independent rAF samples without screenshot capture. Both published GIF sets use Chromium screencast frames with timestamps; discarded screenshot-timeout recordings are not published. GIFs establish appearance and sequence, not physical display latency. The JSON records computed CSS, active animation owners and opacity throughout each flow; progress includes the preceding welcome samples. Counts below refer to DOM elements owning journey animations/transitions, not descendants moved with a wrapper or browser view-transition pseudo-elements.

## Settle delays (ms)

| Welcome element | Before | After |
| --- | ---: | ---: |
| Decorative mark | 0 | none |
| Heading + introduction | 80 | 80 |
| Intent question | none | 160 |
| Agent intent card | 160 | 160 |
| Hosting intent card | 240 | 160 |
| Supporting sentence | none | 160 |
| Footer actions | none | 240 |
| Audience cards | 0 / 80 | 0 / 80 |
| Progress labels / ready details | 0 | 0 |

“none” means no independent settle; the enclosing page transition still applies. Every settle stays 160 ms, ease-out-quart, backwards fill, translateY(4px) → 0 and opacity .45 → 1. Heading, decision block and footer finish at 240 / 320 / 400 ms. Page transitions stay 240 ms, ease-in-out, with horizontal navigation direction. The 80/160/240 ratio comment is unchanged; no local off-scale values or global-token edits.

## Animation owner counts

| Step / event | Before | After |
| --- | ---: | ---: |
| Audience choice entry | 2 | 2 |
| Welcome entry | 5 | 4 |
| Options / wizard single page entry | 1 | 1 |
| Wizard forward/back overlap | 2 | 2 |
| Progress ready handoff peak (two heading frames, four labels, details) | 7 | 7 |
| Settled welcome / reduced-motion wizard | 0 | 0 |

Welcome and handoff peaks measured in JSON; options count follows its single JourneyFrame and no reveal descendants. One element with both opacity and transform transitions counts once. Hover, progress spinners and view-transition snapshots are excluded from this journey-owner count.

## Verdicts and retained decisions

- **Heading — Continuity:** unchanged 80 ms lead; its existing settle now leads a decision block and footer using the same easing, fill and vertical direction.
- **Intent question/cards/support — Continuity:** one 160 ms group; equal choices no longer arrive in different beats, and their explanatory text follows their movement.
- **Footer — Continuity:** 240 ms settle completes the reading order instead of arriving with only the outer page fade.
- **Brand — Restraint:** remove its independent decorative settle. The inline SVG has fixed dimensions and needs no image network request; checks confirm decoded content. Lucide icons are inline SVG.
- **Page frames — Continuity:** reversible CSS transitions replace restarting enter/leave keyframes. In independent probes, Back formerly changed picker opacity .693 → 0 and form .307 → 1; after, picker .507 → .534 and form .493 → .466. No reset to zero. After exit there is one frame. Transition cleanup ignores child and transform events.
- **Audience chooser — Restraint retained:** keep its stable heading/help and two existing card reveals; it has no fading outer page frame. No decorative animation added.
- **Progress/status — Continuity retained:** existing label changes acknowledge actual boot phases and completion; spinner denotes running work. No idle loops added. Ready heading crossfade and technical details remain semantic state changes.
- **Hover/focus — retained:** existing interactive hover follows the recorded fluid-hover ruling; heading focus, inert outgoing frame and reduced-motion immediate cleanup remain. Browser checks: one reduced-motion frame, zero animations, focus returns to “New installation”. Settled welcome has zero active animations.
- **Handoff — retained:** route-level view transitions remain a 240 ms snapshot crossfade, concurrent with destination presentation, not a delayed chain. No route timers or operation lifetimes changed. Internal wizard Back uses retained frames rather than view transitions. Review the full-flow GIF for perceived layering.
- **Scale/registry — retained:** no springs.ts, theme.css duration or load-bearing ratio-comment changes. No conflict with a recorded decision was identified. The same-duration transition implementation changes interruption behavior, not the scale.

Compatibility: @starting-style controls entry in supporting webviews; older engines omit that entry effect and show content immediately. CSS exit transitions and reduced-motion cleanup remain available. Browser evidence is Chromium; Devon should judge supported native webviews before merge.

## Verification

The sandbox foreground `pnpm verify` passed builds, six typechecks, token/ESLint/format checks, and 1,401 TypeScript tests (one skipped), then failed on the ten known environment-dependent VM tests below (320 VM tests passed). Runtime filesystem access under ~/.appliance/vm was denied:

- egress::tests::brokered_injection_requires_exact_lease_peer
- egress::tests::netstack_policy_forces_deny_and_bakes_allowlist
- egress::tests::peer_guard_pins_exact_guest_ip_when_known
- egress::tests::peer_guard_uses_recorded_wsl_prefix_before_exact_lease
- egress::tests::proxy_keeps_vz_on_persisted_policy_without_the_netstack_baked_allowlist
- egress::tests::proxy_url_prefers_the_recorded_gateway
- netstack::guard::tests::denied_flow_is_dropped_and_logged
- netstack::guard::tests::unavailable_runtime_ca_aborts_and_logs_fail_closed
- traffic::tests::records_path_for_intercepted
- traffic::tests::tail_limits_and_parses

Proposed gates: design (Devon), mandatory composition and native-webview review; code (Quinn), because TSX cleanup now listens for the frame's opacity transition completion. Stop before merge.

Final foreground verification with filesystem access: **GREEN**, exit 0. `NX_DAEMON=false pnpm verify` on restored feature commit 5d18d62: builds, typechecks, lint, all 1,401 TS tests (one skipped), Rust tests (362 passed, one ignored), and clippy. All ten sandbox-only failures passed. No code paths remained checked out from main after capture; feature working tree is clean.
