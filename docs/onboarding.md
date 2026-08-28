# Zero → first-deploy onboarding

**Status:** Implemented. This doc describes the shipped onboarding flow — one
guided CLI command, one desktop click, and a hand-off into the first deploy.
It sits on the microVM-only world (bare k3d deleted) with the api-server
running as a guest binary inside the VM and reads for workloads/logs served
over HTTP (`packages/api-server/src/main.ts`, `routes/workloads/index.ts`).

> **Prerequisites.** The managed VM needs a hypervisor: macOS uses
> Virtualization.framework (nothing to install); Windows needs **WSL2**
> (`wsl --install`, then reboot). **Linux support is coming soon** (KVM
> backend). First boot
> downloads a few components and can take a few minutes; subsequent boots are
> fast.

> **Naming.** The onboarding command is
> **`appliance init`** (not the spike's proposed `appliance start`). Bare
> `appliance init` runs local microVM onboarding; the historical remote/cloud
> credential setup is preserved via `appliance init --remote <url>` and
> `appliance login`. Cloud provisioning stays `appliance cloud bootstrap` —
> `init` is local-first and does not subsume AWS.

## Premise

Getting from a fresh machine to a live URL used to be a 4-command scavenger
hunt on the CLI and a dead-ends-at-the-dashboard click path in the desktop.
Everything the happy path needed already existed — it was just unsequenced
and unnamed. E5 wrapped it into **one CLI command** and **one desktop
click**, then **guides** the user into their first deploy so they never have
to discover `appliance app setup` / the deploy wizard on their own.

The bring-up itself is a single function: `runUp`
(`packages/cli/src/utils/microvm-up.ts`) boots the microVM, waits for its k3s
endpoint and the in-VM guest api-server, mints an API key from the VM's
bootstrap token, and saves the **`local`** credential profile. The Rust
engine publishes structured bring-up phases (`packages/vm/src/bringup.rs`:
`Media → Booting → Network → Cluster → Ready`/`Failed`), surfaced to the
desktop as `MicroVmStatus.phase`. And `appliance deploy` find-or-creates the
project + environment, uploads the source, polls the server-side build +
deploy, prints the URL, and writes `link.json`.

## The achieved state (was: "today's fragmentation")

The fragmentation the spike catalogued is gone. What a newcomer sees now:

| Surface | Front door                                                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CLI     | **`appliance init`** — doctor preflight + safe auto-fixes → boot the one managed VM → adopt the `local` profile → guided first deploy    |
| CLI     | **`appliance dev`** — the day-to-day loop: brings the same VM up if needed, deploys the cwd app or stack, streams logs, rebuilds on save |
| Desktop | First-run "Set up local runtime" → structured five-phase bring-up → "Deploy your first app" CTA                                          |

The invariants behind it:

- **One VM.** `appliance init`, `appliance dev`, `appliance up`, and
  `appliance agent` all use the single managed `appliance` VM (booted
  dev-capable with the workspace mounted). There is no separate sandbox VM.
- **One profile.** The default VM owns the **`local`** profile (the legacy
  `microvm` name is dual-written for one release of back-compat); additional
  VMs get `microvm-<name>`.
- **No Docker anywhere.** Onboarding has no container-runtime prerequisite:
  images build server-side against the in-VM BuildKit, and the api-server is
  a guest binary staged by the CLI — nothing is pulled from ghcr and nothing
  is built on the host.
- **`deploy` is self-sufficient.** `appliance deploy` find-or-creates the
  project + environment and writes `link.json`, so first-run never needs
  `appliance app setup` (`setup`/`link` remain for the link-without-deploying
  case only).

## 1. The single CLI command — `appliance init`

`appliance init` is a thin orchestrator
(`packages/cli/src/appliance-init.ts`):

```
appliance init [--name <vm>] [--no-deploy] [-y] [--remote <url>]
```

1. **Preflight + auto-fix** — run `runPreflight()` and `runFixes()`
   (`utils/preflight.ts`). Fail-fast on any hard `fail` that auto-fix can't
   clear, printing the checklist with exact remediations. Docker is
   deliberately **not** checked — nothing in the flow needs it (see §4).
2. **Boot + adopt** — call the shared `runUp()` (`utils/microvm-up.ts`):
   boot the default `appliance` VM with live phases, wait for k3s + the
   in-VM registry + the guest api-server, mint an API key from the bootstrap
   token, save the `local` profile. Idempotent: `runUp` keeps existing creds
   when they still authenticate.
3. **Hand-off** — print the next step, and if cwd is a deployable project,
   offer to run the first deploy now (interactive `Y/n` in a TTY; print-only
   in CI/non-TTY).

`appliance vm up` stays as the lower-level / multi-VM / power-user command
(`--name`, `--cpus`, `--memory`); `init` is the guided first run, and
`appliance dev` is the everyday front door once initialized. No behavior of
`vm up` changes.

### Happy path (CLI)

```
$ appliance init
Appliance doctor — fixing what's safe…
  ✓ kubectl                              installed
  ✓ Ports 8081 / 6443 / 5052 free
  ✓ macOS code-signing                   published binary is signed

Starting microVM "appliance"…
  » preparing boot media
  » booting guest
  » guest network up (10.0.0.5)
  » starting k3s (first boot pulls images — can take a few minutes)
  ✓ cluster ready
✓ api-server ready; credentials saved to profile local

MicroVM runtime 'appliance' is up.
  API server:  http://api.appliance.localhost:8081
  Ingress:     http://*.appliance.localhost:8081
  Profile:     local

Next — deploy your first app:
  → appliance deploy            (run it from your app's directory)
```

The phase lines are the `bringup.rs` labels the engine prints; the final
banner is `runUp`'s output. No image pull, no crane, no docker — the
api-server binary rode the boot media.

## 2. Desktop "Get started" — structured bring-up phases

> Screenshots and a page-by-page tour of the desktop app live in
> [desktop.md](desktop.md).

First launch with no cluster on a shell that can sandbox shows
`FirstRunWelcome` with a single **"Set up local runtime"** button that
navigates straight to the bring-up run — no picker, no form.
`MicroVmProgress` renders the five-stage ladder the engine reports
(`Media → Booting → Network → Cluster → Ready`), sourced live from
`MicroVmStatus.phase`, with the raw event log as a detail drawer and a
`Failed` phase surfacing its `detail` next to the Retry button.

## 3. The guided hand-off — link + first deploy

The runtime being up is the _middle_, not the end. Both surfaces lead the
user into their first deploy:

- **CLI (`appliance init` tail):** after the "up" banner, detect whether cwd
  is deployable (an `appliance.{json,ts,js}` manifest or a Dockerfile). In a
  TTY and deployable and not `--no-deploy`:
  prompt `Deploy <name> now? [Y/n]` and, on yes, run the deploy so its
  banner + URL print verbatim. Non-TTY / CI: print the exact next command
  only.
- **Desktop:** the bring-up success screen's primary CTA is **"Deploy your
  first app"** → the deploy wizard; the empty-projects dashboard state has a
  matching button, so a user who lands on the dashboard first still gets a
  button, not just copy-paste.

## 4. How `doctor --fix` folds in

`appliance init` runs the existing `runPreflight()` then `runFixes()`
(`utils/preflight.ts`) as its first step, blocking on unresolved hard
`fail`s. What doctor checks in the docker-free world:

- **helper binaries (kubectl)** — auto-installable providers drive
  `runInstall()` (`helper/src/install.ts`) instead of only printing the
  manual hint. kubectl is kept for the desktop's surviving PTY/terminal
  paths; **crane, docker, and buildctl are gone from the helper** — image
  build + delivery is entirely server-side.
- **No Docker check, no api-server image check.** Nothing in the appliance
  flow needs a host container runtime, and the api-server ships as a
  CLI-staged guest binary rather than a pulled image
  (`utils/preflight.ts` states this explicitly).
- **Ports** — the VM's five forwarded ports (ingress 8081, k8s 6443,
  registry 5052, egress 5053, buildkit 5054) are probed for conflicts.
- **macOS binary signing** — _guided, not blind_. A published `appliance-vm`
  binary is already signed; only a repo-built one is unsigned. When `init`
  detects a repo-built unsigned binary it offers to run
  `packages/vm/scripts/sign-dev.sh` rather than running it unprompted.

Errors stay fail-fast + actionable: every unfixable item carries a one-line
remediation, rendered by the checklist printer. `init` exits non-zero before
touching the VM if a hard check is still red after fixes.

## 5. What shipped where

- `packages/cli/src/appliance-init.ts` — the orchestrator (preflight+fix →
  boot → hand-off), TTY-aware deploy offer; `--remote` preserves the
  cloud/BYO credential flow.
- `packages/cli/src/utils/microvm-up.ts` — the shared `runUp` bring-up +
  guest api-server wait + bootstrap-token key minting + `local` profile
  adoption (extracted so `init`, `dev`, and `vm up` drive one copy).
- `packages/cli/src/utils/preflight.ts` — docker-free checks + widened
  `runFixes`.
- Desktop: structured-phase rendering in `MicroVmProgress`; "Deploy your
  first app" hand-off CTA; empty-projects deploy button.
- The CLI help groups commands by the three journeys and leads with
  `appliance init` / `appliance dev`.
