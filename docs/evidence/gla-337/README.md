# GLA-337 acknowledgment evidence

## Native path — measured on this Mac, no mock host

**Immediacy: PASS for the measured /apps Install from file → unsigned publisher review path.** Normal and reduced-motion medians are **43 ms / 43 ms**, each with 10 trusted keyboard activations at a verified **1440×1000 CSS-pixel viewport**. The ≤100 ms gate applies to acknowledgment, not installation completion.

Native Tauri/WKWebView development build, current main plus this fix; real `createTauriHost`, real NSOpenPanel, real CLI-generated unsigned bundle. Every run selects the bundle and reaches Unknown Publisher review, then cancels. This measures the native installer verification/review path; accepting the publisher and completing installation is not measured. The backend timings below end when the original `installBundle` Promise rejects with the real review requirement. They do not meet a 100 ms budget and are not claimed to.

Clock: `performance.now()` with observed integer-ms precision. Start is trusted Space keydown on the focused Install button; end is the next animation frame after observing its committed pending presentation, so a paint opportunity has elapsed. This is a renderer acknowledgment upper bound, not an optical/compositor timestamp. It is not a setState timestamp. Focused button identity is retained through acknowledgment; all 20 `focusAtAck` labels are `Choose bundle…`; scroll offsets are unchanged. The native picker and review intentionally take focus afterward. No text selection exists in this scenario.

Reduced-motion twin exercises `prefers-reduced-motion` via a measurement-only matchMedia override, without changing the machine's preference. Native dependencies needed an uncommitted local-only pin workaround; these are development-build results with that workaround, not release-binary certification. See [exact reproduction and caveats](native-reproduction.txt), [initial clean-main failure](native-attempt.txt), and [successful native build](native-build-success.txt).

| Configuration | Count | Acknowledgment samples (ms)            | Median (ms) | Actual installBundle samples (ms)                | Backend median (ms) |
| ------------- | ----: | -------------------------------------- | ----------: | ------------------------------------------------ | ------------------: |
| Normal        |    10 | 41, 42, 42, 43, 43, 43, 27, 43, 43, 43 |          43 | 681, 892, 602, 653, 608, 626, 638, 619, 624, 660 |                 632 |
| Reduced       |    10 | 27, 43, 43, 42, 42, 43, 43, 44, 43, 42 |          43 | 619, 668, 631, 617, 628, 631, 607, 677, 679, 605 |               629.5 |

[All native observations, including picker dwell/review elapsed times](native-samples.json). Picker-to-review elapsed time includes automation dwell and is deliberately not reported as backend cost.

**Continuity: PARTIAL natively.** WKWebView reports no Layout Instability API support. Empty native `shifts` arrays mean unsupported, not zero CLS. Focus/scroll acknowledgment checks passed; normalized CLS and raw layout shifts are measured only in the Chromium comparison below. Native focus loss found in the first run was fixed with guarded `aria-disabled` on the two new Install presentations; the table above contains the final rerun only.

Native same-window captures (1440×1000 content plus the same titlebar, Retina 2×): [before, picker open without button acknowledgment](native-before-picker.png) · [after, Choose bundle… visible behind native picker](native-after-picker.png). These are separate capture runs, not timing samples. The before image uses main's installed-apps handler only, then restores the final source. Window-ID capture excludes unrelated desktop overlays.

## Browser fixture comparison — NOT native hardware evidence

Chromium, 1440×1000, deterministic synchronous 120 ms JS work. Each configuration has 10 independent page loads/activations. Start: pointerdown. End: next rAF after visible acknowledgment is observed; backend setup completion is recorded separately in raw JSON. Installed Apps first acknowledgment before the fix is the publisher dialog; after the fix it is the picker label. Catalogue first acknowledgment before the fix is the result banner; after it is the pending label. Motion preference emulated per browser context.

These fixture numbers are not substituted for the native numbers above. The fixture uses actual page source but controlled host/data; other audited surfaces have source-order/test evidence only, not per-surface timing captures. Broader surface polish remains unmeasured.

| Surface   | Source | Motion        | Count | Individual acknowledgment samples (ms)                                         | Median (ms) | Max standard CLS | Max raw input-adjacent shift sum |
| --------- | ------ | ------------- | ----: | ------------------------------------------------------------------------------ | ----------: | ---------------: | -------------------------------: |
| installed | main   | no-preference |    10 | 162.20, 147.50, 145.90, 164.80, 148.40, 149.20, 163.80, 148.00, 164.70, 163.60 |      155.70 |         0.000000 |                         0.000000 |
| installed | fixed  | no-preference |    10 | 32.60, 31.20, 31.10, 30.80, 32.00, 31.40, 30.70, 31.20, 32.00, 30.40           |       31.20 |         0.000000 |                         0.000341 |
| installed | main   | reduce        |    10 | 151.90, 129.70, 129.90, 129.70, 130.10, 129.40, 129.80, 130.20, 129.90, 129.90 |      129.90 |         0.000000 |                         0.000000 |
| installed | fixed  | reduce        |    10 | 34.40, 30.70, 31.60, 30.50, 31.20, 31.10, 31.90, 30.30, 31.50, 30.10           |       31.15 |         0.000000 |                         0.000340 |
| catalogue | main   | no-preference |    10 | 150.40, 126.00, 126.90, 126.10, 126.40, 127.30, 126.90, 126.30, 126.30, 126.80 |      126.60 |         0.000000 |                         0.012010 |
| catalogue | fixed  | no-preference |    10 | 31.20, 31.60, 31.40, 30.60, 30.90, 31.70, 30.00, 31.40, 29.80, 30.80           |       31.05 |         0.000000 |                         0.012017 |
| catalogue | main   | reduce        |    10 | 149.30, 125.00, 125.50, 125.20, 125.70, 125.30, 125.90, 125.10, 125.90, 125.90 |      125.60 |         0.000000 |                         0.012010 |
| catalogue | fixed  | reduce        |    10 | 32.50, 30.80, 31.30, 32.70, 31.80, 32.00, 31.70, 32.10, 31.20, 30.20           |       31.75 |         0.000000 |                         0.012016 |

[Raw browser samples](browser-fixture-samples.json) include every layout-shift entry and its `hadRecentInput` flag. Standard CLS is zero in these short scenarios because the shifts follow input; zero does not imply no movement. Catalogue success-banner insertion has raw shift sum ≈0.012, exceeding a 0.01 raw-shift reading, both before and after: **Continuity is not fully passed**, and that existing result/arrival reservation is recorded under GLA-340. Installed-app acknowledgment raw shift sum is below 0.001. No scroll change was observed; focus moves to Cancel for publisher review and stays on catalogue Install otherwise. Selection is not applicable.

Same-viewport capture pairs for both approved visual surfaces:

- Installed Apps: [before](installed-before-no-preference-idle.png) / [after](installed-after-no-preference-idle.png); [before review](installed-before-no-preference-completed.png) / [after review](installed-after-no-preference-completed.png).
- Catalogue: [before](catalogue-before-no-preference-idle.png) / [after](catalogue-after-no-preference-idle.png); [before result](catalogue-before-no-preference-completed.png) / [after result](catalogue-after-no-preference-completed.png).
- Reduced-motion twins use the corresponding `*-reduce-*.png` files beside these captures.

## Six-property verdicts and limits

| Property    | Verdict                                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immediacy   | Measured native first acknowledgment passes ≤100 ms at 43/43 ms. Fixture comparison passes after fix. Other handler families are source-order/test verified, not hardware-certified.                                                                       |
| Continuity  | Focus loss corrected in new Install controls; mounted labels reserve width; measured scroll preserved. Native CLS unavailable. Browser standard CLS passes; existing catalogue result-banner raw shift ≈0.012 remains debt, so no blanket Continuity pass. |
| Restraint   | No new animation, palette, duration, or spinner language. Existing busy presentation; two-frame scheduling is independent of motion preference.                                                                                                            |
| Precision   | Picker says Choose bundle…, installer says Installing…; cancellation/rejection restores action. Backend duration is separate from acknowledgment.                                                                                                          |
| Legibility  | Same-viewport native/browser captures show readable pending labels; no new off-token values (count 0).                                                                                                                                                     |
| Forgiveness | Picker cancellation/error and install failure restore the control; trust/grant decisions remain unchanged. Explicit deferrals link to GLA-338/339/340; no silent skips.                                                                                    |

## Reproduction and validation

Temporary probe/harness files are retained as text evidence only: [native probe](native-probe.ts.txt), [native driver](native-runs.py.txt), [native collector](native-server.py.txt), [browser driver](browser-measure.mjs.txt), [browser fixture](browser-fixture.tsx.txt), [Vite config](browser-vite.config.mjs.txt). The scripts contain machine-local paths; adapt those when replaying. For the browser baseline, materialize main's installed-apps and runtime-catalogue source beside the fixture, rewriting its relative dialog imports to the original page paths. Use the fixture's source alias and the full app stylesheet. None of this instrumentation remains in product entrypoints.

Regression coverage includes committed pending DOM before bridge work, both frame boundaries, query-mutation pending notifications, hidden-document release, picker cancellation/rejection/install failures, duplicate activation/focus retention, and disposal before imperative Reopen work. **Full foreground `pnpm verify`: GREEN, exit 0.** Result is recorded in [verification log](verify.txt).

## Review refinements

The approved follow-up adds shared Button aria-disabled styling, restores Install availability during unrelated open/stop work, groups pending state/log resets, guards AWS retry after unmount, and uses one accessible-name path for Install labels. Recorded measurements and captures predate these refinements. Timing was not rerun at the manager's direction: CSS-only disabled styling and restored unrelated-action gating do not alter the measured acknowledgment path's timing semantics; neither do the callback/lifecycle/accessibility fixes. Full foreground `pnpm verify` was rerun with Nx caching disabled: **GREEN, exit 0**, including the Open/Stop availability and AWS retry unmount regressions. See [review verification](verify-review.txt).
