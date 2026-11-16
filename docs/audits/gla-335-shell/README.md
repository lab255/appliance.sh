# GLA-335 cold-shell layout reservation

**Superseded after-series and readiness behavior:** see the [PR review revision](revision/README.md) for the final cold-only latch, restored role policy, chosen deadline, footer evidence, and reruns. The original pack below is retained as the initial implementation record.

Base: `a6d79c6` (main at worktree creation). Product changes are confined to
`packages/app/src/components/layout/app-shell.tsx`.

## Fresh paired measurements

Before: **main `a6d79c6`**. After: **`d72e494`**. Each cell is the median of ten
cold loads at 1440×1000; the gate stays **≤0.01**. There are 140 before and 140
after samples, plus 40 extra-navigation samples. No uncaught browser errors.

| Scenario / fixture                                                   | Before normal | After normal | Before reduced | After reduced | After verdict |
| -------------------------------------------------------------------- | ------------: | -----------: | -------------: | ------------: | ------------- |
| Developer Apps — unconfigured mock, includes Setup                   |    0.12316963 |   0.00001904 |     0.12316963 |    0.00001904 | PASS          |
| Developer Settings — unconfigured mock, includes Setup               |    0.12316963 |   0.00001904 |     0.12316963 |    0.00001904 | PASS          |
| Machine — legacy daemon-down mock (MicroVMs retained)                |    0.14573826 |   0.01002851 |     0.14573826 |    0.01002851 | FAIL          |
| Stale Catalogue — mock                                               |    0.01015608 |   0.00002981 |     0.01015608 |    0.00002981 | PASS          |
| Unverified Catalogue — mock                                          |    0.01015608 |   0.00002981 |     0.01015608 |    0.00002981 | PASS          |
| User Apps — production host, IPC replies, no mock-host               |    0.01015608 |   0.00000000 |     0.01015608 |    0.00000000 | PASS          |
| Missing VM — production host, empty inventory and not-created status |    0.11638035 |   0.00001904 |     0.11638035 |    0.00001904 | PASS          |

[Summary including maxima](summary.json) · [Before raw shifts](before.json) ·
[After raw shifts](after.json) · [+1 row](after-extra1.json) · [+20 rows](after-extra20.json).
Raw shifts include recent-input entries and trusted input timestamps; they are
not discarded from the evidence when excluded from cold CLS.

## Attribution

The GLA-331 historical baseline on `00a0bdd` was **0.09698362**. The prototype
added a separate **+0.01939672** navigation-row contribution, for **0.11638035**
total. These are distinct obligations. This PR fixes the pre-existing shell
failure and prevents cold navigation resolution from depending on the number
of rows. It does not claim ownership of the prototype's Workbench code.

Historical user-mode CLS was **0.01015608**, reproduced through the production
Tauri host adapter without mock-host. Its shifting node was `main#main-content`:
header growth moved its top from **41px to 59px**. Historical scenario 11 was
**0.11723245**, comprising shell 0.11638035 plus a second 0.00085210 shift.
Source: `chore/artifacts` at `682c355`, `gla-331/`.

## Implementation

- Reserve the header from first paint using `min-height: calc(1lh + var(--spacing) * 9 + 3px)` and `text-sm`. The switcher uses a 20px line box, 12px vertical padding, and 2px of borders; the header adds 24px vertical padding and its 1px bottom border. Total: 59px at the default scale. Font line-height and spacing token changes flow into the reserve; taller content can still grow naturally.
- Keep the existing full-height sidebar navigation area reserved while mode,
  selected cluster, and role resolve. Hidden links cannot receive focus or
  appear in the accessibility tree. Reveal the settled list without a
  provisional short list, skeleton, opacity recipe, or assumed row count.
- Reserve the mode footer and allow long navigation lists to scroll within
  the sidebar, rather than growing the surrounding shell.

The navigation data policy, route permissions, installation handlers, and
deployment handlers are unchanged. This reservation addresses cold resolution;
it does not promise zero CLS for arbitrary live additions to an already-visible
navigation list.

## Measurement protocol

Chromium via Playwright, fresh browser context for every cold load, 1440×1000,
DPR 1, dark mode. Ten samples per scenario per motion configuration, including
`prefers-reduced-motion: reduce`. CLS uses the maximum session window (1s gap,
5s maximum), excluding recent-input shifts only from the score. Raw shifts,
source rectangles, trusted input timestamps, and errors remain in JSON.
Screenshots use the same viewport before and after.

The current unconfigured developer fixture includes Setup and can resolve the
header in two steps, so its fresh baseline must not replace the historical
0.09698362 number. The production-host user case uses deterministic IPC replies
(empty config, no VM, persisted user mode); it does not enable `mock-host` and
is not a live native VM test. The empty-VM case also uses production-host IPC replies; catalogue and
legacy daemon-down cases use existing mock-host fixtures. These are shell-equivalent
surfaces, not the unmerged Workbench.

To reproduce, use `a6d79c6` for the before build and `d72e494` for the after
build (keep the measurement scripts available in both checkouts). Build the
workspace with Nx cache disabled, restart the desktop
Vite server on port 1435, then run `node docs/audits/gla-335-shell/measure.mjs before`
or `after`. Set `PLAYWRIGHT_MODULE` to an installed `playwright-core` module and
`CHROMIUM_EXECUTABLE` to its Chromium binary when they are not on the default
resolution path. `APP_URL` and `EVIDENCE_DIR` override server and output paths.
`SCENARIOS` selects comma-separated case names. `EXTRA_NAV=1` or `20` injects
synthetic navigation rows into the browser's bundle response; no product source
or permissions policy is changed. Injection is asserted before recording.

## Audit notes

- An initial after attempt still served the old build because Nx reused cached
  outputs. Those samples are quarantined as `discarded-stale-server` and are
  excluded from the after series. The harness now asserts the reserved header
  class for all after runs. Replacement runs use an uncached rebuild.
- The original `vm-lost` label on the daemon-down fixture was incorrect: that
  fixture retains MicroVM inventory. It is relabelled `machine-daemon-down` in
  the combined baseline; `vm-lost-ipc` explicitly returns an empty VM inventory.
- Capture review found that the first empty-VM IPC fixture omitted its status
  response, leaving page content on the loading skeleton. That case was replaced
  with matched before/after runs returning `exists: false` and asserting the
  settled “Not created” status. Its initial samples are excluded. The replacement
  baseline uses the preserved original `a6d79c6` build output.
- The first sandboxed verification failed ten VM tests because they could not
  create fixtures under `~/.appliance/vm`. Full verification was rerun with the
  necessary filesystem access and Nx cache disabled.

## Verification

`NX_DAEMON=false NX_SKIP_NX_CACHE=true pnpm verify`: **GREEN**, 1,474 TypeScript
and 362 Rust tests. Product source revision: `d72e494`. The three added shell
regressions cover independent mode, cluster, and role readiness. See
[verify.txt](verify.txt) for the complete final-source verification log.

The +1 and +20 synthetic navigation-row checks each contain ten cold samples
per motion configuration. Both medians are **0.00001903646** in both settings.
In all forty runs the computed switcher is **34px** (20px line-height + 6px top
padding + 6px bottom padding + 1px top border + 1px bottom border), and the header
is **59px** (34px + 12px top padding + 12px bottom padding + 1px bottom border).
The spacing token computes from `.25rem`; the header and switcher both use
14px `text-sm` with 20px line-height. This confirms the CSS derivation in normal
and reduced motion rather than relying on the historical shifted y-offset.

## Residual and deferrals

**Machine daemon-down remains a Continuity failure** at **0.01002850694**, over
the unchanged **≤0.01** gate. Its fresh baseline was **0.14573826389**. The named
source is `div.appliance-ui.grid[aria-busy=true]`, containing the
`role=status` / `aria-label="Checking Sandbox"` skeleton. It moves from
**y203 to y255 (+52px)** after the Machine page's Sandbox picker appears:
32px control + 20px `space-y-5` gap. The same shift entry also contains the tiny
switcher ellipsis-to-control replacement. Header/main/sidebar geometry is now
stable. **Deferred to GLA-340**, which owns async-arrival reservation beyond the
shell, per manager direction; this PR does not change the Machine page. The
near-miss is not rounded into a pass.

The switcher replacement remains a tiny within-gate shift inside the reserved
header. It does not displace main content. No new loading UI is introduced to
remove this residual.

Live VM failure/recovery, prototype Workbench behavior, installation and deploy
busy states are outside this shell measurement. Existing fixture and IPC cases
are explicitly not live backend/VM validation. Arbitrary runtime insertion into
an already visible nav is not covered by the cold-resolution contract.

## Polish verdicts

- **Continuity:** the shell reservation and +1/+20 cold navigation checks pass
  the unchanged ≤0.01 CLS gate. Machine daemon-down's separate page-content
  residual **fails**, deferred to GLA-340.
- **Restraint:** pass for this change. No new visible placeholder, colors, or
  animation; settled developer Apps and production-host user Apps captures
  are byte-identical before/after at 1440×1000.
- **Legibility:** preserved on the captured settled surfaces; no typography,
  contrast, or visible information hierarchy redesign. This is not a new
  exhaustive contrast audit.
- **Precision:** the provisional navigation list is not exposed while its mode,
  cluster, or role is unresolved. Fixtures, IPC replies, historical attribution,
  raw shifts, and the residual failure remain separately identified.
- **Immediacy / Forgiveness:** no new timing or recovery-gate pass is claimed.
  Navigation clicks are exercised and their raw input-associated shifts are
  retained; install/deploy busy-state work belongs to the other worker.

## Scenario 11 attribution

The missing-VM and stale-catalogue equivalents confirm the dominant cold shift
comes from the shared shell. Their residual after this fix is confined to the
switcher replacing its ellipsis inside the reserved header; the catalogue case
reports that control moving from y21 to y12. The daemon-down Machine fixture
additionally exposes the independent picker-arrival shift described above.

The historical prototype's 0.11723245 is **not** used as a paired baseline for
this main-branch change. Its additional 0.00085210 entry has no source nodes in
the archived scenario trace, so no exact attribution of that historical small
entry is claimed. The unmerged Workbench's full VM recovery sequence is not
replayed here.

## Matched captures

- developer-apps: [before](before-developer-apps-no-preference.png) / [after](after-developer-apps-no-preference.png); [before reduced](before-developer-apps-reduce.png) / [after reduced](after-developer-apps-reduce.png).
- developer-settings: [before](before-developer-settings-no-preference.png) / [after](after-developer-settings-no-preference.png); [before reduced](before-developer-settings-reduce.png) / [after reduced](after-developer-settings-reduce.png).
- machine-daemon-down: [before](before-machine-daemon-down-no-preference.png) / [after](after-machine-daemon-down-no-preference.png); [before reduced](before-machine-daemon-down-reduce.png) / [after reduced](after-machine-daemon-down-reduce.png).
- stale-catalogue: [before](before-stale-catalogue-no-preference.png) / [after](after-stale-catalogue-no-preference.png); [before reduced](before-stale-catalogue-reduce.png) / [after reduced](after-stale-catalogue-reduce.png).
- unverified-catalogue: [before](before-unverified-catalogue-no-preference.png) / [after](after-unverified-catalogue-no-preference.png); [before reduced](before-unverified-catalogue-reduce.png) / [after reduced](after-unverified-catalogue-reduce.png).
- user-ipc: [before](before-user-ipc-no-preference.png) / [after](after-user-ipc-no-preference.png); [before reduced](before-user-ipc-reduce.png) / [after reduced](after-user-ipc-reduce.png).
- vm-lost-ipc: [before](before-vm-lost-ipc-no-preference.png) / [after](after-vm-lost-ipc-no-preference.png); [before reduced](before-vm-lost-ipc-reduce.png) / [after reduced](after-vm-lost-ipc-reduce.png).

[Capture hashes](captures.json) identify each matched 1440×1000 pair.
