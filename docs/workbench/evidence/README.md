# W1 acceptance and polish evidence

Measured on macOS 27.0.1 / Darwin 27 arm64, Chromium 156.0.8078.4, desktop browser
host fixtures. Viewport 1440×1000, device scale 1, dark scheme; both normal and
reduced motion. Fixture evidence is not live deployment, VM enforcement, or native
picker evidence. The native binding code separately compiled and passed two Rust
filesystem tests.

## Nav CLS: real Workbench item versus design proxy

The GLA-335 harness was reused with its seven fixtures, 10 fresh browser contexts
per fixture per motion setting (140 runs), standard CLS session windows, the same
1440×1000 viewport, and no synthetic nav injection. Apps and Settings contain the
**real Workbench WeightLabel nav item**.

**Real Workbench nav CLS is 0.00001903646 in developer Apps and Settings, in both
motion settings. The design-phase synthetic proxy was +0.01940. This confirms the
GLA-335 variable-length reserve pre-empts that predicted increase; the proxy is
not being substituted for a real measurement.** This is an absolute cold-load CLS
comparison, not a claim that the two figures are identically defined deltas.

| Cold-load scenario   | Normal median | Reduced median | Runs per setting |
| -------------------- | ------------: | -------------: | ---------------: |
| Developer Apps       | 0.00001903646 |  0.00001903646 |               10 |
| Developer Settings   | 0.00001903646 |  0.00001903646 |               10 |
| Machine daemon down  | 0.01002850694 |  0.01002850694 |               10 |
| Stale Catalogue      | 0.00002980903 |  0.00002980903 |               10 |
| Unverified Catalogue | 0.00002980903 |  0.00002980903 |               10 |
| User IPC             |             0 |              0 |               10 |
| VM-lost IPC          | 0.00001903646 |  0.00001903646 |               10 |

**Continuity finding:** Machine daemon-down exceeds the proposed 0.01 gate. Its
median is exactly the same as GLA-335's `after-revision-a` evidence in both motion
settings. This existing Machine-page shift is deferred; W1 does not change it.
Individual samples are retained in [nav-cls.json](nav-cls.json).

## S1/S2 six-property verdicts

| Property    | Verdict and evidence                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immediacy   | PASS, fixture: 10 observations per interaction per motion setting. Normal/reduced median milliseconds: Create 33.80/34.85; validation acknowledgment 13.90/14.70; open row 30.65/31.05; target-change acknowledgment 4.45/4.40. All below 100ms. Backend fixture completion is separate (100ms), not included as a performance claim.                                      |
| Continuity  | PASS for S1/S2 fixture sequence: maximum standard CLS and raw shift sum both 0.00001903646 in either motion setting. Target-save failure including cold load is 0.00203236979 in both settings. Input-excluded shifts remain in raw data. Dialog dismissal restores focus in all 20 runs after Radix commits restoration. Existing Machine finding above remains deferred. |
| Restraint   | PASS: one primary Create entry; no launch, remount, framework initialization, completion animation, or duplicate terminal. Package/Deploy and inspection/session controls have visible unavailable reasons. Named DS motion tokens unchanged.                                                                                                                              |
| Precision   | PASS: canonical symlink/subdirectory root tests; exclusive directory creation/no-overwrite tests; metadata-only writes preserve link/registry bytes. Agent machine and deployment target are separately labeled. Failed target save retains the old binding and global selection. Exact folder preview and mount-mismatch copy are captured.                               |
| Legibility  | PASS, fixture: keyboard Changes/Files/Logs selection, text status and adjacent disabled reasons, long paths at 390×844 and 200% CSS zoom with no horizontal overflow. Same-viewport normal/reduced captures included.                                                                                                                                                      |
| Forgiveness | PASS: all 20 conflict runs retain the name; captures also confirm the parent value; Cancel restores focus without a create call. Native tests show an existing file survives a conflicting create. Failed target saves preserve selection. No automatic remount, retry, launch, or overwritten metadata.                                                                   |

[Individual surface timings](surface.json) and [recovery/zoom results](recovery.json)
retain the samples and raw shifts. A local dialog-centering adjustment avoids a
reduced-motion translated hit-target failure found during testing; final evidence
uses ordinary Playwright pointer clicks, not forced clicks or script activation.

The timing observer records click to the first animation frame containing the
visible updated DOM. Create-entry acknowledgment and the next settled-dialog
control are separate observations; it does not certify physical display latency.

## Acceptance

- `pnpm verify`: **GREEN** (build, typecheck, lint, all TS tests, Rust
  build/test/clippy). Existing VM tests required host filesystem permission; the
  sandbox-only attempt failed with `Operation not permitted`. Full rerun passed,
  including 330 VM tests.
- Desktop native Workbench tests: **2 passed** (canonical root/format ownership;
  exclusive empty-directory creation, invalid paths, no overwrite).
- Workbench direct-route guard: user/admin, user/member, developer/member refused;
  developer/admin admitted only after loading resolves. The same guard wraps list
  and detail, with no global guard change.
- User-navigation branch byte-identical; existing route paths and existing route
  elements unchanged. `/agents`, ordinary deploy source, and MCP server byte-identical.
- SDK schema/source diff: empty. MCP registration list unchanged at **8**:
  `overview`, `deploy`, `deployment_status`, `health`, `logs`, `destroy`, `doctor`, `vm`.
- `/projects/deploy` completed the source-deploy journey in an explicit mock cloud
  fixture without opening Workbench or creating `workbench.json`: folder → review
  → human Deploy → streamed completion → View app. See [capture](deploy-success.png).
  This proves UI independence, not a live cloud deployment.

Static comparisons are in [acceptance-static.json](acceptance-static.json).

## Integration and deferrals

Binding format and host methods are documented in [bindings.md](../bindings.md).
Spine blocks: `packages/app/src/lib/host.ts:344`,
`packages/desktop/src/host.ts:301`, `packages/desktop/src-tauri/src/lib.rs:1`.
W3 baseline hook: `packages/desktop/src-tauri/src/workbench.rs:135`; persistent
Package/Deploy section: `packages/app/src/pages/workbench/detail.tsx:161`.

- W3: real Changes/Files/Logs readers and host-side baseline capture replace
  explicit unavailable stubs. Capture hook is called only for newly remembered
  directories; failures warn without gating launch. W3 owns durable failure state.
- W2: Package implementation, authorization and real result/status.
- Wave 2b: live sessions/intent/steering and workspace Deploy review/execution.
- Native picker launch timing, end-to-end native desktop interaction, and live VM
  mount/session evidence remain native integration checks. Browser fixtures and
  native filesystem unit tests do not certify them.
- Existing Machine daemon-down CLS finding is recorded above, not silently passed.

## Reproduce

Build UI/app dependencies and start the desktop Vite server. Set
`PLAYWRIGHT_NODE_MODULES` to a directory containing `playwright-core`,
`CHROMIUM_EXECUTABLE` to the browser executable, `APP_ORIGIN` to that server, and
`EVIDENCE_DIR` to an existing output directory. Run `node measure.mjs after-w1`,
`node surface.mjs`, `node recovery.mjs`, and `node acceptance.mjs` from this folder.
The nav harness retains the original GLA-335 fixtures and CLS window calculation.
Restart Vite after rebuilding the app library if it retains a stale library entry.
