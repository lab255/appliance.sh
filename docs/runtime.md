# Runtime

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
