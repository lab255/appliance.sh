# GLA-338: pending UI for six audited handlers

Original base: `407345b`. Rebased onto post-#182 main `3a69b9ee` for the review revision. All six entries in
[the GLA-337 audit](../../gla-337-handler-audit.md) still lacked pending state at
that commit; none was skipped. This change covers Workloads Switch, credential
program Browse, Claude sign-in terminal launch, updater Restart, runtime shared
folder picker, and the already-hosting Deploy app selection path.

Each control stays mounted, has one changing accessible name, reserves the maximum
idle/pending label width using invisible grid siblings, guards duplicate activation,
and calls the existing `paintPending` before host work. Native `disabled` is absent
while pending; all six tests enforce that attribute contract. Pending clears in `finally`; cancellation keeps the previous picker value.
Picker/switch failures use the existing toast presentation. Sign-in fallback,
updater retry, and deployment's best-effort selection semantics remain intact.
Clipboard handlers, shared paint helper, and W7's Retry/Refresh handlers are unchanged.

## Measurements and bounds

[Summary](summary.txt), [all 120 samples](samples.json). Every handler has ten runs
in normal motion and ten in reduced motion. Chromium at 1440×1000 CSS pixels,
trusted Enter on the focused control, actual production components and CSS with
controlled host methods. Each method blocks JS for 120 ms, then remains pending
so the observation isolates the idle → pending transition from result arrivals.
These are browser fixture results, **not native Tauri/picker/relaunch timings**.

Acknowledgment is `performance.now()` at the next animation frame after the pending
accessible name and busy DOM state are observed. It is a paint-opportunity upper
bound, not an optical/compositor timestamp. The probe asserts ≤100 ms and that host
work starts after acknowledgment. It checks the same control's rectangle and scroll
position before/at acknowledgment. Focus is recorded as an **observation only**,
not a focus-safety guard: the review's native-disabled mutation survived the Switch
Chromium focus observation, and jsdom does not model the WebKit hazard. The guard
is the DOM `hasAttribute('disabled') === false` assertion, killed 6/6 by the
native-disabled mutant. No native WebKit focus result is claimed. No text selection is made.

The Layout Instability observer records both standard CLS (excluding recent input)
and raw shifts (including recent input). The measured interval is bounded and shorter
than a CLS session window. **Every sample has its own negative control**: after the
recent-input exclusion window, insert a 160px block above the surface, and require
standard CLS >0.01. A zero result is rejected unless its own detector control fires.
This measures pending-state continuity only; result, error, new path, and navigation
arrivals are not represented as passing layout measurements.

All captures are app content only, at the same viewport. Each surface has
`<surface>-<motion>-idle.png` and `-pending.png`; surfaces are `switch`, `program`,
`terminal`, `relaunch`, `folder`, `deploy`; motion is `no-preference` or `reduce`.
No whole-desktop screenshots are used. Captures were visually inspected for label
legibility and retained focus rings.

## Six-property rubric

| Property    | Evidence / limitation                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immediacy   | Ten-run medians per handler and motion preference; ≤100ms acknowledgment under a controlled 120ms synchronous host stall; real two-frame ordering also asserted in DOM tests. Native compositor not measured.                                           |
| Continuity  | Idle/pending control rectangles and scroll preserved in all browser samples; raw shift and CLS ≤0.01, each with its own >0.01 detector control. Result arrivals outside this claim.                                                                     |
| Restraint   | Existing button language; no new animation, spinner, duration, color or opacity recipe. Reduced-motion twins run the same acknowledgment barrier.                                                                                                       |
| Precision   | Switching…, Choose program…, Opening terminal…, Restarting…, Choose folder…, Provisioning cluster… then Opening deploy… identify the actual work; accessible name matches visible text.                                                                 |
| Legibility  | Same-window 1440×1000 capture pairs; named tokens; invisible reservation labels excluded from accessibility.                                                                                                                                            |
| Forgiveness | All six DOM cases check duplicate activation, failure/cancellation/success settlement and reactivation; picker cancellation preserves prior input; failure feedback uses real providers. Existing terminal manual fallback and updater retry preserved. |

## Regression teeth and provider composition

`packages/app/src/pages/pending-handlers.test.tsx` mounts the six actual owning
components with real HostProvider, QueryClientProvider, MemoryRouter, MotionProvider,
ToastProvider, ConfirmProvider and TerminalSessionsProvider. Controlled host methods
are the transport boundary. `useApplianceClient` returns null to avoid unrelated
network reads; xterm's canvas/PTY implementation is mocked because no terminal
session renderer is exercised. Pending controls, paint helper and error toasts are
not mocked. The two adjusted existing test files wrap real Toast/Motion providers;
Workloads' pre-existing transport/cluster/session-hook mocks remain unrelated to
its table assertions. The credential tests select Browse by accessible name and
wait for the new two-frame picker barrier.

[Regression driver](regressions.mjs) temporarily restores the five production files
from `407345b`, then independently removes duplicate guards, then removes the paint
barrier, then adds native disabled to the six pending controls. A seventh case
exercises not-provisioned deployment through failure/success and the transition
from Provisioning cluster… to Opening deploy…. Its misleading-label mutant fails
1/1. Fixed suite: 7/7 pass. The other four variants fail 6/6. It restores every file after each variant, including on failure. The six original cases must fail for baseline, unguarded, no-paint and native-disabled variants; the provisioning-label variant targets only the seventh case. Logs:
[baseline](tests-baseline.txt), [unguarded](tests-unguarded.txt),
[no paint](tests-no-paint.txt), [native disabled](tests-native-disabled.txt),
[misleading provisioning label](tests-provisioning-label.txt), [fixed](tests-fixed.txt).

## Reproduction

From the repo root, install with `pnpm install --frozen-lockfile` and build workspace
dependencies (the normal `pnpm run build` does this). Then:

```sh
node docs/evidence/gla-338/regressions.mjs
BASE_URL=http://127.0.0.1:1456 node docs/evidence/gla-338/serve.mjs
```

In another shell, set `PLAYWRIGHT_MODULE` to an installed Playwright `index.mjs`,
`CHROMIUM_PATH` to a Chromium executable, and `BASE_URL` to the same fixture URL:

```sh
node docs/evidence/gla-338/measure.mjs
```

The probe requires all three variables and fails with a clear message if any is
unset; there are no personal-path defaults. `serve.mjs` materializes the retained
fixture/config text beside the app in `packages/app/.gla338`, using relative repo
paths. Stop the server and remove that generated directory before verification.
Do not run source-mutating regression controls concurrently with browser probes.

For the independent reservation control, run the probe with `RESERVE_CONTROL=1`.
It removes only the target control's invisible reservation labels before activation
and requires the rectangle comparison to detect a change (six single-run controls).
For the timing control, restart the fixture server with `PAINT_CONTROL=1` and run
the probe with `PAINT_CONTROL=1`. A Vite-only transform bypasses the paint barrier;
the same 120ms host stall must now produce acknowledgment >100ms in each of six
single-run controls. Product source is not edited by either browser control.
[Reservation control](summary-reservation-control.txt) and
[timing control](summary-timing-control.txt) retain their measured values and JSON samples.

The regression runner scrubs the repo root **before writing** captured output and
uses [scrub-log.mjs](scrub-log.mjs) for home/temp paths and IDs. Use that same script
on freshly captured verification logs, then run `node docs/evidence/gla-338/scan-logs.mjs`.
Its scan covers evidence `.txt`/`.json` files with home-directory prefixes, temporary-directory prefixes,
private temporary paths, Claude temporary paths, the runtime current username, `thr_[a-z0-9]+`, UUID-shaped
IDs, `playwright_[a-zA-Z0-9_-]+`, `claude-[0-9]+`, and the runtime temporary-directory
ID. This is the stated pattern set, not a claim of exhaustive privacy detection.

Chromium's first sandboxed launch aborted; measurements used an elevated rerun.
The sandboxed acceptance attempt passed the TypeScript phases, then failed ten Rust
VM tests because `~/.appliance` writes were denied (EPERM); see
[the failure excerpt](verify-sandbox-failure.txt). The final acceptance reruns the
whole command elevated, with caching still disabled.
An elevated attempt then failed two unrelated API-server HTTP assertions (404/407);
[isolation](verify-http-isolation.txt) passed those original cases but returned 407
for a different request. [Failure excerpt](verify-http-failure.txt). The manager
reported another concurrent full verify on this host. The specs use Supertest's
`app.listen(0)` and ephemeral ports, so fixed-port cross-talk is **not established**;
HTTP interference is a hypothesis, not a diagnosed product defect. No API-server
code was changed. Final acceptance is coordinated after the other verify finishes.
Acceptance command: `NX_DAEMON=false NX_SKIP_NX_CACHE=true pnpm verify`.

**Original pre-review acceptance: GREEN, exit 0**, full uncached build → typecheck → lint → tests
→ Rust build/test/clippy, elevated after the other full verification completed.
[Original verification log](verify-final.txt). The passing rerun does not diagnose
the earlier HTTP failures; they remain disclosed above.

## Review revision calibration values

After rebase onto `3a69b9ee`, the fixed-state measurement reran all **120 samples**
(six handlers × two motion modes × ten). Ack medians: **10.10–24.65ms**.
The independent positive controls are deliberately broken measurements:

- **Layout observer calibration — 160px spacer insertion:** 120 controls, one per
  fixed-state sample. The **minimum observed CLS is 0.020971**, the weakest control;
  no average is used to validate the zero-CLS observations.
- **Reservation detector calibration — remove invisible target-label reservations:**
  six controls, one per handler in normal motion. Signed width deltas in pixels:
  Switch +28.594, program +63.922, terminal +38.453, Relaunch −28.891,
  folder +0.625, deploy +35.688. All six are detected; minimum absolute delta 0.625px.
- **Acknowledgment calibration — bypass the paint barrier with the same 120ms host stall:**
  six controls, one per handler in normal motion. Ack in milliseconds:
  Switch 125.30, program 123.60, terminal 127.40, Relaunch 122.90,
  folder 129.60, deploy 129.40. Every control exceeds the 100ms budget;
  minimum observed 122.90ms. These single-run controls are calibration, not medians
  across repeated trials; fixed-state medians still use ten samples each.

Focus samples are observational only. The native-disabled safety assertion and its
6/6 failing mutation, rather than a Chromium focus observation, guard the pending
attribute contract. The provisioning branch is covered by the seventh DOM case,
not by the six-surface browser timing fixture.

**Review revision merged-tree acceptance: GREEN, exit 0.**
`NX_DAEMON=false NX_SKIP_NX_CACHE=true pnpm verify`, elevated on post-#182 main
`3a69b9ee` plus this revision: build, typecheck, lint, TypeScript tests and Rust
build/test/clippy all passed. [Merged-tree log](verify-merged.txt).
The [focused W6/W7 composition suite](merged-focused.txt) also passed 22/22.
The stated privacy-pattern scan matched no configured patterns in 21 evidence
text/JSON files after capture-time scrubbing.
