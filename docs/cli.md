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

## cloud update

For a `cloudformation-v1` profile, `appliance cloud update` resolves the requested release (`--version <semver>`, or the latest semver
GHCR tag), downloads `control-plane-release.json` plus `control-plane-release.sig.json`, verifies that pair offline with the pinned
production release key, and sends only the signed manifest digest/evidence to the running server. It streams mirror, CloudFormation,
health, and recovery phases until the job is terminal.

```sh
appliance cloud update [--version 1.58.0]
appliance cloud update --follow selfupdate_123
appliance cloud update --json
appliance cloud update --local [--image <registry/ref>] [--arch amd64|arm64] [--aws-profile <name>]
appliance cloud update --policy off|notify|auto [--aws-profile <name>]
appliance cloud update --check-now
appliance cloud update --status [--json]
```

The scheduled policies are:

- `off` (default): no scheduled check resources exist.
- `notify`: check about once a day and show an available signed image without changing the installation.
- `auto`: check about once a day, reuse `scheduled:<digest>` for idempotency, respect any live update lease, then run the same full
  image-only CloudFormation update and health wait as a manual update.

The cadence is `rate(1 day)` with a 60-minute flexible window. `--check-now` runs the same owner-signed, target-free check immediately.
Repeated manual checks within 60 seconds return the stored decision with reason `cooldown` without dispatching the worker again.
`--status` performs a signed, read-only cluster-info request using the active or selected profile and prints the policy, complete last-check
record, and any available version; add `--json` for the machine-readable server shape.
Enabling `notify` or `auto` is refused while `SystemRoleMode=admin`; restore scoped roles with
`appliance cloud baseline-update --system-role-mode scoped`. Policy changes preserve the running `ImageUri` explicitly and send
`UsePreviousValue` for unrelated stack parameters. Scheduled checks never apply baseline changes. A notify marker is a notice only:
a manual update independently resolves the latest signed release and prints its target and provenance before starting.

`409` means another lease is live; the command prints its status URL and the matching `--follow <jobId>` command. Successful and failed
terminal `--json` output has the stable top-level shape
`{outcome:"terminal", job, previousServerVersion, currentServerVersion}`. The terminal `job` contains `phaseDurationsMs`, explicit
`totalMs`, and `resumeCount`. A live-job conflict instead exits `3` and emits an object with the fields
`{outcome:"conflict", start, previousServerVersion, jobId, statusUrl}`; `jobId` and `statusUrl` are top-level so automation can follow it.
For example, the timing-gate breakdown is:

```sh
appliance cloud update --json > update.json
jq '{mirrorMs: .job.phaseDurationsMs.mirroring, cloudFormationMs: ((.job.phaseDurationsMs["submitting-update"] // 0) + (.job.phaseDurationsMs["waiting-for-stack"] // 0)), healthMs: .job.phaseDurationsMs["probing-health"], totalMs: .job.totalMs}' update.json
```

A failed target with `recovered:true` reports that the previous image was re-pinned and passed health.
`recoveryState:"exhausted"` says that the installation may still be running the failed image and points to `--local`.

`--local` is the explicit break-glass path: it preserves the former operator-machine ECR mirror plus CloudFormation update, so its
`--image`, `--arch`, and `--aws-profile` flags are intentionally unavailable on the normal in-server route. Legacy profiles without an
install-generation marker retain their deprecated updater behavior for the two-release compatibility window. `--local --json` is
rejected because the local path has no server job record. Until production release trust is provisioned, signed self-update fails
closed and directs the operator to the `--local` break-glass path.

Exit code `0` means the selected job succeeded, `1` means a terminal update or user-facing command failure, and `3` means a live-job
conflict (including the JSON form). Follow the printed job id to attach.

## Cloud baseline role mode

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
