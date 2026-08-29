# Packaged app runtime

**Appliance is building the runtime of the future — the fastest, easiest way to ship AI-native apps.**

## Install the CLI

Install Appliance with pnpm, then confirm the command is available:

```sh
pnpm add --global appliance.sh
appliance --version
```

The packaged app commands use manifest v2 `.appliance.zip` bundles. Run
`appliance runtime <command> --help` for all flags.

## Package an app

From a manifest v2 project directory:

```sh
appliance builder package
appliance builder package --out my-app.appliance.zip
```

The default output is `<name>.appliance.zip`. `appliance package` is the same
command. Container projects need a local Docker or BuildKit engine unless you
provide a prebuilt image with `--image`; binary projects must already contain
their declared Linux payloads.

## Run or install a bundle

Run a local bundle immediately:

```sh
appliance runtime run ./my-app.appliance.zip
```

The command validates the bundle, starts it, and follows its logs. Ctrl-C stops
the app but leaves the pooled VM running.

Install a bundle for later use from a local path or HTTPS URL:

```sh
appliance runtime install ./my-app.appliance.zip
appliance runtime install https://example.com/my-app.appliance.zip
appliance runtime list
appliance runtime uninstall my-app
```

Installation records the app in the current workspace target. Use `--profile` for another target. The CLI shows publisher and requested
control prompts before accepting grants when confirmation is required.

## Inspect and control running apps

```sh
appliance runtime ps
appliance runtime ps --json
appliance runtime logs my-app
appliance runtime logs my-app --follow
appliance runtime logs my-app --service api
appliance runtime stop my-app
```

`ps` shows app state and published host ports. Compound apps also show their
services, health, and restart counts. `stop` removes the running instance while
keeping the installed bundle and pooled VM.

## Open an app

```sh
appliance runtime open my-app
appliance runtime open my-app --print
appliance runtime open my-app --json
```

`open` starts a stopped installed app when necessary, then opens its declared
web UI. `--print` prints the URL instead; `--json` prints the resolved app and
route details.

## The pooled sandbox VM

Packaged apps run in one managed `appliance-runtime` VM. Apps are sandboxed by
default, only manifest-declared ports are published to the host, outbound
network access is denied unless the app declares and the user grants a host,
and TLS inspection is on. Each app has its own runtime principal, payload,
process controls, policy, state, and logs; compound services share the app's
network principal.

Payload integrity is verified on every open by the [immutable pre-open copy
test](../packages/cli/src/appliance-runtime.spec.ts). WSL drvfs retains a
verify-on-open TOCTOU residual because Windows can mutate payload bytes after
verification; the pending owner run will record that residual rather than
treating drvfs as immutable ([Windows certification](live-test-runbook-windows.md#results-record)).

### Windows 11 / WSL2 Runtime

App Runtime is in the supported Windows 11 with WSL2 NAT scope, pending the
[owner-run certification R01–R71](live-test-runbook-windows.md#results-record).
The per-VM `wslMode` defaults to `strict`: Runtime refuses manifests with
egress grants while networkless apps may run
([strict-mode tests](../packages/cli/src/appliance-runtime.spec.ts)).

`cooperative` is an explicit, bypassable proxy mode. Each app start receives
its own proxy credential, policy selection never unions grants across apps,
credential-less requests receive 407, and stop/uninstall/delete revokes that
credential ([per-app selection and revocation tests](../packages/vm/src/egress.rs),
[live steps 5–7](live-test-runbook-windows.md#5-strict-refusal)). These controls
do not create a hard Windows egress boundary; see the [Windows egress
contract](egress-firewall.md#windows-wsl-backend).

Windows runtime install and unpack still require paths under MAX_PATH (260
characters) unless `LongPathsEnabled` is enabled. The pending owner run records
the registry posture and a greater-than-260-character install in
[R23](live-test-runbook-windows.md#results-record).

## Desktop screens

**Installed Apps.** This screen lists apps for the selected workspace with
version, license, publisher, state, service count, and egress-host count. Use it
to install a local bundle, search installed apps, open or stop an app, and find
the matching logs command.

**Catalogue.** This screen shows entries from the verified signed index. Search
by name, description, license, or publisher, filter by category, and install an
entry. If only a stale verified cache is available, entries remain visible but
new installs are disabled until refresh succeeds.

**Entitlements.** In Settings, this section shows grants that have not been used
for at least 30 days. Review each suggestion and either keep or revoke the
grant; nothing is revoked automatically.

## Sample apps

The repository includes three source-only samples:

- [Journal](../examples/runtime/journal/) — a single container with a web UI.
- [Dashboard](../examples/runtime/dashboard/) — a static Linux binary with a
  published HTTP port.
- [Notes Suite](../examples/runtime/notes-suite/) — a compound app with an API
  service and a web service.

Build all three into a temporary output directory with:

```sh
scripts/build-runtime-samples.sh --require-docker
```
