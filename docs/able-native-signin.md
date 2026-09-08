# Optional able identity

`appliance account login` and Desktop → Settings → Account → **Sign in with able** open the system browser on the same host. Accounts are optional. Signing in does not authorize a runtime feature, activate a grant, transfer a device, or restore history.

The CLI and Tauri call one native implementation in `packages/credhelper/src/able.rs`, using `openidconnect` 4.0.1. The TypeScript helper and the webview receive redacted identity/status only. Native credentials are never returned over IPC. No client secret or introspection is used.

| Contract         | Value                                                          |
| ---------------- | -------------------------------------------------------------- |
| Public client    | `appliance-desktop`, token authentication `none`               |
| Issuer           | `https://account.able.online/api/auth`, exact literal          |
| Discovery        | `https://account.able.online/.well-known/openid-configuration` |
| JWKS             | `https://account.able.online/api/auth/jwks`                    |
| Grants           | authorization code with PKCE S256; refresh token               |
| Scopes           | `openid profile email offline_access`                          |
| CLI redirect     | `http://localhost:43103/oauth/callback`                        |
| Desktop redirect | `http://localhost:43104/oauth/callback`                        |

The `localhost` spelling is identical in authorization and code-exchange requests. Listeners bind both `127.0.0.1` and `::1` explicitly, before opening the browser. Either bind failing rolls back the other. There is no alternate port, hostname, scheme, pasted-token, or headless flow. Callback state is random and single-use; nonce, signature, issuer, audience and expiration are verified locally. Userinfo must match the verified subject and supply a verified email. Sign-in expires after five minutes. Close the app or use **Cancel sign-in** / `appliance account logout` to cancel.

`sign-in` and `sign-out` remain compatibility aliases for `login` and `logout`.

`appliance account status` prints the identity; `appliance account status --json` prints the helper’s redacted JSON verbatim. `appliance account refresh` refreshes only within 60 seconds of access expiry. Access tokens expire within 3,600 seconds; refresh tokens are bounded to 30 days. Refresh is serialized across native processes and rereads credentials under the OS lock. Rotation is persisted with an atomic replacement. A successful response without a replacement retains the previous refresh token. `invalid_grant` erases the able entry and returns signed out; network failures retain it for a later explicit retry. There is no automatic retry loop or replay of application mutations.

`appliance account logout` and the Settings sign-out button erase the shared identity on this host. The native implementation attempts RFC 7009 refresh-token revocation with `client_id` in the body. Local erasure and pending-login cancellation are persisted even when revocation fails; the user sees that upstream revocation could not be confirmed. Browser-wide able logout is not performed. To switch accounts, sign out first; CLI also accepts explicit `login --switch-account` confirmation.

## Storage and coexistence

The versioned `able` entry lives in `~/.appliance/credentials.json`. On Unix the directory must be owned by the current user with mode 0700 and credential/lock/temp files must be 0600. Symlinks and foreign ownership are rejected. Windows checks ownership and rejects reparse points before applying the existing protected current-user/SYSTEM/Administrators DACL. Windows behavior still needs runner validation; macOS tests cannot establish Windows ACL behavior.

Both native ports use `able.lock` (OS file lock) and the existing `profiles.json.lock` exclusion file in that order. CLI profile writers preserve unknown credential fields and use the same exclusion file, so cluster changes cannot overwrite the able entry. Lock contention fails closed. A process killed while holding the profile exclusion file can leave it behind; after confirming no Appliance process is using the store, remove only that stale exclusion file before retrying. Do not remove `able.lock` to break a live OS lock.

The shared `able_generation` invalidates pending login commits on sign-out. Refresh never caches tokens across operations and holds the lock through rotation, so a subsequent sign-out cannot be undone by stale refresh data. Cloud credentials, device keys, grants and history remain separate.

## Admission and validation boundaries

This identity-only surface stores `account_id: null`: an able subject is not an Appliance account ID. The private RFC requires a separately validated backend admission result before native account/history APIs are used. Its admission endpoint/schema has not been supplied to this worker. This change does not invent that endpoint, provision a domain account, or call the optional sync APIs. Backend admission and persisted account-ID integration remain a release gate for those APIs.

The transport in Rust unit tests is replaced at compile time by an able-compatible HTTP handler with real EdDSA-signed JWTs. It implements discovery, JWKS, authorization, token, userinfo and revoke semantics; callback requests use actual IPv4/IPv6 TCP listeners. No test can contact live able. Tests cover both ports, state/PKCE/nonce/issuer/audience/signature tampering, absent tokens, consent denial, exact callback path, occupied ports/rollback/retry, timeout, storage permissions/symlinks, account switching, rotation/reuse invalidation, concurrent refresh and sign-out cancellation, transient errors, and revoke-fails-still-erases.

Run `pnpm verify` and `cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml`. The latter requires the desktop sidecars staged by the workspace build. AP-234 owns live able smoke tests. No CI polling, workflow changes, merge, or live sign-in is part of AP-233 verification.
