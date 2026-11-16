# PR #172 review revision — cold-only navigation reservation

Product source: **a076796**. This report supersedes the initial pack's after
series and navigation-readiness claims. The initial pack and base measurements
are retained in the parent directory. All new measurements use the committed
harnesses on this final product code: **260 runs**, 1440×1000, dark, ten samples
per scenario and motion setting, raw layout shifts including recent-input
entries, input timestamps, source rectangles, and captures. No uncaught browser
errors. The ≤0.01 gate is unchanged.

## Review changes and policy provenance

The role-policy reversal was **EMERGENT**. Role readiness was added as another
layout input; the test comment subsequently rationalized the gate as avoiding
provisional operator tools. This was not a considered owner-policy recommendation.
That gate and comment are reverted, without an owner fork. `use-key-role.ts`
and its **admin-default-while-resolving** policy are unchanged. Cold or warm
`whoami` latency does not gate navigation visibility.

Mode/config reservation now latches permanently after first reveal. Subsequent
cluster switches, role lookups, and refetches cannot hide the nav again. The
regression first renders pending cluster data, settles it, then re-renders with
`isRoleLoading=true`, and finally with mode/config loading again; nav stays
visible. Separate tests cover the initial admin role default and the deadline.

The **1,000ms deadline is chosen as a usability bound**, not derived from measured
settle times, a p99, or a design token. It limits how long a stalled local host
can reserve an empty navigation area. The timer starts at initial mount and
is not reset by readiness changes. It is a scheduled deadline, not a hard
real-time guarantee: event-loop scheduling and frame observation add latency.

The footer reservation is removed. Its absence is measured, not merely
undefended: see the isolated footer-arrival result below.

## Cold CLS on final code

Before is current-main base **a6d79c6**, retained from the initial matched pack.
Normal and reduced-motion medians below are identical; each value has ten
samples in each setting. Developer fixtures include Setup and can resolve the
header in two steps.

| Fixture                                                    |     Before | Final after | Verdict  |
| ---------------------------------------------------------- | ---------: | ----------: | -------- |
| Developer Apps, unconfigured mock                          | 0.12316963 |  0.00001904 | PASS     |
| Developer Settings, unconfigured mock                      | 0.12316963 |  0.00001904 | PASS     |
| Machine daemon-down mock, MicroVM inventory retained       | 0.14573826 |  0.01002851 | **FAIL** |
| Stale Catalogue mock                                       | 0.01015608 |  0.00002981 | PASS     |
| Unverified Catalogue mock                                  | 0.01015608 |  0.00002981 | PASS     |
| User Apps, production-host IPC without mock-host           | 0.01015608 |           0 | PASS     |
| Missing VM, empty inventory and settled not-created status | 0.11638035 |  0.00001904 | PASS     |

All medians are unchanged from the initial after series. The user normal-motion
series has one 0.00001904 sample; its median remains zero. Adding **1 or 20 nav
rows** still yields **0.00001904** in both motion settings, ten samples per count
per setting. Source: [after.json](after.json), [after-extra1.json](after-extra1.json),
[after-extra20.json](after-extra20.json), [summary.json](summary.json).

The header formula is unchanged: `calc(1lh + var(--spacing) * 9 + 3px)` with
`text-sm`. Computed in both motion settings: 20px line-height + control padding
6+6px + control borders 1+1px = 34px; header padding 12+12px + divider 1px = 59px.

Historical attribution stays separate and is **not** a before/after comparison:
**00a0bdd = 0.09698362**; prototype-only navigation-row addition
**+0.01939672**. The historical prototype scenario 11 was 0.11723245. The
missing-VM and catalogue equivalents continue to confirm the shared shell cause;
no exact attribution of its source-less additional 0.00085210 entry is claimed.

## Reveal, switch, and footer series

[reveal.json](reveal.json) retains all input events, raw shifts, role-request
start/end times, visibility transitions, and footer geometry. All cases have
ten runs per motion setting. The role API is exercised through the real SDK
and host adapter with controlled browser responses; these are not live servers.

| Series                                                                     |   Normal median |  Reduced median | Result                                       |
| -------------------------------------------------------------------------- | --------------: | --------------: | -------------------------------------------- |
| Two first-time cluster switches (A→B→C), each new role response held ≥1.5s |    switch CLS 0 |    switch CLS 0 | Nav never hidden again; 40 switches total    |
| Cold role request held pending for >3s                                     |   hide 112.45ms |   hide 111.95ms | Admin nav visible while role remains pending |
| Mode/config responses delayed 2.5s                                         |  hide 1002.90ms |  hide 1005.25ms | Nav revealed before data, never hidden again |
| Actual footer inserted after first settle, without input                   | insertion CLS 0 | insertion CLS 0 | All link rectangles unchanged                |

The switch result includes **all raw shifts after the first trusted input**,
including recent-input entries: their sum is zero in every run. Full cold+switch
CLS is 0.00001564 (the initial switcher), not incorrectly reported as zero.
The cold role case also has full CLS 0.00001564. Its maximum observed initial
hide is 117.3ms normal / 114.3ms reduced, independent of the pending remote role.

For the host stall, maximum observed hide is **1012ms normal / 1011.7ms reduced**,
measured from first observed hidden-nav frame to first visible frame. This is
an observation, not the source of the chosen deadline. This particular 2.5s
fixture measures CLS **0.00001369** in both settings; it does not prove all late
settles are shift-free.

The footer experiment removes and reinserts the **actual existing Developer
mode footer node** after settling the same unconfigured developer shell. Its
measured height is **50px**. In all twenty insertion windows: **CLS=0**, maximum
raw shift=0, and every nav-link rectangle is identical before/after. The nav's
empty flex area absorbs the footer; reserving 50px in user mode is unnecessary.
The full ordinary cold developer series above also passes with no footer reserve.

## Named deferrals and polish verdict

- **GLA-340 — late post-reveal navigation geometry:** mode/config settling after
  the chosen 1s deadline, or Setup-completion selection after reveal, may insert
  or remove rows and shift visible navigation. Existing late role-policy changes
  also remain visible. The latch bounds hiding; it does not guarantee zero CLS
  after the bound. This is the explicit usability tradeoff, not an implicit
  guarantee or an unmeasured latency percentile.
- **GLA-340 — Machine picker arrival:** still **FAIL, 0.01002851 > 0.01**.
  `div.appliance-ui.grid[aria-busy=true]` containing “Checking Sandbox” moves
  y203→255 (+52px: 32px picker + 20px gap), with a tiny switcher contribution in
  the same shift entry. No Machine page change or rounding pass.
- Live VM recovery, the unmerged Workbench sequence, and install/deploy busy
  states remain outside this shell fix. No new Immediacy/Forgiveness gate pass
  is claimed.

**Continuity:** cold shell and warm switch cases pass; named Machine residual
fails; late post-reveal geometry remains deferred. **Restraint:** no new loading
UI and unnecessary footer reservation removed. **Precision:** recorded role
policy restored and timing provenance explicit. **Legibility:** preserved.

## Verification and reproducibility

Seven shell tests cover styling, cold mode/config readiness, the reveal latch,
admin-default role behavior, and the chosen deadline. Full final verification
is **GREEN: 1,476 TypeScript / 362 Rust tests**, recorded in [verify.txt](verify.txt).

Use [measure.mjs](../measure.mjs) for the cold/+row series and
[measure-reveal.mjs](../measure-reveal.mjs) for the new series. Both accept
`PLAYWRIGHT_MODULE`, `CHROMIUM_EXECUTABLE`, `APP_URL`, and `EVIDENCE_DIR`.
`SCENARIOS` filters cold cases; `CASES` filters reveal cases. The portable cold
harness's duplicated pre-navigation header assertion was removed; its served
bundle assertion remains after navigation. The final reruns used this corrected
committed harness. The original baseline remains in [../before.json](../before.json).

## Final matched captures

- developer-apps: [before](../before-developer-apps-no-preference.png) / [final](after-revision-a-developer-apps-no-preference.png); [before reduced](../before-developer-apps-reduce.png) / [final reduced](after-revision-a-developer-apps-reduce.png).
- developer-settings: [before](../before-developer-settings-no-preference.png) / [final](after-revision-a-developer-settings-no-preference.png); [before reduced](../before-developer-settings-reduce.png) / [final reduced](after-revision-a-developer-settings-reduce.png).
- machine-daemon-down: [before](../before-machine-daemon-down-no-preference.png) / [final](after-revision-a-machine-daemon-down-no-preference.png); [before reduced](../before-machine-daemon-down-reduce.png) / [final reduced](after-revision-a-machine-daemon-down-reduce.png).
- stale-catalogue: [before](../before-stale-catalogue-no-preference.png) / [final](after-revision-b-stale-catalogue-no-preference.png); [before reduced](../before-stale-catalogue-reduce.png) / [final reduced](after-revision-b-stale-catalogue-reduce.png).
- unverified-catalogue: [before](../before-unverified-catalogue-no-preference.png) / [final](after-revision-b-unverified-catalogue-no-preference.png); [before reduced](../before-unverified-catalogue-reduce.png) / [final reduced](after-revision-b-unverified-catalogue-reduce.png).
- user-ipc: [before](../before-user-ipc-no-preference.png) / [final](after-revision-b-user-ipc-no-preference.png); [before reduced](../before-user-ipc-reduce.png) / [final reduced](after-revision-b-user-ipc-reduce.png).
- vm-lost-ipc: [before](../before-vm-lost-ipc-no-preference.png) / [final](after-revision-b-vm-lost-ipc-no-preference.png); [before reduced](../before-vm-lost-ipc-reduce.png) / [final reduced](after-revision-b-vm-lost-ipc-reduce.png).
