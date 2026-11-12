# Bounded S6 optimization — GATE MET

**Real-run UI evidence over fixtures:** final code `8afe2d0a048fbf75f83b98e9634a9335527db2dd`; 1440×1000, DPR 1, Chromium 156.0.8078.4, Apple M4, unchanged after-paint upper-bound proxy, ≥10 finite samples per motion configuration. **Fixture boundary:** mock picker resolves immediately; mock install bridge still waits 120ms. No native picker/installer latency claim. No bridge, Tauri, CLI, publisher or grant internals changed. Branch-only; no push.

## Diagnosis

Temporary `performance.mark` calls bracketed handler entry, picker resolution, busy set, bridge call and rejection. Browser marks record input and dialog DOM appearance. Handler entry median is 0.4ms after input; picker resolves in 0.0ms; bridge wait median is 122.5ms in both configurations, matching the explicit `sleep(120)` in mock-host installBundle. Rejection → dialog DOM is 12.7/12.0ms. The previous ~147ms cluster therefore includes deterministic fixture latency, not 100ms of synchronous installer work. The existing `setBusy('install')` was not rendered by either Install button. The old measurement's first visible acknowledgment was the publisher dialog. Temporary handler marks were removed before the final code build.

## Before → after

| Configuration | Historical recheck ms | Same-session instrumented baseline ms | Optimized first feedback ms |              Samples |
| ------------- | --------------------: | ------------------------------------: | --------------------------: | -------------------: |
| no-preference |                147.80 |                                142.80 |                       26.15 | 10 before / 10 after |
| reduce        |                147.80 |                                144.70 |                       30.75 | 10 before / 10 after |

Zero discarded samples in these four series. All raw values and marks are in `s6-before-measurements.json` / `s6-after-measurements.json`; scripts, videos and traces are adjacent. The same-session baseline variation from the historical run is frame/run scheduling variation; no attempt is made to attribute it to the fix.

The input clock, viewport and post-frame method are unchanged. The acknowledgment predicate now detects the new visible busy button (with dialog fallback); that is an explicit first-feedback semantic change, not a claim that publisher review completes faster. Publisher dialog DOM arrival remains 136.05/135.20ms after input in the optimized runs (DOM timing, not after-paint). Historical alert-dialog measurements are retained. Threshold stays **≤100ms**.

## Minimal change and boundaries

Set picker busy before awaiting pickBundle; reuse existing install busy state; expose “Choose bundle…” / “Installing…” in both Install buttons. Reserve original label width, disable duplicate clicks, reset on cancellation/error and retain existing error handling. No flushSync or artificial delay is necessary: the traced awaited work yields normally. Three regression cases cover deferred picker cancellation, rejection and deferred installation while preserving `acceptUnknownPublisher: false`. An initial calibration caught the status child's missing accessible button name; explicit aria-label fixed it before final measurement. Failed calibration log remains.

## CLS

Unchanged S6 capability-change procedure: **0.0025458353 → 0.0025458353**, within **0.01**. `s6-optimized-cls.json` retains cold 0.11638 separately; the cold shell failure is not erased. Supplemental installer click → dialog → cancel raw shift sums are **0.00001420 / 0.00001374**, including recent-input entries; button bounds are unchanged at 132.90625×32px. See `s6-installer-cls.json`. Cold user-mode defect remains separate.

## Verdict and follow-up

**GATE MET for S6 first acknowledgment in the running prototype.** This code-backed result supersedes the previous S6 first-feedback failure; it does not reclassify historical samples or certify native install completion. All other declared failures (shell, S3 delayed acceptance, reduced-motion modal pointer) stand. GLA-336 / Morgan inherits the diagnosis and minimal presentation change. Full foreground verification: **GREEN, exit 0; 1475 TypeScript / 362 Rust passed**, 11 builds, 6 typechecks. See `s6-verify.log` and `s6-verify-counts.json`.
