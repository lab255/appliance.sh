# F3 readiness bridge evidence

The real Workbench detail page receives a typed **fixture-only** readiness source
and passes a scoped proposal to PackageSection. Production routing supplies no
source: it explains that live statements remain in the session terminal. Neither
registry `done` nor terminal prose manufactures readiness. This PR adds no live
adapter, approval delivery, persisted approval state, or Package eligibility gate.

Spec basis: Rev3 UX §5 (S5): proposal + session identity + captured summary +
inspection link beside Package; a human may Package without readiness. UX F3 and
§3 prohibit authoritative cards from terminal-prose parsing. The fixture source
is explicitly labelled at the boundary and in the result/session copy.

**Judgment call approved by manager:** stopped/dismissed source sessions and
explicitly dismissed proposals retain their context but are marked **Stale**.
Error/exited source sessions are stale too. The spec does not choose clear versus
stale. Clearing was rejected because it discards the review context and makes
arrival/disappearance harder to interpret. Dismissal is local to this mounted
workspace view; it is not persisted or delivered to an agent. Removing the fixture
source clears its presentation. Hide/Observe terminal operations are not wired to
this fixture source and do not masquerade as session dismissal.

Package keeps its existing handler, pending paint, host invocation, failure/retry
and duplicate-click guard. Proposal arrival and dismissal make zero package calls;
a human click makes one. Stale proposals never disable Package. There is no
Approve button: informational dismissal is the only new human action.

## What a real contract needs

These are requirements for a future live bridge, **not implemented guarantees** of
this fixture. Adding a live source requires an explicit adapter contract and review:

- **Emitting channel and authority:** a supported agent emits a structured readiness
  event through its host adapter. Only that registered adapter may deliver events
  for its launched session; terminal prose, workspace files and arbitrary UI callers
  are not authenticated event channels. A readiness event remains informational and
  must never invoke Package, install or promotion.
- **Provenance:** the host must authenticate the emitting adapter/channel and bind
  each event to its registered sessionId and canonical workspace directory. It must
  validate that binding against host-owned launch records rather than trusting
  identifiers supplied by the agent. Cross-session/directory events are rejected.
- **Identity and snapshot version:** define a stable proposalId, revision and the
  host-side baseline/snapshot identity or content digest the proposal describes.
  A later file change invalidates that revision as stale; session `done` is not
  freshness evidence. Packaging still reads current files unless a separately
  reviewed implementation pins/verifies the proposed snapshot.
- **Lifecycle delivery:** stop, dismiss, error and exit must arrive as identified
  lifecycle events from the host/session adapter, replacing the fixture's embedded
  `sessionStatus`. Define terminal-state precedence and reconcile unknown/missing
  lifecycle evidence before presenting a proposal as current. Hiding an observation
  tab remains distinct from stopping/dismissing a source session.
- **Ordering and reconnect:** specify monotonically ordered revisions/events per
  session, deduplicate stable event IDs, reject old revisions and replays, and
  reconcile an authoritative snapshot plus a replay cursor on reconnect. A replay
  must not resurrect a dismissed/stopped proposal; gaps must surface unknown/stale
  state until reconciliation completes.
- **Dismissal disposition:** this PR's dismissal is local, unpersisted and never
  delivered to the agent. The live contract must explicitly choose whether that
  remains so or becomes durable and/or an adapter-delivered response. Durable
  dismissal needs proposal/revision scoping; delivery needs acknowledgments,
  idempotency and visible failure/reconciliation behavior. Neither choice grants
  packaging authority to the agent.

## Measurements

macOS 27.0.1 (26A434), arm64; Chromium 1248 headless; real React detail and
PackageSection, simulated session/result/Package host; 1280×1000 viewport.
Captures are browser app-content viewport captures, not whole-desktop captures.
Narrow 390×844 and 200% CSS zoom probes are additional checks. These are fixture
numbers, **not native hardware authorization or packaging evidence**.

Each normal/reduced configuration has 10 independent page-load samples. Arrival
occurs after a 650ms input-free settling period; acknowledgment clock is event to
the second requestAnimationFrame after visible DOM (paint opportunity, not
compositor pixels). Package acknowledgment is paired with its **simulated** host
duration. Dismiss/arrival have no backend work. Samples and shifts, including
input-adjacent raw shifts, are in [measurements.json](measurements.json).

| Metric                                         |         Normal |        Reduced |
| ---------------------------------------------- | -------------: | -------------: |
| Proposal presentation median, ms               |           8.60 |          11.55 |
| Dismiss acknowledgment median, ms              |          29.80 |          29.90 |
| Package acknowledgment median, ms              |          30.60 |          30.20 |
| Simulated Package host duration median, ms     |         182.35 |         182.60 |
| Proposal arrival standard CLS, max and median  |              0 |              0 |
| Proposal arrival raw shift sum, max and median |              0 |              0 |
| Package button displacement, max px            |              0 |              0 |
| Negative control (reservation removed) raw CLS | 0.025070859375 | 0.025070859375 |

Negative control changes only the readiness region's height to auto and repeats
arrival; it fails the 0.01 threshold. The measured 256px reserve remains scrollable
at narrow widths/zoom, with a labelled, keyboard-focusable region. The initial
probe caught focus loss when Dismiss became natively disabled; the final guarded
aria-disabled implementation retains focus in 20/20 observations.

**S3 delayed acceptance 0.02164 is not this surface.** Manager assigned that
prediction/test to W4 (sessions observation). These numbers establish only S5
proposal arrival. W4 and W5 compared actual detail diffs: W4 replaces the Sessions
placeholder; W5 adds source wiring and inspection anchor/Package prop. Neither
changes the other's region.

## Six-property rubric

| Property    | Verdict and checkable evidence                                                                                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immediacy   | PASS, fixture: all three acknowledgment medians ≤100ms, 10 samples per motion; simulated backend separately reported above.                                                                                                                                     |
| Continuity  | PASS, fixture: arrival CLS 0 and button movement 0px; reservation-removed negative control exceeds 0.01; final Dismiss keeps focus. No new animation.                                                                                                           |
| Restraint   | PASS: ordinary Package button unchanged; no approval animation, automatic operation or completion celebration.                                                                                                                                                  |
| Precision   | PASS, fixture only: explicit fixture/session/result labels; proposing ≠ approved; wrong-directory source rejected; no readiness inferred from done. Zero calls before human click, exactly one afterward in 20/20 runs. Live authorization remains unavailable. |
| Legibility  | PASS, fixture: named tokens and text status; 390px and 200% zoom have no horizontal overflow; scrollable region exposes controls via keyboard; Inspect changes focuses the inspector. See acceptance.json and viewport captures.                                |
| Forgiveness | PASS, fixture: dismissal retains stale context and focus; stopped/error/exited source cannot imply current readiness; Package remains available; existing failure/retry preserved; source subscription cleans up on unmount.                                    |

## Regression teeth

[teeth.py](teeth.py) temporarily restores six defects, runs the integration test,
and restores files in `finally`. Run only without concurrent dev server/verify.
[teeth.json](teeth.json) records actual failures:

- Disconnected detail prop: fails to find `Agent-proposed · not approved`.
- Removed stale handling: fails to find `Stale proposal —`.
- Automatic Package effect: fails because package spy was called before human action.
- Restored implementation: 2 files, 7 tests passed.
- Source directory guard removed: the isolated hook test fails.
- PackageSection directory guard removed: the direct component test fails.
- Dismiss stale guard removed: stopped-session reason is overwritten and the test fails.

Independent negative cases include `done` with no proposal, a proposal from a
different directory, and proposal events without a click. Keyboard/stop/zoom
browser assertions are retained in [acceptance.mjs](acceptance.mjs) and
[acceptance.json](acceptance.json).

## Reproduction

From the repo root, install locked dependencies and build app dependencies. Run
`node docs/evidence/workbench-w5/server.mjs` (fixture source is materialized outside
the product tree). Then run `measure.mjs` and `acceptance.mjs` from this directory
via Node. Set `PLAYWRIGHT_MODULE` to an installed Playwright ESM module path and
`CHROMIUM_PATH` to Chromium; both variables are required and missing values fail with a clear setup message.
The server creates a unique fixture directory under `os.tmpdir()`.
Browser launch may require sandbox permission on macOS. No fixture route is added
to the product router, and evidence sources are outside the app's build inputs.

Run `python3 docs/evidence/workbench-w5/teeth.py` for defect restoration tests.
Acceptance command is `NX_DAEMON=false NX_SKIP_NX_CACHE=true pnpm verify`.
