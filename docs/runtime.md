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

This precedence is specific to `runtime install`; the top-level builder
`install` intentionally ignores `APPLIANCE_PROFILE` as documented in
[CLI target selection](cli.md#install-versus-deploy).

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

For a manifest with `ui.type: web`, **Open** starts the app with the same
`runtime run --detach --json` path used by the CLI, waits up to 15 seconds
for the manifest's named `ui.port`, and creates one native window labelled
`app-<sanitized-appId>-<short-hash>` and titled `<App> — Appliance`. The hash
keeps ids such as `a.b` and `a-b` distinct; the same label keys the remembered
window size. The window is an Appliance-owned wrapper containing the app in a
cross-origin iframe and a 28 px status strip:

```text
sandboxed · egress: 2 hosts allowed · port 20421
```

The iframe keeps the app's `http://127.0.0.1:<published-port>` origin separate
from the desktop origin. The wrapper installs a restrictive CSP whose
`frame-src` names only that loopback origin. Desktop also denies top-level
navigation away from that host/port and rejects `window.open`/`target=_blank`
requests. It does not inject scripts into or read content from the app. The
host count comes from the installed effective Runtime policy (falling back to
the recorded controls summary), and the strip refreshes while the window is
open.

Closing an app window keeps its Runtime process running by default, matching
`appliance runtime ps`. The Rust window command has a `stop-on-close` parameter
for future settings work, but it is not yet user-configurable and every current
Desktop caller uses keep-running. A Desktop restart reconciles the Runtime
registry but does not reopen app windows until the user asks. If the app exits
or is stopped, its window becomes a plain **App exited** page with **Reopen**,
and its Installed Apps card reports `Exited (N)` when the supervisor supplied
an exit code.

Manifests with no `ui` or with a non-web UI show **No UI** and a Logs action on
their card. Their lifecycle remains available through `runtime ps`, `logs`, and
`stop`.

### `appliance runtime open`

```sh
appliance runtime open Journal
appliance runtime open Journal --target local
appliance runtime open Journal --print
appliance runtime open Journal --json
```

`runtime open` starts a stopped app, waits for its UI port, then checks the
private Desktop rendezvous file at
`~/.appliance/runtime/desktop-ipc.json`. A running Desktop accepts a
token-authenticated request over loopback and opens the dedicated app window.
If Desktop is absent or the bounded IPC connection fails, the CLI opens the
same loopback URL in the operating system's default browser. The rendezvous
contains no app data or credentials and is mode `0600`; a stale file only
causes the browser fallback.

`--json` prints the resolved descriptor, chosen route, and the
`metrics.appOpenTtv` context. Desktop completes that measurement on the iframe
load event and records `app_open_ttv` (`cold`, `warm`, or `reopen`) plus
`app_stop_ttx` in its platform log directory as `desktop-metrics.jsonl` (on
macOS: `~/Library/Logs/sh.appliance.desktop/desktop-metrics.jsonl`). Targets
are warm p95 ≤2 seconds, cold p95 ≤15 seconds, and stop-to-exited paint ≤2
seconds.

The current Runtime supports container bundles in the pooled VM. Binary and
compound execution remain separate runtime work; their manifests can be stored
and displayed, including the compound service count, but `runtime run` reports
that they are not yet executable.
