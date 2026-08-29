#!/usr/bin/env bash
#
# verify.sh — THE green bar.
#
# Runs the full project verification sequence and fails on the first error.
# This is the single source of truth for "is the tree green?". Nothing should
# reach In Review without this passing. Mirrors crew.config.json -> verify.steps.
#
# Sections:
#   TS:   build -> typecheck -> lint:check -> test  (Nx run-many across packages)
#   Rust: cargo build -> cargo test -> cargo clippy  (credential-store + credhelper + vm)
#
# Usage: pnpm verify   (or: bash scripts/verify.sh)

set -euo pipefail

# Resolve repo root from this script's location so it works from any cwd.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

step() {
  printf '\n\033[1;34m==> %s\033[0m\n' "$1"
}

# --- TypeScript / Nx green bar -------------------------------------------------

step "1/5 build (nx run-many --target=build --all)"
pnpm run build

step "2/5 typecheck (nx run-many --target=typecheck --all)"
pnpm exec nx run-many --target=typecheck --all

step "3/5 lint:check (eslint + prettier --check)"
pnpm run lint:check

step "4/5 test (nx run-many --target=test --all)"
pnpm exec nx run-many --target=test --all

# --- Rust crates ---------------------------------------------------------------

step "5/5 rust (cargo build && cargo test && cargo clippy)"
(
  cd packages/credential-store
  cargo build --all-features
  cargo test --all-features
  cargo clippy --all-features --all-targets -- -D warnings
)
(
  cd packages/credhelper
  cargo build
  cargo test
  cargo clippy --all-targets -- -D warnings
)
(
  cd packages/vm
  cargo build
  cargo test
  cargo clippy -- -D warnings
)

printf '\n\033[1;32m==> verify: GREEN\033[0m\n'
