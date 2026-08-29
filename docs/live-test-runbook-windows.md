# Windows Runtime owner-run certification (AP-205)

This is the single Windows 11 / WSL2 NAT owner run required by
`docs/rfc/wsl-runtime.md` Decision 5. Run it from Git Bash in a clean checkout.
Do not use WSL mirrored networking except for the final negative test. Keep the
completed worksheet and screenshots with the release evidence.

## Prerequisites and worksheet

- Windows 11 with current WSL2, virtualization enabled, and
  `%USERPROFILE%\.wslconfig` absent or containing `networkingMode=NAT`.
- Node/pnpm, Rust, Go, Docker, Git Bash, `curl`, `jq`, and `zip` available to
  the Windows checkout. Desktop and the CLI must be built from the AP-205
  commit under test.
- `pnpm install`, `pnpm run build`, `cargo build --release --manifest-path
packages/vm/Cargo.toml`, and `scripts/build-runtime-samples.sh` have
  completed.
- Set `APPLIANCE_VM` to the Windows release engine and use
  `packages/cli/dist/appliance` below.

Record these numbered values before testing:

1. Windows build (`winver`): `__________`
2. `wsl.exe --version` first version line: `__________`
3. Engine version (`$APPLIANCE_VM --version`): `__________`
4. Feature commit (`git rev-parse --short HEAD`): `__________`

Pass criterion: all four values are present, `wsl.exe --status` identifies WSL
2, and `.wslconfig` is NAT rather than mirrored.

```sh
export APPLIANCE_VM="$PWD/packages/vm/target/release/appliance-vm.exe"
export AP="$PWD/packages/cli/dist/appliance"
export OUT="$PWD/.tmp/ap-205-runtime-samples"
mkdir -p "$OUT"
wsl.exe --version
"$APPLIANCE_VM" --version
git rev-parse --short HEAD
OUT="$OUT" scripts/build-runtime-samples.sh --require-docker

# Build a temporary binary fixture with one egress grant without changing the
# checked-in sample. Its workload need not implement the probes: step 5 enters
# its network namespace and runs the Runtime image's wget there.
PROBE_SRC="$PWD/examples/runtime/.ap205-egress-probe"
rm -rf "$PROBE_SRC"
cp -R examples/runtime/journal "$PROBE_SRC"
node --input-type=module - "$PROBE_SRC/appliance.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2];
const manifest = JSON.parse(readFileSync(file, 'utf8'));
manifest.name = 'egress-probe';
manifest.description = 'AP-205 owner-run cooperative egress probe';
manifest.network = { egress: [{ host: 'example.com', ports: [443] }] };
writeFileSync(file, JSON.stringify(manifest, null, 2));
NODE
"$PROBE_SRC/build-bundle.sh" "$OUT/egress-probe.appliance.zip"
rm -rf "$PROBE_SRC"
```

## 1. Clean pool and strict default

```sh
"$AP" runtime stop journal 2>/dev/null || true
"$AP" runtime stop dashboard 2>/dev/null || true
"$AP" runtime stop notes-suite 2>/dev/null || true
"$AP" vm stop --name appliance-runtime 2>/dev/null || true
"$AP" vm egress wsl-mode strict
"$AP" vm egress policy --name appliance-runtime | tee "$OUT/policy-strict.json"
"$AP" vm egress list --name appliance-runtime | tee "$OUT/list-strict.txt"
```

Pass criterion: policy JSON says `boundary: "cooperative"`,
`enforcement.backend: "wsl"`, `enforcement.bypassable: true`, and
`wslMode: "strict"`. The list begins exactly `WSL NAT — strict: apps with
egress grants are refused` and never contains `host-enforced`.

5. Strict policy `allow` count: `__________`

## 2. Cold container and binary samples

The Journal and Dashboard samples request no egress grants. Run detached so
the commands below can inspect and stop them.

```sh
SECONDS=0
"$AP" runtime run "$OUT/journal.appliance.zip" --detach
JOURNAL_COLD=$SECONDS
"$AP" runtime ps | tee "$OUT/journal-ps.txt"
"$AP" runtime logs journal | tee "$OUT/journal.log"
"$AP" runtime stop journal

SECONDS=0
"$AP" runtime run "$OUT/dashboard.appliance.zip" --detach
DASHBOARD_COLD=$SECONDS
"$AP" runtime ps | tee "$OUT/dashboard-ps.txt"
"$AP" runtime logs dashboard | tee "$OUT/dashboard.log"
"$AP" runtime stop dashboard
printf 'journal=%s dashboard=%s\n' "$JOURNAL_COLD" "$DASHBOARD_COLD"
```

Pass criterion: each app reaches `running`, has a loopback URL, produces a log,
and stops while the pool remains running. The first strict/networkless run says
its outbound traffic is dropped.

6. Journal cold-start seconds: `__________`
7. Dashboard cold-start seconds: `__________`

## 3. Notes Suite compound lifecycle

```sh
SECONDS=0
"$AP" runtime run "$OUT/notes-suite.appliance.zip" --detach
NOTES_COLD=$SECONDS
"$AP" runtime ps | tee "$OUT/notes-suite-ps.txt"
"$AP" runtime logs notes-suite --service api | tee "$OUT/notes-api.log"
"$AP" runtime logs notes-suite --service web | tee "$OUT/notes-web.log"
```

Pass criterion: root state is `running`; both `api` and `web` are `healthy`;
the web dependency starts after the API; and both service logs are non-empty.

8. Notes Suite cold-start seconds: `__________`
9. Healthy service count: `__________` (must be `2`)

## 4. Browser and Desktop app window

```sh
URL=$("$AP" runtime open notes-suite --print)
printf '%s\n' "$URL" | tee "$OUT/notes-url.txt"
curl -fsS -o "$OUT/notes-body.html" -w '%{http_code}\n' "$URL"
"$AP" runtime open notes-suite
```

Pass criterion: the printed URL is `http://127.0.0.1:<20000-29999>/...`, curl
returns 200, the default browser renders Notes Suite, and with Desktop running
the second open creates the dedicated Desktop app window pinned to the same
URL. Capture one browser and one Desktop-window screenshot.

10. Published host port: `__________`
11. Browser HTTP status: `__________` (must be `200`)

## 5. Strict refusal, then cooperative allow/deny

The temporary fixture built in Prerequisites requests `example.com:443`. After
it starts, run `wget` from its task's network namespace so both requests use the
same WSL principal path as the app.

```sh
"$AP" vm egress wsl-mode strict
set +e
STRICT_OUTPUT=$("$AP" runtime run "$OUT/egress-probe.appliance.zip" --detach 2>&1)
STRICT_RC=$?
set -e
printf '%s\n' "$STRICT_OUTPUT" | tee "$OUT/strict-refusal.txt"

"$AP" vm egress wsl-mode cooperative 2> >(tee "$OUT/cooperative-warning.txt" >&2)
"$AP" runtime run "$OUT/egress-probe.appliance.zip" --detach
TASK_PID=$("$APPLIANCE_VM" shell appliance-runtime --root -- \
  "ctr -n appliance-egress-probe tasks list | awk '\$1 == \"appliance-egress-probe\" { print \$2; exit }'")
PROXY=$("$APPLIANCE_VM" egress gateway appliance-runtime | sed -n 's/^HTTPS_PROXY=//p')
"$APPLIANCE_VM" shell appliance-runtime --root -- \
  "nsenter -t $TASK_PID -n env https_proxy=$PROXY HTTPS_PROXY=$PROXY wget -S --spider https://example.com" \
  2>&1 | tee "$OUT/proxy-allow.txt"
set +e
"$APPLIANCE_VM" shell appliance-runtime --root -- \
  "nsenter -t $TASK_PID -n env https_proxy=$PROXY HTTPS_PROXY=$PROXY wget -S --spider https://not-granted.example.test" \
  >"$OUT/proxy-deny.txt" 2>&1
DENY_RC=$?
set -e
grep -E 'HTTP/[0-9.]+ 200' "$OUT/proxy-allow.txt"
grep -E 'HTTP/[0-9.]+ 403' "$OUT/proxy-deny.txt"
printf 'strict_rc=%s deny_rc=%s\n' "$STRICT_RC" "$DENY_RC"
```

Pass criterion: strict exits non-zero with the exact setting name and
`appliance vm egress wsl-mode cooperative` remediation. Cooperative prints the
prominent bypass warning; the granted HTTPS request succeeds; the ungranted
proxy request returns 403; no direct-egress success is interpreted as policy
enforcement.

12. Strict refusal exit code: `__________` (must be non-zero)
13. Allowed HTTPS status: `__________` (must be `200`)
14. Denied HTTPS status: `__________` (must be `403`)

## 6. Cooperative policy wording

```sh
"$AP" vm egress policy --name appliance-runtime | tee "$OUT/policy-cooperative.json"
"$AP" vm egress list --name appliance-runtime | tee "$OUT/list-cooperative.txt"
```

Pass criterion: JSON remains flattened and contains the sibling
`enforcement: {backend:"wsl", bypassable:true, scope:["http","https"]}` plus
`wslMode:"cooperative"`. The list begins exactly `WSL NAT — cooperative proxy,
bypassable; direct TCP/UDP is not blocked` and never says `host-enforced`.

15. Cooperative union host count: `__________`

## 7. Pool restart and same-URL reopen

Keep Notes Suite installed and record its URL from step 4.

```sh
BEFORE=$(cat "$OUT/notes-url.txt")
"$AP" vm stop --name appliance-runtime
"$AP" vm up --name appliance-runtime
"$AP" runtime ps | tee "$OUT/after-pool-restart.txt"
AFTER=$("$AP" runtime open notes-suite --print)
printf 'before=%s\nafter=%s\n' "$BEFORE" "$AFTER"
test "$BEFORE" = "$AFTER"
```

Pass criterion: after pool restart `runtime ps` reconciles Notes Suite to
stopped, no app/listener auto-starts, `runtime open` revalidates and starts it,
and the exact loopback URL is reused.

16. Reopen seconds: `__________`
17. URL-stable result (`1` pass / `0` fail): `__________`

## 8. Mirrored networking fails fast

Stop WSL, temporarily set `%USERPROFILE%\.wslconfig` to:

```ini
[wsl2]
networkingMode=mirrored
```

Then run from PowerShell and restore NAT immediately afterward:

```powershell
wsl --shutdown
$elapsed = Measure-Command { appliance runtime open notes-suite 2>&1 | Tee-Object "$env:TEMP\ap205-mirrored.txt" }
$elapsed.TotalSeconds
```

Pass criterion: the command fails before provisioning/readiness waits, names
mirrored networking, tells the user to set `networkingMode=NAT` (or remove the
setting), and tells them to run `wsl --shutdown`. It must not approach the old
600-second timeout. Restore NAT and run `wsl --shutdown` again.

18. Mirrored-mode failure seconds: `__________` (target: under `15`)

## Owner result

Overall: `PASS / FAIL` Owner: `__________` Date: `__________`

Evidence paths: `policy-strict.json`, `list-strict.txt`, container/binary and
compound logs, browser/Desktop screenshots, `strict-refusal.txt`,
`cooperative-warning.txt`, `policy-cooperative.json`, `list-cooperative.txt`,
`after-pool-restart.txt`, and `ap205-mirrored.txt`.
