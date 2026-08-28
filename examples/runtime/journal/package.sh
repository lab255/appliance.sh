#!/bin/sh
set -eu

example_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$example_dir/../../.." && pwd)
output_dir=${TMPDIR:-/tmp}
output_path="$output_dir/journal.appliance.zip"

cd "$repo_dir/packages/cli"
pnpm exec bun src/appliance.ts package \
  --directory "$example_dir" \
  --out "$output_path"

printf 'Runnable bundle: %s\n' "$output_path"
