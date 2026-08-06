# @appliance.sh/desktop

Tauri 2 shell for the Appliance desktop app. Frontend is `@appliance.sh/app`; the shell adds OS keychain storage, external URL opening, and native notifications via Rust commands.

## Prerequisites

- Node.js 22+ and `pnpm`
- Rust toolchain (`rustup` + stable `cargo`)
- Platform build deps per https://v2.tauri.app/start/prerequisites/

## Windows notes

The Windows build is fully supported (WSL2 backend). Platform specifics worth
knowing when touching the Rust shell:

- **Guest shells ride `wsl.exe`, not a socket.** The vsock relay socket
  (`~/.appliance/vm/<vm>/shell.sock`) is a unix-only artifact; on Windows
  `appliance-vm shell` drives `wsl.exe -d <distro>` directly, so any "is the
  fast shell available?" check must be `cfg!(windows) || sock.exists()` —
  never the socket check alone (`microvm_host_shell_argv` in `lib.rs`).
  Sessions land in the same in-guest tmux sockets, so reattach semantics
  match macOS.
- **PTY spawns don't inherit the process PATH.** portable-pty on Windows
  rebuilds the child environment from the registry (system + user
  `Environment` keys), which discards the helper bin dir this process
  prepends to PATH at startup. `terminal.rs` re-asserts the live process
  PATH on every `CommandBuilder` — keep that when adding spawn sites, or
  `kubectl` silently stops resolving in terminals while working everywhere
  else.
- **Two managed bin dirs.** The microVM engine installs to
  `~/.appliance/bin/appliance-vm.exe` (shared with the CLI); helper-installed
  tools (kubectl, crane, buildctl) live in `%LOCALAPPDATA%\Appliance\bin`
  (mirrors `helperBinDir()` in `@appliance.sh/helper`). Both are put on the
  desktop's PATH at startup.

## Icons

The full platform icon set (PNGs + `icon.icns` + `icon.ico`) is checked in under `src-tauri/icons/`, generated from a programmatic brand mark. To regenerate (e.g. after tweaking the mark in `scripts/generate-icon.mjs`):

```
node scripts/generate-icon.mjs
pnpm exec tauri icon src-tauri/icons/source.png
```

To swap in designed artwork, replace `src-tauri/icons/source.png` with a ≥1024×1024 PNG (transparency preserved) and re-run `pnpm exec tauri icon src-tauri/icons/source.png`. `bundle.icon` in `tauri.conf.json` already references the `.icns` / `.ico` outputs (Windows bundling hard-requires the `.ico`).

## Scripts

```
pnpm dev                 # Vite frontend dev server (1420)
pnpm build               # Vite frontend build → dist/
pnpm tauri dev           # Launch the Tauri window (runs `pnpm dev` first)
pnpm tauri build         # Build installers for the current platform (dev re-sign)
pnpm tauri:build:release # Release build: Developer ID sign + notarize + updater artifacts
```

`tauri:build` is the day-to-day local build; it re-signs with the stable
self-signed dev cert (below). `tauri:build:release` is what the GitHub
Actions release workflow runs — it overlays `src-tauri/tauri.release.conf.json`
(which turns on signed updater artifacts) and runs `scripts/notarize-macos.mjs`.
Both release steps **no-op cleanly when their secrets are absent**, so you can
run `tauri:build:release` locally and just get an unsigned, un-notarized
bundle without errors.

## Auto-update

The desktop self-updates from a **signed update feed** via Tauri v2's updater
plugin (`tauri-plugin-updater` on the Rust side, `@tauri-apps/plugin-updater` +
`@tauri-apps/plugin-process` on the JS side). Config lives in
`src-tauri/tauri.conf.json` under `plugins.updater`:

- `endpoints` → `https://github.com/appliance-sh/appliance.sh/releases/latest/download/latest.json`
  The app fetches this manifest, compares its `version` against the running
  build, and — when behind — downloads + verifies the matching platform's
  signed tarball.
- `pubkey` → the **public** half of the updater signing keypair. Safe to
  commit. The committed value is a placeholder
  (`REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY`) so local/fork builds fail-safe:
  the bundle builds fine but update _checks_ fail signature verification
  (nothing installs). The release workflow injects the real public key at
  build time via `scripts/set-updater-pubkey.mjs` from the
  `TAURI_UPDATER_PUBKEY` repo secret — set it (see keypair generation below)
  alongside `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  and released builds self-update on macOS **and Windows** (the NSIS
  `-setup.exe` doubles as the Windows updater artifact).

The UI lives in **Settings → Updates**: "Check for updates" → shows the
available version + notes → "Download & install" (with a progress bar) →
"Restart to update". It's wired through the host abstraction
(`ConsoleHost.updater`, an optional desktop-only capability), so the web shell
simply doesn't render the panel, and the browser mock host (`?mock-host`)
simulates the whole flow for UI work.

### Generating the updater keypair (one time, per project)

```
pnpm tauri signer generate -- -w ~/.tauri/appliance-updater.key
```

This writes two files:

- `~/.tauri/appliance-updater.key` — the **private** key. **NEVER commit this**
  and never share it. If you lose it you can't publish further updates (every
  client would reject the new signing key). Store it in a password manager.
- `~/.tauri/appliance-updater.key.pub` — the **public** key. Copy its contents
  into `src-tauri/tauri.conf.json`'s `plugins.updater.pubkey` (it must be the
  key _content_, not a path) and commit that.

You'll be prompted for a password protecting the private key — keep it
non-empty in CI.

### CI secrets for signing the update artifacts

The release workflow signs each bundle's updater tarball with the private key,
provided as repository secrets:

| Secret                               | Value                                        |
| ------------------------------------ | -------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Contents of `~/.tauri/appliance-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you set when generating the key |

When `TAURI_SIGNING_PRIVATE_KEY` is unset, `createUpdaterArtifacts` would make
`tauri build` hard-fail — which is exactly why it's NOT in the base config and
only the release overlay (`tauri.release.conf.json`) enables it, applied by the
workflow.

## macOS: production Developer ID signing + notarization

Release bundles must be signed with a real **Developer ID Application**
identity, built with the **hardened runtime**, and **notarized** by Apple so
Gatekeeper lets users open them without a right-click-Open dance. This is the
production counterpart to the dev re-sign below, driven entirely by env vars
and implemented in `scripts/notarize-macos.mjs`.

The script **no-ops unless the credentials are present** (same contract as
`scripts/sign-macos.mjs`), so local + unsigned-CI builds skip it cleanly. When
the creds are set it: (1) re-signs the `.app` with `--options runtime`
(hardened runtime), a secure timestamp, and `scripts/entitlements.plist`;
(2) submits the `.app` and each `.dmg` to `notarytool --wait`; (3) staples the
notarization ticket so the bundle passes Gatekeeper offline.

Required environment / CI secrets:

| Secret                        | Purpose                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`           | Base64 of the Developer ID Application `.p12` (cert + private key), imported into a temp keychain in CI |
| `APPLE_CERTIFICATE_PASSWORD`  | Export password for that `.p12`                                                                         |
| `APPLE_TEAM_ID`               | 10-char Apple Developer Team ID                                                                         |
| `APPLE_ID` + `APPLE_PASSWORD` | Apple ID + an **app-specific** password for notarytool auth                                             |

There is deliberately **no** `APPLE_SIGNING_IDENTITY` secret: the signing
scripts derive the identity from whatever `Developer ID Application` cert is in
the keychain search list (`scripts/macos-signing.mjs`) — in CI that's exactly
the one the workflow imported from `APPLE_CERTIFICATE`. A hardcoded identity
string goes stale on cert rotation and silently no-ops the signing scripts.
Setting `APPLE_SIGNING_IDENTITY` in the env still overrides the derivation
(useful on a machine with several Developer ID certs); `APPLE_TEAM_ID` also
falls back to the `(TEAMID1234)` suffix of the derived identity when unset.

Bundle **resources** need their own Developer ID signatures — Tauri signs the
app shell and `externalBin` sidecars, but copies `bundle.resources` verbatim,
and notarization rejects the whole archive over one ad-hoc Mach-O (this is
exactly how the ad-hoc-signed `vm-bin/appliance-vm` used to sink every release
build). `scripts/sign-staged.mjs` runs before `tauri build` in
`tauri:build:release` and Developer-ID-signs every Mach-O staged under
`src-tauri/` (hardened runtime + timestamp, per-binary entitlements), skipping
non-Mach-O files like the Linux api-server guest binary.

Alternatively, instead of `APPLE_ID`/`APPLE_PASSWORD`, notarization can use an
App-Store-Connect API key — set `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and
`APPLE_API_KEY_PATH` (path to the `.p8`). The script prefers the API key when
all three are present. Set `APPLE_NOTARIZE=0` to re-sign but skip the
notarization round-trip (useful when iterating on the signing step).

> None of this can be exercised without real Apple credentials. The code path
> is implemented and gated; the release workflow wires the secrets in.

## macOS: stable code-signing for local dev

The app reads each cluster's API key from the macOS Keychain, and macOS gates
Keychain access on the app's code-signing identity. A plain `pnpm tauri build`
**ad-hoc**-signs the bundle with the raw binary hash, which changes on every
rebuild — so each new dev build looks like a different app to the Keychain and
re-prompts for your password. At startup that prompt blocks the WKWebView from
painting (blank window) and starves the API key (every screen shows
"Load failed").

Fix: sign every dev build with one **stable** self-signed certificate.

1. Create a code-signing cert named `Appliance Dev`:
   Keychain Access → Certificate Assistant → _Create a Certificate…_ →
   Name `Appliance Dev`, Identity Type **Self Signed Root**, Certificate Type
   **Code Signing** → Create.
2. Let `codesign` use the key without prompting (one time; enter your login
   password at the prompt):
   ```
   security set-key-partition-list -S apple-tool:,apple: -s -l "Appliance Dev" ~/Library/Keychains/login.keychain-db
   ```
3. Build normally. `pnpm tauri:build` runs `scripts/sign-macos.mjs`, which
   re-signs the bundled `.app` with the cert. Launch it once, click
   **Always Allow** on the Keychain prompt — and because the signing requirement
   is keyed to the cert (not the binary), you won't be prompted on future
   rebuilds.

Override the cert name with `APPLIANCE_MACOS_SIGN_IDENTITY`. Without the cert
present the signing step is a no-op, so CI and other contributors are
unaffected. The cleartext microVM API (`http://api.appliance.localhost`) also
needs the App Transport Security exception already declared in
`src-tauri/Info.plist`.

## IPC surface

Commands exposed by `src-tauri/src/lib.rs`:

| Command                    | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `get_config`               | Returns `{ apiServerUrl, apiKey }` from disk + OS keychain |
| `save_api_server_url(url)` | Writes the cluster URL to `$APP_CONFIG_DIR/config.json`    |
| `save_api_key(id, secret)` | Stores the API key in the OS keychain                      |
| `clear_api_key()`          | Removes the keychain entry (idempotent)                    |

The frontend's `ConsoleHost` calls these via `@tauri-apps/api/core`'s `invoke`.
