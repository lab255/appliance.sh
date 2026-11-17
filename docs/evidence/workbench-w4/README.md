# W4 — F2 observation and inspector regression evidence

Scope: Workbench session observation using the existing VM agent registry and global terminal provider. No launcher, structured approval adapter, readiness bridge, or session engine is introduced. The detail change replaces only the Sessions placeholder; PackageSection and the inspector implementation are unchanged.

## Product decision: visible stopped controls

**Judgment call: ship visible, stopped/gated input, not hidden controls.** UX Rev3 §2 requires an explicit “Interact with agent” transition and discoverable read-only observation; it does not prescribe hiding controls. The terminal stays visible and selectable, while its central write boundary suppresses input. Interact remains visible (focusable `aria-disabled` with a real activation guard when no live connection exists), with an adjacent reason. This reduces the “broken control” failure mode by explaining the mode and next action, while avoiding the discovery cost of hiding interaction. Both the Workbench and global drawer show the same provider-owned mode. An existing Interactive tab remains truthfully Interactive when focused from Workbench. Separately, Hide observation / drawer Hide preserves PTY, scrollback and agent execution; Stop agent is a confirmed host operation; existing End shell remains a confirmed destructive action. Stopping never claims rollback or containment.

## Authorized shared seam

Manager thr_zgc56nj9b2 explicitly approved the provider/drawer extension: a Workbench-only guard would be decoration if the shared tab could still write. Bounds honored: ordinary callers retain interactive input; drawer mount/dismiss remains immediate with no animation/lifecycle changes; labels agree; only the detail Sessions region changed. W5 confirmed its actual detail changes are readiness prop/hook, inspection anchor and PackageSection props, with no overlapping Sessions edit. The manager commissions the independent Opus review and exclusively controls merge.

## Verify-time regression probes

`workspace-inspector.test.tsx` mounts the real inspector directly and through WorkbenchDetailPage with a fixture host (only sessions transport is excluded). Both variants assert:

- Generated-only `.appliance/agent-results/agent-example.json`: `0 files · 1 generated changes hidden`; disclosure names `.appliance/agents.json`, `.appliance/agent-results/*`, `.appliance/.agents.*`; `No changes since workspace baseline` absent.
- Include generated exposes the hidden tree row and changes the count to `1 files`.
- Negative control: genuinely unchanged snapshot shows `No changes since workspace baseline`.
- Good snapshot followed by rejected refresh: `Previous snapshot is stale — captured 2026-11-17T02:00:00Z; refresh failed`, `Comparison unavailable`, no clean-comparison claim. The good pre-failure state is a second negative control.

`terminal-sessions-provider.test.tsx` uses a fixture PTY and mocked xterm emission to exercise the actual provider write boundary. Typing, bracketed paste, Enter, Ctrl-C and arrow sequences make zero writes in Observe. Deliberate interaction writes; returning to Observe blocks again. Dedupe preserves mode; another VM cannot inherit authorization for the same guest ID. Hide does not close the transport; focus reopens the existing session. Ordinary Agents callers remain interactive. Two mounted mode surfaces agree. Connecting Interact retains focus and is guarded, then the same button works after connection (negative control).

Mutation proof (`python3 docs/evidence/workbench-w4/mutation-probes.py`, source restored in `finally`):

```text
premature-observation-focus exit=1 detected=true
provider-write-gate          exit=1 detected=true
generated-hidden-count      exit=1 detected=true
stale-clean-comparison      exit=1 detected=true
dropped-directory-prop      exit=1 detected=true
```

Individual failures are committed as `.txt`; the final unmutated suite has 9 passing tests. These tests run through the existing app Vitest target under `pnpm verify`.

## Browser measurements and boundaries

macOS arm64, Chromium 1248 headless, 1440×1000, dark UI; both `no-preference` and `reduce`. Browser screenshots contain only the application viewport; no OS surface intrudes. `sessions-audit.html` imports the production components with explicitly labelled fixture VM/PTY transport. No live agent authorization or containment certification is claimed. Start the app Vite fixture server on an available port. Every browser script requires `PLAYWRIGHT_MODULE` (module path, file URL, or resolvable package), `CHROMIUM_PATH` (browser executable), and `W4_BASE_URL` (HTTP(S) server base URL). No machine-specific module path, browser path, or port is defaulted. Missing configuration fails before launching the browser; `config-validation.json` records all five scripts failing clearly with all variables missing and each variable missing individually. The configured `refusal.mjs` run is the positive control. Restart Vite after source edits on this host (file watching served stale transforms during the initial probe).

S3 uses real 65-second timers, ten independent pages per motion setting. A reserved fixture-only acceptance region changes from waiting to `Session accepted · agent-fixture · Observing · read-only`. F3 has no structured event bridge; this is a presentation seam, not a successful live launch. The negative control removes BOTH the feed and enclosing-panel reservation before acceptance. The initial attempt removed only the feed, and the enclosing min-height correctly absorbed the shift; it was discarded as an ineffective negative control.

```text
S3 acceptance, no-preference: n=10 CLS median=0 max=0; raw median=0 max=0
S3 acceptance, reduce:        n=10 CLS median=0 max=0; raw median=0 max=0
Unreserved negative control: CLS/raw=0.003162962962962963 in both modes
S3 reservation: nonzero → 0 on this surface
```

The negative control magnitude differs from design-phase 0.02164 because this fixture has different geometry. The supported claim is: reservation takes this surface’s delayed acceptance from nonzero to zero, and the probe detects shift. This does not reproduce the design-phase magnitude or establish a live acceptance adapter.

Interaction acknowledgments use click/key activation to the frame after visible copy. Observe/Interact use pointer clicks; Stop uses Enter on the existing confirmation. Backend fixture completion is separate (300ms). Ten samples per action/motion, each below the 100ms median gate:

| Motion        | Observe median ms | Interact median ms | Stop median ms |
| ------------- | ----------------: | -----------------: | -------------: |
| no-preference |             29.75 |              30.10 |          24.20 |
| reduce        |             31.75 |              31.70 |          22.30 |

```text
Observe initial raw shift before mode-region reservation: 0.020678110532407406
Observe after reservation: raw max 0.0007663599537037038 in both modes (final focus-fixed revision)
Observe/Interact/Stop standard CLS: 0 for all measured scenarios
Interact/Stop raw shift: 0 for all measured scenarios
Observe + Hide trace: [attach], zero write/close/stop
Deliberate Interact negative control: PTY write events present
Failed Stop: exactly one stop per explicit confirmation; visible failure, session retained
```

## Six-property assessment

| Property    | Evidence and limit                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Immediacy   | 10-run medians above; Observe and confirmed Stop use paintPending before transport work.                                                                                       |
| Continuity  | S3 reservation/negative control; mode-region before/after; shared provider keeps session/scrollback through Hide. Drawer stays still and detaches immediately.                 |
| Restraint   | No progress percentage, invented approval, auto-launch or acceptance authorization. Fixture boundaries are visible.                                                            |
| Precision   | Zero-write guard and deliberate-input control; stale status labelled; live VM/registry required for Observe/Stop; full directory mount must match.                             |
| Legibility  | Mode, disabled reasons, security posture and separate Hide/Stop visible; app-scoped 1440×1000 and 390×844 captures.                                                            |
| Forgiveness | Return to observation; Hide is reversible; failed Stop remains visible and requires another confirmation. Shared confirmation pointer limitation is recorded separately below. |

## Shared confirmation probe

`confirm-repro.mjs` exercises only the existing ConfirmProvider via `?confirm-only`, without mounting SessionsObservation. Its result is recorded in `confirm-repro.json`. Any confirmed shared Dialog defect is outside this PR by manager ruling; no shared UI primitive changes are included. Normal-motion pointer confirmation records pointerdown/up/click and `confirmed:true`. Reduced-motion pointer confirmation times out (no pointer events/confirmation); Enter on that same button records `confirmed:true`. This is reproducible without Workbench. The manager owns the separate shared Dialog follow-up; this PR documents the limitation and working keyboard path.

Additional focus/forgiveness checks (`extra-checks.json`): gated Enter makes zero calls and retains Interact focus; Cancel Stop makes zero calls and restores Stop focus; Hide records only `attach` and restores Observe focus. Before the observation-only early-focus guard, a fast fixture host stole the opener and Hide focused the page body; restoring that defect fails the committed guard. Both motion settings show no horizontal overflow at 390×844. Zoom captures use CSS zoom 2, explicitly not native browser zoom.

## Acceptance verification

Uncached command: `NX_DAEMON=false NX_SKIP_NX_CACHE=true pnpm verify`. **Delta outcome: `verify: GREEN`, exit 0** (`verify-delta.log`); the original successful run remains in `verify.log`. The full final run used filesystem access for Rust fixtures under `~/.appliance/vm`; the earlier sandbox-only permission failures are retained in `verify-sandbox-failure.log`. No tests skipped; no cached acceptance. Earlier attempts stopped at formatting of newly generated evidence, which was corrected before the final run.

## Delta gate rework

- HIGH-1: refused input produces “Input not sent — observing read-only. Choose Interact with agent.” in the shared mode region’s `role=status`, visible in the drawer. It expires after three seconds and clears when entering Interact. The cursor stops blinking in Observe. xterm `disableStdin` is false so events can reach the central provider guard and receive feedback; no refused input is forwarded or stored in metadata. Browser typing, Enter, Ctrl-C and paste show the notice with zero writes in both motion settings; deliberate Interact writes and restores blinking (`refusal.json`).
- MEDIUM-1: the new jsdom composition test mounts real SessionsObservation plus provider, clicks Observe, emits PTY input, and checks zero writes and the read-only label; Interact supplies the negative control.
- LOW-1: input after dedupe checks the live write gate as well as metadata/label.
- MEDIUM-2: all browser scripts use the required portable environment loader described above.

```text
missing-refusal-notice: exit=1 (role=status notice assertion fails)
missing-observe-default: exit=1 (Workbench default-observation guard fails)
dedupe-gate-label-drift: exit=1 (expected 2 writes, received 1)
```

The manager explicitly accepted `sessions-audit.tsx`, `sessions-audit.html`, and the `acceptanceFixture` prop as a development-only fixture harness for this PR. They are not a product surface and the library entry does not import the harness; no relocation is included.

Delta uncached verification evidence:

```text
NX_DAEMON=false NX_SKIP_NX_CACHE=true pnpm verify
✓ src/pages/workbench/workspace-inspector.test.tsx (6 tests) 807ms
✓ src/providers/terminal-sessions-provider.test.tsx (3 tests) 625ms
==> verify: GREEN
exit=0
```
