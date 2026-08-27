# RFC 0001: Bundle format and manifest v2

- Status: Proposed
- Date: 2026-08-27
- Claim: `ap-p0-bundle-7f3a1c`
- Scope: bundle and manifest shape only

## Summary

Appliance uses the existing `*.appliance.zip` name for two different artifacts:

- a **source bundle**, which contains a v1 `appliance.json` and a project tree for the API server to build; or
- a **runnable bundle**, which contains a v2 `appliance.json`, prebuilt Linux payloads, a canonical digest, and an
  optional detached Ed25519 signature.

The root manifest is the discriminator. `manifest: "v1"` is source. `manifest: "v2"` together with
`kind: "runnable"` is runnable. Payload or signature sniffing is forbidden because unsigned runnable bundles are
valid.

Manifest v2 defines runnable `container`, `binary`, and `compound` types. A container carries one or more OCI image
tars. A binary carries an arbitrary Linux filesystem plus a declared entrypoint. A compound manifest contains a
minimal inline service tree. Every runnable backend payload is Linux and runs in a Linux microVM. A bundle may also
carry an explicitly unsandboxed macOS binary, but it never replaces the Linux payload and requires a fixed runtime
warning and explicit user confirmation.

This RFC defines the shapes of `network.egress`, `mounts`, `ports`, and `resources`. The manifest-to-VM-controls spike
owns their enforcement semantics and effective defaults. The compound-graph spike owns service lifecycle and
networking.

## Motivation

Today `appliance build` and `appliance deploy` produce a source zip. The CLI writes root `appliance.json`, adds the
project tree, and strips runtime config; the API server safely unzips and builds it. The filename alone therefore
cannot mean “ready to run.”

The Runtime needs an inspectable artifact that boots without a build toolchain or registry pull. The Builder must
preserve existing deploys while gaining a path for prebuilt apps. The format also needs declared control shapes for a
later VM, network, mount, and port policy translator.

The design mock established the product vocabulary but needed these corrections:

- the in-bundle filename remains `appliance.json`, not `manifest.json`;
- a signature cannot distinguish runnable bundles because unsigned local bundles are valid;
- Linux is mandatory even when a macOS-native escape hatch is present;
- mobile `platforms` and `ui.type: "native"` are reserved rather than backend target selectors;
- multiple host mounts cannot map to the current singular `VmSpec.dev_mount`;
- TLS inspection is user-controlled and therefore has no manifest field; and
- credential injection: deferred (owner, 2026-08-27).

## Manifest v2 schema

### Conventions

The runnable bundle always stores strict JSON in `appliance.json`. A Builder may accept TypeScript or JavaScript as
authoring input, using the existing QuickJS loader, but it must resolve that input to canonical JSON before writing
the bundle. Unknown fields are validation errors.

Paths use `/`, are relative to the bundle root, and are case-sensitive. Platform keys use OCI spellings such as
`linux/amd64` and `linux/arm64`; `linux-x64` and `darwin-arm64` from the mock are not valid keys.

`type` describes execution, not the authoring framework:

- `container`: one or more embedded OCI image-layout tar files;
- `binary`: one or more Linux roots, each with a declared executable entrypoint; or
- `compound`: an inline map of container, binary, or nested compound services.

The existing v1 `framework`, `desktop`, and `other` values remain source-manifest values. A framework is built into a
v2 container payload. A desktop or arbitrary executable is packaged as a v2 binary when it has a Linux backend.

`services` is a name-keyed map: every map key is the service name and a valid DNS label. Structural service names are
unique among siblings, and runnable-leaf names are unique across the compound tree. Lifecycle references use these
keys. This RFC is normative for compound field shapes; [RFC 0003](0003-compound-apps-and-isolation.md) is normative
for lifecycle, readiness, restart, and networking semantics.

### Full field reference

“Default” means a schema default. For control fields, “follow-up” means the manifest-to-VM-controls task must decide
the effective runtime value. “VM mapping” names current Rust fields where they exist; it does not prescribe the
translator implementation.

| Field                                | Type                              | Required            | Default                    | Notes                                                                                                                                                    | VM mapping                               |
| ------------------------------------ | --------------------------------- | ------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `manifest`                           | literal `"v2"`                    | yes                 | —                          | Schema/version discriminator.                                                                                                                            | none                                     |
| `kind`                               | literal `"runnable"`              | yes                 | —                          | Artifact discriminator; no v2 source kind is defined.                                                                                                    | none                                     |
| `type`                               | `container \| binary \| compound` | yes                 | —                          | Selects exactly one payload branch.                                                                                                                      | runner selection                         |
| `name`                               | DNS label                         | yes                 | —                          | Lowercase app identity, 1–63 characters.                                                                                                                 | derives `VmSpec.name`                    |
| `version`                            | SemVer string                     | yes                 | —                          | App version, independent of manifest version.                                                                                                            | none                                     |
| `license`                            | SPDX license ID                   | yes                 | —                          | A single SPDX License List ID, not an expression.                                                                                                        | none                                     |
| `description`                        | string, max 500                   | no                  | omitted                    | Human-readable catalog/install text.                                                                                                                     | none                                     |
| `publisher`                          | object                            | yes                 | —                          | Always present, including for unsigned bundles.                                                                                                          | none                                     |
| `publisher.name`                     | string, 1–100                     | yes                 | —                          | Display name; never an authorization identity.                                                                                                           | none                                     |
| `publisher.keyId`                    | string                            | no                  | omitted                    | Stable Ed25519 public-key fingerprint used for trust and blacklist lookup.                                                                               | none                                     |
| `assets`                             | object                            | no                  | omitted                    | Paths to presentation files already covered by the bundle digest.                                                                                        | none                                     |
| `assets.icon`                        | path under `assets/`              | no                  | omitted                    | PNG, JPEG, or WebP; active formats such as SVG are rejected.                                                                                             | none                                     |
| `assets.readme`                      | path under `assets/`              | no                  | omitted                    | UTF-8 Markdown.                                                                                                                                          | none                                     |
| `payload`                            | type-specific object              | container/binary    | —                          | Absent on a compound node; compound children reference shared root `payload/`.                                                                           | guest runner                             |
| `payload.images`                     | map platform → image object       | container           | —                          | At least one Linux OCI platform. Multiple architectures are allowed.                                                                                     | image import, then runner                |
| `payload.images.*.path`              | path under `payload/`             | container target    | —                          | OCI image-layout tar; its config platform must match the map key.                                                                                        | no direct `VmSpec` field                 |
| `payload.targets`                    | map platform → binary target      | binary              | —                          | At least one Linux target.                                                                                                                               | target selection uses guest architecture |
| `payload.targets.*.root`             | path under `payload/`             | binary target       | —                          | Directory containing that target's complete runtime files.                                                                                               | guest `/app` root                        |
| `payload.targets.*.entrypoint`       | path relative to target root      | binary target       | —                          | Must resolve to a regular file within `root`.                                                                                                            | guest runner command                     |
| `payload.targets.*.args`             | string array                      | no                  | `[]`                       | Literal arguments; no shell expansion.                                                                                                                   | guest runner arguments                   |
| `native`                             | object                            | no                  | omitted                    | Optional host-native escape hatches; never a backend payload.                                                                                            | none                                     |
| `native.macos`                       | object                            | no                  | omitted                    | Un-sandboxed macOS execution; requires a fixed runtime warning and confirmation.                                                                         | host execution, outside VM               |
| `native.macos.unsandboxed`           | literal `true`                    | with `native.macos` | —                          | Makes the risk machine-readable and impossible to imply by omission.                                                                                     | none                                     |
| `native.macos.targets`               | map platform → binary target      | with `native.macos` | —                          | Keys are `macos/amd64` or `macos/arm64`; target shape matches Linux binary targets.                                                                      | none                                     |
| `ui`                                 | object                            | no                  | omitted                    | Omission means no declared UI.                                                                                                                           | runtime open behavior                    |
| `ui.type`                            | `web \| native`                   | with `ui`           | —                          | `web` is implemented first; `native` is reserved.                                                                                                        | none                                     |
| `ui.port`                            | port-name string                  | web                 | —                          | References root `ports[]`, or the selected compound service's `ports[]`, exposed as `host`.                                                              | derives selected published port          |
| `ui.service`                         | service-name string               | web compound        | —                          | Service that owns the front door; lifecycle/routing is compound-graph scope.                                                                             | none                                     |
| `ui.path`                            | absolute URL path                 | no                  | `/`                        | Web path only; no scheme, authority, query, or fragment.                                                                                                 | none                                     |
| `platforms`                          | array of `ios \| android`         | no                  | `[]`                       | Reserved mobile declarations; accepted and otherwise ignored in v2.                                                                                      | none                                     |
| `env`                                | map env-name → string             | no                  | `{}`                       | Non-secret runtime configuration; keys must be POSIX-like env names.                                                                                     | guest runner environment                 |
| `network`                            | object                            | no                  | omitted                    | Requested network shape only; enforcement and omission semantics are follow-up.                                                                          | may select `VmSpec.net_link`             |
| `network.egress`                     | egress-rule array                 | no                  | follow-up                  | No TLS-inspection property is allowed.                                                                                                                   | host policy, not currently `VmSpec`      |
| `network.egress[].host`              | DNS name or `*.` wildcard         | with rule           | —                          | ASCII lowercase; wildcard matches subdomains only, not the apex.                                                                                         | host policy                              |
| `network.egress[].ports`             | unique port array                 | with rule           | —                          | Integers 1–65535; publishers state the requested ports explicitly.                                                                                       | host policy                              |
| `mounts`                             | mount array                       | no                  | follow-up                  | Multiple volume and host slots are allowed; names and guest paths are unique.                                                                            | runtime mount plan                       |
| `mounts[].name`                      | DNS label                         | with mount          | —                          | Stable grant/volume identity within an app.                                                                                                              | none                                     |
| `mounts[].source`                    | `volume \| host`                  | with mount          | —                          | `volume` is Runtime-managed; `host` requires a user-selected path.                                                                                       | data disk or VirtioFS                    |
| `mounts[].guest`                     | absolute Linux path               | with mount          | —                          | Must not overlap another mount or protected runtime paths.                                                                                               | guest mount point                        |
| `mounts[].readOnly`                  | boolean                           | with mount          | —                          | Explicit to avoid assigning a policy default in this RFC.                                                                                                | mount flags                              |
| `mounts[].suggestedPath`             | string                            | host only           | omitted                    | Publisher suggestion only; never auto-selected or auto-granted.                                                                                          | not persisted to `VmSpec`                |
| `ports`                              | port array                        | no                  | follow-up                  | Port names and `(guest, protocol)` pairs are unique. Host ports are never publisher-selected.                                                            | `VmSpec.published`                       |
| `ports[].name`                       | DNS label                         | with port           | —                          | Stable reference for UI and compound routing.                                                                                                            | none                                     |
| `ports[].guest`                      | integer 1–65535                   | with port           | —                          | Port inside the guest workload.                                                                                                                          | `PublishedPort.container` for TCP        |
| `ports[].protocol`                   | `tcp \| udp`                      | with port           | —                          | Explicit; current `PublishedPort` supports TCP forwarding only.                                                                                          | new mapping needed for UDP               |
| `ports[].expose`                     | `host \| internal`                | with port           | —                          | Shape only; compound networking behavior is handed off.                                                                                                  | `host` may add `VmSpec.published`        |
| `ports[].primary`                    | boolean                           | no                  | see notes                  | At most one per `ports` array; a discoverable app/leaf has exactly one after defaults. A web `ui.port` defaults `true`; other omissions default `false`. | none                                     |
| `resources`                          | object                            | no                  | follow-up                  | Per-app or per-`isolation: vm` request; shared aggregation is follow-up.                                                                                 | `VmSpec` sizing                          |
| `resources.cpus`                     | integer 1–32                      | no                  | follow-up                  | Requested virtual CPUs.                                                                                                                                  | `VmSpec.cpus`                            |
| `resources.memoryMib`                | integer 512–65536                 | no                  | follow-up                  | MiB, not MB.                                                                                                                                             | `VmSpec.memory_mib`                      |
| `resources.diskGib`                  | integer 1–1024                    | no                  | follow-up                  | Sparse data disk size request.                                                                                                                           | `VmSpec.disk_gib`                        |
| `services`                           | map service-name → service        | compound            | —                          | Non-empty; keys are DNS-label service names. Maximum 16 runnable leaves; structural compound nodes do not count.                                         | graph expansion follow-up                |
| `services.*.version`                 | SemVer string                     | no                  | omitted                    | Optional service version; the root version remains required.                                                                                             | none                                     |
| `services.*.type`                    | `container \| binary \| compound` | service             | —                          | Nested services omit `manifest`, `kind`, `license`, `publisher`, and `assets`; `version` is optional.                                                    | runner selection                         |
| `services.*.isolation`               | `shared \| vm`                    | no                  | `shared`                   | Per-sub-appliance isolation request.                                                                                                                     | VM topology follow-up                    |
| `services.*.dependsOn`               | string array                      | no                  | `[]`                       | Same-top-level-app runnable-leaf name references. Semantics are normative in RFC 0003.                                                                   | graph expansion follow-up                |
| `services.*.health`                  | `ServiceHealth`                   | no                  | omitted                    | HTTP, TCP, or exec probe; runnable leaves only. Semantics are normative in RFC 0003.                                                                     | guest health monitor                     |
| `services.*.health.type`             | `http \| tcp \| exec`             | with `health`       | —                          | Selects exactly one health-probe branch.                                                                                                                 | guest health monitor                     |
| `services.*.health.port`             | port-name string                  | HTTP/TCP health     | —                          | References a port on the same runnable leaf.                                                                                                             | guest health monitor                     |
| `services.*.health.path`             | absolute URL path                 | HTTP health         | —                          | HTTP probe path.                                                                                                                                         | guest health monitor                     |
| `services.*.health.command`          | non-empty string array            | exec health         | —                          | Executed directly without shell expansion.                                                                                                               | guest health monitor                     |
| `services.*.health.intervalSeconds`  | integer 1–300                     | no                  | `5`                        | Probe interval.                                                                                                                                          | guest health monitor                     |
| `services.*.health.timeoutSeconds`   | integer 1–60                      | no                  | `2`                        | Must not exceed `intervalSeconds`.                                                                                                                       | guest health monitor                     |
| `services.*.health.failureThreshold` | integer 1–20                      | no                  | `3`                        | Consecutive failures before unhealthy.                                                                                                                   | guest health monitor                     |
| `services.*.restart`                 | `ServiceRestart`                  | no                  | `{ policy: "on-failure" }` | Runnable leaves only. Semantics are normative in RFC 0003.                                                                                               | guest supervisor                         |
| `services.*.restart.policy`          | `never \| on-failure \| always`   | with `restart`      | `on-failure`               | Restart policy enum.                                                                                                                                     | guest supervisor                         |
| `services.*.restart.maxAttempts`     | integer 0–100                     | no                  | `5`                        | Attempts in a rolling 60-second window.                                                                                                                  | guest supervisor                         |
| `services.*.restart.backoffSeconds`  | integer 1–60                      | no                  | `2`                        | Exponential backoff, capped at 30 seconds.                                                                                                               | guest supervisor                         |
| `services.*.required`                | boolean                           | no                  | `true`                     | Whether failure is fatal to the compound; runnable leaves only. Semantics are normative in RFC 0003.                                                     | graph expansion follow-up                |
| `services.*` controls                | same shapes as root               | no                  | as above                   | `ui` is root-only; service ports may be `internal` or `host`.                                                                                            | per generated VM/workload                |

The lifecycle sub-shape is exactly:

```ts
interface ServiceLifecycleFields {
  dependsOn?: string[]; // default []
  health?: ServiceHealth;
  restart?: ServiceRestart;
  required?: boolean; // default true
}

type ServiceHealth = (
  | { type: 'http'; port: string; path: string }
  | { type: 'tcp'; port: string }
  | { type: 'exec'; command: string[] }
) & {
  intervalSeconds?: number; // default 5
  timeoutSeconds?: number; // default 2
  failureThreshold?: number; // default 3
};

interface ServiceRestart {
  policy: 'never' | 'on-failure' | 'always'; // default on-failure
  maxAttempts?: number; // default 5 in a rolling 60-second window
  backoffSeconds?: number; // default 2, exponential, capped at 30
}
```

The current `VmSpec.dev_mount` is singular and development-specific. It cannot represent v2 host mounts. The controls
follow-up must introduce a multi-mount runtime representation rather than repeatedly overwriting `dev_mount`.

TLS inspection is default-on under user control. A manifest cannot disable, require, or detect it.

### `journal`: container

```json
{
  "manifest": "v2",
  "kind": "runnable",
  "type": "container",
  "name": "journal",
  "version": "1.4.2",
  "license": "MIT",
  "description": "Private daily journal with AI summaries",
  "publisher": {
    "name": "Lab 255",
    "keyId": "ed25519:sha256:6d4d0c8f6b9c5be36d4d0c8f6b9c5be36d4d0c8f6b9c5be36d4d0c8f6b9c5be3"
  },
  "payload": {
    "images": {
      "linux/arm64": {
        "path": "payload/images/journal-linux-arm64.oci.tar"
      }
    }
  },
  "ui": {
    "type": "web",
    "port": "http",
    "path": "/"
  },
  "ports": [
    {
      "name": "http",
      "guest": 3000,
      "protocol": "tcp",
      "expose": "host"
    }
  ],
  "network": {
    "egress": [
      { "host": "api.openai.com", "ports": [443] },
      { "host": "cdn.jsdelivr.net", "ports": [443] }
    ]
  },
  "mounts": [
    {
      "name": "data",
      "source": "volume",
      "guest": "/data",
      "readOnly": false
    }
  ],
  "resources": {
    "cpus": 1,
    "memoryMib": 512,
    "diskGib": 2
  },
  "env": {
    "JOURNAL_LOCALE": "en-GB"
  }
}
```

### `dashboard`: binary with optional macOS escape hatch

```json
{
  "manifest": "v2",
  "kind": "runnable",
  "type": "binary",
  "name": "dashboard",
  "version": "0.9.0",
  "license": "Apache-2.0",
  "publisher": {
    "name": "Acme",
    "keyId": "ed25519:sha256:41ab3286fe2a914041ab3286fe2a914041ab3286fe2a914041ab3286fe2a9140"
  },
  "payload": {
    "targets": {
      "linux/arm64": {
        "root": "payload/dashboard/linux-arm64",
        "entrypoint": "bin/dashboard",
        "args": ["--listen", "0.0.0.0:8080"]
      }
    }
  },
  "native": {
    "macos": {
      "unsandboxed": true,
      "targets": {
        "macos/arm64": {
          "root": "payload/dashboard/macos-arm64",
          "entrypoint": "Dashboard.app/Contents/MacOS/Dashboard",
          "args": []
        }
      }
    }
  },
  "ui": {
    "type": "web",
    "port": "http",
    "path": "/"
  },
  "platforms": [],
  "ports": [
    {
      "name": "http",
      "guest": 8080,
      "protocol": "tcp",
      "expose": "host"
    }
  ]
}
```

The Runtime selects a Linux target by default and boots it in the microVM. Selecting `native.macos` is a distinct,
explicit action. The Runtime supplies the warning text; the publisher cannot soften or replace it.

### `notes-suite`: compound

```json
{
  "manifest": "v2",
  "kind": "runnable",
  "type": "compound",
  "name": "notes-suite",
  "version": "2.0.0",
  "license": "AGPL-3.0-only",
  "publisher": {
    "name": "Lab 255"
  },
  "ui": {
    "type": "web",
    "service": "web",
    "port": "http",
    "path": "/"
  },
  "services": {
    "web": {
      "type": "container",
      "payload": {
        "images": {
          "linux/arm64": {
            "path": "payload/web/web-linux-arm64.oci.tar"
          }
        }
      },
      "ports": [
        {
          "name": "http",
          "guest": 3000,
          "protocol": "tcp",
          "expose": "host"
        }
      ],
      "network": {
        "egress": [{ "host": "fonts.gstatic.com", "ports": [443] }]
      }
    },
    "indexer": {
      "type": "binary",
      "isolation": "vm",
      "payload": {
        "targets": {
          "linux/arm64": {
            "root": "payload/indexer/linux-arm64",
            "entrypoint": "bin/indexer",
            "args": ["--listen", "0.0.0.0:9000"]
          }
        }
      },
      "ports": [
        {
          "name": "grpc",
          "guest": 9000,
          "protocol": "tcp",
          "expose": "internal",
          "primary": true
        }
      ],
      "mounts": [
        {
          "name": "index",
          "source": "volume",
          "guest": "/index",
          "readOnly": false
        }
      ]
    }
  }
}
```

The omitted `web.isolation` resolves to `shared`; its `http` port becomes primary because `ui.port` references it.
This RFC defines the lifecycle field shapes. [RFC 0003](0003-compound-apps-and-isolation.md) defines their lifecycle,
readiness, restart, DNS, cross-VM routing, and control-composition semantics.

## Bundle layout

Runnable bundles use one zip, including compounds; zip-in-zip nesting is forbidden.

```text
journal.appliance.zip
├── appliance.json
├── payload/
│   └── images/
│       ├── journal-linux-amd64.oci.tar
│       └── journal-linux-arm64.oci.tar
├── assets/
│   ├── icon.svg
│   └── README.md
├── digest
└── signature.sig                 # optional
```

Compound payloads share the root `payload/` directory. Every payload path in an inline service is resolved against
the bundle root and covered by the one bundle digest and optional signature.

`appliance.json` must be RFC 8785 canonical JSON encoded as UTF-8 without a BOM or trailing newline. Zip entry paths
must already be normalized. The canonical bundle digest excludes `digest` and `signature.sig`, then hashes every
other regular entry as follows:

1. Sort entry paths by their UTF-8 bytes.
2. For each entry, hash the bytes `path`, NUL, base-10 content length, NUL, then the exact content bytes.
3. Write `digest` as `sha256:<64 lowercase hex>` plus one LF.

This length-framed stream avoids dependence on zip entry order, compression, timestamps, permissions, or extra
fields. Empty directories are not entries in the digest. The Runtime stages a selected binary entrypoint as mode
`0500`; it does not trust zip permission metadata.

`signature.sig`, when present, is `ed25519:<base64url-no-padding>` plus one LF. It is an Ed25519 detached signature
over the UTF-8 bytes of the `sha256:<hex>` string, excluding the LF. Publisher identity is in `appliance.json`; the
signature file does not duplicate it.

Default safety limits are:

- 2 GiB maximum compressed zip size;
- 8 GiB maximum total expanded size;
- 4 GiB maximum size for one expanded entry;
- 4,096 entries, including the two metadata files;
- 256 KiB for `appliance.json` and 240 UTF-8 bytes for an entry path; and
- 100:1 maximum aggregate expansion ratio once the expanded total exceeds 64 MiB.

The root manifest determines artifact kind before any build or execution:

| Root `appliance.json`                           | Classification | Required contents                        | Consumer                             |
| ----------------------------------------------- | -------------- | ---------------------------------------- | ------------------------------------ |
| `manifest: "v1"`                                | Source         | Existing source tree contract            | Builder/API-server build path        |
| `manifest: "v2", kind: "runnable"`              | Runnable       | `payload/`, `digest`; signature optional | Runtime or already-built deploy path |
| Missing, unknown, or inconsistent discriminator | Invalid        | —                                        | Reject; never guess or fall back     |

The `.appliance.zip` suffix, the presence of `payload/`, `digest`, or `signature.sig`, and whether input came from a
URL do not participate in classification. This rule is what permits valid unsigned local runnable bundles.

## Versioning & migration

Manifest v1 is unchanged. Its four current types (`container`, `framework`, `desktop`, `other`), runtime-config split,
programmatic QuickJS loading, source packaging, and server-side build continue to work as today. Existing v1 bundles
do not acquire a license requirement retroactively.

Manifest v2 is strict and runnable-only. New capability-bearing fields require a future manifest version rather than
being silently accepted by old runtimes. The app's SemVer `version` does not affect schema compatibility.

Builder migration:

- `appliance build` keeps producing the current v1 source `appliance.zip`.
- `appliance builder package` is the new source-to-runnable operation. It resolves authoring input, builds Linux
  payloads, writes canonical v2 `appliance.json`, computes `digest`, and signs only when a signing identity is chosen.
- v1 `container` packages to v2 `container`; v1 `framework` first builds and then packages to v2 `container`.
- v1 `desktop` packages to v2 `binary` only when its builder produces a declared Linux target. A macOS artifact alone
  is rejected.
- v1 `other` has no automatic runnable mapping; the author must select container or binary packaging explicitly.

`deploy` behavior is selected only after bounded parsing of root `appliance.json`:

| Input                                 | `deploy` behavior                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Project directory or v1 source bundle | Existing upload, safe unzip, server-side BuildKit/framework build, then deploy.                                             |
| v2 runnable container                 | Verify digest/signature status, select a Linux OCI image, use an already-built image-ingestion path, and skip source build. |
| v2 runnable binary                    | Reject with an actionable unsupported-backend error until a deploy backend owns Linux binary execution.                     |
| v2 runnable compound                  | Reject with an actionable unsupported-backend error until the compound-graph task owns deploy expansion.                    |
| Invalid or future manifest            | Reject before upload; do not reinterpret as v1 source.                                                                      |

The current `packages/cli/src/appliance-deploy.ts` uploads a `--build appliance.zip` without inspecting it, after
which the server's v1 `applianceInput.parse` can expose a raw Zod error for v2. Before any upload, the CLI must read
only the root `appliance.json` from the zip, enforce the 256 KiB manifest and archive safety bounds, and parse its
discriminators. V1 behavior is unchanged. Until a runnable ingestion route lands, every v2 runnable kind is rejected
locally with a clear message explaining that `deploy` currently accepts source bundles; it must never reach the v1
server parser. Once an ingestion route lands, the per-kind behavior above applies.

The already-built container path must not unpack an OCI tar into the existing source build service and hope it behaves
like source. It needs an explicit ingestion contract. A backend lacking a matching Linux architecture fails before
deployment; it does not build, emulate, or pull an undeclared image.

## Signature & publisher block

Integrity and publisher identity are separate:

1. Every runnable bundle has `digest`; a mismatch is always fatal.
2. `signature.sig` is optional. Its absence is valid and yields Unknown Publisher.
3. Every v2 root manifest has `publisher.name`; unsigned bundles may omit `publisher.keyId`.
4. A signature requires `publisher.keyId`. A signature without a key ID is invalid.
5. `publisher.name` is display text. Trust, blacklist, and key lookup use `publisher.keyId` only.
6. Verification resolves the Ed25519 public key by key ID from the identity task's trust source, then verifies the
   detached signature. An unresolved key or unsigned bundle may proceed only through the Unknown Publisher warning
   flow defined by that task; it is not reported as a valid signature.
7. A publisher block without a signature remains Unknown Publisher and grants no trust.

The default key ID encoding is `ed25519:sha256:<hex>`, where the hash covers the 32 raw Ed25519 public-key bytes.
Private keys and public-key distribution are outside this bundle RFC. The hosting layer needs only the canonical
bundle digest and publisher key ID when present; this RFC adds no hosting protocol.

## Validation rules

A v2 validator rejects the bundle when any of these checks fail:

1. The zip is encrypted, exceeds a size/count/ratio limit, contains duplicate or case-colliding paths, or has an
   absolute, backslash, empty-segment, `.`/`..`, NUL, symlink, hardlink, device, or FIFO entry.
2. Root `appliance.json`, `digest`, or referenced files are missing; metadata has the wrong encoding; canonical JSON
   bytes or the recomputed digest differ.
3. `manifest` and `kind` are not exactly `"v2"` and `"runnable"`, an unknown field is present, or the selected `type`
   does not match its payload branch.
4. `name` is not a DNS label, `version` is not SemVer, or `license` is not one current SPDX License List ID.
5. A referenced path escapes its allowed root, does not exist exactly once, or has the wrong file kind.
6. A container has no Linux image, an OCI tar is malformed, or its declared and embedded platforms disagree.
7. A binary has no Linux target, an entrypoint escapes its target root, or a selected entrypoint is not a regular
   file. A macOS target never satisfies the Linux requirement.
8. `native.macos` omits `unsandboxed: true`, names another host OS, or is selected without the runtime's fixed warning
   and explicit confirmation.
9. Port, mount, service, and target names are duplicated; a service map key is not its DNS-label service name;
   numeric limits are exceeded; references from `ui` do not resolve; or a web UI points to a non-TCP or non-host
   port. Each discoverable app or leaf has exactly one primary port; a worker with no inbound API may have no ports.
   When none is explicit, a web UI's referenced port is primary.
10. A host mount includes anything other than a suggestion, or any mount overlaps another guest mount or a protected
    runtime path. The runtime must collect the actual host path from the user.
11. An egress host is an IP literal, URL, public suffix, malformed wildcard, or non-ASCII name; ports are absent,
    duplicated, or out of range. TLS inspection fields are unknown and therefore rejected.
12. A compound has no services, exceeds 16 runnable leaves across the tree, exceeds two service-containment levels,
    or puts `manifest`, `kind`, `license`, `publisher`, or `assets` inside a service. Structural compound nodes do not
    count toward the leaf cap.
13. A structural compound declares lifecycle fields; a dependency or health port reference does not resolve; the
    dependency graph cycles; health timing is outside `intervalSeconds` 1–300, `timeoutSeconds` 1–60 and no greater
    than the interval, or `failureThreshold` 1–20; or restart values are outside `maxAttempts` 0–100 or
    `backoffSeconds` 1–60.
14. `publisher` or its required name is missing; `signature.sig` is malformed, lacks `publisher.keyId`, or fails
    verification with a resolved public key.

Validation order is limits and safe paths, bounded manifest parse, digest recomputation, signature status, full schema
and cross-reference validation, then payload parsing. Nothing executes during validation.

## Follow-up: manifest v2 Zod schema

The SDK schema task must make this exact set of SDK changes:

1. Add `packages/sdk/src/models/appliance-v2.ts` with strict schemas and inferred types for:
   - `applianceV2PublisherInput`, `applianceV2AssetsInput`, `applianceV2UiInput`, and
     `applianceV2NativeMacosInput`;
   - `applianceV2ContainerPayloadInput`, `applianceV2BinaryTargetInput`, and
     `applianceV2BinaryPayloadInput`;
   - `applianceV2EgressRuleInput`, `applianceV2NetworkInput`, `applianceV2MountInput`,
     `applianceV2PortInput`, and `applianceV2ResourcesInput`;
   - `applianceV2HealthInput`, `applianceV2RestartInput`, and recursive `applianceV2ServiceInput` using `z.lazy` plus
     container, binary, and compound root schemas;
   - discriminated union `applianceV2Input`; and
   - inferred `ApplianceV2Input`, `ApplianceV2`, and `ApplianceV2Service` types.
2. Keep `packages/sdk/src/models/appliance.ts` v1 behavior unchanged. Do not add `binary` or `compound` to the current
   `applianceTypeSchema`, because that schema feeds the source builder. Add explicit aliases `applianceV1Input`,
   `ApplianceV1Input`, and `ApplianceV1` only if a union consumer needs clearer naming.
3. Export the new module from `packages/sdk/src/models/index.ts`. `packages/sdk/src/index.ts` already wildcard-exports
   models and needs no edit.
4. Add `packages/sdk/src/models/appliance-v2.spec.ts` covering every example, strict unknown-key rejection, each
   discriminant, Linux-target requirements, recursive depth/runnable-leaf count, lifecycle fields and references,
   port primary selection, SPDX/SemVer, ranges, path rules, native opt-in, and signature/publisher coupling.

Bundle-byte canonicalization, zip safety, digest/signature I/O, QuickJS stub names, CLI loading, and VM translation do
not belong in the Zod task. They require separate downstream tasks after the pure SDK schema lands.

## Open for owner

1. **Are the default zip safety limits acceptable?** Default: 2 GiB compressed, 8 GiB expanded, 4,096 entries,
   256 KiB manifest, and 100:1 aggregate expansion ratio.
2. **Is the key ID wire form stable enough to standardize now?** Default: `ed25519:sha256:<64 lowercase hex>` over the
   raw 32-byte public key.
3. **How often must native macOS execution warn?** Default: warn and require explicit confirmation on every launch;
   do not persist a blanket grant because execution is outside the microVM.
4. **How is “two nesting levels” counted?** Default: the root is depth zero, its services are depth one, their services
   are depth two, and depth-three services are rejected; the 16-service cap counts runnable leaves at either service
   depth, while structural compound nodes do not count.
5. **Should Builder deploy accept runnable binary or compound bundles before their backend tasks land?** Default: no;
   reject explicitly, while runnable containers use the new already-built ingestion path.
