# Workbench prototype · GLA-331

Branch-only design composition. This is not a product implementation or a new host/API contract.

Run `pnpm --filter @appliance.sh/desktop dev`, then open
`/?mock-host&scenario=workbench-1`. Scenarios `workbench-1` through `workbench-12`
match the UX specification's scenario set. The harness enters `/workbench` in
developer mode; direct routes remain operator- and developer-gated.

S1–S7 compose the existing sign-in, launcher, session-provider attachment,
confirmation, Tabs, WeightLabel, LongOperation and LogPane components. Workspace
bindings, target preferences and advisory editing-agent selection are visibly
labelled browser-persistence fixtures. They do not write `.appliance/workbench.json`.
The host-side inspection baseline, registry aggregation, F2 static observation,
F3 approval/readiness, F5 promotion and F8 WSL refusal are fixtures. Static
observation has no terminal transport; an existing interactive dock stays
interactive. Neither is a containment claim.

Package requires a human click and replays the result of an actual
`appliance builder package --directory examples/runtime/journal` run. The exact
name, digest and source revision are in `package-evidence.ts`; the full log and
real unsigned bundle are in the untracked `_evidence-gla331/` directory. The
fixture diff does not claim to be the artifact's input. No result, readiness,
approval or session event invokes Package, install or deploy. The prototype has
no live packaging bridge or signing-key provisioning UI.

Owner ruling, 2026-11-11: File is the v1 headline, Catalogue is later, and Deploy
is a separate verb. Three rows intentionally retain equal visual weight for
design review. The demonstrated unsigned path says “Unsigned — publisher prompts
will warn”. Existing CLI signing remains available when a local development
Ed25519 key is supplied; this prototype introduces no credential handling.

Installed Apps retains publisher/grant review and the separate Open action.
Source deployment remains reachable independently at `/projects/deploy`; the
Workbench target fixture does not silently change its global selection.
Package promotion is unavailable. The three destination rows do not execute
follow-on actions.

The evidence report declares real-run versus fixture-backed claims at its top,
and retains failed gates, raw timing samples, CLS, matched captures, videos and
traces. Evidence binaries are deliberately not committed.

Evidence provenance is recorded per series in
`_evidence-gla331/current-measurements.json`. Package, Deploy and Retry
acknowledgment were re-measured at `52b3849` in both motion configurations;
other historical series retain their actual measurement revision. The evidence
README records before/after medians without changing failure thresholds.

Follow-up board card GLA-336, “Measured shell/installer defects exposed by
GLA-331”, belongs to Morgan, who opens the build epic. It carries shell CLS
(including the branch contribution and user-mode product defect), installer
first acknowledgment and S3 delayed-acceptance liveness. The untracked
`followups.md` preserves the README's `shell-cls` and
`s3-delayed-acceptance` anchors and must accompany artifact publication.

The branch and code follow-up `52b3849` are on origin. This prototype never
merges; there is no product PR. Manager handles publication.

Bounded S6 pass: Install-from-file now renders picker/install busy feedback in
its existing buttons before awaiting the result. The former ~147 ms measurement
waited for the publisher dialog behind mock-host's explicit 120 ms install delay;
this pass changes first feedback, not publisher review or installer latency.
Both motion configurations have ten finite after-paint samples below 100 ms;
S6 CLS remains 0.00255. Full traces and before/after samples are in
`_evidence-gla331/s6-*-measurements.json`. Runtime, Tauri and CLI internals are
unchanged; GLA-336 inherits this branch-only ordering/presentation evidence.
