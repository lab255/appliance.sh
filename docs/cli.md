# CLI reference

Appliance separates authoring and deployment under **Builder** from packaged-app execution under **Runtime**. Existing Builder commands remain available at the top level, so scripts such as `appliance build` and `appliance deploy` continue to work unchanged.

For the product concepts behind the namespaces, see [Appliance Runtime](runtime.md). For the runnable schema used by `package`, see [Manifest v2](manifest-v2.md).

## Builder

`appliance builder <verb>` routes to the same in-process implementation as the existing top-level spelling. `appliance builder --help` reports:

| Verb         | Description                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `build`      | builds the appliance in the current working directory                                                                                 |
| `configure`  | configures the appliance in the current working directory                                                                             |
| `deploy`     | deploy the linked (or named) project to the active cluster (see `appliance cluster`; usually cloud)                                   |
| `deployment` | manage deployments                                                                                                                    |
| `destroy`    | destroy the linked (or named) project/environment                                                                                     |
| `dev`        | run your app locally with live rebuild + logs (Ctrl+C leaves apps running)                                                            |
| `down`       | stop and remove this project's sandbox container                                                                                      |
| `env`        | manage per-environment variables (set/list/unset)                                                                                     |
| `init`       | first-time setup: boot the managed VM and guide your first deploy (after that, `appliance dev`)                                       |
| `install`    | install the linked (or named) project to the local VM cluster (`--cluster <name>` to override) — or the whole stack in a stack folder |
| `link`       | link this folder to a project/environment                                                                                             |
| `logs`       | stream a deployment's container logs (local engines)                                                                                  |
| `manifest`   | evaluate a programmatic appliance manifest in a sandbox                                                                               |
| `open`       | open the latest deployment URL in a browser                                                                                           |
| `package`    | package a manifest v2 project as a runnable bundle (alias: `appliance builder package`)                                               |
| `shell`      | enter this project's sandbox (devcontainer exec, or the VM host shell)                                                                |
| `stack`      | scaffold/inspect/destroy a multi-app stack (`appliance deploy` in a stack folder deploys it)                                          |
| `test`       | run connection and signing diagnostics                                                                                                |
| `unlink`     | remove the local project/environment link                                                                                             |
| `up`         | build + run this project (Dockerfile, compose, or devcontainer) in the managed microVM                                                |

All of these verbs also work directly as `appliance <verb>`. The top-level `destroy` additionally accepts `remove`; the Builder namespace itself accepts `destroy`. Top-level `list`, `logs`, and `open` keep their existing application/deployment meanings and are not Runtime shortcuts.

### `builder package`

`appliance builder package` turns a [manifest v2](manifest-v2.md) project into a runnable bundle. `appliance package` is the identical top-level command.

```sh
appliance builder package [options]
```

| Option                          | Meaning                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `-f, --file <file>`             | Appliance manifest file; defaults to `appliance.json`.                                |
| `-d, --directory <directory>`   | Appliance project directory.                                                          |
| `--variant <name>`              | Variant to load from a programmatic `.ts` or `.js` manifest.                          |
| `-o, --out <file>`              | Output path; defaults to `<manifest-name>.appliance.zip`.                             |
| `--sign <dev-key-file>`         | Sign with a local development Ed25519 key file.                                       |
| `--image <selector=ref-or-tar>` | Use a prebuilt image reference or OCI tar; repeat for multiple platforms or payloads. |

Container manifests are built for every declared Linux platform with the local Docker/BuildKit engine and exported as OCI image-layout tar files. To use a prebuilt image or CI fixture instead, select a platform:

```sh
appliance package --image linux/amd64=ghcr.io/example/my-app:1.2.3
appliance package --image linux/amd64=./tmp/test-image.oci.tar
```

When a compound contains more than one image for the same platform, select each full payload path:

```sh
appliance package \
  --image payload/web/web.oci.tar=./web.oci.tar \
  --image payload/worker/worker.oci.tar=./worker.oci.tar
```

Binary manifests do not compile. Every declared `payload.targets.*.root` directory and entrypoint must already exist. Compound manifests collect container and binary leaves into the shared root `payload/` tree; because manifest v2 has no per-service build-context field, compound container leaves require `--image`.

The output manifest is RFC 8785 canonical JSON. The bundle includes RFC 0001's length-framed SHA-256 digest. `--sign` accepts either a local PKCS#8 Ed25519 PEM or JSON containing `{"privateKey":"ed25519:<base64url-32-byte-seed>"}`, adds the derived publisher key ID, and prints it. This flag is only for a developer-owned local key; never pass a CI signing identity.

Manifest v1 remains the source-bundle contract. `package` directs a v1 project to `appliance build` instead of silently changing the artifact kind. See [v1 versus v2 command behavior](manifest-v2.md#v1-versus-v2-command-behavior).

Before uploading `-a/--build <zip>`, `deploy` and Builder `install` enforce bounded ZIP metadata and a 256 KiB root-manifest read. A v1 source bundle follows the existing upload path byte-for-byte. On this branch, a v2 runnable bundle is rejected locally until runtime ingestion is available, with guidance to use `appliance runtime run` or `appliance runtime install`.

## Runtime

`appliance runtime <verb>` reserves the packaged-app surface. The descriptions below match `appliance runtime --help`:

| Verb           | Description                                             |
| -------------- | ------------------------------------------------------- |
| `run`          | run a `.appliance.zip` (path or URL) without installing |
| `install`      | verify, register, and start a packaged app              |
| `uninstall`    | stop, deregister, and delete an app's VM and volumes    |
| `list`         | list installed packaged apps                            |
| `ps`           | list running packaged apps                              |
| `stop`         | stop a running packaged app                             |
| `logs`         | stream a packaged app's logs                            |
| `open`         | open a packaged app's UI                                |
| `search`       | search the signed app index                             |
| `entitlements` | show, grant, or revoke app entitlements                 |

All ten Runtime verbs are placeholders on this branch. They print `coming in a later release` and exit with status 2. `run`, `ps`, `stop`, and `logs` are arriving with AP-163; the [Runtime availability table](runtime.md#runtime-commands-and-availability) tracks the full surface.

Unambiguous Runtime verbs have top-level aliases:

| Runtime command                  | Top-level alias          |
| -------------------------------- | ------------------------ |
| `appliance runtime run`          | `appliance run`          |
| `appliance runtime uninstall`    | `appliance uninstall`    |
| `appliance runtime ps`           | `appliance ps`           |
| `appliance runtime stop`         | `appliance stop`         |
| `appliance runtime search`       | `appliance search`       |
| `appliance runtime entitlements` | `appliance entitlements` |

The colliding names `install`, `list`, `logs`, and `open` are not top-level Runtime aliases. Use the full `appliance runtime <verb>` spelling for them.

## `install` versus `deploy`

- `appliance deploy` deploys the linked or named source project to the active cluster, usually cloud. Target resolution uses `--profile`, `APPLIANCE_PROFILE`, or the active cluster and falls back to the local cluster when none is selected.
- Builder `appliance install` uses the same deploy engine but defaults to the local VM cluster. It ignores `APPLIANCE_PROFILE` and the active cluster; select another registered cluster with `--cluster <name>`. `--profile <name>` remains accepted for compatibility.
- `appliance runtime install` is the reserved packaged-app operation: verify, register, grant, and start a runnable bundle. It is still a placeholder on this branch.
