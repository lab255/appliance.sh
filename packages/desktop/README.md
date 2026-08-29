# @appliance.sh/desktop

Tauri 2 shell for the Appliance desktop app. Frontend is `@appliance.sh/app`; the shell adds OS keychain storage, external URL opening, and native notifications via Rust commands.

## Prerequisites

- Node.js 22+ and `pnpm`
- Rust toolchain (`rustup` + stable `cargo`)
- Platform build deps per https://v2.tauri.app/start/prerequisites/

## Windows notes

The Windows desktop supports the scoped WSL2 workflow defined by the
[Windows live-test runbook](../../docs/live-test-runbook-windows.md); features
outside that runbook are not implied to have macOS parity. The runbook has not
yet been run against a release candidate; CI proves only the automated
counterparts it names. Platform specifics worth knowing when touching the Rust
shell:

- **Guest shells ride `wsl.exe`, not a socket.** The vsock relay socket
  (`~/.appliance/vm/<vm>/shell.sock`) is a unix-only artifact; on Windows
  `appliance-vm shell` drives `wsl.exe -d <distro>` directly, so any "is the
  fast shell available?" check must be `cfg!(windows) || sock.exists()` —
  never the socket check alone (`microvm_host_shell_argv` in `lib.rs`).
  Sessions land in the same in-guest tmux sockets, so reattach semantics
  match macOS.
- **PTY spawns don't inherit the process PATH.** portable-pty on Windows
  rebuilds the child environment from the registry (system + user
  `Environment` keys), which discards Desktop's startup PATH composition.
  `terminal.rs` re-asserts that complete live PATH on every `CommandBuilder` —
  keep that when adding spawn sites, or `kubectl` silently stops resolving in
  terminals while working everywhere else.
- **Windows PATH composition.** Desktop prepends both managed locations:
  `%LOCALAPPDATA%\Appliance\bin` for helper-installed tools (kubectl, crane,
  buildctl), and `~/.appliance/bin` for `appliance-vm.exe`, shared with the CLI.
  It also prepends existing WinGet links, Scoop shims, and Docker Desktop's bin
  directory. `~` deliberately resolves `HOME` before `USERPROFILE`, matching
  the CLI for Git Bash launches.

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
pnpm tauri:build:release # Release build: Developer ID sign + updater artifacts
```

`tauri:build` is the day-to-day local build; it re-signs with the stable
self-signed dev cert (below). `tauri:build:release` is what the GitHub Actions
release workflow runs. It overlays `src-tauri/tauri.release.conf.json`, which
turns on signed updater artifacts. Signing steps no-op cleanly when their
secrets are absent, so contributors can run the command locally.

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

## macOS production signing

The release workflow signs the app shell, sidecars, and staged Mach-O resources
with a Developer ID Application identity, hardened runtime options, a secure
timestamp, and the appropriate entitlements. `APPLE_CERTIFICATE` and
`APPLE_CERTIFICATE_PASSWORD` provide the CI identity; the signing scripts derive
its name from the temporary keychain. `APPLE_SIGNING_IDENTITY` remains available
as a local override. Without a Developer ID identity, the signing step skips
cleanly.

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
