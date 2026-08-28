# Runtime

## Sample apps

The source-only examples under [`examples/runtime`](../examples/runtime/) are
packaged at test or demo time; generated images, executables, and bundles are
not committed. See the [Runtime live-test runbook](live-test-runbook.md) for the
complete pooled-VM exercise.

### Notes Suite compound app

[Notes Suite](../examples/runtime/notes-suite/) packages two container leaves
into one shared-VM app. The API must become healthy before the web leaf starts;
the web leaf owns the only host port. Leaves receive fixed loopback discovery
URLs, individual cgroups, health state, restart counters, and service-scoped
logs while retaining one app principal, network namespace, and unit lifecycle.

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
