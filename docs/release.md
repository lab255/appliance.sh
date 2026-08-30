# Release operations

## Control-plane release signing (AP-225 / AP-226)

`release-cli-binaries.yml` publishes the two guest api-server binaries, console
bundle, `SHA256SUMS`, `control-plane-release.json`, and
`control-plane-release.sig.json`. The RFC-8785/Ed25519 envelope covers the
artifact names, architectures, byte counts and SHA-256 values plus the sibling
GHCR api-server multi-arch manifest digest. The workflow waits for that image
tag; a manual rerun may instead provide the `image_manifest_digest` input.

Production publishing (`publish=true`, the default) fails unless the Actions
secret `APPLIANCE_RELEASE_SIGNING_KEY` exists. Its value is standard base64 for
exactly one raw 32-byte Ed25519 seed. `publish=false` is the build-only unsigned
dry run and uploads nothing. Never paste, log, or commit the decoded seed.

AP-226 owner steps, in order:

1. Generate the offline production Ed25519 identity and record its custody,
   backup, rotation, revocation, and signed-blacklist procedure.
2. Replace `RELEASE_DEV_FIXTURE_PUBLIC_KEY`,
   `RELEASE_DEV_FIXTURE_KEY_ID`, and the `PINNED_RELEASE_TRUST` mapping in
   `packages/sdk/src/models/release-trust.ts` with that production public key
   and its `ed25519:sha256:<hex>` pin.
3. Store the matching 32-byte seed as standard base64 in the release
   environment secret named exactly `APPLIANCE_RELEASE_SIGNING_KEY`; restrict
   environment access to release owners and required reviewers.
4. Run a non-publishing workflow dry run, then publish a canary and confirm the
   CLI reports `staged asset signed by keyId …` and both VZ/WSL seed checks pass.

## Regenerating the Windows credential-helper digest

The npm package pins the normalized Windows credential helper's SHA-256. The
release workflow refuses to upload a helper that differs from this baked value.
Regenerate it after any helper source, Rust dependency, toolchain, normalization,
or build-recipe change:

```sh
cargo install cargo-xwin --version 0.23.1 --locked
pnpm --filter @appliance.sh/cli credhelper:digest
```

The command uses Rust 1.96.0 and cargo-xwin 0.23.1, downloads the dated MSVC
sysroot, verifies its checked-in SHA-256 before extracting it into cargo-xwin's
local cache, runs the same release cross-build and PE normalization as Actions,
and writes `packages/cli/scripts/credential-helper-checksums.json`. Use
`APPLIANCE_CREDHELPER_SYSROOT_ARCHIVE=/path/to/windows-msvc-sysroot.tar.xz` to
reuse an already downloaded archive.

The Windows helper is currently cross-built and unsigned. Authenticode signing
is tracked by AP-202; release operators should retain the digest guard until the
signed-asset pipeline replaces it.
