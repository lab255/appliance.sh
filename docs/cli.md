# CLI reference

Appliance has two command namespaces. Existing Builder commands remain available at the top level, so scripts such as `appliance build` and `appliance deploy` continue to work unchanged.

## Builder

`appliance builder <verb>` routes to the existing command implementation for:

`build`, `package`, `configure`, `deploy`, `deployment`, `destroy`, `dev`, `down`, `env`, `init`, `install`, `link`, `logs`, `manifest`, `open`, `shell`, `stack`, `test`, `unlink`, and `up`.

Use `appliance builder --help` for the descriptions. The top-level `list`, `logs`, and `open` commands retain their existing application/deployment behavior.

### `builder package`

`appliance builder package` turns a manifest v2 project into a runnable bundle. `appliance package` is the identical top-level alias.

```sh
appliance builder package [--out my-app.appliance.zip] [--sign ./dev-key.pem]
```

Container manifests are built for every declared Linux platform with the local Docker/buildkit engine and exported as OCI image-layout tar files. For a prebuilt image or a CI fixture, bypass the build with a repeatable `--image` selector:

```sh
appliance package --image linux/amd64=ghcr.io/example/my-app:1.2.3
appliance package --image linux/amd64=./tmp/test-image.oci.tar
```

When a compound contains more than one image for the same platform, select each full payload path, for example `--image payload/web/web.oci.tar=./web.oci.tar`. Binary manifests do not compile: every declared `payload.targets.*.root` directory and entrypoint must already exist. Compound manifests collect their container and binary leaves into the shared root `payload/` tree; because v2 has no per-service build-context field, compound container leaves require `--image`.

The default output is `<name>.appliance.zip`. The root manifest is RFC 8785 canonical JSON; the CLI uses its small dependency-free canonicalizer. The bundle carries the RFC 0001 length-framed SHA-256 digest. `--sign` accepts a local PKCS#8 Ed25519 PEM or JSON `{"privateKey":"ed25519:<base64url-32-byte-seed>"}`, adds the derived publisher key ID, and prints that key ID. This option is for a developer-owned local key, never a CI signing identity.

Manifest v1 remains the source-bundle contract. `package` directs v1 projects to `appliance build` rather than silently changing their artifact kind.

Before uploading `-a/--build <zip>`, `deploy` and Builder `install` enforce bounded ZIP metadata and a 256 KiB root-manifest read. A v1 source bundle follows the existing upload path byte-for-byte. Any v2 runnable bundle is rejected locally until runtime ingestion is available, with guidance to use `appliance runtime run/install`.

## Runtime

`appliance runtime <verb>` reserves the packaged-app surface: `run`, `install`, `uninstall`, `list`, `ps`, `stop`, `logs`, `open`, `search`, and `entitlements`.

`run`, `ps`, `stop`, and `logs` operate container or binary bundles in the
pooled Runtime VM. `search` fetches and verifies the same signed free-app index
as the desktop; stale results are labelled and paid entries are discarded
before matching or output. Set `APPLIANCE_CATALOGUE_URL` to override the default
`https://www.appliance.sh` origin; non-local overrides must use HTTPS. The other
Runtime verbs remain placeholders: they print `coming in a later release` and
exit with status 2. Blacklist evaluation is deferred to AP-173 and gates
installation. Existing colliding top-level commands remain unchanged.

## `install` versus `deploy`

- `appliance deploy` keeps the existing target selection: it uses `--profile`, `APPLIANCE_PROFILE`, or the active cluster (usually a cloud cluster), falling back to the local cluster when none is selected.
- `appliance install` uses the same deploy engine but defaults to the local VM cluster. It ignores `APPLIANCE_PROFILE` and the active cluster; use `--cluster <name>` to install to another registered cluster (`--profile <name>` remains accepted for compatibility).
- `appliance runtime install` is the reserved packaged-app command and is still a placeholder in this release.
