# Credentials & secrets lifecycle

How Appliance stores API credentials and per-environment secrets, how
they rotate, and the plan for consolidating today's dual storage into a
single source of truth.

## Stores today

There are three places credential material currently lives:

| Store                                                  | Writer                           | Holds                                               | Format            |
| ------------------------------------------------------ | -------------------------------- | --------------------------------------------------- | ----------------- |
| `~/.appliance/profiles.json`                           | CLI (primary) + desktop (mirror) | apiUrl, keyId, **secret**, metadata, per-profile    | JSON, mode `0600` |
| `~/.appliance/credentials.json`                        | CLI (legacy mirror)              | apiUrl, keyId, secret for the _active_ profile only | JSON, mode `0600` |
| macOS Keychain `sh.appliance.desktop` / `cluster:<id>` | Desktop (primary on macOS)       | keyId + **secret** per cluster                      | Keychain item     |
| `<app-config>/config.json`                             | Desktop (legacy mirror)          | cluster metadata (no secret)                        | JSON              |

Code references:

- CLI: [`packages/cli/src/utils/profile-store.ts`](../packages/cli/src/utils/profile-store.ts)
  (read/write/upsert/resolve), [`credentials.ts`](../packages/cli/src/utils/credentials.ts)
  (the `loadCredentials`/`saveCredentials` shim).
- Desktop: [`packages/desktop/src-tauri/src/lib.rs`](../packages/desktop/src-tauri/src/lib.rs)
  — see the `Shared profile store` block and `mirror_to_shared_profiles`,
  `ingest_shared_into_legacy`, `sync_microvm_cluster`.

### Who is authoritative for what

The two surfaces deliberately do **not** fight over the same entries:

- **CLI-managed profiles** (`managed: "cli"`, e.g. the `local` profile
  written by `appliance vm up` for the default VM): `profiles.json` is
  authoritative. The
  desktop only ever _reads_ these — `mirror_to_shared_profiles` skips any
  entry whose `managed != "desktop"`, and `sync_microvm_cluster` copies
  the CLI's `keyId`/`secret` _into_ the Keychain, never the other way.
- **Desktop-managed clusters** (`managed: "desktop"`): the Keychain is
  authoritative for the secret; `profiles.json` is a mirror written on
  every persisted config change so the CLI can read the same set.

This split is what makes `appliance keys rotate` work across both
surfaces without a server round-trip from the desktop (below).

## API key rotation — `appliance keys rotate`

Implemented end-to-end:

1. **Server** ([`packages/api-server/src/routes/keys/index.ts`](../packages/api-server/src/routes/keys/index.ts),
   [`api-key.service.ts`](../packages/api-server/src/services/api-key.service.ts)):
   `POST /api/v1/keys/rotate`, authenticated by the same RFC 9421
   signature middleware as every data-plane route. It rotates **the
   calling key only** — there is no `keyId` in the path, so a stolen key
   can rotate itself but cannot enumerate or revoke other keys. The
   service mints a replacement (inheriting the old key's name) and then
   revokes the old key. Mint-then-revoke ordering means a crash mid-
   rotation leaves _both_ keys valid (re-runnable) rather than locking
   the operator out with neither.
2. **SDK** ([`appliance-client.ts`](../packages/sdk/src/client/appliance-client.ts)):
   `client.rotateKey()` returns the new `{ id, secret }`.
3. **CLI** ([`packages/cli/src/appliance-keys.ts`](../packages/cli/src/appliance-keys.ts)):
   `appliance keys rotate [--profile <name>]` calls `rotateKey()`,
   **verifies the new key authenticates**, then atomically swaps only
   the `keyId`/`secret` of the resolved profile via `upsertProfile`
   (preserving apiUrl, managed, createdAt, stateBackendUrl,
   lastBootstrapInput). No secret is ever printed.

### Desktop hand-off (no action required)

The rotated key reaches the desktop Keychain automatically via the
existing sync:

- `appliance keys rotate` changes the profile's `keyId` in
  `profiles.json`.
- `sync_microvm_cluster` (runs on every desktop status poll) compares
  the shared entry's `keyId` against the `synced_key_id` it last copied
  into the Keychain. A rotation makes them differ, so the next poll
  writes the new key into `sh.appliance.desktop` / `cluster:<id>` and
  records the new `synced_key_id`.
- Freshness is judged by file comparison, **not** a Keychain read, so
  the poll never triggers a macOS access prompt.

### api-server requirement

`POST /api/v1/keys/rotate` is **new** in this change. An api-server that
predates it returns 404; the CLI surfaces an explicit "upgrade the
api-server and retry" message and leaves the old key untouched. Rotation
against older clusters requires re-bootstrapping (the only prior mint
path was `/bootstrap/create-key`, gated by the one-time
`BOOTSTRAP_TOKEN`).

## Per-environment secrets — `appliance env set/list/unset`

Stored server-side on the environment and injected into **every** deploy
of that environment, so a value set once persists across machines, CI,
and the desktop — unlike `appliance deploy --env-file`, which applies
only to the single deploy that passed it.

- **Server**: [`env-var.service.ts`](../packages/api-server/src/services/env-var.service.ts)
  stores a per-environment variable map (collection `env-vars`, keyed by
  environment id). Routes hang off the environment router
  ([`routes/environments/index.ts`](../packages/api-server/src/routes/environments/index.ts)):
  `GET/PUT /…/environments/:id/env` and `DELETE /…/:id/env/:key`.
  Variables are cleared when the environment is deleted.
- **Injection**: [`deployment.service.ts`](../packages/api-server/src/services/deployment.service.ts)
  merges stored variables into the deploy's `environment` map before
  dispatch, **only** for `deploy` actions. Per-deploy values (manifest /
  `--env-file`, carried in `input.environment`) win over stored ones:
  stored is the persistent baseline, the per-deploy map is the local
  override.
- **Write-only over the API**: `list` returns key **names** only; values
  are never read back, and the CLI never echoes a value. `appliance env
set <p> <e> <key>` prompts for the value with hidden input when it's
  omitted, keeping the secret out of shell history.
- **SDK**: `listEnvVars` / `setEnvVars` / `unsetEnvVar`.

> Note: stored values are persisted in the api-server's object store in
> the clear (same as the api-key secrets it already holds). Encrypting
> them at rest with a cluster KMS key is a sensible follow-up but is out
> of scope for this slice.

## Single source of truth — consolidation plan (design)

### Problem

Today a secret can live in up to three files plus the Keychain. The
split-ownership rules above keep them _consistent in practice_, but the
invariant is enforced by careful code on both sides rather than by the
data model. A new surface (a second desktop, a headless agent) has to
re-learn the rules.

### Target

**`~/.appliance/profiles.json` is the single canonical store of record**
for every credential, on every platform. The OS Keychain becomes a
_derived cache_ of the active profile's secret, not an independent
source.

Rationale: profiles.json is the only store both surfaces already read
and write, it is cross-platform, and it already carries the richest
metadata (multi-profile, apiUrl, managed, bootstrap input). The Keychain
remains valuable as a hardened secret cache on macOS but stops being a
second source of truth.

### Sync direction (one way)

```
                 (authoritative)
            ~/.appliance/profiles.json
                /                \
      (derived cache)        (derived mirror)
   macOS Keychain            <app-config>/config.json
   cluster:<id>              credentials.json (legacy CLI)
```

- All writes go to `profiles.json` first (atomic temp-file rename, mode
  `0600`), then fan out to the derived stores.
- The Keychain is written from `profiles.json`, never read back as a
  source. It is read only to _serve_ a secret to a desktop API call.
- `synced_key_id` (already on the desktop `Cluster` record) generalises
  from "microVM only" to every cluster: it records which profiles.json
  `keyId` the Keychain copy was derived from, so the desktop can detect
  any external re-key (CLI rotate, another device) by file comparison
  without a Keychain prompt.

### Migration

Non-destructive, staged — every step leaves an older binary working:

1. **Current behavior:** profiles.json is already the CLI's primary and
   the desktop's mirror; CLI-managed entries are already one-way
   (CLI → Keychain). `appliance keys rotate` proves the
   profiles.json → Keychain path end-to-end.
2. **Step 2 — desktop adopts one-way for _all_ clusters:** extend
   `sync_*` so desktop-managed clusters are also reconciled
   profiles.json → Keychain via `synced_key_id`, the same way microVM
   clusters are. `mirror_to_shared_profiles` becomes the _only_ writer
   of desktop entries into profiles.json (it already is), and the
   Keychain write moves entirely behind the `synced_key_id` check.
3. **Step 3 — collapse the legacy mirrors:** once both surfaces have
   shipped reading profiles.json first, stop writing
   `credentials.json` and `<app-config>/config.json` on new installs;
   keep _reading_ them for one more release for downgrade safety, then
   drop the read.
4. **Step 4 — Keychain as pure cache:** delete the ingest-from-Keychain
   fallback paths; a missing/blank Keychain item is repopulated from
   profiles.json on next sync rather than treated as a possible source.

### Risks / open questions

- **Keychain-only secrets on legacy desktops:** a desktop install that
  predates profiles.json mirroring could hold a secret _only_ in the
  Keychain. Step 2 must seed profiles.json from the Keychain **once**
  (guarded so it runs only when profiles.json lacks the entry) before
  flipping the direction one-way, or those credentials are stranded.
- **Concurrent writers:** the desktop already serialises config writes
  with `config_lock()`; the CLI writes atomically but has no
  cross-process lock with the desktop. A profiles.json file-lock (e.g.
  `flock`) is worth adding before Step 3 so a CLI rotate and a desktop
  sync can't interleave a read-modify-write.
- **At-rest encryption:** profiles.json stores secrets in cleartext
  (`0600`). Consolidating _more_ secrets there (env vars are server-side,
  but credential secrets are local) raises the value of encrypting the
  file with an OS-bound key. Out of scope here; flagged for the security
  review that should gate Step 4.
- **Non-macOS:** the Keychain path is macOS-only; Linux/Windows desktops
  already rely on profiles.json alone, so they reach the target state at
  Step 1. The plan must not regress them when the macOS Keychain logic
  changes.
