#!/bin/sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=${1:-$HERE/journal.appliance.zip}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/appliance-journal.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM
STAGE=$WORK/stage
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

# Keys are already RFC 8785 lexical order and the file has no trailing LF.
printf '%s' "{\"kind\":\"runnable\",\"license\":\"MIT\",\"manifest\":\"v2\",\"name\":\"journal\",\"payload\":{\"images\":{\"linux/$OCI_ARCH\":{\"path\":\"payload/images/journal-linux-$OCI_ARCH.oci.tar\"}}},\"ports\":[{\"expose\":\"host\",\"guest\":3000,\"name\":\"http\",\"primary\":true,\"protocol\":\"tcp\"}],\"publisher\":{\"name\":\"Lab 255 Runtime live test\"},\"resources\":{\"cpus\":1,\"diskGib\":2,\"memoryMib\":512},\"type\":\"container\",\"ui\":{\"path\":\"/\",\"port\":\"http\",\"type\":\"web\"},\"version\":\"0.1.0\"}" > "$STAGE/appliance.json"

node --input-type=module - "$STAGE" <<'NODE'
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = process.argv[2];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(relative(root, full).split('/').join('/'));
  }
};
walk(root);
files.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
const hash = createHash('sha256');
for (const name of files) {
  if (name === 'digest' || name === 'signature.sig') continue;
  const bytes = readFileSync(join(root, name));
  hash.update(name).update(Buffer.from([0])).update(String(bytes.length)).update(Buffer.from([0])).update(bytes);
}
writeFileSync(join(root, 'digest'), `sha256:${hash.digest('hex')}\n`);
NODE

mkdir -p "$(dirname -- "$OUT")"
rm -f "$OUT"
(cd "$STAGE" && zip -X -q -r "$OUT" appliance.json payload digest)
echo "$OUT"
