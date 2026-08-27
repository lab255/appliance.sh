#!/bin/sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../../.." && pwd)
OUT=${1:-$HERE/notes-suite.appliance.zip}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/appliance-notes-suite.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM
STAGE=$WORK/project

case "$(uname -m)" in
  arm64|aarch64) OCI_ARCH=arm64 ;;
  x86_64|amd64) OCI_ARCH=amd64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
command -v docker >/dev/null 2>&1 || {
  echo "docker with buildx is required to build the source-only service images" >&2
  exit 1
}

mkdir -p "$STAGE/payload/web" "$STAGE/payload/api"
cp "$HERE/appliance.json" "$STAGE/appliance.json"
docker buildx build \
  --platform "linux/$OCI_ARCH" \
  --tag appliance.local/notes-suite-web:live \
  --output "type=oci,dest=$STAGE/payload/web/web-linux-$OCI_ARCH.oci.tar" \
  "$HERE/web"
docker buildx build \
  --platform "linux/$OCI_ARCH" \
  --tag appliance.local/notes-suite-api:live \
  --output "type=oci,dest=$STAGE/payload/api/api-linux-$OCI_ARCH.oci.tar" \
  "$HERE/api"

node --input-type=module - "$STAGE/appliance.json" "$OCI_ARCH" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2];
const arch = process.argv[3];
const manifest = JSON.parse(readFileSync(file, 'utf8'));
for (const name of ['web', 'api']) {
  const image = manifest.services[name].payload.images[`linux/${arch}`];
  manifest.services[name].payload.images = { [`linux/${arch}`]: image };
}
writeFileSync(file, JSON.stringify(manifest, null, 2));
NODE

mkdir -p "$(dirname -- "$OUT")"
cd "$REPO/packages/cli"
pnpm exec bun src/appliance.ts builder package --directory "$STAGE" --out "$OUT"
printf 'Runnable bundle: %s\n' "$OUT"
