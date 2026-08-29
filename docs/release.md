# Release operations

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
