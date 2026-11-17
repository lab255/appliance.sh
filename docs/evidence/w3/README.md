# W3 host inspection evidence

This is the dedicated M3 trust-boundary change. It must receive its own review gate.
Rebased onto W1 squash `912c2ae`; the detail shell, open/create capture hook, and read-time baseline status are integrated. Capture and workspace I/O run off the event loop. The inspector reads persisted host state on refresh/reopen; unused baselineWarning projection enrichment is removed, so listings do not parse baselines; the obsolete warning fallback is removed.

## Trust boundary and adversarial check

`packages/desktop/src-tauri/src/inspection.rs` names the claim at `location`:

> The agent cannot rewrite the baseline; a human comparing changes against it sees host-side truth.

The host resolves the directory, uses collision-free encoded directory keys under desktop app data,
and creates an attempt marker before capture. A failed or corrupted capture cannot be silently
replaced by later agent output. There is no reset/rebaseline command. Snapshot content/hash/mode
comparison never depends on the mutable workspace `.git` or `.appliance` records. Initial Git
status is a separate informational observation, obtained through libgit2 without external
filter/hook callbacks; it does not authorize any action or supply the comparison baseline.

An agent would try to:

- Rewrite `.git/HEAD`, the index, `.appliance/agents.json`, or a fake project-local baseline.
  These change only workspace inputs; the host baseline remains in a separate store.
- Guess the host store path and traverse a symlink or `..`. The VM only receives its project
  mount. Host traversal uses cap-std directory capabilities; symlinks are recorded without
  following their targets. Preview paths are exact keys into a captured snapshot, never filesystem
  paths to open. Snapshot IDs reject reading a different refresh than the displayed header.
- Configure a Git clean/fsmonitor command to execute on the host. No Git subprocess
  is invoked; a regression fixture checks these malicious settings do not create a sentinel.
- Cause a later broad mount to expose an existing baseline. Desktop VM bring-up rejects both
  ancestors and descendants of app data; inspection also checks existing VM mounts. The rejection
  names the rejected directory and app-data directory and recommends a narrower project folder.
- Change only the tail of a large file, after the retained preview. Full-file SHA-256 detects the
  change; the reader explicitly labels the displayed diff as truncated.

The code comment and UI both state that the guarantee weakens on a host the user does not control.
Out-of-band host-CLI remounts remain host-operator authority, not something this app can prevent;
Overlapping mounts are rejected at desktop mount time, and inspection fails closed while an overlapping devMount is recorded. Each new baseline now carries an HMAC-SHA256 tag over its exact bytes and host storage location, using a 32-byte OS-random key held only in the OS keychain. Every baseline load verifies that tag, including reopen, refresh and file preview. A write through a previously overlapping mount is detected after the mount narrows: comparison is unavailable with an authentication failure reason. Missing tags (including old unsigned baselines), missing keys and denied keychain access fail visibly; reads never generate replacement keys or recapture. File views remain available independently, with the comparison failure disclosed.

This authenticates the captured bytes, not their semantic quality or freshness. A hostile host operator with keychain access remains outside the guarantee; deletion is denial of service, and replay of the identical authentic capture at its original location is not detected. Mount-containment and attempt-once behavior are unchanged. No live hostile-VM containment certification is claimed by these tests.

## Review locations

| Location                                                        | Boundary comment / role                                                                                                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop/src-tauri/src/inspection.rs:103`              | “The agent cannot rewrite the baseline; a human comparing changes against it sees host-side truth.” The following lines state the remote-host and host-CLI-remount residuals. |
| `packages/desktop/src-tauri/src/inspection.rs:86`               | Mount protection is independent of baseline availability; never share desktop app data into a VM.                                                                             |
| `packages/desktop/src-tauri/src/inspection.rs:320`              | Workspace-open capture is attempt-once; refresh must never silently move the baseline.                                                                                        |
| `packages/desktop/src-tauri/src/workbench.rs:174`               | Host capture completes (or records failure) before open/create returns.                                                                                                       |
| `packages/desktop/src-tauri/src/inspection.rs` — `refresh_from` | Inspector refresh reads host baseline status, including reopen; workspace listings no longer parse baselines.                                                                 |
| `packages/app/src/pages/workbench/workspace-inspector.tsx:241`  | Remote-host caveat displayed beside the host-side baseline label.                                                                                                             |

## Approved mount-containment extension

Fable 5 PM authorized the guard as part of W3, with PM²'s requirement for concrete rejection copy
and independently reviewable audit evidence. This is a mount-containment guard, **not** a
baseline-I/O launch gate. Failed baseline capture still permits launch with the warning.

Audit of existing flows:

- `packages/app/src/pages/machine/runtime-detail.tsx`: `mountPath` initializes to `null`;
  the native directory picker supplies a selected mount. Bring-up passes
  `{ mount: mountPath ?? undefined }`; there is no automatic home/root mount.
- `packages/cli/src/appliance-vm.ts`: `.option('--mount <path>', ...)` has no default;
  `mount: opts.mount` is forwarded unchanged.
- `packages/cli/src/utils/sandbox.ts`: `ensureSandboxVm` mounts the resolved `projectDir`.
- Local VM configuration audit: `appliance: devMount = None`;
  `appliance-runtime: devMount = None`.

No built-in or observed flow mounts an app-data ancestor. Explicitly selecting home/root now
produces the concrete rejection; choosing a narrower project directory preserves the workflow.

## Validation

Host command (desktop bundle resources are irrelevant to these library tests):

```sh
TAURI_CONFIG='{"bundle":{"resources":[],"externalBin":[]}}' cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml inspection::tests --lib
```

Inspection result: **11 passed, 0 failed**. Full desktop library suite: **71 passed, 0 failed**. Cases cover immutable capture, corrupt/missing baseline,
failed-attempt persistence, dirty initial contents, mutable Git/agent metadata, external symlinks,
malicious Git filters, dirty Git state separate from since-baseline edits, empty/non-Git directories, large-file tail changes, composed over-budget/oversized scans, and text/deleted/binary/
large/missing-baseline preview semantics.

The sentinel is `<fixture-root>/filter-executed`, outside the working tree and initially absent.
The configured clean filter is `touch <fixture-root>/filter-executed`; only executing that command
creates the file. A separate `workspace/dirty.txt` receives the same-size edit and changed mtime
that force content filtering. The test checks **sentinel absence**, not the dirty work-file change.
With fsmonitor disabled in the reverted variant, the sentinel's creation is causally downstream
of the clean filter. Restored libgit2 leaves it absent.

Mutation test (performed, then production restored): replacing libgit2 with the former
`git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath= status --porcelain=v1 --ignore-submodules=all`
executed the repository's **clean filter** and produced:

```text
Repository-configured command executed on the host
test result: FAILED. 0 passed; 1 failed (mutation variant only)
Restored production libgit2 implementation byte-for-byte.
```

The original fixture initially lacked teeth: its changed file size let Git skip content filtering.
The final fixture uses a same-size edit and explicit mtime change, configures a clean filter and
fsmonitor sentinel, and asserts the sentinel is absent before checking status output.
The reverted subprocess variant fails even with fsmonitor disabled; restored libgit2 passes.
`check-filter-mutation.py` reproduces this temporary mutation and restores production in `finally`.

The composed test starts from a successful empty snapshot, adds two files larger than the retained
per-file preview, and exceeds the scan preview budget. The production refresh pipeline returns an
explicit error, retains the old snapshot ID, and does not produce an empty successful comparison.
The browser check verifies a **stale capture timestamp + refresh-failed label**, and confirms the
previous empty snapshot no longer presents “No changes”. See [composed stale state](./composed-stale.png)
and [extra-checks.json](./extra-checks.json).

`NX_DAEMON=false NX_SKIP_NX_CACHE=true pnpm verify`: **GREEN** on the final integrated tree. The daemon/cache are disabled because filesystem watchers previously retained obsolete transforms/declarations.
The full run needed normal host permissions because existing VM tests create fixtures under
`~/.appliance/vm`. An earlier sandbox run failed those fixture writes. An infra timeout under
concurrent builds passed on rerun (44 tests); the UI token check caught and fixed shorthand
hover syntax. No thresholds or tests were weakened.

## Six-property polish evidence

Actual `WorkspaceInspector` component with an explicitly simulated host (200 ms response delay),
Chromium 1248, macOS arm64, 1440×1000, dark mode. This is **fixture UI evidence**, not VM evidence.
The frozen component hash and source revision are recorded with individual observations. Fixture response-presentation medians are 246–248 ms, reported separately from acknowledgment; no native filesystem completion budget is claimed. The ~15 ms acknowledgment medians exclude native baseline parsing. The reviewer measured 60 MiB retained content producing 251 MB JSON and a 434 ms load; JSON number-array storage and repeated inspection parsing/cache work are carded follow-ups. The on-disk format is unchanged in this delta: no encoding change, version bump, or migration. Individual observations and raw input-associated layout shifts are in [measurements.json](./measurements.json).

| Property    | Evidence / result                                                                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immediacy   | 10 observations each for tab, file, diff, binary, and large selection in each motion preference. Medians below; all under 100 ms. Async selection/refresh paint pending state before host work.                                                                                               |
| Continuity  | Standard CLS and raw shift sum both **0** for delayed text, binary, and large arrivals. An actual 1 MiB retained preview arrival also has CLS 0 and no raw shifts. Fixed header/preview/tab-body space. Refresh kept reader scroll at **1150 → 1150** in both configurations.                 |
| Restraint   | Standard DS Tabs only; no stream animation, forced tail-follow, launch, reset, revert, or write controls.                                                                                                                                                                                     |
| Precision   | Host tests cover baseline tampering and degraded comparisons. Generated registry/results hidden by a visible overridable filter. Initial dirty Git status shown separately. Workspace-wide labels, no invented per-agent attribution.                                                         |
| Legibility  | Keyboard tab arrows, tree arrows/Enter, and focused diff PageDown passed. Full paths and textual +/- lines. Large-file withheld/load/truncation labels checked. No horizontal page overflow at 390px or 200% zoom; screenshots attached. Loaded large-file refresh retained scroll 800 → 800. |
| Forgiveness | Failed refresh retains previous diff and labels its capture time and failed operation; missing baseline never renders “No changes”. Retry is deliberate, preview text supports native selection/copy.                                                                                         |

| Selection | Normal motion median ms | Reduced motion median ms | n per column |
| --------- | ----------------------: | -----------------------: | -----------: |
| Tab       |                   15.40 |                    14.30 |           10 |
| File      |                   14.40 |                    14.15 |           10 |
| Diff      |                   12.80 |                    14.50 |           10 |
| Binary    |                   13.60 |                    14.20 |           10 |
| Large     |                   13.45 |                    14.05 |           10 |

Screenshots: [reader](./inspector-no-preference.png), [reduced motion](./inspector-reduce.png),
[large withheld](./large-no-preference.png), [narrow](./narrow-no-preference.png), [390px](./narrow-390.png), [200% zoom](./zoom-200.png).

Reproduce: run `pnpm --filter @appliance.sh/app exec vite --host 127.0.0.1 --port 1443`,
then run `node docs/evidence/w3/measure.mjs` with `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE`
pointing to the installed browser tooling. `extra-checks.mjs` repeats the zoom/narrow/large-refresh checks. The harness entry is `packages/app/inspection-audit.html`;
it is not imported by the application entry point. Restart the dev server after source edits in hosts where filesystem watchers do not invalidate transforms. It exercises the actual reader component.

## Limits / deferrals

- Logs remains an explicit integration stub. No result parsing or agent attribution is invented.
- Captures are bounded scans, not atomic filesystem transactions. All surfaced bounds give concrete counts and a next step; truncation states how much of each side is shown. The UI says “Live files may change”.
  The host retains up to 1 MiB per file, hashes the full content, and labels truncated textual diffs.
- More than 128 MiB retained previews, 50,000 entries, or depth 128 fails the scan explicitly;
  previous data remains stale. Files exceeding the 4 GiB scan limit are explicitly unreadable.
  A larger streaming/blob-backed store is deferred; no files are silently excluded by a Git ignore rule.
- Baseline retention/garbage collection and human rebaseline UX are deferred; no automatic moving baseline. Product risk: attempt-once capture plus no rebaseline permanently disables comparison for projects exceeding scan bounds (for example node_modules-scale trees), even after the tree is reduced.
- Storage encoding and parsed-baseline caching are carded follow-ups; the existing format remains unchanged. Removing unused projection enrichment eliminates per-listing parsing only. Keychain-HMAC baseline authentication is also carded; exposure history is not detected.
- Browser evidence uses fixtures, not a native VM session. Windows/Linux host builds and live hostile-VM
  testing are not claimed. Remote-host/operator authority remains the stated residual.

## Gate delta

The reviewer ran the mutation personally and constructed the composed case at production limits — the findings are the value of an adversarial brief working as designed, not a black mark.

Generated-only edits now disclose their hidden count and patterns; an unchanged-workspace claim requires both visible and hidden counts to be zero. The browser regression verifies three hidden paths (registry, result, lock), then reveals all three with the filter override. See [generated disclosure](./generated-hidden.png). The composed stale screenshot uses the current production MiB wording (fixture budget 1 MiB). Capture comments now acknowledge independent Agents-page launches and possible prior agent output. Missing mount paths name the rejected directory.
