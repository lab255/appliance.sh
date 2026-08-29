# Credentials & secrets lifecycle

How Appliance stores API credentials and per-environment secrets, rotates them,
and migrates older local stores.

## Host credential stores

Cluster and agent credentials are user-global. Their canonical store depends
on the host; per-VM broker state is covered separately below.

| Platform | Canonical secret store                                                          | `profiles.json` / `credentials.json`                                                                                                                                             | Evidence                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | Keychain (`sh.appliance.desktop` for clusters, `sh.appliance.agent` for agents) | Cluster metadata and an empty secret after reconciliation                                                                                                                        | [`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts), [`agent-envelope.spec.ts`](../packages/desktop/src/agent-envelope.spec.ts)                                                |
| Windows  | Windows Credential Manager through `appliance-credhelper.exe`                   | Cluster metadata and an empty secret after verified migration; the legacy `credentials.json` mirror keeps metadata with an empty secret; a legacy agent file is deleted outright | [`credential-store.spec.ts` — verified Windows migration](../packages/cli/src/utils/credential-store.spec.ts), [`keyring_store.rs` — native store tests](../packages/credential-store/src/keyring_store.rs) |
| Linux    | owner-only ACL/mode files under `~/.appliance`                                  | Cluster secret remains cleartext at rest                                                                                                                                         | [`credential-store.spec.ts` — file backend](../packages/cli/src/utils/credential-store.spec.ts), [`file.rs`](../packages/credential-store/src/file.rs)                                                      |

`profiles.json` remains shared discovery and metadata for both desktop and CLI.
On Windows, neither it nor the legacy `credentials.json` is a canonical cluster
secret store. Desktop- and CLI-managed Windows profiles use Credential Manager;
Windows is not part of any file-canonical consolidation target. The desktop and
CLI still have separate process locks, so a cross-process metadata
read-modify-write remains last-writer-wins, although writes are atomic.
[`runtime-doctor.spec.ts`](../packages/cli/src/utils/runtime-doctor.spec.ts)
checks store/file coherence and [`profiles-lock.spec.ts`](../packages/cli/src/utils/profiles-lock.spec.ts)
checks the atomic file behavior.

## Windows helper contract

The packaged CLI invokes only an absolute `appliance-credhelper.exe` sibling;
it never searches `PATH`, the current directory, or an environment override.
The helper asset is SHA-256 checked against the digest baked into the npm
package before installation, and a missing or swapped helper fails closed.
[`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts)
exercises sibling-only discovery and missing-helper behavior;
[`binary-integrity.spec.mjs`](../packages/cli/scripts/binary-integrity.spec.mjs)
exercises digest rejection and release layouts.

The standalone CLI release cross-builds the Windows helper; the desktop
release builds its copy natively. They remain separate builds until AP-202
signs both. Each workflow therefore hashes its own staged output and requires
byte identity with the same CLI-baked digest before publishing.
[`binary-integrity.spec.mjs`](../packages/cli/scripts/binary-integrity.spec.mjs)
locks both release guards to those layouts.

The helper accepts typed cluster, agent, and entitlement operations. Writes
arrive on stdin, reads leave on stdout, and diagnostics use stderr. Windows
pipes are binary: there is no BOM, newline, CRLF translation, or trimming.
Exit codes are `0` success, `3` missing, `4` denied, `5` malformed, `6`
invalid identifier, and `1` internal; every non-zero status is fail-closed.
Secrets are never argv. These byte and status contracts are covered by
[`windows_cli.rs`](../packages/credhelper/tests/windows_cli.rs) and
[`cli_stdio.rs`](../packages/credhelper/tests/cli_stdio.rs), plus the
cross-language vectors in
[`envelope-vectors.json`](../packages/credential-store/testdata/envelope-vectors.json).

## Lazy verified Windows migration

Migration runs on first credential access under the user-global store lock.
Credential Manager wins if it already contains a value. A legacy file is
scrubbed only after the helper reads the imported value back and it matches; a
failure preserves the file and fails closed. Equal duplicates are scrubbed.
Different values preserve both copies and record `conflict`, with Credential
Manager remaining the read source. Re-running is idempotent.
[`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts)
covers cluster, agent, entitlement, idempotence, equality, and conflict cases.

The scrub is a downgrade boundary: an older Windows build cannot read the
Credential Manager value and must be upgraded, or the user signs in again with
`appliance login` (agents: `appliance agent login`). Run `appliance doctor` to
see affected profiles; `appliance doctor --fix` retries only safe write-back
cases and never resolves a conflict. No cleartext downgrade copy is retained.
The migration/coherence states are documented in [control-plane.md](control-plane.md),
backed by
[`runtime-doctor.spec.ts`](../packages/cli/src/utils/runtime-doctor.spec.ts).

## Windows residual risk

Credential Manager prevents ordinary cross-user file reads and removes a
cleartext file from normal home-directory backup/sync and `/mnt/c` exposure;
the [Windows runbook's broker section](live-test-runbook-windows.md#broker-files-and-managed-wsl-distro)
checks `/proc/mounts` and verifies that automount is off.
It does not defend against code already running as the same Windows user,
Administrator, or SYSTEM; those principals can use the same credential APIs.
A malicious same-user replacement helper is also outside this boundary. The
ACL principal checks are covered by
[`file.rs`](../packages/credential-store/src/file.rs) and
[`fs-acl.ts`](../packages/cli/src/utils/fs-acl.ts).

WSL interop is the same-user residual: another distro allowed to launch
Windows executables can invoke the helper. The managed Appliance distro ships
`/etc/wsl.conf` with `[interop] enabled=false` and
`appendWindowsPath=false`, as asserted by
[`wsl.rs`](../packages/vm/src/backend/wsl.rs); this does not constrain other
distros or the Windows user.

## API key rotation — `appliance keys rotate`

`POST /api/v1/keys/rotate` mints a replacement before revoking the calling
key. The CLI verifies the replacement, then atomically swaps that profile's
`keyId` and secret. On macOS and Windows the platform store is updated; on
Linux the owner-only file remains canonical. The secret is never printed.
See [`keychain.spec.ts`](../packages/cli/src/utils/keychain.spec.ts) and
[`api-key.service.spec.ts`](../packages/api-server/src/services/api-key.service.spec.ts).

An api-server that predates rotation returns 404. The CLI leaves the old key
untouched and asks for an api-server upgrade.

## Per-environment secrets — `appliance env set/list/unset`

Environment variables are stored server-side and injected into every deploy
of that environment. Per-deploy values override that persistent baseline.
Listing returns names only; setting without an inline value uses hidden input.
The object store currently persists these values in cleartext, so cluster-side
at-rest encryption remains separate work. See
[`env-var.service.spec.ts`](../packages/api-server/src/services/env-var.service.spec.ts).

## Per-VM broker state and capture

`~/.appliance/vm/<name>/egress-credentials.json` contains ACL-protected rules.
Normal agent rules use an absolute argv helper with `capture:false`, so no real
agent credential is written there or to `egress-secrets.json`. Opting into
capture writes the selected header in cleartext to `egress-secrets.json`.
That file is ACL-reset for the current user but retains backup, same-user,
Administrator/SYSTEM, and any applicable WSL file-access residuals. The rule,
capture, and no-capture paths are covered by
[`creds.rs`](../packages/vm/src/creds.rs).
