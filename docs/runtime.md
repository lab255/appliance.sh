# Runtime

The packaged-app Runtime installs runnable `.appliance.zip` bundles per
workspace target (the current cluster/profile), while sharing content-addressed
bundle bytes across targets.

## Install, list, and uninstall

```sh
appliance runtime install ./journal.appliance.zip
appliance runtime install https://journal.appliance.zip/
appliance runtime list
appliance runtime list --all-targets
appliance runtime run Journal
appliance runtime uninstall Journal
appliance runtime uninstall Journal --keep-data
```

`install` accepts local files and HTTPS URLs only. A URL must match an entry in
the current, verified, non-stale catalogue index; its downloaded digest,
manifest identity, version, license, publisher, and signature must match that
entry. Local files do not need index evidence or a signature. An unsigned or
otherwise unverified local bundle is labelled **Unknown Publisher** and requires
`--accept-unknown-publisher` in headless use, or an explicit `y/N` decision on a
TTY. The flag applies only to that invocation; it does not create permanent
publisher trust.

Before recording an install, Runtime verifies the archive, checks the signed
unsafe-app blacklist, copies the exact bytes to
`~/.appliance/runtime/bundles/<sha256-digest>.appliance.zip`, makes that copy
read-only, and verifies the copy again. Network installs fail closed without a
usable verified blacklist. Local offline installs remain possible with a
warning when no verified blacklist is available.

Installed metadata lives at
`~/.appliance/runtime/installed/<target>/apps.json`. The file is replaced
atomically with mode `0600`; its parent is mode `0700`. Entries include bundle
digest and immutable path, signature/index evidence, publisher tier, source,
install time, license, and a controls summary. The summary is the AP-174 handoff
for the signed entitlement record described below.

The target is `APPLIANCE_PROFILE`, then the active profile, then `local` when no
profile exists. Desktop passes the selected workspace id explicitly. Simple
target names are used as their directory name; unusual names are represented by
a stable SHA-256-derived directory key so path separators can never escape the
store root.

This precedence is specific to `runtime install`; the top-level builder
`install` intentionally ignores `APPLIANCE_PROFILE` as documented in
[CLI target selection](cli.md#install-versus-deploy).

`uninstall` stops a running app first and removes its per-target record and app
data. `--keep-data` retains the data directory. The immutable bundle remains
while any other target references it and is deleted after the last reference is
removed. Entitlement history is retained and marked uninstalled after the last
target removes the app; reinstall never silently reactivates it.

## Entitlements

Every install creates a per-app grant in `~/.appliance/entitlements.json`. The
file is mode `0600` in a mode `0700` directory. Each record contains the app id,
manifest version and SPDX `license`, grant time, a random local installer id,
the approved mounts, egress hosts and ports, published ports, resource limits,
and last-use metadata keyed by stable grant id.

CLI installs show a `GRANT` summary and default to no (`y/N`). Automation can
approve the complete request with `--grant-all`. Desktop shows the same request
as a dialog: egress, published ports, and resources are required and approved
as one set; mounts have per-item checkboxes. This is the v1 default because the
current manifest does not label required versus optional mounts. Declining a
mount removes it from the effective request; a missing required control aborts
install or open and the error names its stable grant id.

An upgrade compares stable ids and canonical control values with the latest
active record. It prompts only for additions or widenings (`UPGRADE DELTA`),
never silently widens a grant, keeps unchanged approval timestamps, and drops
removed requests from the new active snapshot while retaining signed history.

Runtime writes the effective egress policy as the intersection of manifest
controls and the active grant. It stamps last use after installing an allowed
egress rule and after successfully publishing a host port. Timestamps never
move backwards. The runtime enforcement layer does not currently attach
manifest-declared data mounts, so it does not claim or stamp a mount attachment
until that attachment actually exists.

Inspect and revoke grants with:

```sh
appliance runtime entitlements list
appliance runtime entitlements show journal
appliance runtime entitlements --suggest-revoke
appliance runtime entitlements --suggest-revoke --days 14
appliance runtime entitlements revoke journal egress:api.example.test
```

Suggestions are derived only: an observable, active non-mount item appears
after 30 unused days by default (minimum configurable threshold: one whole
day), and nothing is automatically revoked. Mounts are excluded until Runtime
implements attachment and can observe their use. Revoking egress immediately
rewrites a running app's effective default-deny policy. Revoking a mount also
rewrites the policy snapshot but does not stop the app; revoking a published
port or resources stops it so the missing required control is enforced before
another launch.

Records use the RFC 0001 Ed25519 envelope with role `entitlement`. Mutations
take a cross-process lock, verify every prior record, compare the prior file
hash immediately before a mode-`0600` atomic rename, and fail rather than
proceed unlocked. Signed sequence and previous-record hashes detect insertion,
deletion, or reordering within the history. A separate monotonic
`{sequence, headHash}` anchor is advanced while the same lock is held before
the store rename, so a crash between those writes fails closed. The anchor is
a second Keychain item on macOS and a mode-`0600` file beside the device key on
other platforms. Reads refuse a missing, truncated, or rolled-back store whose
head is behind the intact anchor. Invalid bytes are preserved and controls
remain denied for review.

On macOS, the device Ed25519 key bytes are stored as a generic-password
Keychain item. `/usr/bin/security` cannot sign with Ed25519 and Secure Enclave
does not provide Ed25519, so this is not a non-exportable hardware key. Linux
uses a mode-`0600` file beside the entitlement store; Windows uses the same
per-user file location and relies on the current user's filesystem ACL. The
signature provides same-user tamper evidence, not proof that a human consented,
trusted time, user presence, or protection from malware running as that user.
Rollback is detectable only while the anchor is intact; a same-user attacker
who re-signs records or resets both the store and anchor is out of scope. The
macOS `security add-generic-password` command has no seed-from-stdin form (`-w
-` stores a literal dash), so the one-time key creation passes the seed on its
argument vector; it never uses `-U`, and a concurrent creator's existing key
wins after a re-probe.

## Opening installed apps

`runtime run` accepts an installed app id or display name in addition to a
bundle path. Before unpacking, Runtime copies the installed bytes into a private
pre-open file, verifies that exact copy against the stored digest, and unpacks
the same copy for the pooled VM.

Unknown Publisher acknowledgements are digest-bound. Desktop offers **Open
once** and **Open and remember for 30 days**. The latter writes `lastWarnedAt` to
the installed entry; the warning returns after 30 days. CLI automation must pass
`--accept-unknown-publisher` for each invocation and does not update the
remembered time.

## Sample apps

From the repository root, set `OUT` to a temporary directory and run
`scripts/build-runtime-samples.sh --require-docker` to build all three
source-only examples. `OUT` defaults to `$TMPDIR/appliance-runtime-samples`.
CI requires Docker (`--require-docker`); local builds skip with a message. The
script packages each bundle through the CLI's self-verifying `appliance builder
package` path and prints its embedded SHA-256 digest. See the [Runtime live
test](live-test-runbook.md#runtime-live-test) for the complete pooled-VM
exercise.

### [Journal container](../examples/runtime/journal/)

Journal is the smallest container Runtime example: Docker Buildx turns its
static HTML and Dockerfile into a host-architecture OCI image, and the manifest
publishes the HTTP service through the pooled VM. It is the quickest fixture
for validating bundle import, container startup, logs, `ps`, stop, Ctrl-C, and
pool survival.

### [Dashboard binary](../examples/runtime/dashboard/)

Dashboard exercises the binary payload path without committing an executable.
Docker runs `go build` for static Linux amd64 and arm64 targets, then the bundle
selects the matching payload, declared entrypoint, arguments, environment, and
HTTP port. Its optional `exit7` mode also checks exact exit-code propagation.

### [Notes Suite compound app](../examples/runtime/notes-suite/)

Notes Suite packages two container leaves into one shared-VM app. The API must
be healthy before the web leaf starts; the web leaf owns the only host port,
while service discovery, per-leaf logs, restart policy, reverse-order stop, and
one app-level network principal demonstrate the compound lifecycle.

Compound egress is therefore an app-level control: declare `network.egress`
only at the compound manifest root. A leaf-level declaration is rejected with
`compound apps declare network.egress at the root (shared principal)` and a
message naming the leaf whose grants must move to the top level. The runtime
does not union leaf grants. Only leaf ports marked both `expose: "host"` and
`primary: true` are published to the host.

## Compound v1 deviations

The v1 supervisor starts leaves sequentially in deterministic topological
order, with a 300-second readiness cap for each leaf. Exhausting an optional
leaf's restart budget degrades the app but does not stop that leaf's dependents.
Parallel starts and dependent teardown for optional exhaustion are follow-ups.

## Binary v1 deviations

Per-target `env` and `cwd` support is tracked as follow-up AP-164b; binary workloads currently use manifest-level environment variables and the payload root as their working directory.
