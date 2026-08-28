#!/bin/sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../../.." && pwd)
MODE=${1:-serve}
OUT=${2:-$HERE/dashboard.appliance.zip}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/appliance-dashboard.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM
STAGE=$WORK/project

case "$MODE" in
  serve|exit7) ;;
  *) echo "usage: $0 [serve|exit7] [output.appliance.zip]" >&2; exit 2 ;;
esac
command -v docker >/dev/null 2>&1 || {
  echo "docker is required; this source-only example builds with golang:1.22-alpine" >&2
  exit 1
}

mkdir -p "$STAGE/payload/dashboard/linux-amd64/bin" "$STAGE/payload/dashboard/linux-arm64/bin"
STAGE=$(CDPATH= cd -- "$STAGE" && pwd -P)
cp "$HERE/appliance.json" "$STAGE/appliance.json"

docker run --rm \
  -v "$HERE:/src:ro" \
  -w /src \
  golang:1.22-alpine \
  sh -c 'CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /tmp/dashboard . && cat /tmp/dashboard' \
  > "$STAGE/payload/dashboard/linux-amd64/bin/dashboard"
docker run --rm \
  -v "$HERE:/src:ro" \
  -w /src \
  golang:1.22-alpine \
  sh -c 'CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o /tmp/dashboard . && cat /tmp/dashboard' \
  > "$STAGE/payload/dashboard/linux-arm64/bin/dashboard"

if [ "$MODE" = exit7 ]; then
  node --input-type=module - "$STAGE/appliance.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2];
const manifest = JSON.parse(readFileSync(file, 'utf8'));
manifest.name = 'dashboard-exit7';
manifest.description = 'Binary Runtime exit-code propagation fixture';
manifest.payload.targets['linux/amd64'].args = ['--exit-code', '7'];
manifest.payload.targets['linux/arm64'].args = ['--exit-code', '7'];
delete manifest.ports;
delete manifest.ui;
writeFileSync(file, JSON.stringify(manifest, null, 2));
NODE
fi

mkdir -p "$(dirname -- "$OUT")"
cd "$REPO/packages/cli"
pnpm exec bun src/appliance.ts builder package --directory "$STAGE" --out "$OUT"
printf 'Runnable bundle: %s\n' "$OUT"
