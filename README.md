# Appliance

A platform for building, running, and shipping applications — locally and on the cloud — with **no Docker required anywhere**. Define your app in a manifest, run one command, and Appliance handles packaging, builds, infrastructure, and routing.

Everything local runs inside **one managed microVM**: a Kubernetes runtime, an image builder, the Appliance control plane (the same api-server that powers cloud installations, running as a plain binary in the guest), and the dev/agent sandbox. Your machine needs the `appliance` CLI and nothing else.

**Supported platforms:** macOS (Virtualization.framework) and Windows (needs WSL2 — run `wsl --install` once and reboot if you don't have it). Linux support is coming soon.

![The Appliance desktop app — Apps page](docs/images/desktop-apps.png)

## Quickstart

Install the CLI once:

```bash
pnpm add --global appliance.sh
```

### Build an app

```bash
cd your-app
appliance init # checks your machine, boots the VM, offers your first deploy
appliance dev  # deploys, streams logs, rebuilds on save
```

Your app is live at `http://<app>-dev.appliance.localhost:8081`. That's the whole loop — no Dockerfile required (framework apps get their image generated server-side), no Docker daemon, no registry setup.

### Run an app

```bash
cd your-runnable-app
appliance builder package
appliance runtime run ./your-app.appliance.zip
```

`builder package` works today; packaged-app `runtime run` is arriving with AP-163 and is still a placeholder in this release. Learn the distinction in [Appliance Runtime](docs/runtime.md), author bundles with the [manifest v2 reference](docs/manifest-v2.md), and check exact command availability in the [CLI reference](docs/cli.md). The design record starts at the [RFC index](docs/rfcs/README.md).

Prefer clicking to typing? The [desktop app](docs/desktop.md) provides the same product surfaces with buttons.

## The three journeys

### 1. Build & run your app locally

The two commands from the quickstart are the whole journey. `appliance init` is the front door on a fresh machine: it preflights your system (auto-fixing what's safe), boots the managed VM, saves the `local` profile, and offers to run your first deploy. After that, one command is the loop:

`appliance dev` brings the managed VM (and the control plane inside it) up, deploys the current app — or **every member of a multi-service stack** — streams merged, color-prefixed logs, and rebuilds on save. Builds happen server-side against the in-VM BuildKit, so a save-to-rollout loop is a few seconds and an unchanged rebuild is a no-op. Ctrl+C ends the session; the apps keep running.

Every app needs an `appliance.json` (scaffold one with `appliance configure`):

```json
{ "manifest": "v1", "type": "framework", "name": "my-app", "framework": "node" }
```

That's a complete manifest — no Dockerfile needed. Framework apps (`node`, `python`, or `auto`) get a container image generated for them server-side. Apps with their own `Dockerfile` use `"type": "container"` and build exactly what the Dockerfile says. Either way the CLI only uploads your **source**; images are built where they run.

For multi-service applications, `appliance.stack.json` names the members and wires them together:

```json
{
  "manifest": "v1",
  "type": "stack",
  "name": "demos",
  "apps": [{ "dir": "api" }, { "dir": "web", "env": { "API_URL": "{{service:api}}" } }]
}
```

In a stack folder, plain `appliance deploy` (and `appliance dev`) deploys every member with the wiring interpolated per environment. See [`examples/demo-stack-3tier`](examples/demo-stack-3tier) for a frontend → bff → backend stack.

### 2. A development environment + coding agents (zero terminal for teammates)

Non-technical teammates use the **[desktop app](docs/desktop.md)**: first run boots the managed VM as a ready dev environment, and the Agents page runs coding agents (Claude Code, GitHub Copilot, OpenAI Codex) inside it — credentials stay host-side and are injected per-request by the egress broker, never written into the VM.

![Agents in the desktop app](docs/images/desktop-agents.png)

To onboard a teammate onto a shared installation, open the console → **Settings → Team** → **Create invite link**, and send them the link. Opening it signs them in with their own credential — no server URL or secret to paste. Invited teammates get a **member** key: they see and manage apps but not the operator surfaces.

From a terminal, the same sandbox is:

```bash
appliance up                                           # build + run this repo (Dockerfile/compose/devcontainer)
appliance agent login                                  # one-time, per provider (--type copilot|codex)
appliance agent start                                  # launches the agent on cwd inside the VM
appliance agent start --autonomous --task "…" --wait   # headless run to completion
```

`up`, `agent`, and `dev` all share the **one** `appliance` VM — one boot, one lifecycle, one thing to reason about. See [`docs/agent-sandbox.md`](docs/agent-sandbox.md) for the threat model.

External agents can also drive Appliance from the outside: `appliance mcp` serves deploys, logs, health, and diagnostics over the Model Context Protocol, so a Claude Code session on your host (or any MCP client) can deploy and debug without shelling out to the human-facing CLI. See [`docs/mcp.md`](docs/mcp.md).

### 3. Ship the same app to the cloud

```bash
appliance cloud bootstrap                # provision an Appliance installation on AWS (one-time)
appliance deploy --profile <cloud>       # the same source artifact, the same command
```

The cloud api-server is the **same server** that runs inside your VM, deployed as cloud compute — same API, same packaging (a source zip built server-side), same commands. A stack file that runs locally spins up an identical set in the cloud with `appliance deploy --profile <cloud>`. The server URL printed by bootstrap **is** the web console URL — no separate hosting or CORS setup. Tear it all down with `appliance cloud teardown`.

Bootstrap needs an AWS account (credentials from `~/.aws`, SSO profiles work — pass `--aws-profile <name>`) and a domain for the installation; it walks you through both interactively.

> **Coming soon:** server-side **container-image builds on the cloud base**. Until the cloud builder lands, cloud deploys of `container`-type apps need a pre-built image: `appliance deploy --image-uri ghcr.io/org/app:tag`. Local deploys of every type, and cloud deploys of zip-packaged framework apps, build server-side today.

## How deploys work (every target, one pipeline)

1. `appliance deploy` packages your **source** into `appliance.zip` (no images, no Docker) and uploads it.
2. The api-server builds the container image next to where it runs — the in-VM BuildKit locally, the installation's builder on the cloud — generating a Dockerfile for `framework` apps.
3. The image rolls out (Kubernetes locally and on BYO clusters; Lambda on the cloud base) and you get a URL:
   `http://my-app-dev.appliance.localhost:8081` locally, your domain on the cloud.

Deploys are by digest, so re-deploying unchanged source is an idempotent no-op. Pre-built images skip the pipeline entirely: `appliance deploy --image-uri ghcr.io/org/app:tag`.

## Application types

| Type          | Use case                                     | Required fields                                   |
| ------------- | -------------------------------------------- | ------------------------------------------------- |
| **framework** | Source code with auto-detected build tooling | `name`, `framework` (`node`, `python`, or `auto`) |
| **container** | App with its own Dockerfile                  | `name`, `port`                                    |
| **other**     | Custom app with user-defined scripts         | `name`                                            |

Optional fields: `scripts` (lifecycle hooks: `prebuild`, `build`, `postbuild`, `start`, `test`, `migrate`), `includes`/`excludes` (framework), `port`, `platform` (container, cloud targets), `replicas` (Kubernetes targets; omitted → redeploys keep the current scale).

## CLI commands

| Command                              | Description                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `appliance init`                     | First-time setup: boot the managed VM and guide your first deploy                     |
| `appliance dev [env]`                | Dev loop: deploy this app/stack, stream merged logs, rebuild on save                  |
| `appliance deploy [project] [env]`   | Deploy the linked target — or the whole stack in a stack folder                       |
| `appliance destroy [project] [env]`  | Destroy an environment; defaults to the linked target                                 |
| `appliance up` / `down` / `shell`    | Build + run this repo (Dockerfile/compose/devcontainer) in the VM / stop / enter it   |
| `appliance agent …`                  | Run coding agents in the VM (`login`, `start`, `list`, `attach`, `stop`)              |
| `appliance stack …`                  | Scaffold (`init`), inspect (`status`), destroy a stack; `deploy` fans out on its own  |
| `appliance open` / `status` / `list` | Open the deployed URL / show status / list apps and environments                      |
| `appliance env set/list/unset`       | Manage per-environment variables                                                      |
| `appliance logs`                     | Stream a deployment's container logs                                                  |
| `appliance cloud bootstrap`          | Provision a new Appliance installation on AWS                                         |
| `appliance cloud teardown`           | Destroy a cloud installation                                                          |
| `appliance login` / `whoami`         | Authenticate with an installation / show the active profile                           |
| `appliance vm up/stop/status/…`      | Manage the one managed VM (`reset` starts over; also `egress` policy, `creds` broker) |
| `appliance doctor`                   | Preflight checks (`--fix` auto-resolves the safe ones)                                |
| `appliance mcp`                      | Serve deploy/debug tools over MCP (stdio) so AI agents can drive Appliance            |

Top-level `setup`, `status`, and `list` are shortcuts for `appliance app …`. Run `appliance --help` for the full, journey-grouped list.

> **Removed:** the host-side control-plane daemon (`appliance server start`) and its `--runtime docker` mode — the control plane now runs inside the VM, and nothing needs a Docker daemon. `appliance server …` prints the equivalent new command. The separate agent-sandbox VM (`appliance-sbx`) was merged into the one `appliance` VM (`appliance vm delete appliance-sbx` reclaims its disk).

## Profiles: one `local`, any number of clouds

Local deploys use the `local` profile, saved automatically when the VM first boots — `appliance dev` needs no login and no setup. Cloud installations get named profiles via `appliance login`. Switch anywhere with `--profile <name>` or `APPLIANCE_PROFILE`. Credentials live in `~/.appliance/profiles.json`.

`appliance setup` (or the first deploy) writes `.appliance/link.json` — project, environment, target server — so commands run from anywhere in that tree default to the linked target. The link file is safe to commit; it contains names, no secrets.

## The managed VM

`appliance vm up` (run implicitly by `init`, `dev`, `up`, and `agent`) boots an isolated microVM — Virtualization.framework on macOS, WSL2 on Windows; Linux (KVM) is coming soon — containing:

- **k3s** (Kubernetes) with hostname-routed ingress: `http://<app>-<env>.appliance.localhost:8081`
- **BuildKit** + an in-VM image registry: server-side builds with a persistent cache
- **The Appliance api-server as a guest binary** — the control plane at `http://api.appliance.localhost:8081`, serving the web console at the same URL
- **The dev/agent sandbox** — your working tree shared over VirtioFS, agents confined by the VM's egress policy (`appliance vm egress …`)

The VM parks with `appliance vm stop` (state persists) and everything — cluster, registry cache, deployed apps — survives a reboot. `appliance vm status` says what state it's in and what to run next; when something is beyond saving, `appliance vm reset` deletes everything and boots a fresh machine in one command. The CLI stages the api-server guest binary automatically (from the repo build or the release download); no image pulls, no registries, no Docker.

`appliance vm shell` (or **Open shell** in the desktop) drops you into the guest; shells are tmux-backed and reattachable across disconnects — the desktop even reattaches them after an app restart:

![A reattached shell into the managed VM](docs/images/desktop-terminal.png)

## Examples

See [`examples/`](examples/): `demo-node-framework`, `demo-python-framework` (no Dockerfile), `demo-node-container`, `demo-python-container` (own Dockerfile), and `demo-stack-3tier` (frontend → bff → backend with `{{service:…}}` wiring). The directory carries an `appliance.stack.json`, so everything comes up with one command:

```bash
cd examples && appliance deploy
```

## Development

Install dependencies with `pnpm install` (pnpm workspaces + Nx). The repo is a TypeScript monorepo plus one Rust crate (`packages/vm`, the microVM engine).

### Verifying changes — the green bar

`pnpm verify` is **the** green bar. It runs the full verification sequence and fails on the first error; nothing should reach review without it passing:

```bash
pnpm verify
```

It runs, in order (see [`scripts/verify.sh`](scripts/verify.sh)):

1. `pnpm run build` — `nx run-many --target=build --all`
2. `pnpm exec nx run-many --target=typecheck --all`
3. `pnpm run lint:check` — ESLint + Prettier `--check`
4. `pnpm exec nx run-many --target=test --all` — Vitest across packages
5. `packages/vm`: `cargo build && cargo test && cargo clippy -- -D warnings`

For a change that touches only a few packages, gate on the affected ones for a faster loop, e.g.:

```bash
pnpm --filter @appliance.sh/<pkg> run build
pnpm --filter @appliance.sh/<pkg> run test
# Rust only:
cd packages/vm && cargo build && cargo test && cargo clippy
```

Note: `@appliance.sh/bootstrap` and `@appliance.sh/install-aws` carry no unit tests yet — their `test` scripts are intentional no-ops (they are exercised by build/integration), so `pnpm verify` stays a meaningful signal. Add specs there when ready.

## Architecture

For API reference, infrastructure details, and contributor documentation, see [ARCHITECTURE.md](ARCHITECTURE.md).

## License

The Appliance project is [permissively-licensed under the MIT](/LICENSE).
