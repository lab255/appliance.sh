# Windows Runtime owner-run certification (AP-205)

This is the single Windows 11 / WSL2 NAT owner run required by
`docs/rfc/wsl-runtime.md` Decision 5. Run it from Git Bash in a clean checkout.
Allow 60–90 minutes after the builds and sample bundles are available. Keep the
completed worksheet, command output, timing report, and screenshots with the
release evidence.

This run certifies pooled Runtime on WSL2 NAT, manifest-level strict/cooperative
gating, loopback publishing, and Desktop handoff. It does not certify Windows
agent sandboxes, per-app policy enforcement planned for 3b, first-run timing,
or parity with the packaged installer.

## Prerequisites and worksheet

- Windows 11 with virtualization enabled in firmware. In an elevated
  PowerShell, enable WSL2 if needed, then reboot:

  ```powershell
  dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
  dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
  wsl --set-default-version 2
  ```

- Use WSL NAT. Create or edit `%USERPROFILE%\.wslconfig` exactly as follows,
  then run `wsl --shutdown` before the test:

  ```ini
  [wsl2]
  networkingMode=NAT
  ```

- `wsl.exe --status` must identify WSL 2. Docker Desktop may remain running;
  its `docker-desktop` WSL distros must coexist with the Appliance distros.
- Node/pnpm, Rust, Go, Docker, Git Bash, `curl`, `jq`, and `zip` must be
  available to the Windows checkout. Desktop and CLI must be built from the
  AP-205 commit under test.
- `pnpm install`, `pnpm run build`, and `cargo build --release
--manifest-path packages/vm/Cargo.toml` must have completed.
- The first listener in the 20000–29999 range can trigger a Windows Defender
  Firewall prompt. Allow the private-network bind; record any prompt and do
  not count prompt-handling time as Runtime startup time.
- Obtain the sample bundles by one of these routes:
  - Option A: download the `runtime-samples` CI artifact and extract its
    bundles into `$OUT`.
  - Option B: build locally with
    `OUT="$OUT" scripts/build-runtime-samples.sh --require-docker`.

Set the release engine and CLI before obtaining the samples:

```sh
export APPLIANCE_VM="$PWD/packages/vm/target/release/appliance-vm.exe"
export AP="$PWD/packages/cli/dist/appliance"
export OUT="$PWD/.tmp/ap-205-runtime-samples"
mkdir -p "$OUT"
wsl.exe --version
wsl.exe --status
"$APPLIANCE_VM" --version
git rev-parse --short HEAD
```

Record these values before testing:

1. Windows build (`winver`): `__________`
2. `wsl.exe --version` first version line: `__________`
3. Engine version (`$APPLIANCE_VM --version`): `__________`
4. Feature commit (`git rev-parse --short HEAD`): `__________`

Pass criterion: all four values are present, `wsl.exe --status` identifies WSL
2, and `.wslconfig` is NAT rather than mirrored.

Build the cooperative fixture after the selected sample option has populated
`$OUT`. This copies the container sample; it is not a binary fixture.

```sh
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

PROBE_B_SRC="$PWD/examples/runtime/.ap206-egress-probe-b"
rm -rf "$PROBE_B_SRC"
cp -R examples/runtime/journal "$PROBE_B_SRC"
node --input-type=module - "$PROBE_B_SRC/appliance.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2];
const manifest = JSON.parse(readFileSync(file, 'utf8'));
manifest.name = 'egress-probe-b';
manifest.description = 'AP-206 per-app egress isolation probe without grants';
manifest.network = { egress: [] };
writeFileSync(file, JSON.stringify(manifest, null, 2));
NODE
"$PROBE_B_SRC/build-bundle.sh" "$OUT/egress-probe-b.appliance.zip"
rm -rf "$PROBE_B_SRC"
```

## 0. Drive-exposure gate — before any payload runs

Run this before any `runtime run` command:

```sh
wsl.exe -d appliance-vm-appliance -u root -- sh -c 'test ! -e /mnt/c && ! grep -qE "[[:space:]]/mnt/[a-z][[:space:]]" /proc/mounts'; echo "drive_exposure_rc=$?"
```

0. Drive-exposure check exit code: `____` (must be 0; stop the run if non-zero)

## 1. Clean pool and strict default

```sh
"$AP" runtime stop journal 2>/dev/null || true
"$AP" runtime stop dashboard 2>/dev/null || true
"$AP" runtime stop notes-suite 2>/dev/null || true
"$AP" runtime stop egress-probe 2>/dev/null || true
"$AP" runtime stop egress-probe-b 2>/dev/null || true
"$AP" runtime uninstall journal dashboard notes-suite || true
"$AP" runtime uninstall egress-probe 2>/dev/null || true
"$AP" runtime uninstall egress-probe-b 2>/dev/null || true
"$AP" vm stop --name appliance-runtime 2>/dev/null || true
"$AP" vm egress wsl-mode strict
"$AP" vm egress policy --name appliance-runtime | tee "$OUT/policy-strict.json"
"$AP" vm egress list --name appliance-runtime | tee "$OUT/list-strict.txt"
```

Pass criterion: policy JSON says `boundary: "cooperative"`,
`enforcement.backend: "wsl"`, `enforcement.bypassable: true`, and
`wslMode: "strict"`. The list begins exactly `WSL NAT - strict: apps with
egress grants are refused` and never contains `host-enforced`.

5. Strict policy `allow` count: `__________` (must be 0 in strict)

## 2. Cold and warm container and binary samples

Journal and Dashboard request no egress grants. A cold sample starts with the
pool stopped; its warm sample reuses the resident pool. Keep shell `time`
output with the worksheet.

```sh
"$AP" vm stop --name appliance-runtime 2>/dev/null || true
time "$AP" runtime run "$OUT/journal.appliance.zip" --detach \
  2> >(tee "$OUT/journal-first-run.txt" >&2)
"$AP" runtime ps | tee "$OUT/journal-cold-ps.txt"
"$AP" runtime logs journal | tee "$OUT/journal.log"
JOURNAL_URL=$("$AP" runtime open journal --print)
curl -fsS -o "$OUT/journal.body" -w '%{http_code} %{time_total}\n' "$JOURNAL_URL" | tee "$OUT/journal-cold-http.txt"
time "$AP" runtime stop journal
time "$AP" vm up --name appliance-runtime
time "$AP" runtime run "$OUT/journal.appliance.zip" --detach
JOURNAL_URL=$("$AP" runtime open journal --print)
curl -fsS -o "$OUT/journal-warm.body" -w '%{http_code} %{time_total}\n' "$JOURNAL_URL" | tee "$OUT/journal-warm-http.txt"
grep -c 'WSL strict mode: this app requests no egress grants' "$OUT/journal-first-run.txt"
time "$AP" runtime stop journal

"$AP" vm stop --name appliance-runtime
time "$AP" runtime run "$OUT/dashboard.appliance.zip" --detach
"$AP" runtime ps | tee "$OUT/dashboard-cold-ps.txt"
"$AP" runtime logs dashboard | tee "$OUT/dashboard.log"
DASHBOARD_URL=$("$AP" runtime open dashboard --print)
curl -fsS -o "$OUT/dashboard.body" -w '%{http_code} %{time_total}\n' "$DASHBOARD_URL" | tee "$OUT/dashboard-cold-http.txt"
time "$AP" runtime stop dashboard
time "$AP" vm up --name appliance-runtime
time "$AP" runtime run "$OUT/dashboard.appliance.zip" --detach
DASHBOARD_URL=$("$AP" runtime open dashboard --print)
curl -fsS -o "$OUT/dashboard-warm.body" -w '%{http_code} %{time_total}\n' "$DASHBOARD_URL" | tee "$OUT/dashboard-warm-http.txt"
time "$AP" runtime stop dashboard
```

Pass criterion: each app reaches `running`, has a loopback URL, returns HTTP
200, logs output, and stops while the pool remains running. The first
strict/networkless install prints its outbound-traffic notice exactly once.

6. Journal — cold seconds: `____`; warm seconds: `____`; stop seconds: `____`;
   `vm up` seconds: `____`; cold HTTP status/first-byte seconds: `____ / ____`;
   warm HTTP status/first-byte seconds: `____ / ____`
7. Dashboard — cold seconds: `____`; warm seconds: `____`; stop seconds:
   `____`; `vm up` seconds: `____`; cold HTTP status/first-byte seconds:
   `____ / ____`; warm HTTP status/first-byte seconds: `____ / ____`

Strict first-run notice present (1/0): `____`

## 3. Notes Suite compound lifecycle

```sh
"$AP" vm stop --name appliance-runtime
time "$AP" runtime run "$OUT/notes-suite.appliance.zip" --detach
"$AP" runtime ps | tee "$OUT/notes-suite-cold-ps.txt"
"$AP" runtime logs notes-suite --service api | tee "$OUT/notes-api.log"
"$AP" runtime logs notes-suite --service web | tee "$OUT/notes-web.log"
time "$AP" runtime stop notes-suite
time "$AP" vm up --name appliance-runtime
time "$AP" runtime run "$OUT/notes-suite.appliance.zip" --detach
"$APPLIANCE_VM" timings appliance-runtime | tee "$OUT/timings.txt"
```

Pass criterion: root state is `running`; both `api` and `web` are `healthy`;
the web dependency starts after the API; both service logs are non-empty; and
`timings.txt` contains phase and total timings comparable with
`docs/live-test-runbook.md`.

8. Notes Suite — cold seconds: `____`; warm seconds: `____`; stop seconds:
   `____`; `vm up` seconds: `____`
9. Healthy service count: `__________` (must be 2)

## 4. Browser and Desktop app window

Close Appliance Desktop before the first open so it exercises browser
fallback.

```sh
URL=$("$AP" runtime open notes-suite --print)
printf '%s\n' "$URL" | tee "$OUT/notes-url.txt"
curl -fsS -o "$OUT/notes-suite.body" -w '%{http_code} %{time_total}\n' "$URL" | tee "$OUT/notes-http.txt"
"$AP" runtime open notes-suite
```

Launch the Desktop app and wait until its main window is ready. Then run the
second open:

```sh
"$AP" runtime open notes-suite
```

Pass criterion: the printed URL is `http://127.0.0.1:<20000-29999>/...`, curl
returns 200, the first open renders in the default browser, and the second open
creates the dedicated Desktop app window at exactly the same URL. Capture one
browser and one Desktop-window screenshot.

10. Notes Suite printed URL: `________________________________________`
11. Browser HTTP status / first-byte seconds: `__________ / __________`

Desktop window opened (1/0): `____`

Desktop window URL (must equal item 10's URL): `________________________________________`

## 5. Strict refusal, then cooperative allow/deny

Fixture A copies the Journal container and requests `example.com:443`; fixture
B requests no egress. The proxy URLs are read from each task's environment into
shell variables and are never printed or written to the worksheet. `wget`
enters the task network namespaces so both requests traverse the WSL proxy path.

```sh
"$AP" vm egress wsl-mode strict
set +e
STRICT_OUTPUT=$("$AP" runtime run "$OUT/egress-probe.appliance.zip" --detach 2>&1)
STRICT_RC=$?
set -e
printf '%s\n' "$STRICT_OUTPUT" | tee "$OUT/strict-refusal.txt"

"$AP" vm egress wsl-mode cooperative
"$AP" runtime run "$OUT/egress-probe.appliance.zip" --detach \
  2> >(tee "$OUT/cooperative-warning.txt" >&2)
"$AP" runtime run "$OUT/egress-probe-b.appliance.zip" --detach
grep -c 'WSL cooperative mode is bypassable' "$OUT/cooperative-warning.txt"
TASK_A_PID=$("$APPLIANCE_VM" shell appliance-runtime --root -- \
  "ctr -n appliance-egress-probe tasks list | awk '\$1 == \"appliance-egress-probe\" { print \$2; exit }'")
TASK_B_PID=$("$APPLIANCE_VM" shell appliance-runtime --root -- \
  "ctr -n appliance-egress-probe-b tasks list | awk '\$1 == \"appliance-egress-probe-b\" { print \$2; exit }'")
PROXY_A=$("$APPLIANCE_VM" shell appliance-runtime --root -- \
  "tr '\\0' '\\n' </proc/$TASK_A_PID/environ | sed -n 's/^HTTPS_PROXY=//p' | head -n1")
PROXY_B=$("$APPLIANCE_VM" shell appliance-runtime --root -- \
  "tr '\\0' '\\n' </proc/$TASK_B_PID/environ | sed -n 's/^HTTPS_PROXY=//p' | head -n1")
test -n "$PROXY_A" && test -n "$PROXY_B" && test "$PROXY_A" != "$PROXY_B"
"$APPLIANCE_VM" shell appliance-runtime --root -- \
  "nsenter -t $TASK_A_PID -n env https_proxy='$PROXY_A' HTTPS_PROXY='$PROXY_A' wget -S --spider https://example.com" \
  2>&1 | tee "$OUT/proxy-allow.txt"
set +e
"$APPLIANCE_VM" shell appliance-runtime --root -- \
  "nsenter -t $TASK_B_PID -n env https_proxy='$PROXY_B' HTTPS_PROXY='$PROXY_B' wget -S --spider https://example.com" \
  >"$OUT/proxy-cross-app-deny.txt" 2>&1
CROSS_APP_RC=$?
set -e
grep -E 'HTTP/[0-9.]+ 200' "$OUT/proxy-allow.txt"
grep -E 'HTTP/[0-9.]+ 403' "$OUT/proxy-cross-app-deny.txt"

set +e
"$APPLIANCE_VM" shell appliance-runtime --root -- \
  "nsenter -t $TASK_A_PID -n env https_proxy='http://${PROXY_A#*@}' wget -S --spider https://example.com 2>&1 | grep -E 'HTTP/1\.[01] 407'" \
  >"$OUT/proxy-credentialless.txt" 2>&1
CREDENTIALLESS_RC=$?
set -e
test "$CREDENTIALLESS_RC" -eq 0

"$AP" vm egress policy --name appliance-runtime | tee "$OUT/policy-cooperative.json"
"$AP" vm egress list --name appliance-runtime | tee "$OUT/list-cooperative.txt"
jq -e '.enforcement.scope == ["http","https","per-app"]' "$OUT/policy-cooperative.json"
jq -e '.apps[] | select(.app == "egress-probe") | .hosts[] | select(.host == "example.com" and .ports == [443])' \
  "$OUT/policy-cooperative.json"

REVOKED_PROXY="$PROXY_A"
"$AP" runtime stop egress-probe
set +e
"$APPLIANCE_VM" shell appliance-runtime --root -- \
  "nsenter -t $TASK_B_PID -n env https_proxy='$REVOKED_PROXY' HTTPS_PROXY='$REVOKED_PROXY' wget -S --spider https://example.com" \
  >"$OUT/proxy-revoked.txt" 2>&1
REVOKED_RC=$?
set -e
grep -E 'HTTP/[0-9.]+ 407' "$OUT/proxy-revoked.txt"
unset PROXY_A PROXY_B REVOKED_PROXY
printf 'strict_rc=%s cross_app_rc=%s credentialless_rc=%s revoked_rc=%s\n' \
  "$STRICT_RC" "$CROSS_APP_RC" "$CREDENTIALLESS_RC" "$REVOKED_RC"

```

Pass criterion: strict exits 2 with the exact setting name and
`appliance vm egress wsl-mode cooperative` remediation. The `runtime run`
command prints the prominent bypass warning exactly once. App A's granted HTTPS
request succeeds; the same destination under app B's credential returns 403;
and app A's captured credential returns 407 after `runtime stop` revokes it.
The JSON and human list attribute the exact host+port grant to app A without
printing either credential. Cooperative DNS must use proxy CONNECT by hostname;
direct UDP 53 remains dropped. No direct egress success is interpreted as
policy enforcement.

12. Strict refusal exit code: `__________` (must be 2)
13. Allowed HTTPS status: `__________` (must be 200)
14. Same host under app B status: `__________` (must be 403)
15. App A credential after stop status: `__________` (must be 407)

Credential-less 407 grep exit: `__________` (must be 0)

```sh
"$AP" vm egress traffic --name appliance-runtime | tee "$OUT/traffic.json"
jq '[.[] | select(.decision == "deny" and .app != null and .reason == "policy")] | length' \
  "$OUT/traffic.json"
jq '[.[] | select(.reason == "proxy-auth")] | length' "$OUT/traffic.json"
jq '[.[] | select(.reason == "proxy-auth" and .principal == null)] | length' \
  "$OUT/traffic.json"
```

Per-app deny count: `__________`

Proxy-auth-failure count: `__________`

Credential-less count (`principal == null`): `__________`

```sh
"$AP" runtime stop egress-probe-b
```

Bypass-warning line count: `____` (must be 1)

## 6. Cooperative policy wording

The section 5 capture supplies both files used here.

Pass criterion: JSON remains flattened and contains the sibling
`enforcement: {backend:"wsl", bypassable:true,
scope:["http","https","per-app"]}` plus `wslMode:"cooperative"` and an
`apps` block with each app's exact hosts and TCP ports. The list begins exactly
`WSL NAT - cooperative proxy, bypassable; direct TCP/UDP is not blocked`, shows
per-app rows, never exposes a proxy credential, and never says `host-enforced`.
Requests without credentials receive 407 and never inherit another app's
hosts.

16. Per-app rows with expected host+port (count): `__________` (must literally show `egress-probe-b … (no hosts)`; only app A has `example.com:443`)

## 7. Pool restart and same-URL reopen

Keep Notes Suite installed and record its URL from item 10.

```sh
BEFORE=$(cat "$OUT/notes-url.txt")
"$AP" vm stop --name appliance-runtime
time "$AP" vm up --name appliance-runtime
"$AP" runtime ps | tee "$OUT/after-pool-restart.txt"
SECONDS=0
AFTER=$("$AP" runtime open notes-suite --print)
REOPEN_SECONDS=$SECONDS
printf 'before=%s\nafter=%s\nreopen_seconds=%s\n' "$BEFORE" "$AFTER" "$REOPEN_SECONDS"
test "$BEFORE" = "$AFTER"
```

Pass criterion: after pool restart `runtime ps` reconciles Notes Suite to
stopped, no app/listener auto-starts, `runtime open` revalidates and starts it,
and the exact loopback URL is reused.

17. Reopen seconds: `__________` (target under 15s, compare to item 8)
18. URL-stable result (1 pass / 0 fail): `__________`

## 8. Mirrored networking fails fast, then NAT recovers

From PowerShell, preserve the current NAT configuration, write the mirrored
negative-test configuration, and use the `$AP` variable rather than a bare
`appliance` command:

```powershell
$AP = $env:AP
$OUT = $env:OUT
$WslConfig = "$env:USERPROFILE\.wslconfig"
$WslBackup = "$env:TEMP\ap205-wslconfig-backup"
if (Test-Path $WslConfig) { Copy-Item $WslConfig $WslBackup -Force }
@"
[wsl2]
networkingMode=mirrored
"@ | Set-Content -Encoding ascii $WslConfig
wsl --shutdown
$elapsed = Measure-Command { & $AP runtime open notes-suite 2>&1 | Tee-Object "$OUT\mirrored.txt" }
$elapsed.TotalSeconds

if (Test-Path $WslBackup) {
  Copy-Item $WslBackup $WslConfig -Force
  Remove-Item $WslBackup
} else {
  Remove-Item $WslConfig
}
wsl --shutdown
wsl.exe --status
$Recovered = & $AP runtime open notes-suite --print
$Expected = (Get-Content "$OUT\notes-url.txt" -Raw).Trim()
$Recovered
if ($Recovered -ne $Expected) { throw "post-NAT URL changed" }
```

Pass criterion: mirrored mode fails before provisioning/readiness waits, names
mirrored networking, tells the user to set `networkingMode=NAT` (or remove the
setting), and tells them to run `wsl --shutdown`. It must not approach the old
600-second timeout. After restoring `.wslconfig`, `wsl --shutdown` and
`wsl.exe --status` confirm NAT/WSL2, and `"$AP" runtime open notes-suite
--print` returns item 10's URL.

Mirrored fail-fast seconds: `__________`

Post-mirrored NAT recovery (1/0): `__________`

## 9. Final teardown

```sh
"$AP" runtime stop notes-suite 2>/dev/null || true
"$AP" runtime stop egress-probe 2>/dev/null || true
"$AP" runtime stop egress-probe-b 2>/dev/null || true
"$AP" runtime uninstall egress-probe 2>/dev/null || true
"$AP" runtime uninstall egress-probe-b 2>/dev/null || true
"$AP" vm egress wsl-mode strict
"$AP" vm egress wsl-mode
! grep -Eiq '(://[^/ ]*:[^/ ]*@|proxy-authorization: *basic)' "$OUT"/proxy-*.txt
```

Final strict-mode restore confirmed (1/0): `__________`

Do not leave the certification host in cooperative mode. Confirm the final
read prints `strict`, `.wslconfig` is restored to NAT (or its original absent
state), and all evidence files under `$OUT` have been retained.
