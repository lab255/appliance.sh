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

The default output is `<name>.appliance.zip`. The root manifest is RFC 8785 canonical JSON; the CLI uses its small dependency-free canonicalizer. The bundle carries a length-framed SHA-256 digest. `--sign` accepts a local PKCS#8 Ed25519 PEM or JSON `{"privateKey":"ed25519:<base64url-32-byte-seed>"}`, adds the derived publisher key ID, and prints that key ID. This option is for a developer-owned local key, never a CI signing identity.

Manifest v1 remains the source-bundle contract. `package` directs v1 projects to `appliance build` rather than silently changing their artifact kind.

Before uploading `-a/--build <zip>`, `deploy` and Builder `install` enforce bounded ZIP metadata and a 256 KiB root-manifest read. A v1 source bundle follows the existing upload path byte-for-byte. Any v2 runnable bundle is rejected locally until runtime ingestion is available, with guidance to use `appliance runtime run/install`.

## Runtime

`appliance runtime <verb>` reserves the packaged-app surface: `run`, `install`, `uninstall`, `list`, `ps`, `stop`, `logs`, `open`, `search`, and `entitlements`.

`run`, `install`, `ps`, `stop`, `logs`, and `open` operate container, binary, or
compound bundles in the pooled Runtime VM. `list` and `uninstall` manage the
installed-app registry, `search` fetches and verifies the same signed index as
the desktop, and `entitlements` shows or changes app grants. Stale search results
are labelled. Set `APPLIANCE_CATALOGUE_URL` to override the default
`https://www.appliance.sh` origin; non-local overrides must use HTTPS. The
runtime checks the current blacklist before installation. Existing colliding
top-level commands remain unchanged.

## `install` versus `deploy`

- `appliance deploy` keeps the existing target selection: it uses `--profile`, `APPLIANCE_PROFILE`, or the active cluster (usually a cloud cluster), falling back to the local cluster when none is selected.
- `appliance install` uses the same deploy engine but defaults to the local VM cluster. It ignores `APPLIANCE_PROFILE` and the active cluster; use `--cluster <name>` to install to another registered cluster (`--profile <name>` remains accepted for compatibility).
- `appliance runtime install <path|url>` installs a packaged app into the current workspace target (see [docs/runtime.md](runtime.md#run-or-install-a-bundle)); unlike the top-level `install`, it honours `APPLIANCE_PROFILE`.

## Cloud baseline role mode

### `cloud update`

For a `cloudformation-v1` profile, `appliance cloud update` resolves the requested release (`--version <semver>`, or the latest semver
GHCR tag), downloads `control-plane-release.json` plus `control-plane-release.sig.json`, verifies that pair offline with the pinned
production release key, and sends only the signed manifest digest/evidence to the running server. It streams mirror, CloudFormation,
health, and recovery phases until the job is terminal.

```sh
appliance cloud update [--version 1.58.0]
appliance cloud update --follow selfupdate_123
appliance cloud update --json
appliance cloud update --local [--image <registry/ref>] [--arch amd64|arm64] [--aws-profile <name>]
```

`409` means another lease is live; the command prints its status URL and the matching `--follow <jobId>` command. `--json` emits the
terminal job, including `phaseDurationsMs`, for timing evidence. A failed target with `recovered:true` reports that the previous image
was re-pinned and passed health. `recoveryState:"exhausted"` points to `--local`.

`--local` is the explicit break-glass path: it preserves the former operator-machine ECR mirror plus CloudFormation update, so its
`--image`, `--arch`, and `--aws-profile` flags are intentionally unavailable on the normal in-server route. Legacy profiles without an
install-generation marker retain their deprecated updater behavior for the two-release compatibility window. Until AP-226 provisions
`PINNED_RELEASE_TRUST`, signed self-update fails closed with: `self-update disabled until the production key is pinned (AP-226)`.

`appliance cloud baseline-update` applies the CLI's current CloudFormation template while preserving the stack's existing `ImageUri`.
New stacks default to scoped roles; omitting `--system-role-mode` on an existing stack preserves its current mode. A routine
`appliance cloud baseline-update` intentionally bundles baseline/IAM migrations; the normal signed image update uses the previous
template and changes only `ImageUri`.

If a live deployment exposes an unenumerated AWS permission, `--system-role-mode admin --yes` is the loud, temporary break-glass
escape hatch. Restore least privilege with `appliance cloud baseline-update --system-role-mode scoped` after identifying the missing
action from CloudTrail. The baseline command polls api-server health after CloudFormation completes and prints the admin recovery
command if a scoped update leaves the endpoint unhealthy.

Before release, the owner must exercise the complete path on a disposable real install:

1. Run `appliance cloud baseline-update --system-role-mode scoped`, deploy a representative sample appliance, then destroy it.
2. Run `appliance cloud update`; confirm both system Lambdas remain healthy and their CloudWatch logs contain no `AccessDenied` or
   `UnauthorizedOperation`.
3. Run `appliance cloud baseline-update --system-role-mode admin --yes`, confirm `UPDATE_COMPLETE`, then run
   `appliance cloud baseline-update --system-role-mode scoped` and confirm `UPDATE_COMPLETE` again. This exercises the conditional
   `Policies: []` collapse and restoration path.
4. Query CloudTrail for denied worker/api-server actions. Specifically watch for CloudFront vended-log calls to
   `logs:PutResourcePolicy` or `logs:DescribeResourcePolicies`; do not pre-grant them without live evidence.
