# GLA-331 evidence — fixture-backed vs real-run

**REAL-RUN:** `appliance builder package` executed against `examples/runtime/journal`, producing **journal.appliance.zip**, digest **sha256:e21962f4abc316be925cb748b0f5596b676c0cbd8f8c6960379c18c560004f14**, unsigned. The real bundle and stdout are here. Real React compositions use AgentSignIn, LaunchAgentButton, the existing terminal-session provider/RunsList attachment pattern, DS Tabs, WeightLabel, ConfirmDialog, LongOperation and LogPane. Timings, CLS, captures, videos and traces were measured on the running browser prototype; these are real UI measurements over the data described below, not live VM measurements.

**FIXTURE-BACKED:** agent sessions and all four registry states (workspace aggregation/VM allocation seam F1/arch F04); static observation (F2: shared terminal input-mode coordination is missing); approval card/readiness (F3: no structured request/readiness bridge); host-side baseline, files/diff and captured results (new host reader absent); target/binding persistence (browser storage substitutes for workbench.json); Package playback of the real pre-run artifact (new live host packaging bridge absent); package promotion (F5/arch F05/F08: no remote bundle ingestion or compound promotion contract); Deploy outcome (mock source operation); WSL refusal and cooperative runtime state (F8/arch F02 and F6: no live WSL execution/enforcement evidence); installer/catalogue journeys (existing components over mock-host). Arch F03 has no demonstrated MCP capability filter/human-click proof. **None of these fixtures passes a live authorization, isolation, installation or promotion gate.**

Owner ruling 2026-11-11 is applied: File — ruled v1 headline; Catalogue — roadmapped (later); Deploy — separate verb (see Deploy action). Rows remain equal-weight review artifacts. Unsigned result says **Unsigned — publisher prompts will warn**. No signing-key provisioning was added.

Branch: `feat/gla-331-workbench-prototype`. Revision: `7a6df986d8e39a10f9fa9232236df1d615a66354`. Base at branch creation: `00a0bdd`; origin/main advanced independently with docs-only changes during the spike. No push or merge.

## Measurement protocol and configuration

Device: Apple M4; darwin 27.0.0 arm64. Chromium 156.0.8078.4. Vite mock-host, built app library, viewport 1440×1000, DPR 1. Adapter Claude unless the Copilot case is named; VM `appliance` is mocked. Normal and reduced motion each have 10 samples for every named interaction (360 total). Native select input/change events are automated; other controls use trusted pointer events except reduced-motion dialog Validation/Stop, which use Enter. Method: input event timestamp → visible DOM acknowledgment → next animation frame plus post-frame task, a conservative after-paint upper-bound proxy. This is not a hardware display latency measurement. Browser audits ran on the same host; no artificial CPU/network throttling. All raw samples and per-interaction medians are in [all-measurements.json](all-measurements.json).

No timing samples use backend completion as UI immediacy. Second real package execution completed in 2.588s, exit 0; see [package-timing.json](package-timing.json) and [package-timed.log](package-timed.log). UI playback waits 450 ms for package and 400 ms for deploy; these are labelled fixture latencies, not engine benchmarks. Native directory picker is mocked and no native launch-latency pass is claimed.

CLS uses the standard maximum session window (1 s gap / 5 s window); raw shifts also include input-associated entries. Gate remains ≤0.01. [surface-cls.json](surface-cls.json) records cold and surface-update CLS plus every shift. [scenarios.json](scenarios.json) records all 12 scenario checks and shifts. A first paint is not a layout-shift exemption after content has already painted.

## Measured gates by surface

Worst median across that surface's named interactions/configurations; S2 also shares S1's 10 detail-navigation observations per configuration. Do not average unlike interactions to hide a failed one.

| Surface | Samples | Worst median ms | Cold CLS | Surface-update CLS | Raw update shifts |
| ------- | ------: | --------------: | -------: | -----------------: | ----------------: |
| S1      |      60 |           48.80 |  0.11638 |            0.00000 |           0.00000 |
| S2      |      20 |           48.80 |  0.11638 |            0.00000 |           0.00000 |
| S3      |      80 |           32.25 |  0.11638 |            0.00000 |           0.00143 |
| S4      |      40 |           31.75 |  0.11638 |            0.00000 |           0.00006 |
| S5      |      40 |           31.90 |  0.11638 |            0.00000 |           0.09858 |
| S6      |      60 |          147.30 |  0.11638 |            0.00255 |           0.00255 |
| S7      |      60 |           31.75 |  0.11638 |            0.00000 |           0.03633 |

**Failures:** cold shell CLS 0.11638 exceeds 0.01 for every surface/scenario. The existing header grows 18 px and Settings moves 204 px when host/mode data resolves; [cls-cold-diagnostic.json](cls-cold-diagnostic.json) identifies both nodes. Surface transitions are below the gate, but that does not erase cold-load failure. Existing Install from file first acknowledgment is ~147 ms and misses 100 ms. Reduced-motion pointer delivery to modal controls was unreliable in automated Chromium runs; keyboard succeeds. The pointer limitation remains unresolved and is not hidden by the keyboard samples. No shared shell/installer rewrite was made outside prototype scope.

## Six-property pass/fail table

PASS means measured prototype presentation/recovery only. Precision FAIL means required live proof is blocked, even when the explicitly labelled fixture behavior passes. This table does not certify fixtures as real enforcement.

| Surface | Immediacy | Continuity | Restraint | Precision                                    | Legibility | Forgiveness                       | One-line verdict                                                                              |
| ------- | --------- | ---------- | --------- | -------------------------------------------- | ---------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| S1      | PASS      | FAIL       | PASS      | FAIL · binding/FS fixture                    | PASS       | FAIL · reduced pointer limitation | Continuity fails cold shell CLS; creation drafts and keyboard cancel survive.                 |
| S2      | PASS      | FAIL       | PASS      | PASS · target separation fixture             | PASS       | PASS                              | Precision preserves separate directory, VM and target; failed selection retains the target.   |
| S3      | PASS      | FAIL       | PASS      | FAIL · F1/F2/F3/F8 live seams                | PASS       | FAIL · reduced pointer limitation | Precision is fixture-only for read-only/approval; all registry labels and Copilot copy pass.  |
| S4      | PASS      | FAIL       | PASS      | FAIL · host baseline/reader fixture          | PASS       | PASS                              | Forgiveness retains file selection, selected result and stale snapshot through refresh.       |
| S5      | PASS      | FAIL       | PASS      | FAIL · live host bridge/signing provisioning | PASS       | PASS                              | Restraint passes: readiness makes zero calls, double-click one attempt, no follow-on install. |
| S6      | FAIL      | FAIL       | PASS      | FAIL · mocked installer/capability           | PASS       | PASS · normal pointer / keyboard  | Immediacy misses 100 ms at Install; publisher and grant cancellation retain context.          |
| S7      | PASS      | FAIL       | PASS      | FAIL · mock deployment/F5                    | PASS       | PASS                              | Forgiveness requires timeout reconciliation before deliberate retry; no invented URL.         |

## Captures, motion, tokens and recovery

[before/](before/) and [after/](after/) contain S1–S7 captures at the same 1440×1000 viewport, content and initial state. For a controlled visual comparison, “before” applies the first implementation checkpoint's CSS (`4c09d5a`) to final markup, clearing subsequently introduced reserve rules. This is a **CSS-baseline reconstruction**, not a claim that the owner-ruling text existed in the earlier commit. “After” uses final CSS. The `capture.mjs` script records that method exactly. Original first-pass captures are `first-list.png` / `first-detail.png`.

Narrow 390×844 and 200%-equivalent layout (720×500 CSS pixels, DPR 2, equivalent 1440×1000 physical raster) captures cover every surface. This is an explicit layout/raster simulation, not a native browser chrome zoom test. [legibility.json](legibility.json) records no surface horizontal overflow and restored Create focus. Long path/name and WSL copy are included. [interaction-audit.json](interaction-audit.json) records zero WeightLabel sibling displacement, preserved diff selection/result selection, validation drafts, cancel focus and interrupted/reversed Create presentation. Corresponding trace: `interaction-audit-trace.zip`.

Rendered prototype S2–S7: **0 off-token durations, 0 opacity-derived colour recipes**; added-source recipes also 0, see [token-audit.json](token-audit.json). The reused sign-in's original 150 ms transition is scoped to the named 80 ms fast token inside Workbench; reduced motion removes it. S1 adds no transition duration or colour recipe. The existing global terminal drawer remains unchanged and contains an inherited `bg-black/40` scrim: **1 opacity-derived recipe outside the route's scope** when Interact opens it. This is carried as inherited composition debt, not counted as zero for the whole app. Activity spinners are existing indefinite indicators, not new discrete motion tiers; no new slow consumer.

Recorded stillness decisions: files/diffs and stream rows stay still to preserve reading position; log/terminal dismissal keeps existing immediate teardown/focus semantics; metadata, fixture session updates and destination rows do not animate; operation results use reserved space instead of movement. Existing DS tabs/weight use fast; confirmation uses base with fast scrim; reduced motion uses immediate behavior. No decorative celebrations, forced log tail-follow or invented progress percentages.

Recordings: `recordings/`, `scenario-recordings/`, `install-recordings/`. Traces: `trace-no-preference.zip`, `trace-reduce.zip`, `scenario-1-trace.zip` … `scenario-12-trace.zip`, install traces, and interaction audit. Scenario 3 retains 0s/10s/1min launch captures and a 65s delayed acceptance. Failed calibration logs remain available rather than being recast as passes.

## Scenario/live-evidence boundary

1. Blank/dirty folders and no-overwrite: fixture-only; binding/directory writer absent. 2. Sign-in then launch: real components, mock credentials/VM; no live agent. 3. Delayed/quiet launch: 0s, 10s, 1min pending and retained draft measured; mock acceptance after 65s. 4. Permission/deny/stop delivery: F3 fixture, no structured live request bridge. 5. N=0/1/3/20 and static observation: F2/F1 fixture; static output has no input transport, shared live mode coordination remains blocked. 6. Partial edits/error/missing/text/JSON results: host reader fixture. 7. Manifest gates/failure/readiness/human Package: fixtures around one genuine pre-run artifact; no live bridge. 8. Three owner-ruling rows: equal geometry (within 1/64 CSS px rounding) and weight; no selection/publishing. 9. Existing user-mode publisher/grant journey: mock installer; cancellation verified, live install not claimed. 10. Existing normal Deploy route is reachable with no workbench.json; its real backend success is not claimed, while S7 success/no URL and failure/reconcile are fixtures. 11. VM recovery/stale catalogue/verification failure: existing surfaces with fixtures. 12. WSL launch disabled, exact refusal, raw stderr only expandable, cooperative warning: F8/F6/arch F02 fixture; no in-guest key fallback selected.

Architecture acceptance: user-mode navigation remains the existing three items; route guards retain developer/operator checks. No SDK/API/Rust changes. MCP registration source is unchanged (8 tools). Package/Deploy are reachable only from human event handlers; readiness and approval have no operation call path. Normal source deployment is not intercepted. An agent capable of shell commands is not claimed to be contained by these UI decisions.

## Verification

Foreground `pnpm verify`: **GREEN**, exit 0. 11 project builds; 6 typechecks; lint/design-token/format gates passed; 1472 TypeScript tests passed in 158 files (1 skipped), across 10 test projects; 362 Rust tests passed, 1 ignored, 0 failed; all three Rust crates built and passed clippy. Full log: [verify.log](verify.log); machine-readable counts: [verify-counts.json](verify-counts.json). The first attempt stopped on formatting in two untracked evidence scripts; those were formatted, then the full foreground command was rerun successfully.

[route-guards.json](route-guards.json): operator/developer allowed; direct Workbench URLs excluded for user mode and member role. Evidence remains untracked; `git ls-files _evidence-gla331` is empty. No binaries are on the feature branch. No push or merge.
