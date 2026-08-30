# Release operations

## Control-plane release signing (AP-225 / AP-226)

`release-cli-binaries.yml` transfers the two guest api-server binaries, console
bundle, and `SHA256SUMS` to its separate `release-signing` environment job. That
job uploads the guest assets in one release operation, adding
`control-plane-release.json` and `control-plane-release.sig.json` when the
signing secret is provisioned; a pinned CLI therefore cannot observe a guest
binary-only window while signing is still running. The RFC-8785/Ed25519
envelope covers the artifact names, architectures, byte counts and SHA-256
values plus the sibling GHCR api-server multi-arch manifest digest. The workflow
waits for that image tag using the configurable `image_digest_poll_attempts` and
`image_digest_poll_seconds` budget. An `image_manifest_digest` override is still
checked against `imagetools inspect`; wiring an explicit `needs:` relationship
to the sibling image workflow remains a follow-up because GitHub workflows run
independently.

Before AP-226, `publish=true` without `APPLIANCE_RELEASE_SIGNING_KEY` uploads the
unsigned binaries and `SHA256SUMS`, writes **UNSIGNED release — AP-226 not
provisioned** to the job summary, and publishes no payload/envelope. Setting
`require_signature=true` makes a missing secret fatal; AP-226 changes its default
to true only after provisioning. `publish=false` uploads nothing but executes a
throwaway-key sign-and-verify self-check. The secret value is standard base64
for exactly one raw 32-byte Ed25519 seed. Never paste, log, or commit it.

Signed generations are derived from semver as `major*1,000,000 + minor*1,000 +
patch`. The signing script rejects a generation that does not match the version
or fails to exceed the newest previously published signed payload, preventing an
old tag rerun from minting a signed downgrade with a newer workflow-run number.

AP-226 owner steps, in order:

1. Generate the offline production Ed25519 identity and record its custody,
   backup, rotation, and revocation procedure. Signed blacklist distribution is
   still an AP-226/CU2 follow-up; until then revocation requires a CLI upgrade.
2. Replace the intentionally empty `PINNED_RELEASE_TRUST.keys` mapping in
   `packages/sdk/src/models/release-trust.ts` with that production public key
   and its `ed25519:sha256:<hex>` pin, then consciously delete the empty-pin test.
3. Create the GitHub Actions environment named exactly `release-signing`, add
   tag/deployment protection and release-owner reviewers, and store the matching
   standard-base64 32-byte seed there as the environment secret named exactly
   `APPLIANCE_RELEASE_SIGNING_KEY`.
4. Run a non-publishing workflow dry run, then publish a canary and confirm the
   CLI reports `staged asset signed by keyId …` and both VZ/WSL seed checks pass.
5. As the final AP-226 step, change the workflow input `require_signature`
   default to `true`; thereafter a missing secret stops the release.

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
