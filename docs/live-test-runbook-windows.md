# Windows credential and desktop release runbook

Use this runbook on a non-admin Windows 11 user before calling the Windows
credential and installed-desktop path release-ready. It covers the scope that
[`docs/desktop.md`](desktop.md) and
[`packages/desktop/README.md`](../packages/desktop/README.md) claim; it does not
claim parity for features outside these steps.

## 1. Prerequisites

- Use WSL2 NAT, not WSL v1 or mirrored networking.
- Install the candidate NSIS desktop bundle and the same-tag standalone CLI.
- Start from a user profile containing legacy non-empty cluster credentials in
  both `~/.appliance/profiles.json` and `~/.appliance/credentials.json`, plus
  one legacy agent credential.
- Record the release tag, Windows build, `wsl.exe --version`, and SHA-256 of
  both installed `appliance-credhelper.exe` copies.

Pass: the helper hashes are identical and match the
`x86_64-pc-windows-msvc` entry in
[`credential-helper-checksums.json`](../packages/cli/scripts/credential-helper-checksums.json).

## 2. Installed layout and helper pipes

From PowerShell, locate the standalone and desktop-bundled CLI/helper pairs.
For each pair, confirm `appliance-credhelper.exe` is a file sibling of
`appliance.exe`. Temporarily rename one helper, run an authenticated CLI
command, restore it, and rerun the command.

Pass: the missing-helper run fails closed with no file fallback; the restored
run succeeds. Do not place any substitute helper on `PATH` or in the current
directory during the retry: neither location may be used. The automated
counterpart is
[`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts).

Exercise a test Credential Manager item whose value contains a newline,
non-ASCII text, and trailing whitespace through helper `put`/`get` stdin and
stdout pipes.

Pass: the bytes round-trip exactly, the value never appears in argv or stderr,
and missing/denied/malformed cases return their documented distinct statuses.
The Windows-only automated counterpart is
[`windows_cli.rs`](../packages/credhelper/tests/windows_cli.rs).

## 3. Lazy migration and downgrade boundary

Run an authenticated CLI command, then inspect the two JSON files and Windows
Credential Manager.

Pass:

- every migrated cluster value is present in Credential Manager;
- `profiles.json` retains metadata with an empty secret;
- `credentials.json` retains metadata with an empty secret;
- the legacy agent file is removed only after read-back verification; and
- a second run makes no further changes.

Recreate one legacy file with bytes different from the Credential Manager
item, then run the command again.

Pass: neither value is overwritten, Credential Manager remains the read
source, and `appliance doctor` reports `conflict`. After the verified scrub,
launching an older Windows CLI must require upgrade or re-login rather than
recovering a cleartext downgrade copy. The fixture counterpart is
[`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts).

## 4. Doctor states

Create or simulate each state in turn: `missing`, `denied`, `malformed`,
`migrated`, `conflict`, `helper-missing`, and `legacy-name`. Run `appliance
doctor` after each change; use `doctor --fix` only for a safe missing/write-back
case.

Pass: Windows shows a credential-store row for every profile—never
`not-applicable`—and each state has distinct remediation. Conflict repair does
not choose or delete either value automatically. The rendering counterpart is
[`runtime-doctor.spec.ts`](../packages/cli/src/utils/runtime-doctor.spec.ts).

## 5. Broker files and managed WSL distro

Sign in an agent and start it once. Inspect the VM's
`egress-credentials.json`, `egress-secrets.json`, and Windows ACLs.

Pass: the generated rule contains absolute argv ending in `agent print-key
--type <agent>`, uses `capture:false`, and leaves no real agent credential in
either per-VM file. If capture is explicitly enabled for a disposable test
header, the header appears in cleartext in `egress-secrets.json` and doctor
must warn before release approval. Restore `capture:false` and delete the test
secret afterward. The rule/capture counterparts are
[`agent.spec.ts`](../packages/cli/src/utils/agent.spec.ts) and
[`creds.rs`](../packages/vm/src/creds.rs).

Inside the managed distro, inspect `/etc/wsl.conf` and `/proc/mounts`.

Pass: `[interop] enabled=false`, `appendWindowsPath=false`, and no Windows drive
is automatically mounted. These controls do not constrain other distros or
same-user Windows execution. The configuration counterpart is
[`wsl.rs`](../packages/vm/src/backend/wsl.rs).

## 6. Record the result

Attach the command transcript with secrets redacted, both helper hashes,
doctor output for every state, ACL principals, `/etc/wsl.conf`, and the NSIS
installed-file list to the release evidence. Record any failed step as a
release blocker; do not weaken the workflow digest guard or publish gating to
work around it.
