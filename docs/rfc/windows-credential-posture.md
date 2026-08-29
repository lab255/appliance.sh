# RFC: Windows credential posture

- **Status:** Proposed decision
- **Created:** 2026-08-29
- **Task:** AP-191

## Summary

On Windows, put durable user-global credentials in **Windows Credential
Manager**, accessed through the Rust `keyring` crate. Ship a small
`appliance-credhelper.exe` beside the standalone CLI so the TypeScript/Bun CLI
can use the same store without depending on the desktop. Keep per-VM broker
configuration and captured broker secrets in owner-only, ACL-reset files.

This chooses an OS store where a secret has a stable user-global identity and
an ACL'd file where state is VM-scoped, high-cardinality, and atomically edited
by `appliance-vm`. Credential Manager reduces ordinary backup, sync, and direct
WSL file exposure; it does not protect secrets from code already executing as
the same Windows user.

## Verified current state

Paths are relative to the repository root. Line numbers are current anchors,
not API contracts.

| Evidence                                                                                                | Current behavior                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/desktop/src-tauri/Cargo.toml:33`                                                              | Desktop `keyring` already enables `windows-native`.                                                                                                                      |
| `packages/desktop/src-tauri/src/lib.rs:1173,1217,1529`                                                  | Desktop writes cluster keys through `keyring`, but only macOS blanks the shared-file secret; Windows therefore also writes cleartext to `profiles.json`.                 |
| `packages/cli/src/utils/keychain.ts:287-414`                                                            | Cluster/device keystore operations are implemented only through macOS `security`; non-macOS falls back to files.                                                         |
| `packages/cli/src/utils/runtime-doctor.ts:645-655`                                                      | The Keychain/profile coherence probe returns `not-applicable` when the platform/account mapping is absent.                                                               |
| `packages/cli/src/utils/profile-store.ts:75-77,200-209`                                                 | Secret files get a best-effort Windows `icacls` reset after writes, but `ensureDir` does not tighten `~/.appliance` itself. AP-195 owns that complete ACL pass.          |
| `packages/cli/src/utils/agent.ts:481-710`                                                               | Agent credentials use macOS Keychain or `~/.appliance/agent/<provider>-cred`; the Windows file gets no Windows-specific protection here.                                 |
| `packages/desktop/src-tauri/src/lib.rs:5791-6058`                                                       | Desktop duplicates the agent file/Keychain policy and the `{kind,value}` envelope contract.                                                                              |
| `packages/vm/src/creds.rs:57-140,230-289`                                                               | VM broker rules and captured secrets are per-VM JSON files; injection can resolve a host helper. AP-194 separately replaces its shell-string helper execution with argv. |
| `packages/cli/src/utils/keychain.ts:54-231`                                                             | The entitlement signing seed and rollback anchor use macOS Keychain or owner-only files. The anchor is not secret, but it is integrity-sensitive.                        |
| `docs/credentials.md:200-208`; `docs/control-plane.md:300-318`; `docs/agent-sandbox.md:136-139,478-483` | Current docs describe non-macOS cleartext/`0600` fallback and leave stronger Windows storage aspirational.                                                               |

## Decision by secret class

| Secret class                      | Windows canonical store                                                                                                                                                                                                                                                                                                                                                                   | File contents after migration                                                                                                              | Reason                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cluster API key                   | Credential Manager via `keyring`; service `sh.appliance.desktop`, account `cluster:<profile-name>` for every Windows profile, regardless of `managed`                                                                                                                                                                                                                                     | `profiles.json` retains URL, key ID, name, and other metadata with an empty `secret`; stop putting the active secret in `credentials.json` | Both desktop and CLI need the value, and the desktop already writes the selected OS API. A helper closes the CLI-read gap.                                                                                                                                                                                   |
| Agent credentials                 | Credential Manager via `keyring`; service `sh.appliance.agent`, account `<provider>`                                                                                                                                                                                                                                                                                                      | No `<provider>-cred` after verified migration                                                                                              | These are long-lived, user-global secrets. Store the existing UTF-8 `{kind,value}` envelope as one opaque value.                                                                                                                                                                                             |
| Entitlement device key and anchor | Credential Manager via `keyring`; existing accounts `device:entitlements:v1` and `device:entitlements-anchor:v1` under `sh.appliance.desktop`; under the user-global lock; after any write the helper re-reads and returns the value now canonical in Credential Manager — an existing key always wins (create-if-absent; `keyring::set_password` alone overwrites and is not sufficient) | Remove the default-home key and anchor files after verified migration; explicit non-default/test homes remain file-backed                  | The seed is a private signing key. Keeping the independent anchor outside ordinary files makes simple file rollback/restore harder, even though it cannot defeat same-user compromise.                                                                                                                       |
| Per-VM broker state               | ACL'd files under `~/.appliance/vm/<name>`: `egress-credentials.json` and `egress-secrets.json`                                                                                                                                                                                                                                                                                           | Unchanged format and location; AP-195 resets the directory and files to the current user                                                   | Rules are VM-scoped structured state and need atomic whole-file updates. Normal agent rules contain only helper argv and `capture:false`, so no agent credential lands here. An explicitly configured capture rule can put a cleartext header in `egress-secrets.json`; that exception is owner-gated below. |

Linux keeps owner-only files and macOS keeps Keychain. This RFC does not adopt
Secret Service on Linux and does not change AP-194's helper argv contract or
AP-195's complete Windows ACL work.

Windows deliberately covers all profiles; the macOS `managed === 'desktop'`
restriction is unchanged here and its cleartext CLI-managed case is a separate
follow-up.

## CLI access: ship `appliance-credhelper.exe`

Add a small Rust companion executable and release it with the Windows CLI. It
uses the same neutral store crate and `keyring` Windows backend as the desktop.
It exposes typed operations, not arbitrary service/account access:

```text
appliance-credhelper cluster get|put|delete|probe --profile <name>
appliance-credhelper agent get|put|delete|probe --provider <provider>
appliance-credhelper entitlement-key get-or-create
appliance-credhelper entitlement-anchor get|put|import
```

Writes consume the value on stdin; reads return only the requested value on
stdout; diagnostics go to stderr; missing, denied, and malformed have distinct
exit codes. Secrets never appear in argv or logs. The TS caller uses
`execFileSync`/`spawnSync` with fixed argv and private pipes, never a shell.
The helper validates cluster/profile/provider identifiers against the same
allowlists and length limits as its callers.

The helper sets stdin/stdout to binary mode (`_setmode(_O_BINARY)`); values are
written raw with no trailing newline, no BOM, no CRLF translation; callers read
the exact byte count and never `.trim()` before storing. Exit codes: 0 ok, 3
missing, 4 denied, 5 malformed, 6 invalid-identifier, 1 internal; every
non-zero exit is fail-closed at every hop.

The CLI resolves the helper only as an absolute sibling of its own executable
path (never `PATH`, `cwd`, or an env override), and spawns with
`CREATE_NO_WINDOW`. Because the install dir is user-writable, a swapped helper
is same-user compromise, not a boundary this defends.

The release publishes a SHA-256 for the helper asset; postinstall verifies the
digest against a value baked into the published npm package before the file is
made executable, and deletes on mismatch. (The existing `appliance-bin`
download has no such check — tracked separately.)

The helper is installed beside `appliance-bin.exe`, and the desktop bundle
includes it beside its bundled CLI. Packaging tests must cover npm, direct
release download, and Tauri resource layouts; a missing helper is a fail-closed
credential error, not a fallback write to cleartext.

## One store seam

Create a neutral Rust library crate at `packages/credential-store`, outside
both desktop and VM packages:

```rust
trait CredentialStore {
    fn get(&self, key: &StoreKey) -> Result<Option<Vec<u8>>, StoreError>;
    fn put(&self, key: &StoreKey, value: &[u8]) -> Result<(), StoreError>;
    fn delete(&self, key: &StoreKey) -> Result<(), StoreError>;
    fn probe(&self, key: &StoreKey) -> Result<Presence, StoreError>;
}
```

`StoreKey` is a closed enum for cluster, agent, entitlement key/anchor, and
per-VM broker entries. Feature-gated `KeyringStore` and `AclFileStore`
implement the trait. The desktop and helper enable `KeyringStore`;
`appliance-vm` enables only `AclFileStore`. This dependency direction matters:
the desktop still launches `appliance-vm` as a sidecar, and neither package
depends on the other; both depend on the neutral crate.

Create one CLI module, `packages/cli/src/utils/credential-store.ts`, with the
same typed operations and three private backends:

- macOS: `/usr/bin/security`, preserving current item names;
- Windows: the sibling `appliance-credhelper.exe`;
- Linux and explicit test homes: owner-only files.

Call-site result:

- `agent.ts` owns adapter/login UX only and calls `credential-store.ts` for
  read/write/probe/delete.
- `keychain.ts` is folded into the module; profile and entitlement callers do
  not branch on OS.
- desktop `lib.rs` validates Tauri inputs, encodes the envelope once, and calls
  the neutral Rust store instead of duplicating `security`/file functions.
- VM `creds.rs` asks the file store for VM rules/captured values and invokes
  AP-194's argv resolver for global agent credentials. It has no macOS/Windows
  agent-store branch and never depends on the desktop.

### Envelope invariant

The agent value in every backend remains exactly the UTF-8 bytes
`{"kind":"<kind>","value":"<value>"}` with JSON escaping and field order
`kind`, then `value`. Store APIs treat it as opaque bytes: a migration copies
and verifies the original bytes and never parse/reserializes them. TS and Rust
encoders share checked-in golden vectors covering all kinds, quotes,
backslashes, and non-ASCII. Legacy bare API keys are copied byte-for-byte and
retain the existing read-as-`api-key` compatibility. A corrupt JSON-looking
envelope continues to fail closed.

## Windows migration

Migration is lazy and idempotent under a user-global migration lock:

1. Read Credential Manager first. If the item exists and a legacy file value
   also exists: if they are byte-equal, scrub the file (steps 3–5); if they
   differ, keep both, do NOT overwrite either, and surface a doctor `conflict`
   state instructing re-login. Credential Manager remains the read source; no
   path may leave an unscrubbed cleartext copy silently.
2. If the item is missing, read the legacy file value and write it to Credential
   Manager. For clusters, migrate each non-empty profile and the legacy
   active-profile mirror; for agents, consider `<provider>-cred` then the legacy
   `anthropic-key`; for entitlements, validate the key/anchor structures before
   import.
3. Read Credential Manager back and require exact logical equality (exact bytes
   for agent envelopes).
4. Only after verification, atomically blank the cluster secret fields and
   delete the migrated agent/device files. If any step fails, leave the
   original file untouched and fail closed; never silently choose file-canonical.
5. Record a non-secret schema marker so every surface can distinguish
   not-yet-migrated from already-scrubbed. Re-running is safe after a crash.

The marker is a non-secret hint for surfacing state only; no scrub, trust, or
read decision may be gated on it, and a flipped marker cannot cause an overwrite
because an existing Credential Manager item is never replaced from a file.

Per-VM files do not move. AP-195 tightens their existing files and parent
directories in place. The scrub creates a downgrade boundary: an older Windows
CLI cannot read Credential Manager and requires upgrade or re-login; accepting
that is owner-gated below.

## Alternatives and threat model

| Option                                                              | Other local users                                                                                | Same-user malware                                                 | Backup/sync leakage                                                                                                             | WSL `/mnt/c`                                                                                                                          | CLI/operational result                                                                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Credential Manager + bundled helper (chosen for global secrets)** | Windows user isolation blocks ordinary cross-user reads; administrators/SYSTEM remain privileged | Can call Credential APIs or the helper as the user; not protected | Avoids cleartext in ordinary home-directory backup/sync; account/system credential backups remain in the Windows trust boundary | No file to read directly. A distro with Windows interop can invoke the helper as the same user, so it inherits the same-user residual | Standalone and desktop work without either depending on the other; adds a small signed/released binary                                                                                            |
| Shell from CLI to desktop sidecar                                   | Similar once the sidecar reaches Credential Manager                                              | Same residual, plus a larger callable surface                     | Same as Credential Manager                                                                                                      | Same as Credential Manager                                                                                                            | Rejected: desktop may be absent or stopped; headless CLI and recovery paths would depend on GUI installation/lifecycle                                                                            |
| Node native module                                                  | Similar once it reaches Credential Manager                                                       | Same residual; native supply-chain/loader code runs as the user   | Same as Credential Manager                                                                                                      | Same-user interop residual                                                                                                            | Rejected: Bun single-binary, Node ABI, npm prebuild, Tauri, and five release targets create a larger packaging/ABI surface than a narrow Rust helper; it also duplicates the working Rust backend |
| ACL'd file canonical for all secrets                                | ACL reset blocks ordinary other users; administrators/SYSTEM can take ownership                  | Reads cleartext directly                                          | Cleartext leaks when `~/.appliance` is backed up or synced                                                                      | DrvFS exposes the Windows file to a distro running as that user; ACLs do not create a second trust boundary                           | Rejected for durable global secrets; retained for per-VM state only                                                                                                                               |

Windows generic credentials carry no per-application ACL: any process
running as the user can `CredRead` them, and unlike macOS Keychain there is no
per-binary prompt. The helper does not add exposure but does lower attacker
effort by naming the items. The real delta versus an ACL'd file is therefore
narrow: no cleartext in ordinary home-directory backup/sync, and no file for a
WSL distro to read over `/mnt/c`. Credential Manager stores generic credentials
under the same user DPAPI master key an app could use directly; choosing it over
a hand-rolled DPAPI blob buys enumeration, lifecycle, and a shared `keyring`
backend — not a stronger trust boundary.

The honest residual is **same-user execution**: neither Credential Manager nor
ACLs defend against malware already running as the Appliance user, an elevated
administrator, screen/input capture at login, or a malicious replacement
helper. Release signing, hash verification, and fail-closed helper discovery
protect distribution integrity, not a compromised account. Credential Manager
also does not make entitlement signing hardware-backed or non-exportable.

One WSL mitigation option is to ship `/etc/wsl.conf` with `[interop]
enabled=false` and `appendWindowsPath=false` in the appliance distro — partial:
does not constrain other distros or the user.

## Required documentation edits after implementation

- `docs/credentials.md`
  - Replace the macOS/non-macOS split with macOS Keychain, Windows Credential
    Manager, and Linux ACL/mode-file rows.
  - State that Windows `profiles.json` and `credentials.json` contain metadata,
    not cluster secrets; document the helper, migration, downgrade boundary,
    and same-user/WSL residual.
  - Remove the Windows claim from the file-canonical consolidation target.
- `docs/control-plane.md`
  - Replace “CLI cannot read DPAPI” and the DPAPI-wrapped-DEK future note with
    the shipped Credential Manager/helper contract.
  - Extend doctor coherence/fix behavior to Windows and distinguish missing,
    denied, malformed, and migrated states.
  - Keep Linux cleartext-at-rest and desktop/CLI locking residuals explicit.
- `docs/agent-sandbox.md`
  - Say Windows agent credentials are Credential Manager-backed, while agent
    broker rules remain per-VM ACL files and default helper rules contain no
    secret.
  - State that opt-in capture writes cleartext to `egress-secrets.json`, with
    backup, WSL, administrator, and same-user residuals.
  - Update `print-key` language to AP-194 argv plus the TS store/helper path.
- Consistency sweep: make the same store wording changes in
  `docs/agent-login.md` and `docs/multi-agent-adapters.md`.

## Sub-issues and merge order

1. **Windows store core + helper packaging — L.** Add the neutral Rust crate,
   typed helper, Windows store tests, and all CLI/npm/Tauri release layouts.
   Acceptance: round-trip/probe/delete tests pass under a non-admin Windows
   user; binary-mode pipe contract test with golden bytes; digest-pinned
   download; sibling-only discovery test; stdin/stdout never puts a secret in
   argv/logs; missing helper fails closed; signed asset/install layout is
   verified.
2. **Thin callers + migration — L.** Add the single TS module, move desktop
   agent calls to the Rust seam, move VM files behind `AclFileStore`, and run
   the idempotent scrub migration. Acceptance: cross-language envelope golden
   vectors match byte-for-byte; legacy cluster/agent/entitlement fixtures
   migrate without loss; conflict-state migration test; injected agents still
   fail closed; doctor reports all Windows states. Merge after card 1.
   AP-194 may land before it; consume its argv contract rather than changing it.
   AP-195 must land before declaring the retained per-VM file posture complete.
3. **Posture documentation and release guard — S.** Apply the bullets above
   and add a release check that the Windows CLI and desktop both contain the
   matching helper. Acceptance: no doc promises `0600` as Windows protection or
   calls Windows keychain checks not-applicable. Merge after card 2.

## Owner gates and decisions

1. **DECIDED (owner, 2026-08-29): Accept cleartext for opt-in per-VM captured
   secrets — yes, the proposed default.** Retain ACL files because capture is
   explicit and normal agent rules use a global helper with `capture:false`.
   **DECIDED: capture keeps macOS parity (opt-in, same default); doctor warns
   when enabled on Windows; AP-195 landed the Rust-side directory+file ACLs.**
2. **DECIDED (owner, 2026-08-29): Accept the post-scrub downgrade boundary —
   yes, the proposed default.** Preserve data on failed migration, but after
   verified import remove cleartext and require upgrade/re-login for old
   binaries rather than retaining a downgrade copy.
3. **DECIDED (owner, 2026-08-29): Treat same-user code execution and WSL interop
   as host compromise — yes, the proposed default.** Do not claim Credential
   Manager protects against either; addressing them requires a different trust
   boundary, not another store API.
