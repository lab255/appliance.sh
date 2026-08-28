# Desktop information architecture — target IA, move-map, staging

> **Status note (the IA has moved on).** The navigation has since evolved past
> this plan: the current nav is **Apps / Agents / Machine / Cloud / Settings**,
> with a **"Dev Machine"** vocabulary for the single managed microVM (a
> parallel change is in flight in `packages/app`). The plan below is kept as
> the historical blueprint — read its ①–⑤ areas and naming table as the
> stepping stone to that IA, not the current state.

## Current audience modes

The desktop now asks once, per machine, whether to start in **User** or
**Developer** mode. User mode keeps the workspace switcher and exposes only
**Installed Apps · Catalogue · Settings**. Developer mode contains that same
runner set, then appends **Setup · Projects · Agents · Machine · Cloud** under a
**Develop** group; the existing role, VM-capability, and configured-state gates
still apply. The choice can be changed immediately in **Settings → Mode**.

Web/console hosts have no desktop preference capability, so they retain the
historical developer mode without showing the first-run choice.

Status: **plan** (no feature code). This is the blueprint phases **I1–I5** build to.
Scope: the Appliance **desktop app** (`packages/app`, the shared `Console`). The same
bundle is the web PWA, so every surface below is **host-capability gated** — the web
shell must keep rendering nothing for desktop-only surfaces (`host.vm`,
`host.agentAuth`, `host.local`, `host.terminal`, `host.updater`, `host.bootstrap`).

Owner-locked decisions (do not relitigate in the build phases):

- **Five top-level areas:** ① Setup · ② Clusters · ③ Projects · ④ Agents · ⑤ Settings.
- The **egress firewall** + **credential broker** live under ② (per-runtime).
- **Agent sign-in moves OUT of Settings into ④.**
- The **persistent terminal/console dock stays as global chrome** — it survives
  navigation (Phase-4 nav-survival contract via `terminal-sessions-provider`).
- Default landing: **Setup if unconfigured, else Projects.**

---

## 1. Why — the drift we are removing

The current app is a flat 6–7-item sidebar over pages that grew by accretion. The
worst offender is `pages/local-runtime/index.tsx` (**2 429 lines**) — a single route
that is simultaneously a doctor, a VM lifecycle manager, an egress firewall, a
credential broker, an agent launcher, and a workloads/logs browser. `settings.tsx`
(**1 244 lines**) is the second kitchen sink: cluster CRUD + four cloud-lifecycle
panels + a destroy button + agent auth + updates + about.

Naming has drifted three ways and must be made canonical:

| Concept                  | Names in the tree today                                                                                                                                                                                                  | Canonical (this doc)                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project-grid home        | `Dashboard` (nav label + index route), `Overview` (the page's own `<h1>`)                                                                                                                                                | **Projects** — area ③ landing. Retire **both** "Dashboard" and "Overview".                                                                                         |
| The local microVM engine | `Runtimes` (nav label `app-shell.tsx:34` + section `<h2>` `index.tsx:230`), `Local runtime`/`Local Runtime` (page `<h1>`, wizard, get-started card), `/local-runtime` (route), `MicroVM Runtime` (`microVmClusterLabel`) | **Local runtimes** — a section of ② Clusters. Route base `/clusters`. The cluster-switcher badge stays the existing `sandboxed`.                                   |
| Deploy target            | "cluster" / "engine" / "runtime" / "VM" used interchangeably                                                                                                                                                             | A **cluster** is any deploy target (cloud or local). A **local runtime** is a microVM-backed cluster (`isMicroVmClusterId`). "engine" stays an internal term only. |

---

## 2. Target nav + route tree

Five sidebar items (replacing today's `baseNav`/`tailNav` in
`components/layout/app-shell.tsx`) + the persistent terminal/console dock as global
chrome (not a nav item). The header keeps the **`ClusterSwitcher`** (cluster
selection is always one click away) and gains no new chrome.

```
Sidebar (top → bottom)            Route base     Gated by
────────────────────────────────  ─────────────  ──────────────────────────────────
① Setup            (icon: Wand)   /setup         always (web = Connect-only)
② Clusters         (icon: Server) /clusters      always (local-runtime bits: host.vm)
③ Projects         (icon: Folder) /projects      always (needs a selected cluster)
④ Agents           (icon: Bot)    /agents        host.vm  (hidden on web, like Runtimes today)
⑤ Settings         (icon: Cog)    /settings      always
────────────────────────────────────────────────────────────────────────────────────
[ Terminal/console dock ]  global chrome — TerminalDock + TerminalLayer, OUTSIDE <Outlet/>
```

Default landing — replace the bare `index` element with a redirect resolver:

```
/  →  Setup if unconfigured (no clusters / none selected), else /projects
```

"Unconfigured" = `useSelectedCluster()` resolves no cluster (`config.clusters` empty
or `selectedClusterId` null). This subsumes today's `DashboardPage` branch that flips
between `FirstRunWelcome`/`GetStarted` and `Overview`.

### Full route table

```
PUBLIC (no AppShell)
  (none — Setup/Connect/Bootstrap move INSIDE the shell so the dock + switcher persist)

/  → redirect resolver (Setup | Projects)

① /setup
   /setup                      onboarding hub (first-run welcome + the three paths)
   /setup/connect              Connect form (was /connect)
   /setup/bootstrap            new-installation wizard: mode picker + AWS form + local-runtime form (was /bootstrap)
   /setup/bootstrap/run        bring-up progress / phase ladder (was /bootstrap/run)
   /setup/doctor               prerequisite preflight (was the PreflightPanel atop /local-runtime)

② /clusters
   /clusters                   connected clusters list (select/switch/add/remove) + local-runtimes overview
   /clusters/:id               cluster detail — dispatches on cluster kind:
                                 · cloud cluster → lifecycle ops (baseline / api-server / promote / demote / destroy)
                                 · local runtime → VM lifecycle (start/stop/delete, dev-env, mount, shell) + egress + credentials + facts

③ /projects
   /projects                   project grid + recent activity  (replaces Dashboard/Overview; the new index)
   /projects/deploy            deploy wizard (was /local-runtime/deploy); accepts ?project=&environment=
   /projects/:id               project detail
   /projects/:projectId/environments/:id   environment detail + Workloads (deployments/pods/logs/pod-shell)
   /deployments                cross-project deployment activity (reachable from ③, not a nav item)
   /deployments/:id            deployment detail

④ /agents
   /agents                     agent sign-in (per-type) + launcher + agent-run list across runtimes
                                (observe terminals continue to live in the global dock)

⑤ /settings
   /settings                   Updates · About · Preferences  (slimmed)
```

Notes:

- **Environments and Deployments lose their top-level nav entries.** They are
  sub-surfaces of ③ Projects (reachable from the grid, project detail, and env
  detail), keeping the nav at five. Their routes stay live so existing links resolve.
- Setup/Bootstrap/Connect move **inside** `AppShell` (today they are siblings of it
  in `routes.tsx`). That is deliberate: it keeps the dock + cluster switcher mounted
  during onboarding and removes a class of "naked page" with no way back.

---

## 3. Page plan per area (decompose, don't relabel)

### ① Setup — `/setup`

- **Onboarding hub** (`/setup`): one entry that unifies today's three first-run
  surfaces. The "Get started → boot the default microVM" express path
  (`FirstRunWelcome`) is the primary CTA; "More options" reveals the three cards
  (Local runtime / Bootstrap on AWS / Connect) from `GetStarted`.
- **Connect** (`/setup/connect`): the add-a-cluster form (probe URL → verify creds →
  `host.addCluster`). The single canonical add-cluster surface.
- **Bootstrap** (`/setup/bootstrap` + `/setup/bootstrap/run`): mode picker → AWS form
  or local-runtime form → live phase ladder (AWS 3-phase Pulumi, or microVM
  media→booting→network→cluster→ready). Unchanged engine; relocated + deduped entry.
- **Doctor** (`/setup/doctor`): the prerequisite preflight (docker / kubectl, daemon
  up, auto-install, "Start runtime"). Lifted out of the runtimes page so a failing
  prereq is a first-class setup step, not a banner buried above VM cards.

### ② Clusters — `/clusters`

- **Clusters index** (`/clusters`): the connected-cluster list (select / switch / add
  / remove) — today's Settings "Clusters" section — **plus** the local-runtimes
  overview (one card per microVM, the default `appliance` VM always surfaced, "New
  VM"). Cloud clusters and local runtimes in one list, tagged by kind.
- **Cluster detail** (`/clusters/:id`): dispatches on `isMicroVmClusterId`:
  - **Cloud cluster** → lifecycle ops: update baseline, update api-server, promote /
    demote installer state, **destroy** (all gated on `host.bootstrap.*`).
  - **Local runtime (microVM)** → VM lifecycle (install engine, start / start-dev /
    stop / delete, dev-env toggle, host-folder mount, **Open shell**), the **Egress
    firewall** panel, the **Credentials broker** panel, and the at-a-glance facts
    (k8s URL, cluster id, allocated ports). "Deploy application" here deep-links to
    ③ `/projects/deploy` with this cluster selected. "Run agent" deep-links to ④.

### ③ Projects — `/projects`

- **Project grid** (`/projects`): the Vercel-style card grid + per-project health
  rollup + recent-activity feed (today's `Overview`). The new home; canonical name
  "Projects".
- **Deploy wizard** (`/projects/deploy`): pick folder → configure → build+deploy. One
  wizard, reachable from every contextual "Deploy" CTA.
- **Project detail** (`/projects/:id`) and **Environment detail**
  (`/projects/:projectId/environments/:id`). Env detail absorbs the **Workloads**
  surface (deployments / pods / services tables, live pod-log drawer, **pod-shell**)
  from the runtimes page — workloads belong with the thing deployed, not the engine.
- **Deployments** activity (`/deployments`, `/deployments/:id`): cross-project run
  history, reachable in-area.

### ④ Agents — `/agents`

- **Agent sign-in**: the per-type credential UI (`AgentLoginPanel` + the type picker
  with "signed in" dots), moved out of Settings. Claude (API key / Sign in with
  Claude), Copilot (fine-grained PAT), Codex (OpenAI key). Host-side keychain;
  never enters the VM.
- **Launcher**: pick a runtime + agent type + task, spawn into the VM's shared
  workspace, attach an observe tab to the **global dock**.
- **Runs list**: the agents reconciled from each runtime's registry (`agent.list`),
  with their live status — the durable index behind the dock's agent tabs.

### ⑤ Settings — `/settings`

- **Updates** (`host.updater`): check / download / relaunch.
- **About**: version, build time, shell kind.
- **Preferences**: app-level prefs (e.g. onboarding-dismissed reset; future home).
  Cluster CRUD, cloud lifecycle, and agent auth have all left this page.

---

## 4. THE MOVE-MAP (load-bearing)

Every current surface → its new home. Component names are exact.

### 4a. Decompose `pages/local-runtime/index.tsx` (2 429 lines)

| Component(s) in `local-runtime/index.tsx`                                                                                                                                        | Does                                                                                                                                               | New home                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `LocalRuntimePage` (shell/header)                                                                                                                                                | page frame, "Deploy" header CTA, supported-gate                                                                                                    | **dissolved** — split into ② index + ② detail; header "Deploy" CTA → ③ `/projects/deploy` |
| `PreflightPanel`, `PreflightRow`, `checkReady`                                                                                                                                   | docker/kubectl preflight, auto-install, Start-runtime                                                                                              | **① `/setup/doctor`**                                                                     |
| `EnginesSection`, `EngineCard`, `EngineTag`, `NewVmButton`                                                                                                                       | list of microVMs, "New VM"                                                                                                                         | **② `/clusters`** (local-runtimes overview)                                               |
| `MicroVmPanel`                                                                                                                                                                   | per-VM lifecycle: `install`/`up`/`devUp`/`stop`/`remove`, dev-env checkbox, mount picker, **Open shell**, deploy-here, ready/serving state machine | **② `/clusters/:id`** (local-runtime detail)                                              |
| `MicroVmFacts`, `microVmClusterLabel`                                                                                                                                            | k8s URL / cluster id / ports facts                                                                                                                 | **② `/clusters/:id`**                                                                     |
| `LaunchAgentButton`, `looksLikeAuthFailure`                                                                                                                                      | agent type picker + launch + keyless-login gate + reauth nudge                                                                                     | **④ `/agents`** (launcher). Detail page keeps a thin "Run agent →" deep-link.             |
| `EgressPanel` + `BakedAllowlist`, `DeniedAttempts`, `TrafficView`, `RuleList` + helpers (`isBaked`, `aggregateDenied`, `hostMatches`, `ruledStatus`, `errMessage`, `DeniedHost`) | egress firewall: policy, rules, traffic feed, denied-attempts allow loop                                                                           | **② `/clusters/:id`** (Egress firewall) — owner-locked under ②                            |
| `CredentialsPanel` (+ shared `RuleList`)                                                                                                                                         | per-host capture/inject credential rules + stored secrets                                                                                          | **② `/clusters/:id`** (Credentials broker) — owner-locked under ②                         |
| `WorkloadsPanel`, `DeploymentsTable`, `PodsTable`, `ServicesTable`, `PodLogsDrawer`, `relativeAge`                                                                               | workloads/pods/services tables, live log tail, **pod-shell** launch                                                                                | **③ env detail** (`/projects/:projectId/environments/:id`)                                |

`pages/local-runtime/index.tsx` ends up **deleted**; `pages/local-runtime/deploy.tsx`
moves to `pages/projects/deploy.tsx`; `pages/local-runtime/terminal-drawer.tsx`
(`TerminalLayer`/`TerminalDrawerView`) stays a layout concern — see §6.

### 4b. Slim `pages/settings.tsx` (1 244 lines)

| Component in `settings.tsx`                                                     | Does                                                                  | New home                                           |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| `SettingsPage` "Clusters" section + `ClusterRow`                                | cluster list, select/switch, remove, "Add cluster" / "Bootstrap" CTAs | **② `/clusters`** (clusters index)                 |
| `UpdateBaselinePanel`                                                           | re-run phase 1 baseline                                               | **② `/clusters/:id`** (cloud detail)               |
| `UpdateApiServerPanel`                                                          | mirror + redeploy api-server/worker                                   | **② `/clusters/:id`** (cloud detail)               |
| `StateMigrationPanel` (`promote`/`demote`) + `setClusterStateBackendIfPossible` | detach/reattach installer state                                       | **② `/clusters/:id`** (cloud detail)               |
| `DestroyClusterPanel`                                                           | `pulumi destroy` the installer stack                                  | **② `/clusters/:id`** (cloud detail)               |
| `AgentAuthSection`                                                              | per-agent host-side sign-in                                           | **④ `/agents`**                                    |
| `UpdatesSection`                                                                | self-update                                                           | **⑤ `/settings`** (keep)                           |
| "About" rows + `Section`/`Row` helpers                                          | version/build/shell                                                   | **⑤ `/settings`** (keep; `Section`/`Row` → shared) |

`SettingsPage` shrinks to Updates + About + Preferences.

### 4c. Other current surfaces

| Current surface                                                      | New home                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| `pages/dashboard.tsx` `Overview` (grid + recent activity)            | ③ `/projects` (the index)                                 |
| `pages/dashboard.tsx` `FirstRunWelcome`, `GetStarted`, `ActionCard`  | ① `/setup` (onboarding hub)                               |
| `pages/dashboard.tsx` `EmptyProjects`                                | ③ `/projects` empty state                                 |
| `pages/connect.tsx` `ConnectPage`                                    | ① `/setup/connect`                                        |
| `pages/bootstrap/wizard.tsx` (mode picker + forms)                   | ① `/setup/bootstrap`                                      |
| `pages/bootstrap/progress.tsx` (phase ladder)                        | ① `/setup/bootstrap/run`                                  |
| `pages/projects.tsx`, `pages/projects/detail.tsx`                    | ③ (unchanged paths)                                       |
| `pages/environments.tsx`, `pages/environments/detail.tsx`            | ③ — folded under Projects; nav entry removed, routes kept |
| `pages/deployments/list.tsx`, `pages/deployments/detail.tsx`         | ③ — reachable in-area; nav entry removed, routes kept     |
| `components/layout/cluster-switcher.tsx`                             | header chrome (unchanged)                                 |
| `components/agent-login.tsx` (`AgentLoginPanel`, `useAgentSignedIn`) | shared — consumed by ④ (and the launcher's keyless gate)  |
| `pages/placeholder.tsx` (`PlaceholderPage`)                          | **deleted** — no importers (dead)                         |

---

## 5. Dedup plan

1. **Onboarding: 3+ entries → 1.** Today the first-run choice exists in
   `dashboard.tsx` (`FirstRunWelcome` + `GetStarted`), in `bootstrap/wizard.tsx`
   (`ModePicker` + `LocalRuntimeForm`), and as a hint block on `connect.tsx`. Collapse
   to a single **① `/setup`** hub; the wizard becomes the "advanced path" the hub
   links into, not a parallel doorway.
2. **Add-cluster: 4 → 1.** Entry points today: `settings.tsx` "Add cluster" (×2 —
   empty + populated states), `cluster-switcher.tsx` "Add cluster", `connect.tsx`
   itself, and the `GetStarted` "Connect" card. One canonical form at
   **① `/setup/connect`**; ② `/clusters` and the switcher link to it.
3. **Deploy: ~7 → 1.** Entry points today (from the census): `local-runtime/index.tsx`
   header CTA + `MicroVmPanel.deployHere`, `dashboard.tsx` `EmptyProjects`,
   `environments.tsx`, `environments/detail.tsx`, and `bootstrap/progress.tsx` (×2).
   These are all _links into the same wizard_ — keep the contextual CTAs, but there is
   **one wizard implementation** at **③ `/projects/deploy`** (today
   `/local-runtime/deploy`). No duplicate wizards; just one canonical route.
4. **Delete dead `pages/placeholder.tsx`.** `PlaceholderPage` has no importers
   (verified) — remove the file.
5. **Egress double-fetch.** `EgressPanel` and `CredentialsPanel` each register their
   own `useQuery(['microvm', name, 'egress'], () => egress.get(), { refetchInterval:
15_000 })` (`index.tsx:1064` and `:1622`). TanStack dedupes the _cache_ by key, but
   both observers keep an independent 15 s poll, and `CredentialsPanel` only needs
   `policy.mitm`. Lift one egress-policy query into the ② local-runtime **detail
   container** and pass `policy` (or just `mitm`) down to the credentials panel — one
   poll, one source of truth.

---

## 6. Preserve (do not break)

- **Persistent terminal/console dock — the Phase-4 nav-survival contract.**
  `TerminalSessionsProvider` is mounted **above** the router in `App.tsx`; `App.tsx`,
  the provider, `TerminalDock`, and `TerminalLayer` are unchanged. The new `AppShell`
  must keep rendering `<TerminalDock/>` + `<TerminalLayer/>` as grid rows **OUTSIDE**
  the route `<Outlet/>` (today's `app-shell.tsx:92,97`). Live shells, the off-screen
  xterm holder, de-dupe-by-key, and on-launch rehydrate all live in the provider —
  none of that moves. Routes may swap freely underneath; sessions outlive them.
- **Agent observe tabs.** Agent tabs are dock sessions tagged with `AgentTabMeta`
  (`agentSessionKey`, `mintAgentSessionId`, the running-agent status poll, and the
  `agent-`-prefixed rehydrate path). ④ Agents launches **through the same provider**
  (`terminals.openSession({ agent: … })`) — it does not own a second terminal stack.
  The launcher's close→`agent.stop` and rehydrate enrichment stay in the provider.
- **Providers.** `HostProvider`, `QueryClientProvider`, `ToastProvider`,
  `ConfirmProvider`, `TerminalSessionsProvider` and their nesting order in `App.tsx`
  are untouched. This is an IA/routing refactor, not a provider refactor.
- **Host-capability gating (web shell renders nothing for desktop-only surfaces).**
  The contract per area:
  | Capability absent (web) | Effect |
  |---|---|
  | `host.vm` | ④ Agents nav item hidden; ② local-runtimes overview + detail hidden (cluster list still shows cloud/BYO clusters); ③ deploy gated |
  | `host.local` | ① Doctor + ③ deploy wizard show the "desktop app only" message |
  | `host.terminal` | "Open shell" / pod-shell omitted; dock shows the inert error session |
  | `host.bootstrap` | ① Bootstrap path + ② cloud lifecycle ops hidden (Connect still works) |
  | `host.agentAuth` | ④ sign-in + launcher keyless gate render nothing (`AgentLoginPanel` already returns `null`) |
  | `host.updater` | ⑤ Updates section hidden |
  Keep using the existing `Boolean(host.x)` checks — do not introduce a new gating
  mechanism. The web build must compile and run with every optional capability absent.

---

## 7. Staging (de-risk — never big-bang)

Each phase is independently shippable and leaves `scripts/verify.sh`
(build → typecheck → lint:check → test, + the Rust crate) **green**. The rule that
keeps the tree green mid-migration: **never delete a page/symbol until its replacement
is mounted and every importer points at it; until then the old route stays reachable
behind a redirect.**

### I1 — New shell + 5-area nav + route skeleton

- Rewrite `app-shell.tsx` nav. The live items are **Setup (adaptive), Clusters,
  Projects, Settings**; Setup shows only while unconfigured and demotes out of the
  primary nav once a cluster is selected (Q3). The **Agents nav item lands in I4** —
  it has no backing page yet, so I1 doesn't add a dead item (when it lands it's
  `host.vm`-gated, mirroring today's Runtimes gate). Keep `<TerminalDock/>` /
  `<TerminalLayer/>` as grid rows OUTSIDE `<Outlet/>`.
- Add the new route paths in `routes.tsx`, **inside `AppShell`** (Setup / Connect /
  Bootstrap move in, so the dock + cluster switcher stay mounted during onboarding).
  Initially each new path renders the **existing** page component (or a thin
  redirect) — `/setup` → the onboarding hub (`DashboardPage`'s first-run branch; on
  web the **Setup CTA is Connect-led**, since the microVM-express path is
  desktop-only), `/clusters` + `/clusters/:id` → `LocalRuntimePage`, `/projects` →
  `DashboardPage` (the Overview grid), `/setup/doctor` → the page that hosts the
  `PreflightPanel`, `/agents` → redirect to `/clusters`. Old paths (`/dashboard`,
  `/local-runtime`, `/environments`, `/deployments`, `/bootstrap`, `/connect`) stay
  reachable — a redirect when stateless (`/connect`, `/dashboard`), an alias (same
  element at both paths) when they carry `?mode` / router state (`/bootstrap`,
  `/bootstrap/run`).
- Add the `/` redirect resolver (Setup-if-unconfigured-else-Projects), replacing
  `DashboardPage`'s own index-route branch.
- The **workloads** browser + **agent launcher** keep rendering inside ②
  (`LocalRuntimePage`) until I3 / I4 extract them — I1 stands up the shell + routes,
  it does **not** move surfaces.
- **Green because:** every old page still mounts; nothing is moved yet, only
  re-pointed and re-labelled. Pure routing/nav change.

### I2 — Clusters (②)

- Stand up `/clusters` + `/clusters/:id`. Move `EnginesSection`/`MicroVmPanel`/
  `MicroVmFacts`/`EgressPanel`/`CredentialsPanel` out of `local-runtime/index.tsx` and
  the four cloud-lifecycle panels + cluster list out of `settings.tsx`. Fix the egress
  double-fetch (lift the policy query to the detail container).
- Point `/local-runtime` → redirect `/clusters`; the cluster-switcher + Settings
  "Add/Manage" CTAs point at ②.
- Leave the **doctor**, **deploy wizard**, **workloads**, and **launcher** still
  rendering from their old locations until their phases land (so nothing 404s).
- **Green because:** ② becomes the live owner of cluster/runtime management; the old
  `LocalRuntimePage` is reduced to a redirect and the moved Settings panels are
  imported by ② instead. No dangling imports.

### I3 — Projects (③)

- `/projects` becomes the project grid (move `Overview` out of `dashboard.tsx`). Move
  the deploy wizard to `/projects/deploy`; move `WorkloadsPanel` (+ tables, log
  drawer, pod-shell) into env detail. Fold Environments/Deployments under the area
  (drop their nav entries; keep routes).
- Redirect `/` index, `/local-runtime/deploy`, and the old Dashboard path into ③.
- **Green because:** the grid + wizard + workloads now live in ③; the contextual
  deploy CTAs already point at one route (§5.3), so re-homing the wizard is a path
  rename + redirect.

### I4 — Agents (④)

- Stand up `/agents`: move `AgentAuthSection`/`AgentLoginPanel` usage and
  `LaunchAgentButton` here; add the runs list (`agent.list` across runtimes). Wire the
  launcher to the **existing** `TerminalSessionsProvider` — observe tabs are unchanged.
- ② detail's "Run agent" becomes a deep-link into ④.
- **Green because:** the dock/provider already power agent tabs; ④ is a new consumer
  of the same provider + `agent-login` component, not a new terminal stack.

### I5 — Setup + Settings + cleanup

- Build the `/setup` hub consolidating `FirstRunWelcome`/`GetStarted` + Connect +
  Bootstrap + the **Doctor** (preflight). Slim `settings.tsx` to Updates/About/Prefs.
- **Delete** `pages/local-runtime/index.tsx`, `pages/placeholder.tsx`, and the dead
  redirects/old nav. Final canonical-naming pass (retire "Dashboard"/"Overview";
  "Local runtimes" everywhere).
- **Green because:** every consumer of the deleted files was re-pointed in I1–I4;
  this phase removes now-orphaned code and the temporary redirects last.

---

## 8. Resolved decisions (owner + Devon + Parker)

The planning-pass open questions are now locked — the build phases implement these,
they don't relitigate them:

- **Q1 — one adaptive `/clusters/:id`.** A single cluster-detail route dispatches on
  cluster kind (`isMicroVmClusterId`): a cloud cluster → lifecycle ops, a local
  runtime → VM lifecycle + egress + credentials + facts. No separate
  `/clusters/runtimes/:name` namespace. [build in I2]
- **Q2 — Environments/Deployments are routes-only, nested under ③ Projects.** They
  lose their top-level nav entries (this is what keeps the nav at five) but keep live
  routes so existing links resolve; they're reachable from the grid, project detail,
  and env detail. No secondary in-area tab strip. [nav drops in I1, re-home in I3]
- **Q3 — Setup is ADAPTIVE.** ① is a prominent nav item (and the default landing)
  while the shell is unconfigured, and is **demoted out of the primary nav once a
  cluster is selected**. `/setup` stays routable; its recurring children (add-cluster,
  doctor) surface from ② Clusters. Configured users see the four-item nav Clusters /
  Projects / Agents / Settings. [build in I1]
- **Q4 — Doctor: canonical in Setup, plus a re-run entry from the runtime.** The
  prerequisite preflight lives at ① `/setup/doctor`, and a "Re-run checks" entry
  surfaces from the ② cluster/runtime detail — **one `PreflightPanel`, two entry
  points**, not two implementations. [build in I2/I5]
- **Q5 — the deploy wizard is target-aware.** When no runtime is up, the wizard gains
  an inline "start a runtime" step and **preserves the deploy intent** (project /
  environment) across the runtime bring-up, rather than dead-ending in a wizard that
  can't finish or bouncing the operator out to ②. [build in I3]

```

```
