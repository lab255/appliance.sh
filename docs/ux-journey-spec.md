# UX Journey & State-Legibility Spec — Desktop App

Principal-designer redesign pass, 2026-08-19. Layer ABOVE the bug-level audit
(`docs/desktop-appliance-audit-2026-08.md`): assumes all Workstream 1–3 fixes
land as specified (landing routes cluster→`/projects` else vmExists→`/machine`
else `/setup`; switcher shows a core-ready Dev Machine row; express ladder stops
at core; Machine exposes shell/agent at core). Everything here is
frontend-only: copy, layout, navigation, and sequencing of host calls that
already exist (`up`/`devUp`/`clusterUp`/`selectCluster`/`bootstrap.run`).

## Executive summary

1. Name the two layers in product terms and kill the engineering vocabulary:
   the core machine is the **Sandbox**, the deployment layer is **App
   hosting**, and the upgrade verb everywhere is **"Set up hosting"** — the
   machine header becomes a two-row capability ledger instead of one
   overloaded green pill.
2. First run branches by intent — **"Run a coding agent" vs "Host an app"** —
   two cards, one machine underneath; intent shapes the ladder shown, the
   success CTA, and the first-session landing, never the IA.
3. The pairing story is told at the target level: the Cloud area's empty state
   speaks to Dev-Machine-only users ("apps here live on this computer — pair a
   cloud to put them on the internet"), and "Deploy to cloud" becomes a
   navigational action on app/environment detail over the existing wizard.
4. One `<LongOperation>` pattern (ladder + now-line + collapsible log + stall
   reassurance + honest time label) replaces the four divergent treatments;
   every duration estimate lives in one table; ladders are built only from
   work actually scheduled.
5. Home is capability-aware and object-centric: `/projects` once a deploy
   target exists, `/agents` for a core-only machine with agent intent or agent
   activity, `/machine` for core-only otherwise, `/setup` for nothing.

Priorities: **P0** = vocabulary/ledger, intent fork, hosting-upgrade moment,
landing rule. **P1** = pairing narrative, switcher grouping, LongOperation
adoption on AWS bootstrap + deploy run. **P2** = polish (elapsed timers,
naming debt, app-detail pairing line).

---

## 0. The one-sentence product model (write this once, reuse everywhere)

> **Appliance gives this computer a private machine-in-a-machine. Out of the
> box it's a Sandbox — a safe place to run coding agents and dev shells.
> Turn on App hosting and it also runs your apps with live URLs. Pair a
> cloud when apps need to live on the internet.**

Every area's header copy should be a projection of this sentence. Today each
page invents its own framing ("isolated virtual machine that runs your apps,
dev shells, and coding agents" — machine/index.tsx:59,72 — lists all three
with no order or story). The sentence establishes the _ladder of commitment_:
Sandbox (free, instant) → Hosting (one-time setup, minutes) → Cloud (paired,
many minutes). That ladder is the spine of Q1–Q5 below.

---

## Q1 — The two-audience tension: branch first-run by intent (P0)

### Verdict on the IA

The five-area IA survives both audiences and should **not** fork. Apps /
Agents / Machine / Cloud / Settings are nouns both users recognize; the
self-hoster simply never opens Agents and the agent-runner rarely opens
Cloud. What does NOT survive both audiences is the **first-run funnel**:
`FirstRunWelcome` (setup/index.tsx:63-91) is written 100% for the
self-hoster ("Run your apps right on this computer") while the express boot
it triggers now produces a machine whose _immediate_ capabilities (15s core:
shell, agents, guarded egress) are the agent-runner's. The current single
button over-promises hosting and under-sells the thing that is actually
ready in fifteen seconds.

### The first-run decision — two cards, one machine

Replace the single "Get started" button with an intent choice. This is not a
wizard and not a mode switch: both cards boot the same core machine; intent
only decides (a) which ladder is shown, (b) the success panel's primary CTA,
(c) the first-session landing area, (d) whether hosting setup is chained on.

```
                    ┌────┐
                    │ ⌂  │
                    └────┘
              Welcome to Appliance

   Your computer, with a safe machine-in-a-machine:
   run coding agents in a sandbox, host apps with
   live local URLs — no cloud account needed.

   What do you want to do first?

┌──────────────────────────────┐  ┌──────────────────────────────┐
│  🤖  Run a coding agent      │  │  🚀  Host an app             │
│                              │  │                              │
│  Claude Code and friends     │  │  Deploy an app to this       │
│  work in an isolated sandbox │  │  computer and get a live     │
│  — your files stay yours,    │  │  local URL. Free, private,   │
│  their internet is guarded.  │  │  always on while this        │
│                              │  │  computer is.                │
│  Ready in about 15 seconds   │  │  First-time setup takes a    │
│                              │  │  few minutes                 │
│                              │  │                              │
│  [ Start the sandbox ]       │  │  [ Set up hosting ]          │
└──────────────────────────────┘  └──────────────────────────────┘

          Set up later        ·        More options
```

Copy rules baked in above:

- **Time-shape is on the card** ("about 15 seconds" vs "a few minutes") —
  the intent choice doubles as the honest time disclosure, so nobody is
  surprised by the ladder that follows.
- Neither card claims the other's capability is unavailable. Text under the
  fold (small, one line, shared): _"Either way you get both — this just
  picks what we set up first."_
- "Set up later" / "More options" behave exactly as today
  (setup/index.tsx:37-42).

### What each intent does

|                            | `intent: 'agent'`                                  | `intent: 'host'`                                                                                                                         |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Boot call                  | `devUp` (core only) — as today's express           | `devUp`, then chain `vm.clusterUp` in the same run (both exist on the host bridge; progress.tsx already knows how to run sequenced work) |
| Ladder                     | Core rungs only, terminal rung **"Sandbox ready"** | Core rungs + a second group **"Setting up App hosting"** (see Q4 ladder spec)                                                            |
| Success panel primary CTA  | **"Run your first agent"** → `/agents`             | **"Deploy your first app"** → `/projects/deploy` (target auto-skips — one ready target)                                                  |
| Success panel secondary    | "Open a shell" (opens dock session)                | "Run an agent instead" → `/agents`                                                                                                       |
| First-session landing (Q5) | `/agents`                                          | `/projects`                                                                                                                              |

Implementation pointers: extend `MicroVmWizardValues` (bootstrap/wizard.tsx:60-64)
with `intent?: 'agent' | 'host'`; `FirstRunWelcome` passes it in router state
(setup/index.tsx:56-62); `MicroVmProgress` (progress.tsx:420) branches ladder +
success CTAs on it; persist to `localStorage['appliance.firstRunIntent']` for
the landing resolver (routes.tsx:30). The `GetStarted` menu (setup/index.tsx:94)
keeps its cards but retitles "On this computer" → **"Host apps on this
computer"** and gains a sibling **"Run coding agents in a sandbox"** card
(links the same express boot with `intent:'agent'`), so the full menu answers
both audiences too.

### Success-panel copy (replaces progress.tsx:745-786)

Agent intent:

> ✓ **Sandbox ready**
> An isolated machine is running on this computer. Agents work in its shared
> workspace; their internet access is guarded and your credentials never
> enter the VM.
> `[ Run your first agent ]` `[ Open a shell ]` > _App hosting isn't set up yet — you can add it any time from the Machine
> page or on your first deploy._

Host intent (after the chained hosting group completes):

> ✓ **Ready to host apps**
> Your machine is running with App hosting on. Deploys get a live local URL.
> `[ Deploy your first app ]` `[ Run an agent instead ]`

---

## Q2 — The tri-state model: product vocabulary + the capability ledger (P0)

### Naming

| Engineering term                                                           | Product term                                | Rule                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core machine / core sandbox                                                | **Sandbox**                                 | What the machine can _always_ do once running: shells, agents, guarded internet, brokered credentials.                                                                             |
| deployment layer / cluster / k3s / api-server / deploy target registration | **App hosting** ("hosting" in running text) | A capability you _turn on_, once, per machine. Never say "provision", "cluster", "k3s", "deployment layer", "registered as a deploy target" outside Technical-details disclosures. |
| `clusterUp` action                                                         | **"Set up hosting"**                        | The one verb, everywhere: Machine card, deploy wizard TargetStep, switcher row.                                                                                                    |
| tri-state `none / core-machine / deploy-target`                            | "Not created / Sandbox / Sandbox + Hosting" |                                                                                                                                                                                    |

Why "App hosting" and not "app platform"/"deploy layer": it names the _user
outcome_ (my apps are hosted here), reads correctly to the self-hoster, and
gives the upgrade verb a natural object ("set up hosting"). "Core" is an
engineering qualifier — a user's machine is not "core ready", it's _ready_,
and the thing that isn't ready is hosting.

Color semantics (fixes the audit's green-pill ambiguity systematically, not
per-pill): **cyan = sandbox capability** (the existing `isolated VM` tint),
**green = "apps can run here"** (hosting on, cloud ready, deploy succeeded).
A machine that cannot host never wears green.

### The capability ledger (Machine header redesign)

Replace the single overloaded state pill (runtime-detail.tsx:203-247 — where
`core ready` and `running` share one green pill) with: **pill = machine
lifecycle only**, plus a two-row ledger that makes the layers visible and
names the upgrade.

```
appliance   [isolated VM] [default]                     ● Running
──────────────────────────────────────────────────────────────────
 Sandbox        ● Ready        shells · agents · guarded internet
 App hosting    ○ Not set up   apps deploy here once it's on
                               [ Set up hosting ]  one-time · 2–4 min
──────────────────────────────────────────────────────────────────
 Lifecycle | Egress | Credentials | Facts | Workloads
```

Ledger states:

| Machine state                        | Pill                                     | Sandbox row                 | App hosting row                                                               |
| ------------------------------------ | ---------------------------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| not created                          | `Not created` (muted)                    | `○ Off — start the machine` | `○ Not set up` (no button)                                                    |
| stopped                              | `Stopped` (muted)                        | `○ Off`                     | previous value, muted (`Set up` / `On — resumes on start`)                    |
| starting                             | `Starting…` (cyan)                       | `◌ Starting…`               | unchanged                                                                     |
| running, core-only                   | `Running` (green border, neutral fill)\* | `● Ready` (cyan)            | `○ Not set up` + **Set up hosting** button                                    |
| running, hosting provisioning        | `Running`                                | `● Ready`                   | `◌ Setting up… 2–4 min` (LongOperation inline, Q4)                            |
| running, hosting on, healthz pending | `Running`                                | `● Ready`                   | `◌ Starting the app platform…` (cyan)                                         |
| running, hosting serving             | `Running`                                | `● Ready`                   | `● On` (green) — subtitle "apps deploy here · appears in the target switcher" |
| failed                               | `Failed` (red)                           | per-phase                   | per-phase                                                                     |

\* Lifecycle "Running" uses a neutral/green-border treatment distinct from the
green _capability_ dot, so a running-but-can't-host machine reads "alive"
without reading "deployable".

The existing "Core sandbox ready" card (runtime-detail.tsx:425-445) — the one
honest treatment — is _promoted into_ this ledger rather than remaining a
transient banner: the ledger is permanent, so the mental model is taught on
every visit, not only in the one state where the banner shows. Its restart
warning moves into the Set-up-hosting confirm line: _"Restarts this machine
once — open shells close and reconnect; agents' workspace files are kept."_

### Where each layer surfaces (audience mapping)

- **Agents area**: sandbox-only vocabulary. Never mentions hosting (already
  true — gating is `running && devMount`; keep it that way).
- **Apps area / deploy wizard**: the only places that _ask_ for hosting.
  TargetStep's row label changes from `core ready` (deploy.tsx:910) to
  `sandbox — hosting not set up`, and the amber prepare box (deploy.tsx:934-953)
  rewrites to: _"**appliance** is running as a sandbox, but hosting isn't set
  up yet. Setting it up takes 2–4 minutes (one-time) and restarts the
  machine; your folder and settings here are kept."_ Button:
  **"Set up hosting & continue"**.
- **Machine area**: the ledger — the one place both layers are always visible.
- **Switcher** (cluster-switcher.tsx): core row subtitle `sandbox — can't
deploy yet · set up hosting`, hosting row subtitle unchanged
  (URL). Selecting a core row routes to `/machine` (nothing to bind a client
  to) — the row is a status + doorway, not a target.

### The upgrade moment

One choreography wherever "Set up hosting" fires (Machine ledger, TargetStep,
switcher deep-link → Machine):

1. Confirm-in-place (no modal): button swaps to a two-line confirm —
   _"One-time setup, usually 2–4 minutes. Restarts this machine; open shells
   close, agent workspace files are kept."_ `[ Set up ] [ Cancel ]`. Skip the
   confirm when nothing is running that a restart would kill (no shells, no
   agents).
2. LongOperation inline (Q4 pattern, `minutes` class): rungs
   `Restarting with hosting` → `Starting the app platform` (live sub-detail
   from `CLUSTER_SUB_PHASES`, progress.tsx:411-416) → `Ready for deploys`.
3. Completion: ledger row flips to `● On` green with a 2s ease; toast
   **"appliance can now host apps"**; if launched from TargetStep, the wizard
   advances itself (already does — deploy.tsx:861-870); switcher row subtitle
   updates on the next config invalidation (already wired).

---

## Q3 — The pairing story: one narrative, zero new backend (P1)

### The honest frame

Local and cloud targets are separate control planes with separate app lists —
there is no cross-target app object, no sync, no migration. So the pairing
story must be told at the **target level** ("where do apps live") and the
"offload" action must be **"deploy this app to a cloud too"** — a re-deploy
of the same source through the existing wizard, not a move. Anything implying
migration ("promote", "transfer") would be a lie; "deploy to cloud" is
exactly what happens.

The narrative sentence (used on Cloud empty state, Machine facts, deploy
target step):

> **Apps on your Dev Machine live on this computer — private local URLs,
> running while it's on. Pair a cloud to run apps on the public internet.**

### Cloud area, Dev-Machine-only state (cloud/index.tsx:55-67 rewrite)

Today: "No cloud connected — Connect to an existing Appliance installation,
or bootstrap a new one on your AWS account." This reads as an error and
speaks pure ops. Replace with a pairing pitch that acknowledges what the user
already has:

```
Cloud
Pair this computer with a cloud installation.

┌──────────────────────────────────────────────────────────────┐
│            ☁                                                 │
│   Your apps currently live on this computer                  │
│                                                              │
│   The Dev Machine hosts them at private local URLs — free,   │
│   and only reachable here while this computer is on.         │
│   Pair a cloud when an app needs a public URL, more uptime,  │
│   or teammates.                                              │
│                                                              │
│   [ Connect an existing cloud ]   [ Create one on AWS ]      │
│                                                              │
│   Creating on AWS builds real infrastructure in your own     │
│   account and takes 15–30 minutes. Connecting to one your    │
│   team already runs takes a minute.                          │
└──────────────────────────────────────────────────────────────┘
```

(If no Dev Machine exists either — web shell, or nothing set up — fall back
to today's neutral copy.) The two CTAs keep their existing destinations
(`/setup/connect`, `/cloud/bootstrap?mode=aws`); the time-shape line is the
Q4 estimates table speaking early.

Once ≥1 cloud is connected, add one line above the list: _"Deploys go to the
selected target — switch between this computer and your clouds in the target
menu, or per-deploy in the wizard."_ That sentence is the entire "how do the
two areas relate" doc, placed where the question arises.

### "Deploy to cloud" as a user action

On **environment detail** (environments/detail.tsx) and **app detail**
(projects/detail.tsx), next to the existing Deploy button, when the selected
target is a Dev Machine:

- ≥1 cloud connected → secondary button **"Deploy to cloud…"**: selects the
  cloud (single) or opens a small target picker (multiple), then navigates
  `/projects/deploy?project=<name>&environment=<env>` — the wizard's preset
  capture (deploy.tsx:85-88) and TargetStep do the rest. Sub-line under the
  confirm: _"Re-uploads this app's source and builds it in the cloud. Set its
  environment variables again in the Configure step — they don't follow
  automatically."_ (Honesty over convenience; env vars are per-target.)
- 0 clouds connected → same button, routes to `/cloud` (the pairing pitch
  above), carrying `?intent=deploy&project=…&environment=…` so Cloud can show
  _"Pair a cloud, then we'll take you back to deploying `web/production`."_
  (Pure navigation state; drop it silently if the user wanders off.)

### Switcher as the daily pairing surface (cluster-switcher.tsx)

Group rows under two headers so the pairing is visible on every open:

```
┌───────────────────────────────────────┐
│ THIS COMPUTER                         │
│ ✓ Dev Machine        [this computer]  │
│   sandbox + hosting · localhost:8443  │
│ CLOUD                                 │
│   acme-prod                           │
│   api.acme.example.com                │
├───────────────────────────────────────┤
│ + Pair a cloud                        │
└───────────────────────────────────────┘
```

Rename the footer "Add cloud" → **"Pair a cloud"** here and on the Cloud page
header button — one verb for the relationship everywhere. When only the
Dev Machine exists, the empty CLOUD group shows a single muted line "none
paired yet" — a standing, zero-cost advertisement that the concept exists.

### Machine facts (runtime-detail.tsx:610-613)

Append one sentence: _"Apps here get local web addresses. To put an app on
the public internet, pair a cloud →"_ (links `/cloud`).

---

## Q4 — Time-shape honesty: the `<LongOperation>` pattern (P0 pattern; P1 full adoption)

### Audit of today's long operations

| Operation                   | Real shape                                    | Current UI                                                                   | Gaps                                                                                                    |
| --------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Core boot (express)         | ~15 s (first run: media download can stretch) | 5-rung ladder + collapsible log + stall notice (progress.tsx)                | Best in class. Post-fix it stops at core — keep.                                                        |
| Hosting setup (`clusterUp`) | minutes (first run: image pulls)              | bare `<pre>` tail, button label "Provisioning…" (runtime-detail.tsx:464-471) | No steps, no estimate, no stall, no success moment — the cyan card just vanishes. Worst offender.       |
| TargetStep inline prepare   | minutes                                       | 10px `<pre>` + pulsing button (deploy.tsx:947-951)                           | Same gaps.                                                                                              |
| Deploy run                  | 1–5 min                                       | log + status badge (RunStep, deploy.tsx:1418)                                | No stall notice; 5-min poll timeout surfaces as raw "polling timed out".                                |
| AWS bootstrap               | many minutes (15–30)                          | 3 phase cards + always-open log (progress.tsx:236-357)                       | No estimates, no stall detection, phase jargon ("phase1", "Promote state"), log is the primary surface. |

Three different stall philosophies, three log stylings, two ladder stylings,
zero shared estimates. The express ladder already embodies the right ideas —
extract it.

### The pattern: one component, three time classes

`<LongOperation>` (new: `src/components/long-operation.tsx`), used by all
five operations above. Anatomy, top to bottom:

```
┌ Title ────────────────────────────── [status badge] ─┐
│  "Setting up App hosting"            Running · 1:42  │
│                                                      │
│  ✓ Restarting with hosting                           │
│  ◌ Starting the app platform                         │
│     Platform images staged — importing.        ← now-line (live sub-detail)
│  ○ Ready for deploys                                 │
│                                                      │
│  [stall notice — only when quiet too long]           │
│                                                      │
│  ▸ Details (log)                    ← collapsed while healthy
└──────────────────────────────────────────────────────┘
   Usually 2–4 minutes. Safe to visit other areas —    ← time + leave-safety line
   this continues in the background.
```

Contract:

- **Steps** are built from the _scheduled plan only_ (the generalized B2
  rule): a rung may never exist for work this run won't do, and terminal
  success may only check rungs that ran. Rung grammar: `label` = outcome noun
  ("Ready for deploys"), `runningLabel` = present progressive ("Registering
  as a deploy target"), `detail` = one sentence, live-replaceable (the
  `CLUSTER_SUB_PHASES` mechanic, progress.tsx:411-416, becomes a generic
  `nowLine` prop).
- **Log** is always present, collapsed by default when steps exist, auto-
  expands on failure and on stall-notice click. One styling (the
  progress.tsx one). Ops with no meaningful steps (deploy build) may run
  log-open with a 3-step coarse ladder (below).
- **Stall notice** = the express boot's reassurance block
  (progress.tsx:685-706) verbatim as a component, with per-class thresholds
  and per-op copy for _why_ quiet is normal. It never aborts; the engine
  stays the failure authority.
- **Time + leave-safety line**: every operation declares
  `estimate: string` and `leaveSafety: 'resumable' | 'keep-page'`.
  Resumable (engine-side work observable by polling: VM boot, hosting
  setup): _"Safe to visit other areas — this continues in the background."_
  Keep-page (page-held promise drives the work: AWS bootstrap, deploy
  upload): _"Keep this page open until it finishes."_ No operation ships
  without an honest answer to "can I leave?".
- **Terminal states**: success = check-all + one primary CTA + at most one
  secondary (the express panel's rule); failure = `FriendlyError` with the
  failing rung named only if a rung was actually observed
  (progress.tsx:793-799 rule), Retry primary, log open.
- **Elapsed timer** in the badge for `minutes`/`long` classes (P2 for
  `seconds`).

Time classes and thresholds:

| Class               | Ops                                         | Ladder                                 | Stall notice after | Estimate string shown                                          |
| ------------------- | ------------------------------------------- | -------------------------------------- | ------------------ | -------------------------------------------------------------- |
| `seconds` (≤ ~30 s) | core boot (warm), stop, VM start            | optional; spinner + now-line is enough | 30 s               | none (an estimate on a 15 s op is noise)                       |
| `minutes` (1–5 min) | hosting setup, deploy run, cold core boot   | yes                                    | 90 s               | "usually 2–4 minutes" / "usually 1–3 minutes"                  |
| `long` (10 min +)   | AWS bootstrap, first-boot media+image pulls | yes, grouped                           | 3 min              | "usually 15–30 minutes" + per-rung estimates on the slow rungs |

### The estimates table (single source of truth)

New `src/lib/duration-estimates.ts` — every user-facing duration string
imports from here; nothing hand-writes minutes anywhere else (today "a few
minutes" / "10–15 minutes" / "2–4" would drift):

| key             | copy                                                       |
| --------------- | ---------------------------------------------------------- |
| `coreBoot`      | "about 15 seconds"                                         |
| `coreBootFirst` | "first start downloads the VM image — up to a few minutes" |
| `hostingSetup`  | "one-time · usually 2–4 minutes"                           |
| `deployRun`     | "usually 1–3 minutes"                                      |
| `cloudCreate`   | "usually 15–30 minutes"                                    |
| `cloudConnect`  | "about a minute"                                           |

### Per-operation respecs

- **Hosting setup** (runtime-detail.tsx `run('cluster', …)` + TargetStep
  `startRuntime`): class `minutes`, rungs `Restarting with hosting` /
  `Starting the app platform` / `Ready for deploys`; stall copy: _"First-time
  setup downloads the app platform's images — a quiet couple of minutes is
  normal."_ Success CTA in Machine context: none needed (ledger flips +
  toast); in wizard context: auto-advance (existing).
- **Deploy run** (RunStep): class `minutes`, coarse rungs derived from the
  meta lines it already emits (deploy.tsx:358,372,381): `Package & upload` /
  `Build` / `Roll out`; log open by default (builds are the one place users
  genuinely read output). Replace the raw 5-minute timeout error with:
  _"Still deploying after 5 minutes — the deploy continues on the server.
  Check Recent activity for its final status."_ + link to the deployment
  detail (the poll knows the id).
- **AWS bootstrap** (AwsProgress): class `long`. Convert the three
  `PhaseCard`s to the ladder with human rungs: `Cloud foundation — VPC,
cluster, DNS (usually 15–25 min)` / `Control plane — the Appliance server`
  / `Handover — moving install records into the cloud`. Raw `phase1/2/3` and
  "State backend s3://…" demote to Technical details. (Workstream 2 owns the
  engine question; this is presentation only and applies to whichever engine
  streams.) Stall notice: _"AWS is building real infrastructure — long quiet
  stretches are normal. The event log shows the last resource created."_
  `leaveSafety: 'keep-page'`, stated.
- **Core boot** (MicroVmProgress): already conforms; port it onto the shared
  component so there is exactly one implementation, and swap terminal-rung
  copy per Q1 intent ("Sandbox ready" / continue into hosting group).

---

## Q5 — The home question (P0 for the rule; trivial code)

**Recommendation: keep `/projects` as home once a deploy target exists —
including a zero-app one — but do not send core-only users to `/machine` as a
terminal home; send agent-intent users to `/agents`.**

Reasoning:

- _Home should be where your live objects are._ For a hosting user that's
  apps — and `EmptyApps` (apps/index.tsx:428-451) is a good first-deploy
  surface, so zero-apps is not an argument against Apps-as-home. For a
  core-only agent user, the live objects are **agent runs**, and the Agents
  page is the only page that shows them (sign-in, launcher, Runs list, with
  competent empty states for every sub-state including machine-down —
  agents/index.tsx:213-225). `/machine` is a _management_ page: lifecycle
  buttons, egress, credentials. Landing an agent user there daily is landing
  them in the garage instead of the car.
- `/machine` remains the right landing for the state where nothing else has
  an object to show: core machine exists, no agent signed in, no host intent
  — i.e. the user who clicked "Set up later" mid-thought. With the ledger
  (Q2) plus B3's shell/agent affordances, Machine is a competent "what now"
  surface for exactly that user.

Landing table (`LandingRedirect`, routes.tsx:30-39):

| State                                                                                                            | Home        | Why                                             |
| ---------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------- |
| No cluster, no VM                                                                                                | `/setup`    | nothing exists                                  |
| VM exists, core-only, `firstRunIntent === 'agent'` **or** any agent credential stored **or** any run in registry | `/agents`   | the user's objects are runs                     |
| VM exists, core-only, otherwise                                                                                  | `/machine`  | ledger + "Set up hosting" + shell/agent buttons |
| Cluster selected (Dev Machine with hosting, or cloud)                                                            | `/projects` | apps are the objects; `EmptyApps` handles zero  |

The agent-signal checks are cheap and local (`localStorage` intent; the
signed-in probe and `agent.list` already exist — reuse, don't add). If the
signals are unavailable within ~200 ms, fall back to `/machine`; never block
landing on a slow probe.

One addition to make `/machine`-as-home excellent for its one audience: when
state = core-only, render a compact "Start something" row above the ledger —
`[ Run an agent ]  [ Open a shell ]  [ Set up hosting ]` — the three exits
from the parked state, so home always answers "what can I do right now?".

---

## Prioritized implementation list

### P0 — state legibility + first-run (highest leverage, small surface)

1. **Vocabulary sweep**: "Sandbox" / "App hosting" / "Set up hosting"
   replaces core/cluster/deployment-layer/provision in all user-facing
   strings. Files: runtime-detail.tsx (card :425-445, pill :203-247, tab
   tooltip :295-297, error headlines :447-461), machine/index.tsx (picker
   suffix :99, header :72), deploy.tsx (TargetStep :910, :934-953, no-client
   error :322), progress.tsx (ladder + success), cluster-switcher.tsx (core
   row), agents/index.tsx (no changes — verify no hosting leakage).
2. **Capability ledger** in the Machine header (runtime-detail.tsx) with the
   state table in Q2; lifecycle pill loses capability meaning; green
   reserved for "apps can run here".
3. **First-run intent fork** (setup/index.tsx, wizard.tsx values,
   progress.tsx ladder/success/CTAs) incl. chained hosting setup for
   `intent:'host'`.
4. **Landing rule** per Q5 table (routes.tsx) + the core-only "Start
   something" row on Machine.
5. **`<LongOperation>` component** extracted from MicroVmProgress and adopted
   by hosting setup (Machine + TargetStep) — the two worst offenders — with
   `duration-estimates.ts`.

### P1 — pairing + long-op completion

6. Cloud empty-state pairing pitch + "paired" one-liner (cloud/index.tsx).
7. Switcher grouping (THIS COMPUTER / CLOUD) + "Pair a cloud" rename; core
   row routes to `/machine` (cluster-switcher.tsx).
8. "Deploy to cloud…" action on environment/app detail with the honest
   env-vars caveat; `/cloud?intent=deploy` return-path nicety.
9. LongOperation adoption: deploy RunStep (coarse rungs + timeout rewrite),
   AWS bootstrap (ladder + stall + keep-page line + human phase names).
10. GetStarted menu: dual-audience cards (agent card added, host card
    retitled) (setup/index.tsx:94-155).

### P2 — polish and debt

11. Elapsed timers on `minutes`/`long` operations; success-flip animation on
    the ledger.
12. Machine facts pairing line; Recent-activity "View all →" to
    `/deployments` (also closes the audit's orphaned-page note from above the
    bug layer).
13. Naming debt, considered and deferred: renaming "Dev Machine" (developer-
    slanted for self-hosters) was evaluated and rejected — it's established
    across CLI/desktop/docs and the switcher's "this computer" badge carries
    the hosting audience; revisit only with a product-wide rename.
14. First-run intent recorded to telemetry-free local state only; if the two
    audiences diverge further (e.g. hosting users never opening Agents),
    consider nav ordering by intent — explicitly out of scope now.

## Acceptance narratives (test the journeys, not the screens)

- _Agent-runner, cold start_: install → "Run a coding agent" → 15 s ladder →
  "Sandbox ready" → Run your first agent → lands `/agents`, signs in,
  launches; never sees the words cluster, provision, deploy target; next
  app-open lands `/agents` with the run visible.
- _Self-hoster, cold start_: install → "Host an app" → ladder runs core then
  "Setting up App hosting (usually 2–4 minutes)" with a stall notice at
  90 s quiet → "Ready to host apps" → deploy wizard auto-skips target →
  first URL; next app-open lands `/projects` with one card.
- _Agent-runner discovers hosting_: opens Machine, ledger shows
  `App hosting ○ Not set up`, clicks Set up hosting, sees restart warning
  because a shell is open, proceeds, watches the 3-rung LongOperation, gets
  the "can now host apps" toast, and the switcher row's subtitle now shows a
  URL.
- _Hoster outgrows the Mac_: opens env detail → "Deploy to cloud…" → 0 paired
  → Cloud pitch page ("apps currently live on this computer") → Connect →
  returns to deploying `web/production` on the cloud target, re-enters env
  vars per the caveat it warned about.
