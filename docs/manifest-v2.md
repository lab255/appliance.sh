# Manifest v2 reference

Manifest v2 describes an already-built runnable Appliance app. It is strict JSON: unknown fields are errors, paths are case-sensitive bundle-relative `/` paths, and platform keys use OCI spellings such as `linux/amd64` and `linux/arm64`.

This reference follows the SDK's `applianceV2Input` schema and RFC 0001. For execution and security behavior, see [Appliance Runtime](runtime.md). For packaging and command availability, see the [CLI reference](cli.md).

## Field reference

“Required” describes author input. Defaults are applied by schema parsing or, where marked “Runtime,” by the runtime-controls contract.

| Field                                | Type                                                                                            | Required                 | Default            | Notes                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`                           | literal `"v2"`                                                                                  | Yes                      | —                  | Schema discriminator.                                                                                                                     |
| `kind`                               | literal `"runnable"`                                                                            | Yes                      | —                  | Artifact discriminator; v2 defines no source kind.                                                                                        |
| `type`                               | `container \| binary \| compound`                                                               | Yes                      | —                  | Selects exactly one payload branch.                                                                                                       |
| `name`                               | DNS label                                                                                       | Yes                      | —                  | Lowercase app identity, 1–63 characters.                                                                                                  |
| `version`                            | SemVer string                                                                                   | Yes                      | —                  | App version; independent of the manifest version.                                                                                         |
| `license`                            | SPDX license ID                                                                                 | Yes                      | —                  | One current SPDX License List ID, not an expression.                                                                                      |
| `description`                        | string, max 500                                                                                 | No                       | Omitted            | Human-readable catalogue and install text.                                                                                                |
| `publisher`                          | object                                                                                          | Yes                      | —                  | Required even for unsigned bundles.                                                                                                       |
| `publisher.name`                     | string, 1–100                                                                                   | Yes                      | —                  | Display text only; never an authorization identity.                                                                                       |
| `publisher.keyId`                    | `ed25519:sha256:<64 lowercase hex>`                                                             | No                       | Omitted            | Must match `signature.sig` when a signature is present.                                                                                   |
| `assets`                             | object                                                                                          | No                       | Omitted            | Presentation files covered by the bundle digest.                                                                                          |
| `assets.icon`                        | path under `assets/`                                                                            | No                       | Omitted            | PNG, JPEG, or WebP; active formats such as SVG are rejected.                                                                              |
| `assets.readme`                      | Markdown path under `assets/`                                                                   | No                       | Omitted            | UTF-8 Markdown.                                                                                                                           |
| `payload`                            | type-specific object                                                                            | Container or binary      | —                  | Absent from compound nodes; children share root `payload/`.                                                                               |
| `payload.images`                     | map: Linux platform → image                                                                     | Container                | —                  | Non-empty; one or more embedded OCI image-layout tar files.                                                                               |
| `payload.images.*.path`              | path under `payload/`                                                                           | Each image               | —                  | Declared platform must match the embedded OCI platform.                                                                                   |
| `payload.targets`                    | map: Linux platform → binary target                                                             | Binary                   | —                  | Non-empty; at least one Linux target.                                                                                                     |
| `payload.targets.*.root`             | path under `payload/`                                                                           | Each target              | —                  | Directory containing the target's complete runtime files.                                                                                 |
| `payload.targets.*.entrypoint`       | path relative to target root                                                                    | Each target              | —                  | Must resolve to a regular file inside `root`.                                                                                             |
| `payload.targets.*.args`             | string array                                                                                    | No                       | `[]`               | Literal arguments; no shell expansion.                                                                                                    |
| `native`                             | object                                                                                          | No                       | Omitted            | Host-native escape hatches; never a backend payload.                                                                                      |
| `native.macos`                       | object                                                                                          | No                       | Omitted            | Explicit unsandboxed macOS execution option.                                                                                              |
| `native.macos.unsandboxed`           | literal `true`                                                                                  | With `native.macos`      | —                  | Makes execution outside Runtime controls explicit.                                                                                        |
| `native.macos.targets`               | map: `macos/amd64 \| macos/arm64` → binary target                                               | With `native.macos`      | —                  | Non-empty; uses the binary target shape.                                                                                                  |
| `ui`                                 | object                                                                                          | No                       | Omitted            | Omission means no declared UI.                                                                                                            |
| `ui.type`                            | `web \| native`                                                                                 | With `ui`                | —                  | `native` is reserved; web UI validation is implemented.                                                                                   |
| `ui.port`                            | port-name string                                                                                | Web UI                   | —                  | Must name a declared host-exposed TCP port.                                                                                               |
| `ui.service`                         | service-name string                                                                             | Compound web UI          | —                  | Must name the runnable leaf that owns `ui.port`; invalid on simple apps.                                                                  |
| `ui.path`                            | absolute URL path                                                                               | No                       | `/`                | No scheme, authority, query, or fragment.                                                                                                 |
| `platforms`                          | array of `ios \| android`                                                                       | No                       | `[]`               | Reserved mobile declarations; accepted and otherwise ignored in v2.                                                                       |
| `env`                                | map: env name → string                                                                          | No                       | `{}`               | POSIX-like names; the `APPLIANCE_SVC_` prefix is reserved.                                                                                |
| `network`                            | object                                                                                          | No                       | Omitted            | Requested network shape; grants may only narrow it.                                                                                       |
| `network.egress`                     | egress-rule array                                                                               | No                       | Effective deny all | Absent and empty both deny all off-VM egress. TLS inspection is not manifest-controlled.                                                  |
| `network.egress[].host`              | DNS name or `*.` wildcard                                                                       | Each rule                | —                  | Lowercase hostname, not an IP, URL, or public suffix; wildcard excludes the apex.                                                         |
| `network.egress[].ports`             | unique integer array                                                                            | Each rule                | —                  | Non-empty; values 1–65535.                                                                                                                |
| `mounts`                             | mount array                                                                                     | No                       | No mounts          | Names and guest paths must be unique.                                                                                                     |
| `mounts[].name`                      | DNS label                                                                                       | Each mount               | —                  | Stable grant or volume identity within the app.                                                                                           |
| `mounts[].source`                    | `volume \| host`                                                                                | Each mount               | —                  | Volumes are Runtime-managed; host paths require user selection.                                                                           |
| `mounts[].guest`                     | absolute Linux path                                                                             | Each mount               | —                  | Cannot overlap another mount or a protected Runtime path.                                                                                 |
| `mounts[].readOnly`                  | boolean                                                                                         | Each mount               | —                  | Explicit request; users may further restrict access.                                                                                      |
| `mounts[].suggestedPath`             | string                                                                                          | No; host only            | Omitted            | Publisher suggestion only; never automatically selected or granted.                                                                       |
| `ports`                              | port array                                                                                      | No                       | No listeners       | Names and `(guest, protocol)` pairs must be unique.                                                                                       |
| `ports[].name`                       | DNS label                                                                                       | Each port                | —                  | Stable UI and routing reference.                                                                                                          |
| `ports[].guest`                      | integer 1–65535                                                                                 | Each port                | —                  | Port inside the workload.                                                                                                                 |
| `ports[].protocol`                   | `tcp \| udp`                                                                                    | Each port                | —                  | Explicit; unsupported protocols fail instead of widening access.                                                                          |
| `ports[].expose`                     | `host \| internal`                                                                              | Each port                | —                  | Host ports are allocated by Runtime; internal ports are compound-sibling only.                                                            |
| `ports[].primary`                    | boolean                                                                                         | No                       | See notes          | Exactly one per non-empty port array. With no explicit primary, the web UI's referenced port becomes primary; other ports become `false`. |
| `resources`                          | object                                                                                          | No                       | Runtime defaults   | Per-app ceilings and quota hints, not VM sizing.                                                                                          |
| `resources.cpus`                     | integer 1–32                                                                                    | No                       | 1 CPU              | Runtime cgroup ceiling.                                                                                                                   |
| `resources.memoryMib`                | integer 512–65536                                                                               | No                       | 512 MiB            | Runtime cgroup ceiling.                                                                                                                   |
| `resources.diskGib`                  | integer 1–1024                                                                                  | No                       | 2 GiB              | Writable-data quota; does not resize the VM disk.                                                                                         |
| `services`                           | map: service name → service                                                                     | Compound                 | —                  | Non-empty; maximum 16 runnable leaves and two containment levels.                                                                         |
| `services.*.type`                    | `container \| binary \| compound`                                                               | Each service             | —                  | Nested entries omit root `manifest`, `kind`, `name`, `license`, `publisher`, and `assets`; the map key is the name.                       |
| `services.*.version`                 | SemVer string                                                                                   | No                       | Omitted            | Optional service version; the root version remains required.                                                                              |
| `services.*.isolation`               | `shared \| vm`                                                                                  | No; first level only     | `shared`           | `vm` is a locked minimum; descendants inherit a structural parent's placement.                                                            |
| `services.*.dependsOn`               | DNS-label string array                                                                          | No; runnable leaves only | `[]`               | Unique references to other runnable-leaf keys in the same top-level app.                                                                  |
| `services.*.health`                  | health object                                                                                   | No; runnable leaves only | Omitted            | HTTP, TCP, or exec readiness and ongoing health probe.                                                                                    |
| `services.*.health.type`             | `http \| tcp \| exec`                                                                           | With `health`            | —                  | Selects exactly one probe branch.                                                                                                         |
| `services.*.health.port`             | port-name string                                                                                | HTTP or TCP health       | —                  | Must name a port on the same runnable leaf.                                                                                               |
| `services.*.health.path`             | absolute URL path                                                                               | HTTP health              | —                  | HTTP success is status 200–399.                                                                                                           |
| `services.*.health.command`          | non-empty string array                                                                          | Exec health              | —                  | Executed directly without shell expansion.                                                                                                |
| `services.*.health.intervalSeconds`  | integer 1–300                                                                                   | No                       | `5`                | Probe interval.                                                                                                                           |
| `services.*.health.timeoutSeconds`   | integer 1–60                                                                                    | No                       | `2`                | Must not exceed `intervalSeconds`.                                                                                                        |
| `services.*.health.failureThreshold` | integer 1–20                                                                                    | No                       | `3`                | Consecutive failures before unhealthy.                                                                                                    |
| `services.*.restart`                 | restart object                                                                                  | No; runnable leaves only | On failure         | Defaults to `{ "policy": "on-failure", "maxAttempts": 5, "backoffSeconds": 2 }`.                                                          |
| `services.*.restart.policy`          | `never \| on-failure \| always`                                                                 | No                       | `on-failure`       | Explicit stop always wins.                                                                                                                |
| `services.*.restart.maxAttempts`     | integer 0–100                                                                                   | No                       | `5`                | Attempts in a rolling 60-second window.                                                                                                   |
| `services.*.restart.backoffSeconds`  | integer 1–60                                                                                    | No                       | `2`                | Exponential backoff, capped at 30 seconds.                                                                                                |
| `services.*.required`                | boolean                                                                                         | No; runnable leaves only | `true`             | A terminal required-service failure fails the app; optional failure may degrade it.                                                       |
| `services.*` runtime controls        | Same `native`, `platforms`, `env`, `network`, `mounts`, `ports`, and `resources` shapes as root | No                       | As above           | `ui` is root-only; controls are enforced per runnable leaf.                                                                               |

## Examples

These examples are copied from RFC 0001.

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

### `dashboard`: binary

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

Runtime selects Linux by default. Choosing `native.macos` is a separate explicit action and runs outside the Linux VM, so Appliance egress, mount, port, and resource controls do not apply.

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

The omitted `web.isolation` resolves to `shared`; its `http` port becomes primary because the root UI references it.

## Validation rules

Validation completes before extraction or execution. It rejects a bundle when any of these checks fail:

1. The ZIP is encrypted, exceeds an archive size/count/ratio limit, contains duplicate or case-colliding paths, or contains an absolute, backslash, empty-segment, `.`/`..`, NUL, symlink, hardlink, device, or FIFO entry.
2. Root `appliance.json`, `digest`, or a referenced file is missing; metadata encoding is wrong; or canonical manifest bytes and the recomputed digest differ.
3. `manifest` and `kind` are not exactly `"v2"` and `"runnable"`, an unknown field is present, or `type` does not match its payload branch.
4. `name` is not a lowercase DNS label, `version` is not strict SemVer, or `license` is not one current SPDX ID.
5. A referenced path is not normalized, escapes its allowed root, does not exist exactly once, or has the wrong file kind.
6. A container has no Linux image, an OCI tar is malformed, or its declared and embedded platforms disagree.
7. A binary has no Linux target, its entrypoint escapes the target root, or the selected entrypoint is not a regular file. A macOS target does not satisfy the Linux requirement.
8. `native.macos` omits `unsandboxed: true`, uses an unsupported key, or is selected without Runtime's fixed warning and explicit confirmation.
9. Mount, port, service, target, dependency, or egress-port names that must be unique are duplicated. Port pairs must also be unique.
10. A web UI reference does not resolve to a host-exposed TCP port, a health port does not resolve on its leaf, or a non-empty ports array does not have exactly one primary after defaults.
11. A host mount contains authority beyond `suggestedPath`, or any mount overlaps another guest mount or a protected Runtime path.
12. An egress host is an IP, URL, public suffix, malformed wildcard, or non-ASCII/lowercase DNS name; ports are missing, duplicated, or out of range. TLS-inspection keys are unknown and rejected.
13. A compound is empty, has more than 16 runnable leaves, exceeds two service-containment levels, repeats a runnable-leaf name, places lifecycle fields on structural nodes, or sets `isolation` below the first service level.
14. A compound dependency is missing, self-referential, duplicated, or cyclic; health and restart values are outside their ranges; or `timeoutSeconds` exceeds `intervalSeconds`.
15. `publisher.name` is missing, a key ID is malformed, or a present signature has the wrong canonical envelope, algorithm, role, key ID, signature length, or verification result.

Archive validation then proceeds in this order: limits and safe paths, bounded root-manifest parsing, digest recomputation, signature classification, full schema and cross-reference validation, and payload parsing. Nothing executes during validation.

## v1 versus v2 command behavior

| Input                                          | `deploy` / Builder `install`                                                                                                                                                                           | `builder package` / top-level `package`                                                                                                           | `runtime run`                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| v1 project or source bundle                    | Keeps the existing source upload and server-side build path. Builder `install` defaults that deployment to the local VM cluster; `deploy` uses the selected/active cluster.                            | Rejects with guidance to use `appliance build`; it never silently changes a source artifact into a runnable one.                                  | Not a runnable artifact. Runtime support is still arriving and will require manifest v2.                            |
| v2 runnable project or bundle                  | On this branch, rejects runnable bundles locally before upload with guidance to use Runtime. Future container ingestion will skip source build; binary and compound deploy require their own backends. | Validates manifest v2, builds or collects payloads, writes canonical metadata and digest, and optionally signs a runnable `<name>.appliance.zip`. | Intended consumer for local paths or URLs. The command is a placeholder on this branch and is arriving with AP-163. |
| Missing, future, or inconsistent discriminator | Rejects before upload; never reinterprets it as v1.                                                                                                                                                    | Rejects validation.                                                                                                                               | Rejects validation once Runtime ingestion lands.                                                                    |

`appliance build` remains the v1 source-bundle operation. See [Builder and Runtime commands](cli.md#builder) and [Runnable app bundles](runtime.md#runnable-app-bundles) for the surrounding workflows.
