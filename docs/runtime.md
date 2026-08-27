# Appliance Runtime

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
for entitlement prompts; AP-173 does not create `GRANT` records.

The target is `APPLIANCE_PROFILE`, then the active profile, then `local` when no
profile exists. Desktop passes the selected workspace id explicitly. Simple
target names are used as their directory name; unusual names are represented by
a stable SHA-256-derived directory key so path separators can never escape the
store root.

`uninstall` stops a running app first and removes its per-target record and app
data. `--keep-data` retains the data directory. The immutable bundle remains
while any other target references it and is deleted after the last reference is
removed.

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

The current Runtime supports container bundles in the pooled VM. Binary and
compound execution remain separate runtime work; their manifests can be stored
and displayed, including the compound service count, but `runtime run` reports
that they are not yet executable.
