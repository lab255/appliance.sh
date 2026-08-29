# Windows live-test certification

This is the single ordered Windows 11 / WSL2 NAT owner run for the credential,
installed Desktop, and App Runtime release paths. Run every section top to
bottom as a non-admin Windows user. It covers only the assertions exercised
here; it does not claim Windows parity outside these steps.

## How to run the certification (AP-201 handoff)

Allow **60–90 minutes** after builds and sample bundles are available. Check
off the prerequisites below, run Runtime sections 0 through 11 in order, retain the
redacted transcript and artifacts under `$OUT`, then paste the completed
[Results record](#results-record) table back into the certification ticket.

For the fastest path, use **Option A**: download the `runtime-samples` artifact
from the [`runtime-samples` CI job](../.github/workflows/pr.yml), extract its
bundles into `$OUT`, and skip the local sample build. Option B builds the same
fixtures locally and requires Docker.

## Prerequisites checklist

- Use WSL2 NAT, not WSL v1 or mirrored networking.
- Install the candidate NSIS desktop bundle and the same-tag standalone CLI.
- Start from a user profile containing legacy non-empty cluster credentials in
  both `~/.appliance/profiles.json` and `~/.appliance/credentials.json`, plus
  one legacy agent credential.
- Record the release tag, Windows build, `wsl.exe --version`, and SHA-256 of
  both installed `appliance-credhelper.exe` copies in R03, R04, R07, R09, and
  R10.
- Windows virtualization is enabled; `wsl.exe --status` identifies WSL 2.
- Node/pnpm, Rust, Go, Docker (Option B only), Git Bash, `curl`, `jq`, and
  `zip` are available to the Windows checkout.
- Desktop and CLI are built from the commit under test; `pnpm install`,
  `pnpm run build`, and `cargo build --release --manifest-path
packages/vm/Cargo.toml` have completed.
- Budget 60–90 minutes, plus build/download time. A first listener in the
  20000–29999 range may prompt for Windows Defender Firewall access; allow the
  private-network bind, record the prompt, and exclude prompt handling from
  Runtime startup timing.

Open Git Bash before starting the checks and keep this timer in that session:

```sh
export CERT_STARTED_AT=$(date +%s)
date +%F
```

Put the printed date in R05.

Pass: the helper hashes are identical and match the
`x86_64-pc-windows-msvc` entry in
[`credential-helper-checksums.json`](../packages/cli/scripts/credential-helper-checksums.json).
Record the digest comparison in R11.

## Credential and Desktop release checks

These checks cover the Windows claims in [`docs/desktop.md`](desktop.md) and
[`packages/desktop/README.md`](../packages/desktop/README.md).

### Installed layout and helper pipes

From PowerShell, locate the standalone and desktop-bundled CLI/helper pairs.
For each pair, confirm `appliance-credhelper.exe` is a file sibling of
`appliance.exe`. Temporarily rename one helper, run an authenticated CLI
command, restore it, and rerun the command.

Pass: the missing-helper run fails closed with no file fallback; the restored
run succeeds. Do not place any substitute helper on `PATH` or in the current
directory during the retry: neither location may be used. The automated
counterpart is
[`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts).

Exercise a test Credential Manager item whose value contains a newline,
non-ASCII text, and trailing whitespace through helper `put`/`get` stdin and
stdout pipes.

Pass: the bytes round-trip exactly, the value never appears in argv or stderr,
and missing/denied/malformed cases return their documented distinct statuses.
The Windows-only automated counterpart is
[`windows_cli.rs`](../packages/credhelper/tests/windows_cli.rs).
Record the layout/fail-closed check in R12 and the byte/status pipe check in
R13.

### Lazy migration and downgrade boundary

Run an authenticated CLI command, then inspect the two JSON files and Windows
Credential Manager.

Pass:

- every migrated cluster value is present in Credential Manager;
- `profiles.json` retains metadata with an empty secret;
- `credentials.json` retains metadata with an empty secret;
- the legacy agent file is removed only after read-back verification; and
- a second run makes no further changes.

Recreate one legacy file with bytes different from the Credential Manager
item, then run the command again.

Pass: neither value is overwritten, Credential Manager remains the read
source, and `appliance doctor` reports `conflict`. After the verified scrub,
launching an older Windows CLI must require upgrade or re-login rather than
recovering a cleartext downgrade copy. The fixture counterpart is
[`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts).
Record the migration/idempotence check in R14 and the conflict/downgrade check
in R15.

### Doctor states

Create or simulate each state in turn: `missing`, `denied`, `malformed`,
`migrated`, `conflict`, `helper-missing`, and `legacy-name`. Run `appliance
doctor` after each change; use `doctor --fix` only for a safe missing/write-back
case.

Pass: Windows shows a credential-store row for every profile—never
`not-applicable`—and each state has distinct remediation. Conflict repair does
not choose or delete either value automatically. The rendering counterpart is
[`runtime-doctor.spec.ts`](../packages/cli/src/utils/runtime-doctor.spec.ts).
Record the complete doctor-state check in R16.

### Broker files and managed WSL distro

Sign in an agent and start it once. Inspect the VM's
`egress-credentials.json`, `egress-secrets.json`, and Windows ACLs.

Pass: the generated rule contains absolute argv ending in `agent print-key
--type <agent>`, uses `capture:false`, and leaves no real agent credential in
either per-VM file. If capture is explicitly enabled for a disposable test
header, the header appears in cleartext in `egress-secrets.json`; verify that by
hand. `appliance doctor` warns for every enabled capture rule on Windows,
naming the VM, host, and cleartext residual.
Restore `capture:false` and delete the test secret afterward. The rule/capture counterparts are
[`agent.spec.ts`](../packages/cli/src/utils/agent.spec.ts) and
[`creds.rs`](../packages/vm/src/creds.rs).

Inside the managed distro, inspect `/etc/wsl.conf` and `/proc/mounts`.

Pass: `[interop] enabled=false`, `appendWindowsPath=false`, and no Windows drive
is automatically mounted. These controls do not constrain other distros or
same-user Windows execution. The configuration counterpart is
[`wsl.rs`](../packages/vm/src/backend/wsl.rs).
Record broker no-capture behavior in R17, explicit capture cleanup in R18,
and the managed-distro posture in R19.

### Credential and Desktop evidence

Attach the command transcript with secrets redacted, both helper hashes,
doctor output for every state, ACL principals, `/etc/wsl.conf`, and the NSIS
installed-file list to the release evidence. Record any failed step as a
release blocker; do not weaken the workflow digest guard or publish gating to
work around it. R60 is complete only when this evidence and the Runtime
evidence are retained.

## App Runtime owner-run certification (AP-205/AP-206)

This run satisfies [`docs/rfc/wsl-runtime.md`](rfc/wsl-runtime.md) Decision 5.
Run it from Git Bash in a clean checkout. Keep the completed Results record,
command output, timing report, and screenshots with the release evidence.

This run certifies pooled Runtime on WSL2 NAT, manifest-level strict/cooperative
gating, per-app cooperative proxy selection and revocation, loopback
publishing, and Desktop handoff. It does not certify Windows agent sandboxes,
a hard egress boundary, first-run timing, or parity with the packaged
installer.

## Prepare the host and runtime artifacts

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
sha256sum "$APPLIANCE_VM"
```

Record R01–R10 before testing. Pass criterion: every value is present,
`wsl.exe --status` identifies WSL 2, and `.wslconfig` is NAT rather than
mirrored.

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

### 0. Drive-exposure gate — before any Runtime payload runs

Run this before any `runtime run` command:

```sh
wsl.exe -d appliance-vm-appliance -u root -- sh -c 'test ! -e /mnt/c && ! grep -qE "[[:space:]]/mnt/[a-z][[:space:]]" /proc/mounts'; echo "drive_exposure_rc=$?"
```

Record R20. It must be 0; stop the run if it is non-zero.

### 1. Clean pool and strict default

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

Record R21; the strict policy `allow` count must be 0.

### 2. Cold and warm container and binary samples

Journal and Dashboard request no egress grants. A cold sample starts with the
pool stopped; its warm sample reuses the resident pool. Keep shell `time`
output with the Results record.

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

Record Journal results in R22–R27, Dashboard results in R28–R33, and the
strict first-run notice count in R34.

### 3. Notes Suite compound lifecycle

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

Record Notes Suite timings in R35–R38 and the healthy service count in R39.

### 4. Browser and Desktop app window

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

Record the URL in R40, browser result in R41, Desktop-open result in R42, and
Desktop URL comparison in R43.

### 5. Strict refusal

Fixture A copies the Journal container and requests `example.com:443`; fixture
B requests no egress.

```sh
"$AP" vm egress wsl-mode strict
set +e
STRICT_OUTPUT=$("$AP" runtime run "$OUT/egress-probe.appliance.zip" --detach 2>&1)
STRICT_RC=$?
set -e
printf '%s\n' "$STRICT_OUTPUT" | tee "$OUT/strict-refusal.txt"
```

Pass criterion: strict exits 2 with the exact setting name and
`appliance vm egress wsl-mode cooperative` remediation. Record R44.

### 6. Cooperative opt-in

The proxy URLs are read from each task's environment into shell variables and
are never printed or written to the Results record. `wget` enters the task
network namespaces so both requests traverse the WSL proxy path.

```sh
"$AP" vm egress wsl-mode cooperative
"$AP" runtime run "$OUT/egress-probe.appliance.zip" --detach \
  2> >(tee "$OUT/cooperative-warning.txt" >&2)
"$AP" runtime run "$OUT/egress-probe-b.appliance.zip" --detach
grep -c 'WSL cooperative mode is bypassable' "$OUT/cooperative-warning.txt"
```

Pass criterion: cooperative mode is an explicit opt-in and the `runtime run`
command prints the prominent bypass warning exactly once. Record R45.

### 7. Per-app allow, deny, and revocation

Continue in the same Git Bash session. The two apps must already be running
from section 6.

```sh
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

Pass criterion: App A's granted HTTPS request succeeds; the same destination
under app B's credential returns 403;
and app A's captured credential returns 407 after `runtime stop` revokes it.
The JSON and human list attribute the exact host+port grant to app A without
printing either credential. Cooperative DNS must use proxy CONNECT by hostname;
direct UDP 53 remains dropped. No direct egress success is interpreted as
policy enforcement. Record R46–R49.

```sh
"$AP" vm egress traffic --name appliance-runtime | tee "$OUT/traffic.json"
jq '[.[] | select(.decision == "deny" and .app != null and .reason == "policy")] | length' \
  "$OUT/traffic.json"
jq '[.[] | select(.reason == "proxy-auth")] | length' "$OUT/traffic.json"
jq '[.[] | select(.reason == "proxy-auth" and .principal == null)] | length' \
  "$OUT/traffic.json"
```

Record the traffic counts in R50–R52.

```sh
"$AP" runtime stop egress-probe-b
```

### 8. Cooperative policy wording

The section 7 capture supplies both files used here.

Pass criterion: JSON remains flattened and contains the sibling
`enforcement: {backend:"wsl", bypassable:true,
scope:["http","https","per-app"]}` plus `wslMode:"cooperative"` and an
`apps` block with each app's exact hosts and TCP ports. The list begins exactly
`WSL NAT - cooperative proxy, bypassable; direct TCP/UDP is not blocked`, shows
per-app rows, never exposes a proxy credential, and never says `host-enforced`.
Requests without credentials receive 407 and never inherit another app's
hosts.

Record R53. The list must literally show `egress-probe-b … (no hosts)`; only
app A may have `example.com:443`.

### 9. Pool restart and same-URL reopen

Keep Notes Suite installed and use its URL from R40.

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

Record R54–R55. Reopen targets under 15 seconds; compare with R36.

### 10. Mirrored networking fails fast, then NAT recovers

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
--print` returns R40's URL. Record R56–R57.

### 11. Final teardown

```sh
"$AP" runtime stop notes-suite 2>/dev/null || true
"$AP" runtime stop egress-probe 2>/dev/null || true
"$AP" runtime stop egress-probe-b 2>/dev/null || true
"$AP" runtime uninstall journal dashboard notes-suite 2>/dev/null || true
"$AP" runtime uninstall egress-probe 2>/dev/null || true
"$AP" runtime uninstall egress-probe-b 2>/dev/null || true
"$AP" vm egress wsl-mode strict
"$AP" vm egress wsl-mode
! grep -Eiq '(://[^/ ]*:[^/ ]*@|proxy-authorization: *basic)' "$OUT"/proxy-*.txt
"$AP" vm stop --name appliance-runtime
CERT_TOTAL_MINUTES=$(( ($(date +%s) - CERT_STARTED_AT) / 60 ))
printf 'total_minutes=%s\n' "$CERT_TOTAL_MINUTES"
```

Do not leave the certification host in cooperative mode. Confirm the final
read prints `strict`, `.wslconfig` is restored to NAT (or its original absent
state), and all evidence files under `$OUT` have been retained. Put the printed
total in R06 and record R58–R60.

## Results record

Fill only the **Actual** column. Each recorded value has one slot and an
explicit expected result; use `FAIL: <reason>` instead of omitting a failed
check. Paste this entire table back into the certification ticket.

| Slot | Result                                    | Expected                                                                                             | Actual |
| ---- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ |
| R01  | Engine SHA-256                            | 64 lowercase hex characters for `$APPLIANCE_VM`                                                      |        |
| R02  | Feature commit                            | Commit tested; short Git SHA                                                                         |        |
| R03  | WSL version                               | First `wsl.exe --version` line; WSL2-capable release                                                 |        |
| R04  | Windows build                             | Windows 11 build from `winver`                                                                       |        |
| R05  | Certification date                        | ISO `YYYY-MM-DD`                                                                                     |        |
| R06  | Total certification time                  | Elapsed minutes; expected 60–90 excluding builds and firewall-prompt handling                        |        |
| R07  | Release tag                               | Candidate Desktop/CLI tag; both installs match                                                       |        |
| R08  | Engine version                            | Non-empty `$APPLIANCE_VM --version` output                                                           |        |
| R09  | Standalone helper SHA-256                 | 64 lowercase hex characters                                                                          |        |
| R10  | Desktop helper SHA-256                    | 64 lowercase hex characters                                                                          |        |
| R11  | Helper digest comparison                  | R09 = R10 = release checksum entry                                                                   |        |
| R12  | Helper layout and missing-helper behavior | Both helpers are CLI siblings; both missing-helper retries fail closed; restored retries pass        |        |
| R13  | Helper pipe bytes and statuses            | Bytes round-trip exactly; no argv/stderr leak; missing/denied/malformed statuses differ              |        |
| R14  | Lazy migration and idempotence            | Both cluster stores scrubbed; agent file removed after read-back; second run changes nothing         |        |
| R15  | Conflict and downgrade boundary           | Neither value overwritten; doctor says `conflict`; old CLI requires upgrade/re-login                 |        |
| R16  | Doctor states                             | All seven states distinct; no `not-applicable`; conflict is not auto-repaired                        |        |
| R17  | Broker no-capture posture                 | Absolute print-key argv, `capture:false`, no real credential in either VM file                       |        |
| R18  | Explicit capture residual and cleanup     | Warning names VM/host/residual; cleartext observed, then deleted and `capture:false` restored        |        |
| R19  | Managed-distro posture                    | Interop off, Windows PATH append off, no Windows drive automount                                     |        |
| R20  | Drive-exposure gate exit                  | `0`; otherwise stop immediately                                                                      |        |
| R21  | Strict policy allow count                 | `0`                                                                                                  |        |
| R22  | Journal cold start                        | Seconds recorded                                                                                     |        |
| R23  | Journal warm start                        | Seconds recorded                                                                                     |        |
| R24  | Journal stop                              | Seconds recorded                                                                                     |        |
| R25  | Journal `vm up`                           | Seconds recorded                                                                                     |        |
| R26  | Journal cold HTTP                         | `200` and first-byte seconds recorded                                                                |        |
| R27  | Journal warm HTTP                         | `200` and first-byte seconds recorded                                                                |        |
| R28  | Dashboard cold start                      | Seconds recorded                                                                                     |        |
| R29  | Dashboard warm start                      | Seconds recorded                                                                                     |        |
| R30  | Dashboard stop                            | Seconds recorded                                                                                     |        |
| R31  | Dashboard `vm up`                         | Seconds recorded                                                                                     |        |
| R32  | Dashboard cold HTTP                       | `200` and first-byte seconds recorded                                                                |        |
| R33  | Dashboard warm HTTP                       | `200` and first-byte seconds recorded                                                                |        |
| R34  | Strict first-run notice count             | `1`                                                                                                  |        |
| R35  | Notes Suite cold start                    | Seconds recorded                                                                                     |        |
| R36  | Notes Suite warm start                    | Seconds recorded                                                                                     |        |
| R37  | Notes Suite stop                          | Seconds recorded                                                                                     |        |
| R38  | Notes Suite `vm up`                       | Seconds recorded                                                                                     |        |
| R39  | Notes Suite healthy services              | `2`                                                                                                  |        |
| R40  | Notes Suite printed URL                   | Loopback URL with port 20000–29999                                                                   |        |
| R41  | Browser HTTP                              | `200` and first-byte seconds recorded                                                                |        |
| R42  | Desktop window opened                     | `1`                                                                                                  |        |
| R43  | Desktop window URL                        | Exactly R40                                                                                          |        |
| R44  | Strict refusal exit                       | `2`, with exact setting and cooperative remediation                                                  |        |
| R45  | Cooperative bypass-warning count          | `1`                                                                                                  |        |
| R46  | App A allowed HTTPS                       | `200`                                                                                                |        |
| R47  | Same host under app B                     | `403`                                                                                                |        |
| R48  | Credential-less 407 grep exit             | `0`                                                                                                  |        |
| R49  | App A credential after stop               | `407`                                                                                                |        |
| R50  | Per-app policy-deny traffic count         | At least `1`                                                                                         |        |
| R51  | Proxy-auth-failure traffic count          | At least `2` (credential-less and revoked)                                                           |        |
| R52  | Credential-less traffic count             | At least `1`, with `principal == null`                                                               |        |
| R53  | Cooperative per-app rows                  | Count equals JSON `apps` length; B has `(no hosts)`, only A has `example.com:443`                    |        |
| R54  | Reopen time                               | Seconds recorded; target under 15, compare with R36                                                  |        |
| R55  | URL stable after pool restart             | `1`; reopened URL exactly R40                                                                        |        |
| R56  | Mirrored fail-fast time                   | Seconds recorded; fails before provisioning/readiness and far below 600 seconds                      |        |
| R57  | NAT recovery                              | `1`; WSL2/NAT restored and URL exactly R40                                                           |        |
| R58  | Final strict-mode restore                 | `1`; final read is `strict`                                                                          |        |
| R59  | Proxy evidence secret scan                | Pass; no credential URL or Basic proxy authorization match                                           |        |
| R60  | Teardown and retained evidence            | All samples stopped/uninstalled, Runtime VM stopped, NAT/original config restored, evidence retained |        |
