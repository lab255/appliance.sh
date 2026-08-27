# Appliance Runtime

Appliance has two complementary product surfaces:

- **Builder** turns source and authoring manifests into deployable source bundles or runnable app bundles. Its commands live under `appliance builder` and retain their existing top-level spellings.
- **Runtime** verifies and runs packaged apps. Its commands live under `appliance runtime` and use a separate, production-oriented microVM pool.

See the [CLI reference](cli.md) for the exact commands and [manifest v2 reference](manifest-v2.md) for the runnable manifest contract.

## Runnable app bundles

A `<app>.appliance.zip` is a self-contained runnable bundle, not merely a renamed source archive. Its root `appliance.json` is a strict manifest v2 document. The archive carries one or more prebuilt Linux OCI images, Linux binary roots, or a bounded compound graph of both under `payload/`, plus a canonical `digest` and an optional `signature.sig`.

The filename does not decide what the artifact is. The Runtime reads the bounded root manifest first:

- `manifest: "v1"` identifies the existing source-bundle contract consumed by Builder and the API server.
- `manifest: "v2", kind: "runnable"` identifies a runnable bundle consumed by Runtime.
- A missing, unknown, or inconsistent discriminator is invalid; Appliance does not guess from the suffix or archive contents.

Builder creates a runnable bundle with `appliance builder package`. See [Packaging runnable apps](cli.md#builder-package) for its inputs and flags.

## The runtime pool and per-app controls

Ordinary packaged apps share one core-only Linux microVM named `appliance-runtime`. It is separate from the development/deploy VM and has no workspace mount, k3s, BuildKit, Docker daemon, or developer toolchain. A first-level service that declares `isolation: "vm"` receives a dedicated core-only VM; a user may also strengthen shared isolation to a dedicated VM.

Sharing the pool does not mean sharing permissions. Each app, and each runnable service in a compound app, receives its own unprivileged identity, process/container lifecycle, cgroup, mount namespace, and network namespace. Namespace isolation limits accidents, but it is not a second VM security boundary; use `isolation: "vm"` when a separate guest kernel is required.

Runtime controls are deny-by-default and constrained by the manifest:

- **Egress:** no declaration means no off-VM network access. The user may grant only a subset of declared DNS hosts and ports. Apps do not inherit development allowlists.
- **TLS inspection:** allowed HTTPS is inspected by default in inspection-only mode. Appliance may observe protocol metadata, but does not rewrite headers or bodies. The publisher cannot disable or detect inspection; the user may disable it globally or per app while destination enforcement remains active.
- **Mounts:** no declaration means no host path or persistent volume is mounted. A publisher can suggest a host path, but you must choose or confirm the actual path and access for every host mount. Refused mounts remain absent.
- **Ports:** only declared and granted ports can be reached. Appliance chooses host ports; publishers cannot select them. Internal ports are reachable only by declared siblings in the same compound app.
- **Resources:** CPU, memory, and disk fields are per-app ceilings or quota hints inside the selected VM. They do not size the pooled VM and cannot reserve capacity from another app.

The effective policy is the intersection of runtime safety rules, the publisher's declared ceiling, and the user's grants. A user can narrow a request or strengthen isolation, but cannot add undeclared egress, mounts, or ports, nor weaken `isolation: "vm"`.

## Desktop modes

On first run, the desktop asks whether this machine should start in **User** or **Developer** mode. Both modes can browse the catalogue, install apps, and manage Runtime settings. Developer mode adds the source-building surfaces for projects, agents, the development machine, and cloud work. The choice affects navigation, not the security model, and can be changed later in **Settings → Mode**. Web consoles retain the developer-oriented navigation because they cannot store the desktop preference.

## Unknown Publisher

Unsigned bundles and bundles whose signer cannot currently be verified are valid local inputs, but they are not trusted publishers. Before first open, Runtime presents an **Unknown Publisher** warning separately from the controls prompt. You may open once or remember the exact digest for up to 30 days; that acknowledgement is not global publisher trust, does not cover changed bytes, and returns on expiry, upgrade, signer/status change, revocation, or a request for an additional entitlement. An invalid digest is tampering and cannot be acknowledged past.

## Entitlements

An entitlement is the local record of controls you approved for one app: for example egress hosts, mount slots, and published ports, along with the manifest's SPDX license and usage history. Upgrades retain unchanged grants, remove capabilities no longer requested, and prompt only for additions or widenings. Runtime records last use for granted mounts and egress hosts and suggests review after 30 unused days by default; suggestions never revoke access automatically. Uninstall deactivates grants but keeps their history. Free local apps do not require an account.

## Runtime commands and availability

The namespace reserves these commands:

| Command                          | Purpose                                                       | Availability on this branch              |
| -------------------------------- | ------------------------------------------------------------- | ---------------------------------------- |
| `appliance runtime run`          | Run a local path or URL without installing it.                | Arriving with AP-163; placeholder today. |
| `appliance runtime ps`           | List running packaged apps and service principals.            | Arriving with AP-163; placeholder today. |
| `appliance runtime stop`         | Stop a running packaged app as a unit.                        | Arriving with AP-163; placeholder today. |
| `appliance runtime logs`         | Stream a packaged app's lifecycle and workload logs.          | Arriving with AP-163; placeholder today. |
| `appliance runtime install`      | Verify, register, grant, and start a packaged app.            | Placeholder.                             |
| `appliance runtime uninstall`    | Stop, deregister, and remove an installed app's runtime data. | Placeholder.                             |
| `appliance runtime list`         | List installed packaged apps.                                 | Placeholder.                             |
| `appliance runtime open`         | Open a packaged app's declared UI.                            | Placeholder.                             |
| `appliance runtime search`       | Search the signed app catalogue.                              | Placeholder.                             |
| `appliance runtime entitlements` | Show, grant, review, or revoke app entitlements.              | Placeholder.                             |

All Runtime verbs currently print `coming in a later release` and exit with status 2. The unambiguous top-level aliases are `appliance run`, `uninstall`, `ps`, `stop`, `search`, and `entitlements`; colliding top-level commands such as `install`, `list`, `logs`, and `open` keep their Builder/deployment behavior.
