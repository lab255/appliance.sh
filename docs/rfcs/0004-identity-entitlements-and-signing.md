# RFC 0004: Identity, entitlements, and Ed25519 signing

- Status: Proposed
- Date: 2026-08-27
- Claim: `ap-p0-identity-9a7f62`
- Security reviewer: Sasha
- Decision owners: Appliance owners
- Depends on: RFC 0001 bundle manifest, publisher block, and signature envelope

## Summary

Appliance Runtime is local-first. An account is optional, and installing or running a free app never requires one. Signing in later may sync local grant history to `account.appliance.sh` in P4, but account availability is never in the local open path.

Distribution trust uses Ed25519 and three distinct key roles:

1. an offline Appliance root key delegates bounded authority;
2. a delegated key in GitHub secrets signs the catalogue index, blacklist, and first-party bundles in CI; and
3. publisher keys sign third-party bundles.

The root public key and the currently shipped delegated public key are pinned in both CLI and desktop releases. Root-signed delegation and revocation documents authorize rotation without turning the online delegated key into a root. Private keys are never committed, printed, logged, embedded in examples, or handled by coding agents.

The free catalogue lives at `/catalogue/index.json` with a detached signature. Clients verify it before rendering any entry and omit every `paid: true` entry in v1. A static signed blacklist at `/catalogue/blacklist.json` blocks a matching app id, bundle digest, or publisher key before open by default.

Locally built bundles need no signature. Unsigned bundles, bundles whose signer is unknown, and bundles whose prior trust can no longer be established are untrusted rather than invalid. They may run after an **Unknown Publisher** warning on first open and again at least every 30 days. Remembering the decision is bounded to the exact bundle digest and expires; it is never a permanent silent trust grant.

Every install writes a local per-app entitlement record to `~/.appliance/entitlements.json`, mode `0600`. The record includes the manifest's SPDX license and every approved control. An upgrade prompts only for additional controls. Runtime records last use per granted mount and egress host and suggests revocation after 30 unused days by default. Uninstall marks the record historical rather than deleting it.

A device Ed25519 key signs entitlement snapshots. It is generated on first Runtime use and stored through the keychain utility; only its public key and fingerprint appear in the entitlement file or sync. This signature detects accidental or external file modification and gives P4 account sync a stable device attestation. It does not prove that the human approved a grant and does not protect against malware running as the same OS user with keychain access.

This RFC defines identity, trust, and entitlement semantics. RFC 0001 owns the exact `publisher` block and signature-envelope wire shape. The manifest inside a bundle is named `appliance.json`. Credential injection: deferred (owner, 2026-08-27). The existing host credential broker is unchanged and out of scope.

Normative words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** have their RFC 2119 meanings. Times are UTC RFC 3339 strings. Digests are lowercase `sha256:<hex>` values over the bytes defined by RFC 0001. Key ids are fingerprints derived from public keys, never user-chosen labels.

## Trust model

### Identity domains are separate

Appliance has three identity domains and MUST NOT reuse a key across them:

| Domain                 | Credential                                  | Meaning                                                |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------ |
| Distribution           | Ed25519 root, delegated, and publisher keys | Authenticates static metadata and bundle bytes         |
| Device                 | Per-device Ed25519 key                      | Attests the local entitlement snapshot and sync record |
| Existing control plane | HMAC API key and HTTP Message Signatures    | Authenticates requests to an Appliance API server      |

The existing `profiles.json`, legacy `credentials.json`, API-key roles, invitations, and `packages/api-server/src/middleware/auth.ts` HMAC verification do not establish publisher identity. A valid cluster API key MUST NOT sign a bundle or entitlement record. A valid bundle signature MUST NOT authenticate an API request or account.

An Appliance account is also not a local authorization boundary. Signing out MUST NOT remove installed apps or local grants. Signing in MUST NOT widen a local grant. Free installs MUST NOT display an account gate.

### Chain of authority

The trust chain is:

```text
offline Appliance root public key (shipped pin)
  └─ root-signed delegation statement
       ├─ delegated catalogue key -> index and blacklist
       ├─ delegated first-party role -> first-party bundle
       └─ index entry -> publisher key + exact bundle digest
                            └─ publisher signature -> third-party bundle
```

The root key is the only authority that may create or revoke a delegation. It remains offline and is used only during an owner-run ceremony. The delegated private key is online only as an encrypted GitHub Actions secret. CI receives scopes, not root authority.

Publisher identity is a public key plus claims authenticated by a verified index entry. The display name in `appliance.json` is untrusted text until it is matched to that entry. Changing a publisher key creates a new cryptographic identity even if the display name is unchanged.

Transport security is defense in depth. TLS protects availability and privacy, but CDN, DNS, Worker, R2, mirror, and local proxy responses remain untrusted until cryptographic verification.

### Delegation format

Delegations are published as `/catalogue/delegations.json` and `/catalogue/delegations.json.sig`. The JSON is canonicalized using the same canonical JSON rule chosen by RFC 0001. The detached envelope is RFC 0001's envelope with role `appliance-root`.

The signed payload has these semantics:

```json
{
  "schema": "appliance.catalogue-delegations/v1",
  "generation": 12,
  "issuedAt": "2026-08-27T00:00:00Z",
  "expiresAt": "2027-02-27T00:00:00Z",
  "delegations": [
    {
      "keyId": "ed25519:example-delegated-key-fingerprint",
      "publicKey": "ed25519:EXAMPLE_PUBLIC_KEY_NOT_KEY_MATERIAL",
      "scopes": ["catalogue-index", "catalogue-blacklist", "first-party-bundle"],
      "notBefore": "2026-08-27T00:00:00Z",
      "notAfter": "2026-11-27T00:00:00Z"
    }
  ]
}
```

All key strings above are nonfunctional placeholders. `generation` MUST increase for every root-signed change. Clients MUST reject a lower generation than the highest previously verified generation on that device. Clients MUST reject an unknown schema, invalid root signature, expired document, key outside its validity window, or use outside listed scopes.

The binary pinset contains the root public key and the delegated public key current at release time. A root-verified newer delegation MAY add an authenticated delegated pin to the local trust cache. A pinned delegated key without a currently valid root delegation MUST NOT sign new metadata merely because an old binary contains it.

### Delegated-key revocation

Emergency revocations are published as `/catalogue/revocations.json` and a detached root signature. The payload contains a monotonic `generation`, `issuedAt`, and entries with `keyId`, `effectiveAt`, `reason`, and optional `replacementKeyId`.

Clients MUST process a valid newer root revocation before accepting newly downloaded index or blacklist metadata. A revoked delegated key is invalid for all catalogue metadata immediately, regardless of a signer-controlled timestamp. Previously installed first-party bundles signed only by that key lose first-party status and enter Unknown Publisher handling unless a replacement verified index binds their exact digest to a trusted publisher key. A blacklist match remains a separate block decision.

Revocation is not instantaneous for offline clients. An offline client that has not obtained the root revocation can continue to trust its last verified state. This is an explicit residual risk, not something signatures solve.

### Verification tiers

The Runtime derives one tier for an exact bundle digest:

| Tier             | Required evidence                                                                      | User-facing label         |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------------- |
| First-party      | Valid delegated `first-party-bundle` signature and exact verified index binding        | `Appliance · First-party` |
| Verified account | Valid publisher signature, exact index binding, and valid `notarization` attestation   | `Verified publisher`      |
| Known publisher  | Valid publisher signature and exact verified index binding                             | Publisher display name    |
| Unknown          | Unsigned, signer absent/invalid, key not bound, evidence unavailable, or trust revoked | `Unknown Publisher`       |

The verified-account tier is a future hook only. RFC 0001's envelope and index entry MAY carry a nullable `notarization` field with `{tier, attestationId, issuedAt}` semantics. V1 MUST treat the field as informational and MUST NOT claim it was verified. No notarization service, account verification workflow, or build is included.

An invalid signature does not become valid because the app is local. It is reported as a failed signature and placed in Unknown Publisher handling. The UI MUST distinguish `Unsigned` from `Signature could not be verified`.

Trust tier is not permission. First-party apps receive no implicit egress, mount, port, or other control. Every tier uses the same entitlement prompt and deny-by-default runtime policy.

## Bundle, index, and blacklist verification flows

### Catalogue refresh and render

The desktop and CLI use this sequence:

1. Load the highest verified delegation and root revocation generations.
2. If online, fetch newer root-signed delegation and revocation documents.
3. Fetch `/catalogue/index.json` and its detached signature as a pair.
4. Verify canonical bytes, signer scope, key validity, signature, schema, `generation`, `issuedAt`, and `expiresAt`.
5. Reject a generation lower than the device's highest accepted generation.
6. Atomically replace the cached index only after all checks succeed.
7. Filter out `paid: true` before data reaches search, categories, counts, accessibility trees, telemetry, or deep-link results.
8. Render the entries and the quiet `Verified index ✓ signed` state with the verified time.

The client attempts refresh on catalogue open when the verified cache is older than six hours and at most every six hours while desktop remains running. Manual refresh bypasses that timer but not signature verification.

If download or verification fails, the client MUST retain the prior verified cache and display its verification time plus the refresh error. A verified cache MAY render offline until its signed `expiresAt`. An expired cache MAY render only in an explicitly labelled offline/stale view; it MUST NOT be represented as current and MUST NOT enable a new network install. No verified cache means no catalogue entries render.

An exact already-downloaded bundle MAY be installed offline when its digest and publisher evidence match a still-retained verified index entry. The entitlement prompt remains required.

### Catalogue install

For a catalogue install:

1. Select an entry from a verified, free-only view.
2. Fetch the URL without trusting URL, ETag, filename, MIME type, or CDN headers.
3. Stream to a temporary file while computing SHA-256.
4. Compare the exact digest with the verified index entry.
5. Read `appliance.json` and the RFC 0001 envelope without executing payload.
6. Require manifest `appId`, version, license, and publisher claim to match the verified entry.
7. Verify the bundle signature using the exact publisher key bound by the entry, or the valid delegated key for a first-party bundle.
8. Refresh and evaluate the blacklist as described below.
9. Compute requested controls from `appliance.json` and existing grants.
10. Show license and any new-control prompt before atomic installation.
11. Write the device-signed entitlement snapshot only after user approval.

A mismatch at steps 4 or 6 is tampering and MUST stop installation. A cryptographically invalid expected signature MUST stop catalogue installation; the user may instead import the bytes as a separate local/unknown bundle, where the source change is explicit and the Unknown Publisher contract applies.

### Local bundle install or run

Local paths do not require an index entry or signature. The Runtime still computes and records the digest before extracting or running. It parses `appliance.json`, validates its schema, checks archive path safety, evaluates the blacklist when enabled, and computes entitlement deltas.

If the signature is valid and maps to cached verified evidence, the corresponding tier is shown. Otherwise the bundle is Unknown Publisher. `--trust-publisher` MUST NOT create permanent global trust in v1. Trust acknowledgement is digest-bound and time-bounded through the UX contract.

### Pre-open integrity and blacklist check

Every open recomputes or retrieves an authenticated digest of installed bytes, checks it against the installed record, and re-verifies available signature evidence before payload execution. Local storage changes after install therefore cannot silently retain the old publisher label.

Blacklist metadata lives at `/catalogue/blacklist.json` with detached signature. It is signed by a delegation carrying `catalogue-blacklist` scope. Its payload includes schema, monotonic generation, `issuedAt`, `expiresAt`, and entries with a selector and human-safe reason code:

```json
{
  "schema": "appliance.blacklist/v1",
  "generation": 7,
  "issuedAt": "2026-08-27T00:00:00Z",
  "expiresAt": "2026-09-03T00:00:00Z",
  "entries": [
    { "digest": "sha256:example-only", "reason": "malware" },
    { "appId": "example.bad-app", "reason": "compromised" },
    { "publisherKeyId": "ed25519:example-only", "reason": "key-compromise" }
  ]
}
```

Selectors are ORed; a match on any selector blocks. An app-id selector covers all versions unless an optional version range narrows it. The reason shown to users is local fixed copy selected by reason code, not untrusted HTML from the file.

The client refreshes the blacklist before open if its verified cache is older than six hours, and in the background every six hours while running. A confirmed match fails closed: the app does not open and the UI identifies the matched selector, verification time, and recovery path.

If refresh fails, the last verified unexpired blacklist is evaluated. If it is expired or no verified blacklist exists, open fails **open** after a prominent `Safety list unavailable` warning that names the last successful check. The warning offers Retry, Cancel, and Open anyway. Choosing Open anyway applies only to that open attempt. This availability choice leaves an honest window for newly blacklisted malware.

### Disable-check setting

Default: `Check known unsafe apps before opening` is on. Turning it off requires an OS-user confirmation dialog and records the setting change time locally. It disables blacklist refresh and blacklist enforcement, including confirmed matches, until re-enabled.

NOTE: the owner brief says the user may disable "the check"; this RFC interprets that as the blacklist check only. Digest integrity and signature classification always run and cannot be disabled. This is Open for owner with that interpretation as the default.

When blacklist checking is disabled, every app window and open confirmation shows `Unsafe-app checking is off` with a direct re-enable action. Disabling it does not mark a publisher known, suppress Unknown Publisher, extend an acknowledgement, or grant any runtime control.

## Unknown Publisher UX contract

Unknown Publisher is a risk disclosure, not a claim that the app is malicious. It is required for unsigned apps, unverified or unknown signers, invalid signatures, revoked signing trust, and unavailable publisher evidence.

Before first open of each exact digest, the Runtime blocks launch on a modal containing:

- app id, version, source, SPDX license, and shortened SHA-256 digest;
- status: unsigned, invalid signature, unknown key, revoked key, or offline evidence unavailable;
- plain language that publisher identity and code origin are unverified;
- requested/granted controls, separately from publisher trust;
- Cancel, Open once, and `Open and remember for 30 days` actions.

There is no preselected accept action. Keyboard focus begins on Cancel. Automation and headless CLI require an explicit flag for that invocation and MUST NOT synthesize a remembered acknowledgement.

`Open once` authorizes one launch attempt and writes no acknowledgement. `Open and remember for 30 days` records `acknowledgedAt`, `expiresAt`, digest, signer key id if present, and reason category in the local entitlement history. It does not create a trusted publisher or authorize a different digest.

The warning returns at the earliest of:

- acknowledgement expiry, 30 days after acknowledgement;
- bundle digest, app id, signer, or signature status changing;
- upgrade or reinstall, even when the version string is unchanged;
- a newly verified key revocation; or
- the app requesting an additional entitlement.

The last condition may share one transaction with the delta prompt, but the UI must keep publisher risk and control approval visually distinct. Repeated opens in the same day after Cancel MAY be rate-limited, but no launch may proceed from a cancelled warning.

Desktop Settings lists remembered unknown bundles with expiry and `Forget now`. The CLI lists them in verbose entitlement output. No `Always trust`, wildcard publisher trust, or silent permanent dismissal exists in v1.

The warning still appears on this cadence when blacklist checking is disabled. The dialog adds the separate unsafe-app-checking-off status, so accepting one risk never implies acceptance of the other.

## Entitlement record and grant lifecycle

### Store and signed record

`~/.appliance/entitlements.json` is a versioned document containing records:

```json
{
  "schema": "appliance.entitlements/v1",
  "records": [
    {
      "appId": "sh.appliance.example",
      "version": "1.2.0",
      "license": "MIT",
      "grantedAt": "2026-08-27T08:00:00Z",
      "installerId": "desktop:example-installation-id",
      "grants": [
        {
          "id": "egress:api.example.test",
          "control": "egress-host",
          "value": "api.example.test",
          "approvedAt": "2026-08-27T08:00:00Z"
        },
        {
          "id": "mount:data",
          "control": "mount",
          "value": { "name": "data", "access": "read-write" },
          "approvedAt": "2026-08-27T08:00:00Z"
        }
      ],
      "usage": {
        "egress:api.example.test": {
          "lastUsedAt": "2026-08-27T09:12:00Z",
          "useCount": 3
        },
        "mount:data": {
          "lastUsedAt": "2026-08-27T09:10:00Z",
          "useCount": 1
        }
      },
      "signature": {
        "algorithm": "Ed25519",
        "deviceKeyId": "ed25519:example-device-fingerprint",
        "value": "EXAMPLE_SIGNATURE_NOT_KEY_MATERIAL"
      }
    }
  ]
}
```

The required record fields are `appId`, `version`, manifest SPDX `license`, `grantedAt`, `installerId`, `grants`, `usage`, and the device signature. Implementation MAY add lifecycle metadata without changing these semantics. The signature covers the canonical record excluding `signature` and includes the store schema domain separator to prevent cross-protocol use.

The file and parent directory MUST be owner-only (`0600` and `0700` on Unix, equivalent ACL on Windows). Writes use a cross-process lock and atomic temporary-file rename. On a corrupt or invalidly signed record, the Runtime preserves the bytes for recovery, denies controls not independently recoverable, and asks the user to review rather than silently recreating broad grants.

`installerId` identifies the local CLI or desktop installation event, not an account and not a publisher. It is random public metadata and MUST NOT contain a username, hostname, API key, or machine serial number.

Host-path mount selections are local-only sensitive values. If implementation needs the chosen path, it stores it in local grant detail but redacts it from display logs and account sync. The example deliberately contains only a named mount slot.

### Install

Install derives requested controls only from the validated `appliance.json` contract owned by sibling RFCs. Absent control is denied. The prompt groups each concrete control, shows purpose text as untrusted publisher-supplied copy, and permits item-by-item rejection where the Runtime can still operate.

Accepting the SPDX license records the license identifier and manifest version; it is not a server-side purchase receipt. Free installs still create the local grant record. No account, email, API key, or network connection is required.

The Runtime installs only after the record and app registration can be committed atomically or recovered as a transaction. A crash MUST NOT leave runnable app bytes with undocumented broad grants.

### Upgrade delta

Grants are per app id, not blanket publisher grants and not automatically per version. For upgrade, canonical stable grant ids compare requested controls with active approved controls.

The prompt contains only additions or widenings:

- a new egress host;
- a broader egress host pattern;
- a new mount slot or increased mount access;
- a new exposed port or other separately grantable runtime control; or
- a control whose meaning changed incompatibly.

Unchanged grants remain active without another prompt. Removed requests do not stay active merely because an older version had them: they become inactive history, while their audit entries remain. A later reintroduction is a new delta and requires approval.

A widening MUST NOT be disguised as a rename. Unknown or ambiguous comparisons are treated as new controls. Rejecting a required delta aborts the upgrade and leaves the old version and grants intact; optional controls may be denied if the manifest contract supports degraded operation.

Downgrades are never automatic. An explicit downgrade shows old and target versions, retained grants, requested differences, and warning that older code may contain fixed vulnerabilities. A lower version cannot revive an inactive historical grant without approval.

### Usage tracking

Runtime enforcement points update usage only after a granted item is actually used. For egress, successful policy authorization of a connection updates the exact host grant. For mounts, successful attachment or first access per session updates the named mount grant; implementations SHOULD prefer first actual access when observable.

Credential usage is not tracked because credential injection is deferred. The existing host credential broker is outside this model.

`lastUsedAt` is the security-relevant signal. `useCount` is optional coarse local context and MUST be saturating. Updates SHOULD be coalesced and flushed at most daily to limit disk writes and keychain signing operations, while preserving the most recent observed time. Clock rollback MUST NOT move `lastUsedAt` backwards.

Usage metadata stays local by default. P4 sync includes only last-used time when the user enables entitlement sync. It never includes request contents, URLs beyond the granted host, filenames, mount paths, bytes, or app data.

### Suggested revocation

The default unused threshold is 30 days. A grant is suggested when it is active and:

- `lastUsedAt` is older than the threshold; or
- it has never been used and `approvedAt` is older than the threshold.

Suggestions are derived state, not signed authority. They are maintained as a `suggested-revocation` view so a stale UI cache cannot itself revoke access. Desktop Settings and `appliance runtime entitlements --suggest-revoke` show app, control, last use, and reason.

The user may revoke one item, all suggestions for an app, snooze for 30 days, or keep it. No suggestion auto-revokes. Revocation takes effect before the next connection, mount, or launch that needs the item and writes a new device-signed snapshot. If the app still requests it later, approval is required again.

The threshold is configurable in whole days, minimum 1. Changing it alters suggestions only and never grants or revokes a control.

### Uninstall and reinstall

Uninstall marks the entitlement record `uninstalled` with time and makes every grant inactive. It keeps license, grant, usage, acknowledgement, and signature history. Uninstall does not silently delete the device key or account-sync history.

Reinstall computes a new prompt from no active grants by default while showing the prior history for convenience. It MUST NOT silently reactivate old controls. An explicit `Restore previous grants` action MAY select matching controls, but the user confirms the resulting list before install.

History deletion is a separate destructive privacy action in Settings and CLI. If P4 sync has occurred, local deletion explains that remote deletion is a separate operation whose service semantics are not defined here.

## Device key

On first Runtime use, CLI or desktop asks the shared keychain utility to create one non-exportable-where-supported Ed25519 device key. The private key is stored through `packages/cli/src/utils/keychain.ts` under a device-specific service/account namespace separate from cluster API keys. Callers request `sign(bytes)` and never receive or log private key bytes.

The current utility is macOS/API-key-specific. Implementation therefore requires extending its abstraction for device signing and equivalent OS-protected storage on supported platforms. This RFC does not change the existing API-key keychain entries or credential broker.

The public key fingerprint is `deviceKeyId`. It is pseudonymous and not an account id. Desktop and CLI on the same OS user profile MUST resolve the same device key. VM guests and apps MUST never access it.

If the keychain is locked or signing fails, usage events may queue in memory, but new grants, revocations, imports, and sync MUST stop with a recoverable error. The Runtime MUST NOT create an unsigned entitlement mutation.

Key loss makes old records unverifiable by a replacement device key. Recovery preserves old snapshots as `key-lost` history, generates a new key only after explicit user confirmation, and requires review before reactivating grants. There is no root or account escrow of device private keys.

The device signature protects integrity against ordinary file edits and supports deduplication during sync. It does not provide trusted time, user presence, hardware attestation, or defense against same-user malware that can invoke keychain signing.

## Account sync record

Account sync is P4 shape only; this RFC specifies no endpoint, database, auth flow, conflict UI, or service implementation. It is opt-in after sign-in and never required for free install or open.

Each upload is a device-signed, privacy-reduced record:

```json
{
  "schema": "appliance.entitlement-sync/v1",
  "recordId": "example-stable-random-id",
  "deviceKeyId": "ed25519:example-device-fingerprint",
  "devicePublicKey": "ed25519:EXAMPLE_PUBLIC_KEY_NOT_KEY_MATERIAL",
  "sequence": 18,
  "appId": "sh.appliance.example",
  "version": "1.2.0",
  "license": "MIT",
  "state": "installed",
  "grantedAt": "2026-08-27T08:00:00Z",
  "updatedAt": "2026-08-27T09:12:00Z",
  "grants": [
    {
      "id": "egress:api.example.test",
      "control": "egress-host",
      "value": "api.example.test",
      "lastUsedAt": "2026-08-27T09:12:00Z"
    },
    {
      "id": "mount:data",
      "control": "mount",
      "value": { "name": "data", "access": "read-write" },
      "lastUsedAt": "2026-08-27T09:10:00Z"
    }
  ],
  "signature": "EXAMPLE_SIGNATURE_NOT_KEY_MATERIAL"
}
```

`recordId` is stable for one local app-install lineage. `sequence` strictly increases per record and makes same-device replay detectable. The signature covers all fields except `signature` with a sync-specific domain separator.

The sync record MUST NOT contain device private keys, account tokens, API keys, hostnames, usernames, machine serials, absolute mount paths, request contents, app data, environment values, or credentials. Mount values are reduced to publisher-declared slot and access level.

Account sync is backup/history, not remote authorization. Downloaded records do not activate grants automatically on another device. Restore presents them as requested controls and requires a fresh local approval signed by that device.

Conflicting devices retain separate device-signed histories. The future service MUST reject a lower or repeated sequence for the same `recordId` and device key, but it MUST NOT merge grants by taking the union. Uninstall syncs `state: uninstalled`; it is not a deletion tombstone.

## Threat model

### Assets and boundaries

Protected assets are catalogue authenticity, bundle identity and bytes, unsafe app blocks, least-privilege grants, local grant history, and device private key. The Runtime treats app code, bundle metadata text, network transport, CDN/storage, and unsigned local files as attacker-controlled.

The host process and OS user account are trusted to enforce local policy. The microVM is a containment boundary for app code, not a source of identity. Root ceremony operators and release owners are trusted. GitHub Actions and repository administrators can exercise the delegated key's scopes while that key is available to CI.

This RFC does not claim protection after full same-user host compromise, root account compromise, malicious signed runtime updates, or offline root-key theft.

### Threats, mitigations, and residual risk

| Threat                          | Mitigation                                                                                                      | Honest residual                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Tampered index                  | Detached Ed25519 signature, scoped delegation, canonical bytes, generation rollback check, verify before render | Compromised delegated key or root can sign a malicious index; offline clients miss revocation                          |
| Tampered bundle                 | SHA-256 match to verified index plus RFC 0001 signature before extraction/open                                  | Unknown local bundles remain user-runnable; a malicious authorized publisher can sign malware                          |
| Tampered blacklist              | Scoped signature, monotonic generation, atomic verified cache                                                   | Compromised delegated key can publish or suppress entries until root revocation reaches clients                        |
| Missing/stale blacklist         | Six-hour refresh, visible age, fail-open warning, manual retry                                                  | User may open newly known malware while offline or may disable enforcement entirely                                    |
| Replay of old metadata          | Monotonic generations, signed expiry, highest-seen state                                                        | Clearing local state or rolling back the whole device can restore old metadata; wall-clock rollback weakens expiry     |
| Revoked delegated key           | Root-signed revocation, scope checks, loss of first-party tier, rotation runbook                                | Offline revocation delay; previously maliciously signed app may already have run                                       |
| Stolen publisher key            | Blacklist by key/app/digest, index key rotation, Unknown tier after removal                                     | No universal revocation channel for a never-online local user; signed malware looked known before response             |
| Stolen device key               | OS keychain, non-exportable use where supported, separate namespace, no sync secret                             | Same-user malware may request signatures; device signatures do not prove human presence                                |
| Edited entitlement file         | Device signature, owner-only permissions, atomic locked writes, fail-safe review                                | Malware with keychain signing access can forge coherent records; file deletion causes denial/recovery, not restoration |
| Malicious upgrade asks for more | Delta-only prompt, stable grant ids, ambiguous changes treated as new                                           | Users can approve dangerous deltas; purpose labels come from publisher and may deceive                                 |
| Downgrade to vulnerable code    | No automatic downgrade, explicit version warning, blacklist version selectors, no grant revival                 | User can explicitly downgrade while offline; vulnerability knowledge may not yet be in blacklist                       |
| App impersonates publisher name | Trust label comes from verified key/index binding, not manifest text                                            | Similar Unicode names/icons can still socially engineer; UI must show tier and digest details                          |
| Paid entry leakage in v1        | Filter after verification and before all render/search/telemetry surfaces                                       | Direct local bundle import remains possible and is intentionally outside catalogue commercial policy                   |
| Account takeover                | Local opens and grants do not depend on account; remote record cannot activate grants                           | Synced history and app list are privacy-sensitive and exposed to the compromised account                               |
| Signature algorithm confusion   | RFC 0001 envelope, explicit Ed25519 algorithm, role/domain separation                                           | Bugs in canonicalization or crypto library use remain implementation risks requiring test vectors and review           |

### Specific attack walkthroughs

**Tampered index:** an attacker changes an app URL, digest, `paid` flag, license, or publisher key at the CDN. Signature verification fails and the new bytes never replace the verified cache. The UI shows the old cache and refresh failure, or no entries if none exists.

**Tampered bundle:** an attacker swaps payload bytes while retaining metadata. The streamed digest differs from the signed index and installation stops before extraction. For a local import with no verified index, the changed digest invalidates any remembered Unknown Publisher acknowledgement and triggers the warning again.

**Tampered blacklist:** an attacker removes a digest or adds a target. Without the delegated signature it is ignored. With a stolen delegated key the attacker can sign the change; root revocation is the recovery mechanism, but clients that are offline remain exposed.

**Replay:** an attacker serves a formerly valid index or empty blacklist. Highest-seen generation rejects it on an intact device and signed expiry limits use. Deleting or rolling back both cache and highest-seen state defeats this defense; hardware monotonic storage is not required in v1.

**Revoked delegated key:** after clients receive the root revocation, new metadata from the key is rejected regardless of embedded signing time. Previously installed direct signatures lose first-party presentation. The blacklist determines whether opening is blocked; otherwise Unknown Publisher handling permits an informed open.

**Stolen device key:** an attacker who can invoke the device signing key and edit the entitlement file can forge grant history. The model reduces exposure through OS storage and file permissions but cannot distinguish that attacker from the legitimate same-user Runtime. Device signatures are therefore audit integrity, not non-repudiation.

**Downgrade:** an attacker tries to replace a fixed app with an older signed build. Installed-version comparison prevents silent replacement, and a known blacklist can block it. An explicit user downgrade while offline remains allowed after warning because local-first operation does not claim an always-online vulnerability oracle.

## Key custody and rotation runbook

### Normal custody

- The owner keeps the root private key offline in owner-controlled hardware or encrypted removable storage with a separately stored recovery copy.
- The root public key fingerprint is reviewed out of band and pinned in CLI and desktop source/releases.
- The delegated private key exists only in the GitHub secret store and the ephemeral signing process that needs its scoped operation.
- CI logs include key id, artifact digest, workflow identity, and delegation generation, never private key or raw secret values.
- First-party bundle and catalogue signing jobs run only on protected release refs/environments with owner approval and least-privilege repository access.
- Publisher private keys are publisher responsibility and never uploaded merely to appear in the catalogue; the index stores public keys only.
- Coding agents may edit formats, fixtures with explicit placeholders, and public-key pins after owner provision, but never create, retrieve, transform, validate by exposure, or rotate real private keys.

### Planned delegated-key rotation

1. Owner creates the replacement key outside agent and ordinary developer environments; this RFC intentionally provides no key-generation command.
2. Owner records and independently verifies the replacement public key and id.
3. Owner signs a higher-generation delegation containing overlapping old and new keys, scopes, and a short transition window.
4. Publish delegation and detached root signature before using the new key.
5. Release clients pinning the new public key while older clients learn it from the root-signed document.
6. Owner installs the new private key in the protected GitHub environment using the secret UI; it never crosses an issue, chat, log, commit, or agent prompt.
7. CI signs index, blacklist, and a harmless release candidate with the new key; verification checks public artifacts and key ids only.
8. After the supported-client overlap, owner publishes a higher-generation delegation whose old `notAfter` has passed, then deletes the old CI secret.
9. Retain public audit metadata and signatures; do not retain exposed private material in build artifacts or logs.

### Emergency delegated-key revocation

1. Owner disables signing workflows and removes access to the suspected CI secret.
2. Owner audits published generations, bundle digests, workflow runs, and access logs without copying the private key.
3. Offline root ceremony signs a higher-generation revocation naming the exact delegated key id and effective time.
4. Owner creates a replacement delegation with minimum necessary scopes.
5. Publish revocation and delegation through at least the normal static origin; ship an application update containing the new public pins and revocation.
6. Publish blacklist entries for malicious app ids, digests, or publisher keys found during audit, signed by the replacement delegated key.
7. Re-sign clean index, blacklist, and first-party bundles as appropriate.
8. Communicate the offline exposure window and affected versions honestly.

Root-key compromise has no online automatic recovery. Owners must stop distribution, establish a new root through a separately audited software update and public incident process, and treat all old-chain metadata as suspect.

## CLI and desktop surfaces

### CLI

- `appliance runtime search`: only entries from a verified free-only index; shows signer, generation, and verified time in verbose output.
- `appliance runtime install <source>`: digest, trust tier, license, blacklist state, and entitlement prompt; no account gate for free apps.
- `appliance runtime run <bundle>`: local unsigned bundles allowed after Unknown Publisher and control prompts.
- `appliance runtime open <app>` and `appliance open <app>`: pre-open integrity, signature classification, blacklist evaluation, and warnings.
- `appliance runtime entitlements [app]`: active and historical per-app grants, last use, license, source tier, and acknowledgement expiry.
- `appliance runtime entitlements --suggest-revoke`: all active grants unused for the configured threshold, with item-level revoke actions.
- `appliance runtime entitlements <app> --revoke <grant-id>`: confirm and write a device-signed revocation snapshot.
- `appliance runtime trust status`: root/delegation/revocation/index/blacklist generations and ages without secret material.

CLI exit behavior:

- signature or digest tampering during catalogue install is nonzero and cannot be bypassed in place;
- confirmed blacklist match is nonzero while checking is enabled;
- unavailable blacklist requires interactive confirmation, or an explicit per-invocation flag in noninteractive use;
- Unknown Publisher requires an explicit per-invocation flag in noninteractive use and never writes a remembered acknowledgement from that flag.

### Desktop

- Catalogue shows `Verified index ✓ signed` and last verified time only after successful verification; paid entries never enter rendered state.
- App cards and windows show SPDX license and trust tier independently of `sandboxed` status.
- Install and upgrade dialogs show only requested controls and highlight the upgrade delta.
- Unknown Publisher modal follows the exact digest-bound, 30-day contract.
- Confirmed blacklist matches show a blocking safety view and recovery actions.
- Settings > Safety contains blacklist-check toggle, latest verified blacklist, delegation/revocation status, and remembered unknown bundles.
- Settings > Entitlements contains active grants, last-used times, suggested revocations, threshold, history, and explicit history deletion.
- Settings > Account offers future opt-in sync without implying that an account is required for local use.
- Status strips continue to show sandbox state and granted egress separately; a trusted publisher is never labelled as a trusted sandbox.

Accessibility copy MUST say what was verified. Color or a checkmark alone cannot communicate publisher, index, blacklist, or sandbox status.

## Open for owner

1. **Scope of the disable-check setting.** Default: it disables blacklist refresh and enforcement only; digest integrity and signature classification remain mandatory.
2. **Maximum offline catalogue staleness beyond signed expiry.** Default: expired verified entries may be browsed in a labelled stale view but cannot start a new network install.
3. **Blacklist fail-open interaction frequency.** Default: warn on every open attempt while no unexpired verified blacklist is available; `Open anyway` applies once.
4. **Non-macOS device-key backend required for v1.** Default: use an OS-protected key through the shared keychain abstraction and block entitlement mutation when none is available; do not fall back to a plaintext private-key file.
5. **Reinstall convenience.** Default: prior grants remain inactive; an explicit reviewable `Restore previous grants` action may preselect exact matching controls.
6. **Usage sync privacy.** Default: P4 opt-in sync includes per-grant `lastUsedAt` but no counts, mount paths, request details, or app data.
