# Workbench Package

Package is an explicit human action in the desktop Workbench. It invokes the bundled
`appliance builder package` CLI in the selected workspace directory, streams its actual
stages and logs, and returns the verified runnable v2 `.appliance.zip` path and content
digest. It uses the existing packaging engine and bundle format. A v1 manifest keeps
the engine's source-project error; it is not converted or presented as a successful
hand-off.

The input is the current directory, not a pinned inspection snapshot. Stop editors
and review changes before packaging. Keep the page open while packaging. The native
bridge rejects concurrent Package operations for the same canonical directory.

## Local developer signing

The desktop detects one explicitly provisioned, developer-owned local key at:

```text
<desktop app config directory>/workbench/developer-ed25519.pem
```

On macOS the default path is
`~/Library/Application Support/sh.appliance.desktop/workbench/developer-ed25519.pem`.
Provisioning UI is not included. Use the existing CLI's supported Ed25519 key format
(PKCS#8 PEM or its development-key JSON seed format). The file must be a regular file,
outside the workspace, and on Unix owned by the app-config owner with mode 0600.
The existing engine validates that the private key is Ed25519. An unreadable,
malformed or unsuitable configured key fails packaging; it never silently downgrades
to unsigned output.

If no key is present, the artifact is labelled exactly:

> Unsigned — publisher prompts will warn

The bridge does not read signing configuration from workspace files, agent results,
CI environment variables, or catalogue/production identities. It never sends private
key bytes to the frontend or agent. A local signature does not establish catalogue
endorsement or guarantee that a recipient can resolve the publisher's public key.

## File hand-off and separate actions

Each attempt writes a fresh file under the desktop app data directory's
`workbench-packages/<operation-id>/review.appliance.zip`. The reported digest is the
bundle's canonical content digest, not a ZIP-container byte hash. Failed attempts do
not expose an installable File result. Successful artifacts remain available after
leaving the page.

File is the primary result. Catalogue is labelled “coming later”; no publication
workflow is built. Deploy remains the existing source-deployment action at
`/projects/deploy`. Packaging never installs, publishes, deploys, or launches an app.

The recipient separately opens `/apps`, selects a target, and chooses “Install from
file”. Existing Unknown Publisher and grant prompts remain authoritative. Installing
is distinct from Open. The current installer stores a local immutable bundle and a
target-keyed installed-app record; selecting a cloud target does not turn this into
remote cloud installation or package promotion.

## Authority boundary

Only the Package button's event handler invokes the bridge. Registry polling,
readiness proposals, session completion and result arrival do not. The existing eight
MCP tools are unchanged. Package is not registered as an agent tool. This is a
Workbench workflow boundary, not containment against a shell-capable agent.

## Reproducing native development measurements

Build the CLI and stage it with the ordinary desktop development scripts before
launching Tauri. The committed Cargo lock must remain unchanged; use `--locked` for
native Cargo checks.

Rebuilding the macOS debug binary changes its signing identity. Existing desktop
Keychain items can then park startup behind a securityd ACL prompt. Before applying
the known recovery, confirm the selected profiles still have a recoverable source
and the current `syncedKeyId` field still controls synchronization. Quit the debug
app, delete only the affected recoverable `sh.appliance.desktop` / `cluster:<id>`
items, clear their `syncedKeyId` fields in the app's config, then relaunch so the app
creates its own entries. Do not recreate them with `security add-generic-password`:
that gives them the wrong creator ACL. Do not delete non-recoverable canonical keys.

### P2 recipient finding

A developer-signed file arriving without catalogue binding or another resolvable
public-key source still follows Unknown Publisher review. The existing recipient
copy says “Signature could not be verified”; the publisher remains untrusted.
The “Publisher (unverified)” row displays the publisher name as declared in the
bundle manifest, unverified. It is not key-derived or a verified identity. Signing provides independently verifiable integrity when
the developer public key is supplied; it does not grant recipient trust. Catalogue
publisher trust remains a later-phase question. Trust/grant decisions are unchanged.
