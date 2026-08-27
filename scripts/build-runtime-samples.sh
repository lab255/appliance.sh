#!/bin/sh
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=${OUT:-${TMPDIR:-/tmp}/appliance-runtime-samples}
REQUIRE_DOCKER=0

case "${1:-}" in
  '') ;;
  --require-docker) REQUIRE_DOCKER=1 ;;
  *) echo "usage: $0 [--require-docker]" >&2; exit 2 ;;
esac

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  if [ "$REQUIRE_DOCKER" -eq 1 ]; then
    echo "Docker is required to build Runtime samples (--require-docker was set)." >&2
    exit 1
  fi
  echo "Skipping Runtime samples: Docker is unavailable (pass --require-docker to make this an error)."
  exit 0
fi

mkdir -p "$OUT"
OUT=$(CDPATH= cd -- "$OUT" && pwd -P)

# The package command runs from TypeScript source, but its two workspace
# imports publish compiled entrypoints. Build only those small dependencies;
# compiling the standalone CLI binary is unnecessary.
(cd "$REPO" && pnpm exec nx run-many --target=build --projects=@appliance.sh/sdk,@appliance.sh/helper)

build_sample() {
  name=$1
  shift
  bundle=$OUT/$name.appliance.zip
  printf 'Building %s...\n' "$name"
  rm -f "$bundle"
  log=$OUT/$name.build.log
  if ! "$@" "$bundle" >"$log" 2>&1; then
    cat "$log" >&2
    echo "Runtime sample packaging failed: $name" >&2
    if grep -q "OCI exporter is not supported" "$log"; then
      echo "Hint: the default docker buildx driver cannot export OCI images; run \`docker buildx create --use\` to switch to a docker-container driver." >&2
    fi
    exit 1
  fi
  cat "$log"
  if [ ! -s "$bundle" ]; then
    echo "Runtime sample packaging produced no bundle: $bundle" >&2
    exit 1
  fi
  digest=$(unzip -p "$bundle" digest)
  case "$digest" in
    sha256:*) ;;
    *) echo "Runtime sample bundle has no valid digest: $bundle" >&2; exit 1 ;;
  esac
  printf '%s  %s\n' "$digest" "$bundle"
}

# Each builder ends in `appliance builder package`, whose verifyBundle call
# validates the emitted archive before the command can return success.
build_sample journal "$REPO/examples/runtime/journal/build-bundle.sh"
build_sample dashboard "$REPO/examples/runtime/dashboard/build-bundle.sh" serve
build_sample notes-suite "$REPO/examples/runtime/notes-suite/build-bundle.sh"
