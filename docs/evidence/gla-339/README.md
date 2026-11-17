# GLA-339 — read retry/refetch acknowledgment

Base: `407345b`. Manager approved shared orchestration before implementation and confirmed disjoint W6 overlap hunks. No query function, retry setting, backoff setting, polling interval or background invalidation is modified.

`RefetchButton` commits local pending through existing `paintPending` before its first await, waits two animation frames, then invokes the supplied read exactly once. It holds pending through the returned promise, guards repeat activation, skips queued work after unmount, preserves focus with guarded `aria-disabled`, and reserves both text labels in one grid cell. Icon controls retain the existing fixed button dimensions; pending text becomes their accessible name. Unavailable controls remain idle. Existing Button styling supplies named color/motion tokens; icon animation respects reduced motion.

## Audited binding coverage

All 22 GLA-339 bindings from `docs/gla-337-handler-audit.md`:

| Page                                 | Controls                                                        |
| ------------------------------------ | --------------------------------------------------------------- |
| settings-team                        | Invite retry; API-key retry                                     |
| deployments/detail, deployments/list | Deployment retry; deployment-list retry                         |
| apps/index                           | Grouped projects/deployments/environments retry                 |
| projects/detail                      | Project; environments; deployments retries                      |
| environments/detail                  | Environment; deployments; health retries                        |
| environments/workloads-panel         | Refresh workloads icon                                          |
| settings-account                     | Retry account status                                            |
| machine/egress-panel                 | Traffic retry; policy refresh                                   |
| machine/runtime-detail               | Runtime status retry                                            |
| machine/credentials-panel            | Credentials retry                                               |
| agents/index                         | VM-list retry; runtime status retry; grouped VM-list/runs retry |
| setup/doctor                         | Ready icon re-check; not-ready text re-check                    |

Grouped retries return `Promise.all` so feedback lasts until all reads settle. Delegated health/doctor callbacks now return their promises. Account retry calls the existing effect-owned read via a ref instead of restarting the effect: the initial read and two-second polling remain immediate, while only the user click paints pending first. The polling interval is no longer reset by a retry click.

## Behavioral evidence

The browser fixture uses the production component, React Query and app styles. Its simulated query spends 160ms in synchronous setup followed by a 180ms async response. This is browser fixture evidence, not a native-host performance claim. `measure.mjs` performs ten trusted keyboard activations per text/icon × normal/reduced-motion × original/fixed case (80 samples). Each gets a rapid second activation. Acknowledgment is the first animation-frame observation of committed busy feedback; query start must follow that frame. Raw layout shifts retain `hadRecentInput`; standard CLS is reported separately. Geometry, focus and scroll are sampled independently.

Final timing table and retry fingerprint are in `measurements.json` and pasted in the PR body. Passing controls must have median acknowledgment ≤100ms, CLS and raw shift sum ≤0.01, zero button/neighbor movement, retained focus, unchanged scroll and exactly one queryFn start. The original query-owned button is the latency negative control. Independent geometry/CLS, focus and scroll negative controls deliberately widen the icon button, move the page, blur focus and scroll; each detector must report the regression. No zero measurement is treated as self-validating.

Default retry ownership is exercised twice: fake-clock test requires exactly 1000/2000/4000ms between failed starts; a real-clock browser failure requires that same signature after subtracting the fixture's 340ms query duration. Four starts are expected for this failure case (initial attempt plus three React Query retries), rather than confusing automatic retries with duplicate activation.

`refetch-button.test.tsx` covers synchronous acknowledgment, both frame boundaries, duplicate activation, focus, settlement, unmount, retry signature, unavailable-state behavior, and actual AccountSection initial/poll/click reads. `async-recovery.test.tsx` exercises actual deployment retry with cached rows and account error-to-success recovery. The seven shared-component tests plus three existing recovery tests are the focused suite.

`guard-mutations.py` temporarily removes the paint barrier or restores native disabled, runs the component tests, and restores source in `finally`. All four mutants must fail; retained logs show the behavioral assertions, not compilation failures. Barrier removal starts queryFn before acknowledgment, breaks unmount protection, and loses account-click pending. Native disabled fails the focus-safe DOM requirement.

## Six-property rubric

| Property    | Verdict and boundary                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Immediacy   | PASS in measured browser fixture: final ≥10-run medians and original-defect comparison in JSON/PR. Both animation-frame boundaries asserted in unit tests. No native timing claim.                                                                           |
| Continuity  | PASS for measured acknowledgment controls, including fixed-size icon: raw shifts and standard CLS ≤0.01; reserved geometry, focus and scroll checked with independent negative controls. Async data-arrival layout across whole pages remains GLA-340 scope. |
| Restraint   | Existing Button tokens and refresh icon; no palette or duration additions. Reduced motion disables new icon rotation while the paint barrier still runs.                                                                                                     |
| Precision   | Retry reads say Retrying; re-check/refresh says Refreshing. Pending lasts through the read promise. Background polling and unavailable state are not presented as click-owned work.                                                                          |
| Legibility  | Pending accessible name, reserved readable text, fixed-size icon. `appearance.json` and screenshots check 390px viewport and 200% CSS zoom in both motion modes; CSS zoom is not a native browser zoom claim.                                                |
| Forgiveness | Query errors restore the action after React Query retries; account error remains retryable and success clears it. Rapid repeats are guarded; unmount before work cancels queued invocation.                                                                  |

## Reproduce

No script provides a personal path default. Supply `REPO_ROOT`, `PORT`, `BASE_URL`, `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` for the tools installed on the measuring host:

```sh
REPO_ROOT="$PWD" PORT=1458 node docs/evidence/gla-339/server.mjs
# In another terminal with PLAYWRIGHT_MODULE and CHROMIUM_PATH exported:
BASE_URL=http://localhost:1458 node docs/evidence/gla-339/measure.mjs
BASE_URL=http://localhost:1458 node docs/evidence/gla-339/appearance.mjs
REPO_ROOT="$PWD" python3 docs/evidence/gla-339/guard-mutations.py
pnpm --filter @appliance.sh/app exec vitest run src/components/refetch-button.test.tsx src/pages/async-recovery.test.tsx
NX_DAEMON=false NX_SKIP_NX_CACHE=true pnpm verify
```

Do not run mutation probes concurrently with verification or browser measurements. The fixture server copies its source at startup; restart it when changing the fixture. Product changes need no fixture entrypoint or production instrumentation.

## Final measured results and acceptance

| Control / motion | Original median | Fixed median | Fixed max CLS / raw shift |
| ---------------- | --------------: | -----------: | ------------------------: |
| Text / normal    |        172.75ms |       6.60ms |                     0 / 0 |
| Icon / normal    |        170.30ms |       7.80ms |                     0 / 0 |
| Text / reduced   |        171.10ms |      10.95ms |                     0 / 0 |
| Icon / reduced   |        170.65ms |       9.65ms |                     0 / 0 |

All fixed samples retained focus, kept scroll and geometry unchanged, and made exactly one queryFn start after acknowledgment despite rapid repeat activation. The independent negative control produced 0.0648375 standard CLS/raw shift, 364px neighbor movement, focus loss and 200px scroll change. Real-clock retry delays after subtracting 340ms fixture work were 1003.6 / 2001.8 / 4004.4ms. Medians use the mean of the fifth and sixth sorted samples.

**Acceptance: `NX_DAEMON=false NX_SKIP_NX_CACHE=true pnpm verify` GREEN (exit 0).** Full build, typecheck, lint, tests and all Rust build/test/clippy suites passed. App: 31 files, 160 tests (post-gate revision). See `verify.txt`. The first sandbox attempt reached VM tests but lacked permission to write their fixtures under the user's appliance directory; the passing run used sandbox escalation, without source workarounds.

## Gate revisions F1–F5

F1: RefetchButton composes the incoming `onClick` before initiating its read (and respects `preventDefault`). The actual `IconTooltip` regression test passed with plain Button but failed at c630b89 with RefetchButton: expected `closed`, received `instant-open`. Both now close before read work. See `tooltip-before.txt` and the repeatable `no-composed-click` mutant.

F2: All captured paths are scrubbed to `<repo>` in committed logs, and mutation output is scrubbed when captured. Missing `REPO_ROOT` reports an explicit setup instruction.

F3: The repeat-activation test now seeds query cache so React Query cannot hide missing activation guards by merging empty-cache requests. The seeded test passes without the `running` ref (`without-running-ref.txt`), so the redundant ref was deleted. Removing the remaining busy/availability guard fails with two queryFn starts where one is required (`no-repeat-guard.txt`). All four deliberate mutants fail on behavioral assertions; seven component cases pass on production source.

F4: The **movement == 0** assertion is the operative geometry guard. The raw-shift threshold alone is insufficient: the gate's geometry mutants produced only 0.000146/0.000308 raw shift, below 0.01, but were caught by movement.

F5: Reserving the longer pending label deliberately increases the at-rest width of small text Retry buttons from approximately **56.5px to 85.1px**, across about 20 controls. This is an owner-visible tradeoff: wider idle buttons in exchange for no width change on activation. Icon button dimensions remain fixed. The owner may overrule this reservation tradeoff.
