# Desktop appliance-flow audit — 2026-08-19

Smoke test + user-journey audit of the desktop app now that the core-first
microVM boot + lazy deployment-layer flow is live (1.55.0 + desktop fix
`e415c47`/`145a35f` on origin/main). Verified against source; dev server boots
clean, app typechecks clean.

The shipped desktop lazy-cluster fix corrected the **deploy wizard** and the
**Machine "Provision deployment layer"** path. It did NOT cover the **first-run
express boot**, the **landing/switcher gating**, or the **Machine
shell/agent affordances** — that's the bulk of what follows.

## Workstream 1 — core-first-boot coherence (highest leverage)

Root cause: express "Get started" boots a **core** sandbox (no key, no profile,
no cluster registration — `sync_microvm_cluster` early-returns with no profile
entry, lib.rs), but the UI still assumes the pre-flip "up == registered deploy
target" contract. Three BLOCKERs share this root cause.

- **B1 — Landing loop.** `LandingRedirect` routes `cluster ? '/projects' : '/setup'`
  (routes.tsx:38). A core-booted VM registers no cluster, so every app open
  bounces back to `/setup` → `FirstRunWelcome`, as if nothing was set up. The
  booted machine only exists on `/machine`, which landing never points to.
  → Fix: either register the Dev Machine cluster at core
  boot, OR teach `LandingRedirect` + `useSelectedCluster` + cluster-switcher +
  the setup gate that "a core VM exists" == configured (route to `/machine`).

- **B2 — Express ladder lies.** `progress.tsx` ready rung (~:398) says
  "Delivering the api-server and registering the machine as a deploy target"
  and the success panel (~:764) repeats it; express calls `devUp()` (~:569)
  which does none of that. On resolve, `setReached(len-1)` (~:575) flips ALL
  rungs green including "Starting the app platform" / "api-server" that never
  ran. → Render only the core rungs for express boot; stop at a "Core ready"
  terminal rung; correct success copy to "Core sandbox ready — the deploy
  layer is added on your first deploy."

- **B3 — Machine page hides core-only affordances.** Open shell + Run agent →
  live inside `status?.running && status.kubeconfigReady` (runtime-detail.tsx:473),
  i.e. only after the deployment layer. A shell and an agent need only the core
  sandbox (Egress/Credentials tabs correctly gate on `vmRunning`; the Agents
  page itself gates launch only on `running && devMount`, never
  clusterProvisioned — confirmed coherent). → Move Open-shell + Run-agent out of
  the `kubeconfigReady` block; keep "Deploy app" gated on the deploy layer
  (deployHere already provisions inline).

Supporting copy fixes (same workstream):

- FirstRunWelcome comment/copy promises "cluster → ready … connects
  automatically" (setup/index.tsx:58-59) and "One click sets everything up"
  (:71) — soften to the core-first reality.
- deploy.tsx:322 no-client error: "it registers itself automatically" — false
  post-flip; reword to "Start the Dev Machine and provision its deploy layer".
- "core ready" pill uses the same green as "running" (runtime-detail.tsx:236-243);
  distinguish tone/label so a green machine that can't deploy is legible.
- Cluster switcher shows "Not connected" with only "Add cloud" when a local
  core VM exists (cluster-switcher.tsx:93-95,148) — surface a "Dev Machine —
  finish setup" / link to `/machine`.

## Workstream 2 — cloud wizard still drives the retired 3-phase Pulumi bootstrap

- Desktop "New installation → AWS Cloud" still runs the legacy engine
  (`wizard.tsx` `'aws'` path → `/cloud/bootstrap/run` → `host.bootstrap.run`),
  which now streams the `emitLegacyDeprecation` "deprecated: legacy 3-phase
  bootstrap…" line into the user-visible log. The shipped `appliance cloud
install` (CloudFormation, `installGeneration:'cloudformation-v1'`) is CLI-only.
- Latent: destroy panel + update-baseline/api-server panels hardcode `pulumi
destroy` / `assertLegacyInstallation` throws for a CFN cluster added via
  Connect (panels.tsx). They never read `baseConfig.provisioner` from
  `/cluster-info` to branch.
- Stale copy: "Three Pulumi phases" (wizard.tsx:171), "phase 2/3", raw
  "State backend s3://…" shown to every user; connect.tsx:131 points web users
  at retired `appliance bootstrap`.
- NOTE: decision-of-record #8 froze the legacy bootstrap for 2 releases, so the
  legacy PATH staying is intentional — but users should not see "deprecated"
  streamed at them, and a CFN install UI is not yet implemented.

## Workstream 3 — cross-cutting friction batch

- Drill-down pages (projects/detail:114, environments/detail:150,
  deployments/list:54, deployments/detail:69) dump raw error strings instead of
  `<FriendlyError>` — no plain headline, no Reconnect on auth-expiry.
- Settings header (settings.tsx:30-34) tells members to use Machine/Cloud/Agents
  nav that `RequireAdmin` hides from them → gate on `isOperator`.
- Apps home create/delete buttons (apps/index.tsx:185-194) unconditional → a
  member 403s on submit; hide/disable for non-admin.
- Agent launcher: status-query + vm-list-query error branches render as
  perpetual "Checking…" / wrong "not running" dead-ends (agents/index.tsx:288-306,
  190-225); sign-in via the launcher panel doesn't clear the page banner
  (authBump not threaded, :81 vs launch-agent-button.tsx:274-281); no stop/remove
  on a run row (:425-453).
- Deployments list page is orphaned (no nav entry / no "View all" from
  RecentActivity).
- Empty/loading-state inconsistency (only deployments/list uses `<EmptyState>`;
  detail pages show bare "Loading…").
- Doctor + Facts leak kubectl/Docker/profile jargon into first-run copy.

## Not-a-bug (confirmed coherent, preserve)

- Agents launch gating (running && devMount, no clusterProvisioned) — correct
  under core-first boot.
- Deploy wizard `TargetStep` inline "Prepare Dev Machine for deploy" — provisions
  the layer without dead-ending.
- runtime-detail.tsx:425-445 "Core sandbox ready" + "Provision deployment layer"
  card — the clearest, most honest treatment of the new model; mirror its wording.
- Invite/member onboarding, Remove-vs-Destroy split, destroy type-the-name gate.
