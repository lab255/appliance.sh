# GLA-340 — W9 mechanism evidence

Base: `5172323b`. Local execution: macOS arm64. Platform-stubbed lock tests faithfully schedule filesystem observations for Windows, Linux, and macOS branches; they are not a Windows runtime claim. Draft PR Windows CI is a separate platform check. No reviewer approval or merge claim.

## Entitlement investigation and product decision

The proposed store-before-anchor explanation is disproven for the failing mutation path: `mutateStore` already writes the independent protected anchor **before** renaming the store, within its acquired lock. The retained Windows failure is a same-sequence head-hash mismatch in a child mutation, not an unlocked public read. An independent anchor remains necessary for rollback detection; combining it with the ordinary store would weaken that property.

The actual proven defect is lock ownership: after an `EEXIST`, the old implementation treats `ENOENT` as stale and unlinks the pathname later. A successor can acquire that pathname in between. A stale `stat` snapshot likewise authorizes unlinking a successor; age alone also evicts a still-live owner. Each creates overlapping critical sections. The precise interleaving in the historical CI event was not instrumented, so this is a proven mechanism consistent with that signature, not an attribution of every historical failure.

Deterministic teeth:

- `lock-before.txt`: original production code, six scheduled successor-loss tests fail (two observations × three platform branches), plus live-owner age eviction fails; five existing controls pass.
- `race-before.txt`: restored `5172323b` lock code loses writer B's real signed mutation, leaving only writer A; the changed >60s refusal test also fails. The hook schedules B after A's CAS check, before A publishes its anchor. No sleeps or timing probability.
- `race-after.txt` and `entitlements-after.txt`: signed mutation preservation, old-lock refusal, ownership interleavings, owner diagnostics and existing rollback/tampering/cross-process tests pass. Subsequent full verification also includes the added race test.
- Windows sharing/permission contention still retries within the deadline, Unix permission errors still fail immediately, and timeout never authorizes a write.

**Product-behavior decision, manager-authorized:** crash recovery is now manual. Acquisition never reaps a lock. Timeout names its exact path, observed age, owner PID, process-start hint and current alive/dead/unknown observation, and instructs removal only when no appliance process is active. PID reuse is explicitly noted. Inaccessible/incomplete lock metadata is reported as unknown. A refusal to write is preferable to lost trust-store mutations. Identity re-read/unlink and rename takeover retain a TOCTOU because Node has no conditional pathname deletion. OS advisory locking is the structural future option, deliberately outside this lane; the owner may overrule this product tradeoff.

Surfaces: CLI install/uninstall, entitlement revoke and runtime usage stamps acquire this shared lock. Desktop install/uninstall/revoke/run use that CLI sidecar too. `run_appliance_capture` in `packages/desktop/src-tauri/src/lib.rs` preserves stderr in its returned error; the Settings revoke catch in `packages/app/src/pages/settings.tsx` renders the error in a `role="alert"`. Lock enforcement is shared; the UI propagation statement is source inspection, not a GUI automation claim. Public `readEntitlementStore` remains unlocked; crash/interrupted-pair recovery is not redesigned here.

## Credhelper cancellation

The deadline starts before metadata/browser work. The test's one-second wall-clock allowance includes ACL/file work and callback setup. Once elapsed, the receive loop checks timeout before cancellation. Production timeout precedence is unchanged; the cancellation test now freezes an injected monotonic clock, and a separate controlled-boundary test verifies real timeout behavior. The port mutex protects exclusivity rather than data, so tests recover its guard after poisoning instead of cascading a prior assertion failure.

- `cancellation-wall.txt`: restore the original wall clock and inject 1100 ms signout delay; the exact original assertion fails with `Sign-in timed out; retry` versus `Sign-in cancelled`.
- `cancellation-frozen.txt`: the identical delay with the frozen clock passes. `cancellation-control.py` reproduces both and restores the fixture in `finally`.
- `poison-before.txt`: restoring `PORTS.lock().unwrap()` fails the intentional failed-test recovery regression with `PoisonError`.
- `credhelper-after.txt` plus full verification: cancellation, controlled timeout, poison recovery and existing auth tests pass. This is a faithful local scheduling reproduction, not a Windows ACL performance measurement.

## API-server investigation (no mitigation)

`loopback.py` deliberately starts the same entire api-server suite twice concurrently while binding/listening on `127.0.0.1:0` and immediately checking `lsof` with each socket still held. Both suites pass; 346 observations find the expected owner and zero foreign owners. This does not prove collisions or interception can never occur.

`ARDAgent` binds wildcard **addresses** at port 3283, not arbitrary ports; its probe returned non-HTTP. Several node/bb listeners return 404 or 200. Four loopback processes resolve to Claude Code version 2.1.325 and answer `407 Proxy Authentication Required`, with `Proxy-Authenticate: Basic realm="srt"` and the identical body SHA256 `933b971c6388d594a23fa1559825db5bec8ade2db1240aa8fc9d0c684949e8c9` (`proxy-listeners.txt`, `http-sandbox.txt`, `http-elevated.txt`). That identifies a source of 407 responses, **not** interception of the test requests.

The discriminator used 100 newly allocated, held HTTP listeners plus curl in the default sandbox and 100 elevated: all 200 responses carry the expected marker; zero interception observed in either mode. Historical evidence retains status assertions only, so no historical header/body fingerprint comparison is possible. W6's retained `docs/evidence/gla-338/verify-http-isolation.txt` explicitly records an elevated 407 failure; a sandbox/elevated binary explanation is unsupported. The mechanism of the three historical sightings remains unresolved. No bind retry, connect verification, suite serialization or test-harness change ships. This is a non-reproduction report for the card, not closure by green reruns.

## Verification scope

`run.py` scrubs workspace/home/temp paths before writing subprocess output. Probe output excludes usernames, response bodies and environment credentials. `verify.txt` is the uncached default-sandbox run: TS build/typecheck/lint/tests and credential-store/helper Rust pass, VM tests fail on sandbox EPERM under the runtime home (and dependent missing-file/traffic assertions). The authorized full elevated rerun uses `NX_DAEMON=false NX_SKIP_NX_CACHE=true pnpm verify`; `verify-elevated.txt` records GREEN (exit 0), including all 330 VM tests. Draft Windows CI remains a separate platform check.

## Canonical Windows helper pin

The clock-injection source change necessarily changes the packaged credential-helper bytes. Draft validation run `44013232735`, Linux producer job `133804943047`, built SHA256 `90315483cf47724358fcf8a6326939eb4f1dda65a5ea11fd16f2d5995df41798` and rejected the old baked pin. The downloaded `credential-helper-linux` artifact's executable independently hashes to that exact value. The pin is updated from that canonical Ubuntu CI artifact (not a local build); `digest-check.txt` verifies it through the repository's artifact-consumer check. The subsequent CI run must reproduce the pin and execute the canonical artifact on Windows.
