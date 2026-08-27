#!/bin/sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../../.." && pwd)
OUT=${1:-$HERE/journal.appliance.zip}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/appliance-journal.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM
STAGE=$WORK/project
mkdir -p "$STAGE/payload/images"

case "$(uname -m)" in
  arm64|aarch64) OCI_ARCH=arm64 ;;
  x86_64|amd64) OCI_ARCH=amd64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

command -v docker >/dev/null 2>&1 || {
  echo "docker with buildx is required to produce the sample OCI image" >&2
  exit 1
}

docker buildx build \
  --platform "linux/$OCI_ARCH" \
  --tag appliance.local/journal:live \
  --output "type=oci,dest=$STAGE/payload/images/journal-linux-$OCI_ARCH.oci.tar" \
  "$HERE"

cp "$HERE/appliance.json" "$STAGE/appliance.json"
node --input-type=module - "$STAGE/appliance.json" "$OCI_ARCH" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2];
const arch = process.argv[3];
const manifest = JSON.parse(readFileSync(file, 'utf8'));
manifest.payload.images = {
  [`linux/${arch}`]: { path: `payload/images/journal-linux-${arch}.oci.tar` },
};
writeFileSync(file, JSON.stringify(manifest, null, 2));
NODE

mkdir -p "$(dirname -- "$OUT")"
cd "$REPO/packages/cli"
pnpm exec bun src/appliance.ts builder package \
  --directory "$STAGE" \
  --image "payload/images/journal-linux-$OCI_ARCH.oci.tar=$STAGE/payload/images/journal-linux-$OCI_ARCH.oci.tar" \
  --out "$OUT"
printf 'Runnable bundle: %s\n' "$OUT"
