# `appliance up`: project detection + UX contract

**Status:** Implemented (originally a spike; this remains the UX contract). Sits on the in-guest Docker engine (`docs/sandbox.md`) and must stay cloud-promotable (`docs/cloud-promotion-contract.md` §5).

## Premise

`appliance up` is near-zero-config local testing of a repo's _own_ container definition (Dockerfile/compose/devcontainer), distinct from `appliance deploy` (ships an appliance to the in-VM api-server) and `appliance vm dev up` (an interactive provisioned workspace). It drives the in-guest **dockerd** over the vsock `DOCKER_HOST` and forwards published ports from the VM's allocated block (`docs/sandbox.md` §3, §5). The in-guest dockerd is a guest feature that exists solely for `up`'s own container runs — the deploy pipeline never touches it (deploy builds run server-side via the api-server's BuildKit). It is **not** k3s; nothing here touches the api-server guest-binary provisioning.

## 1. Detection precedence

Resolve the project type by checking, in order, relative to cwd:

1. **docker-compose** — `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml` (compose's own search order).
2. **devcontainer** — `.devcontainer/devcontainer.json` or `.devcontainer.json`. Runs the official `@devcontainers/cli` in-guest (`docs/microvm.md:183-187`).
3. **Dockerfile** — `Dockerfile` (then `Dockerfile.*` only via explicit `--file`).
4. **appliance manifest** — `appliance.json`/manifest: _not run by `up`_; detected only to print "use `appliance deploy`" and exit 0.

**Why this order:** compose is the most specific (it can itself reference a Dockerfile and a devcontainer can reference compose), so the broadest declaration wins. A repo with _both_ compose and a Dockerfile is the common monorepo case — compose is the intended entrypoint.

**Ambiguity:** if two same-tier candidates exist (e.g. both `compose.yaml` and `docker-compose.yml`) error and name the fix. Across tiers, the precedence above resolves silently but `up` prints the detected type (`Detected: docker-compose (compose.yaml)`).

**Override flag:** `--type compose|devcontainer|dockerfile` forces a tier; `--file <path>` points at a specific compose/Dockerfile. `--type` skips detection entirely.

## 2. Command surface

Recommend **new top-level commands** (`up`/`down`/`logs`/`status`), not under `vm`. Rationale: these are project-scoped verbs (operate on cwd, read `link.json`), matching `deploy`/`logs`/`open` — not VM-management verbs like `vm stop`/`vm delete`. Register them in `appliance.ts:34` SUBCOMMANDS. There is no collision with `appliance vm up` (still the VM bring-up) or top-level `appliance logs` (deployment logs) **except** the existing `appliance logs` — so `up`'s logs route by link.json: a `sandbox` link → docker logs, an api-server link → existing path.

```
appliance up   [--type <t>] [--file <p>] [--vm <name>] [--build] [--detach] [--no-open]
appliance down [--vm <name>] [--volumes]        # stop+remove this project's containers
appliance logs [service] [-f] [--tail <n>] [--vm <name>]
appliance status [--vm <name>] [--json]         # per-service state + URL map
```

`up` is foreground-with-`--detach` (Vercel-like: stream build, then print the URL map). It implicitly boots/uses the one managed VM (the same engine path as `vm up`) and shares the workspace (§3) before invoking docker/compose over `DOCKER_HOST`.

## 3. Project → VM

Run in the **single managed VM** (`--vm` overrides; default name `appliance` — the same VM `appliance dev`, `appliance deploy`, and `appliance agent` use, booted dev-capable with docker + the workspace mounted; the former separate `appliance-sbx` sandbox VM is retired). One-VM-per-project is rejected: it multiplies 4-GiB/2-CPU VMs (`spec.rs:59-62`) and fragments the shared dockerd image cache on `/persist/docker`. Projects coexist by Docker Compose project name (§5) inside one dockerd, exactly as `docker compose` isolates projects on one daemon.

The workspace reaches the guest by **reusing VirtioFS `--mount`** (`guest.rs:43,295-300`): `up` shares cwd at `/persist/workspace` and runs the build there (matches `docs/sandbox.md` Task B). `up` re-shares on each invocation; an existing different mount errors with the `vm up --no-mount` hint rather than silently re-pointing.

## 4. Port / URL surfacing

Deterministic, Vercel-like map. Each service's published ports draw from the VM's **allocated block**, never the reserved `8081/6443/5052/5053/5054` (`docs/sandbox.md` §5; `spec.rs:54,104`). Forwarding is `spawn_proxy(hostPort, guest_ip:containerPort)` via the per-VM published-port registry. Output (honors checklist item 6 — **no single-URL assumption**):

```
Sandbox up — myapp (compose)
  web   →  http://localhost:8201   (container :3000)
  api   →  http://localhost:8202   (container :8080)
  db    internal (not published)
Logs: appliance logs -f       Stop: appliance down
```

Host ports are assigned deterministically (stable per service across `up`s, persisted in state §5) so URLs don't churn. A clash reprints the `appliance vm stop` hint verbatim (`docs/sandbox.md` §5).

## 5. Project identity + state

Identity is **deterministic** (checklist item 4): the compose project name, else the cwd basename, normalized to a `dnsName` label. Persist a sandbox block in the same `.appliance/link.json` (`utils/link.ts:19`), additive — does not disturb `projectName`/`environmentName`:

```jsonc
"sandbox": {
  "type": "compose", "vm": "appliance",
  "project": "myapp",                              // deterministic project id (item 3,4)
  "services": [{ "name": "web", "port": 3000, "exposed": true, "hostPort": 8201,
                 "dependsOn": ["db"] },            // record depends_on (item 7)
               { "name": "db", "exposed": false }],
  "env": { "...": "shared project scope" }         // item 5
}
```

Each service is a **DNS-safe-named workload** (item 1), with an explicit per-service port + exposed flag (item 2), under **one project = one future Environment** (item 3). Services are **independently buildable** — never a fused artifact (item 8). This is the literal input the cloud promotion path (`appliance-deploy.ts:61` stackName, per-service builds) will reuse.

## 6. Sub-task contracts (acceptance)

- **A — Dockerfile up:** detect `Dockerfile`, build in-guest from the shared workspace, run, publish its port from the allocated block. _Done:_ `appliance up` on a single-Dockerfile repo prints one URL that serves; `down` removes the container; the image survives `vm stop`/`up`.
- **B — Compose up:** parse compose, model **N services** with DNS-safe names + per-service ports + `depends_on` into link.json (items 1,2,7), apply shared env (item 5), `docker compose up` in-guest under the deterministic project name. _Done:_ multi-service project comes up; `status`/output shows the per-service URL map with internal services marked unexposed; `down` removes the whole project; link.json is 1:1 promotable.
- **C — Devcontainer up:** run `@devcontainers/cli` in-guest against the shared workspace (`docs/microvm.md:183-187`); `appliance logs`/shell reach the dev container. _Done:_ a repo's `devcontainer.json` toolchain comes up verbatim and is reachable.
- **D — Desktop parity:** `host.ts` gains `up/down/logs/status` IPC mirroring the `microvm_*` channels (`packages/desktop/src/host.ts:240-269`), surfacing the same per-service URL map. _Done:_ the desktop "Local runtime" can detect a folder, run it, and show service URLs without dropping to the CLI.
