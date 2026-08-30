# Windows live-test certification

This is the single ordered Windows 11 / WSL2 NAT owner run for the credential,
installed Desktop, and App Runtime release paths. Run every section top to
bottom as a non-admin Windows user. It covers only the assertions exercised
here; it does not claim Windows parity outside these steps.

## How to run the certification (AP-201 handoff)

Allow **90–120 minutes** after builds and sample bundles are available. Check
off the prerequisites below, run every section in order, retain the
redacted transcript and artifacts under `$OUT`, then paste the completed
[Results record](#results-record) table back into the certification ticket.

For the fastest path, use **Option A**: download the `runtime-samples` artifact
from the [`runtime-samples` CI job](../.github/workflows/pr.yml), extract its
bundles into `$OUT`, and skip the local sample build. Option B builds those
sample bundles locally. Docker with `buildx` is required under either option
to build the section 7 egress-probe fixtures.

## Prerequisites checklist

- Use WSL2 NAT, not WSL v1 or mirrored networking.
- Have the candidate NSIS desktop bundle and same-tag standalone CLI package
  ready; the timed NSIS installation is R09.
- Set `APPLIANCE_RELEASE_TAG` in Git Bash and
  `APPLIANCE_NSIS_INSTALLER` in PowerShell to that tag and the installer's
  absolute path. Extract the immediately previous standalone CLI to
  `$OUT\previous-release\appliance.exe` for R16.
- Start from a user profile containing legacy non-empty cluster credentials in
  both `~/.appliance/profiles.json` and `~/.appliance/credentials.json`, plus
  one legacy agent credential.
- Record the release tag, Windows build, `wsl.exe --version`, and SHA-256 of
  both installed `appliance-credhelper.exe` copies in R03, R04, R07, R10, and
  R11.
- Windows virtualization is enabled; `wsl.exe --status` identifies WSL 2.
- Node/pnpm, Rust, Go, Docker with `buildx`, Git Bash, `curl`, `jq`, and
  `zip` are available to the Windows checkout.
- Desktop and CLI are built from the commit under test; `pnpm install`,
  `pnpm run build`, and `cargo build --release --manifest-path
packages/vm/Cargo.toml` have completed.
- Budget 90–120 minutes, plus build/download time. A first listener in the
  20000–29999 range may prompt for Windows Defender Firewall access; allow the
  private-network bind, record the prompt, and exclude prompt handling from
  Runtime startup timing.
- The timed imports below expect the Appliance guest image to be cached. If
  this owner observes its first-ever image download, note its seconds
  separately and exclude them from R24/R31.

Open Git Bash before starting the checks and keep this timer in that session:

```sh
export CERT_STARTED_AT=$(date +%s)
date +%F
```

Put the printed date in R05.

## App Runtime owner-run certification (AP-205/AP-206)

This run satisfies [`docs/rfc/wsl-runtime.md`](rfc/wsl-runtime.md) Decision 5.
Run it from Git Bash in a clean checkout. Keep the completed Results record,
command output, timing report, and screenshots with the release evidence.

When completed, this run certifies pooled Runtime on WSL2 NAT, manifest-level strict/cooperative
gating, per-app cooperative proxy selection and revocation, loopback
publishing, and Desktop handoff. It does not certify Windows agent sandboxes or
a hard egress boundary.

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
export AP="$PWD/packages/cli/dist/appliance.exe"
export OUT="$PWD/.tmp/ap-205-runtime-samples"
mkdir -p "$OUT"
sha256sum "$APPLIANCE_VM"                                                        # R01
git rev-parse --short HEAD                                                        # R02
wsl.exe --version                                                                # R03
powershell.exe -NoProfile -Command 'Get-ComputerInfo OsName,OsVersion,WindowsBuildLabEx' # R04
printf 'release_tag=%s\n' "$APPLIANCE_RELEASE_TAG"                               # R07
"$APPLIANCE_VM" --version                                                        # R08
wsl.exe --status
```

`pnpm --filter @appliance.sh/cli run compile` is the script that produces
`packages/cli/dist/appliance.exe` on Windows. Record R01–R08 before testing.
Pass criterion: every value is present,
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

## Credential and Desktop release checks

These commands exercise the claims in [`docs/desktop.md`](desktop.md) and
[`packages/desktop/README.md`](../packages/desktop/README.md). Run each block
from PowerShell in the checkout; use a disposable `ap200-live` profile/item.

### Installed bundle, layout, hashes, and fail-closed helper lookup

```powershell
$OUT = "$PWD\.tmp\ap-205-runtime-samples"
$Installer = Get-Item $env:APPLIANCE_NSIS_INSTALLER
$install = Measure-Command {
  $p = Start-Process $Installer.FullName -ArgumentList '/S' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "NSIS install exited $($p.ExitCode)" }
}
$DesktopCli = Get-ChildItem "$env:LOCALAPPDATA\Programs",$env:ProgramFiles -Filter appliance.exe -Recurse -ErrorAction SilentlyContinue |
  Where-Object FullName -Match 'Appliance' | Select-Object -First 1 -ExpandProperty FullName
$DesktopHelper = Join-Path (Split-Path $DesktopCli) 'appliance-credhelper.exe'
$GlobalPnpmRoot = (& pnpm root --global).Trim()
$StandaloneDir = Join-Path $GlobalPnpmRoot '@appliance.sh\cli\bin'
$StandaloneCli = Join-Path $StandaloneDir 'appliance-bin.exe'
$StandaloneHelper = Join-Path $StandaloneDir 'appliance-credhelper.exe'
$freshVersion = & powershell.exe -NoProfile -Command "appliance --version"
if ($LASTEXITCODE -ne 0 -or -not $freshVersion) { throw 'fresh shell did not resolve appliance from PATH' }
"install_seconds=$($install.TotalSeconds) fresh_version=$freshVersion" # R09
"standalone_cli=$StandaloneCli standalone_helper=$StandaloneHelper"
"desktop_cli=$DesktopCli desktop_helper=$DesktopHelper"
Get-ChildItem (Split-Path $DesktopCli) -Recurse | Select-Object FullName,Length | Tee-Object "$OUT\nsis-installed-files.txt"

$StandaloneHash = (Get-FileHash $StandaloneHelper -Algorithm SHA256).Hash.ToLowerInvariant()
$DesktopHash = (Get-FileHash $DesktopHelper -Algorithm SHA256).Hash.ToLowerInvariant()
$Checksums = Get-Content packages/cli/scripts/credential-helper-checksums.json -Raw | ConvertFrom-Json
$ExpectedHash = $Checksums.digests.'x86_64-pc-windows-msvc'
"standalone_hash=$StandaloneHash" # R10
"desktop_hash=$DesktopHash"       # R11
"expected_hash=$ExpectedHash hashes_equal=$($StandaloneHash -eq $DesktopHash -and $DesktopHash -eq $ExpectedHash)" # R12

foreach ($Pair in @(@($StandaloneCli,$StandaloneHelper),@($DesktopCli,$DesktopHelper))) {
  if ((Split-Path $Pair[0]) -ne (Split-Path $Pair[1])) { throw "helper is not a CLI sibling" }
  Rename-Item $Pair[1] "$($Pair[1]).disabled"
  try {
    & $Pair[0] whoami 2>&1 | Tee-Object "$OUT\missing-helper-$([IO.Path]::GetFileName((Split-Path $Pair[0]))).txt"
    "missing_helper_rc=$LASTEXITCODE"
    if ($LASTEXITCODE -eq 0) { throw "missing helper did not fail closed" }
  } finally { Rename-Item "$($Pair[1]).disabled" $Pair[1] }
  & $Pair[0] whoami
  if ($LASTEXITCODE -ne 0) { throw "restored helper failed" }
}
```

R10 is the standalone hash, R11 the Desktop hash, R12 the comparison against
the release checksum, and R13 the two sibling/fail-closed trials. Do not put a
substitute helper on `PATH` or in the working directory. The counterpart is
[`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts).

### Raw helper pipes

```powershell
$Item = 'ap200-live'
$Input = "$OUT\helper-input.bin"
$RoundTrip = "$OUT\helper-output.bin"
[IO.File]::WriteAllBytes($Input,[Text.UTF8Encoding]::new($false).GetBytes("line1`n雪  "))
$put = Start-Process $StandaloneHelper -ArgumentList @('cluster','put','--profile',$Item) -RedirectStandardInput $Input -Wait -PassThru
$get = Start-Process $StandaloneHelper -ArgumentList @('cluster','get','--profile',$Item) -RedirectStandardOutput $RoundTrip -Wait -PassThru
"put_rc=$($put.ExitCode) get_rc=$($get.ExitCode) bytes_equal=$([Linq.Enumerable]::SequenceEqual([IO.File]::ReadAllBytes($Input),[IO.File]::ReadAllBytes($RoundTrip)))"
& $StandaloneHelper cluster get --profile ap200-absent 2> "$OUT\helper-missing.txt"; "missing_rc=$LASTEXITCODE"
cargo test -p appliance-credhelper exit_code_matrix_is_closed_and_fail_closed | Tee-Object "$OUT\helper-denied-malformed-matrix.txt"
& $StandaloneHelper cluster delete --profile $Item
```

Pass: newline, non-ASCII, and trailing whitespace bytes round-trip exactly;
the value never appears in argv or stderr; and missing, denied, and malformed
statuses differ. Record R14. The Windows counterpart is
[`windows_cli.rs`](../packages/credhelper/tests/windows_cli.rs).

### Lazy migration, conflict, downgrade, and doctor states

```powershell
$ApplianceDir = Join-Path $env:USERPROFILE '.appliance'
$Profiles = Join-Path $ApplianceDir 'profiles.json'
$Legacy = Join-Path $ApplianceDir 'credentials.json'
$AgentLegacy = Join-Path $ApplianceDir 'agent\anthropic-key'
Copy-Item $Profiles "$OUT\profiles.before.json" -Force
Copy-Item $Legacy "$OUT\credentials.before.json" -Force
if (Test-Path $AgentLegacy) { Copy-Item $AgentLegacy "$OUT\agent-credentials.before.json" -Force }
& $StandaloneCli whoami
& $StandaloneCli agent print-key --type claude-code | Out-Null
Get-Content $Profiles,$Legacy | Tee-Object "$OUT\credential-files.after-first.txt"
Get-FileHash $Profiles,$Legacy -Algorithm SHA256 | Tee-Object "$OUT\migration-first.hashes"
& $StandaloneCli whoami
Get-FileHash $Profiles,$Legacy -Algorithm SHA256 | Tee-Object "$OUT\migration-second.hashes"
Compare-Object (Get-Content "$OUT\migration-first.hashes") (Get-Content "$OUT\migration-second.hashes")

$ProfileDoc = Get-Content $Profiles -Raw | ConvertFrom-Json
$Profile = $ProfileDoc.activeProfile
$ProfileDoc.profiles.$Profile.secret = 'different-disposable-file-value'
[IO.File]::WriteAllText($Profiles,($ProfileDoc | ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
& $StandaloneCli whoami
& $StandaloneCli doctor | Tee-Object "$OUT\doctor-conflict.txt"
& "$OUT\previous-release\appliance.exe" whoami 2>&1 | Tee-Object "$OUT\downgrade.txt"
```

Pass R15: every cluster value migrated to Credential Manager, both JSON stores
retain metadata with empty secrets, the legacy agent file disappears only
after read-back, and the second command changes nothing. Pass R16: a different
legacy value is not overwritten, Credential Manager stays the read source,
doctor says `conflict`, and the prior CLI requires upgrade or re-login rather
than recovering cleartext. Restore the pre-run files after R17. The automated
counterpart is
[`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts).

Use these literal one-liners to produce the seven R17 doctor states, saving
each output. `$Profile` and the backups above remain set.

```powershell
& $StandaloneHelper cluster delete --profile $Profile; & $StandaloneCli doctor | Tee-Object "$OUT\doctor-missing.txt"
$d=Get-Content "$OUT\profiles.before.json" -Raw|ConvertFrom-Json; $payload=@{id=$d.profiles.$Profile.keyId;secret=$d.profiles.$Profile.secret}|ConvertTo-Json -Compress; $payload|& $StandaloneHelper cluster put --profile $Profile; Copy-Item "$OUT\profiles.before.json" $Profiles -Force; & $StandaloneCli doctor | Tee-Object "$OUT\doctor-migrated.txt"
pnpm exec vitest run packages/cli/src/utils/credential-store.spec.ts -t 'reports malformed and conflicting Windows profile entries distinctly' | Tee-Object "$OUT\doctor-malformed.txt"
$d=Get-Content $Profiles -Raw|ConvertFrom-Json; $d.profiles.$Profile.secret='different-file-value'; [IO.File]::WriteAllText($Profiles,($d|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false)); & $StandaloneCli doctor | Tee-Object "$OUT\doctor-conflict.txt"
Rename-Item $StandaloneHelper "$StandaloneHelper.disabled"; try { & $StandaloneCli doctor | Tee-Object "$OUT\doctor-helper-missing.txt" } finally { Rename-Item "$StandaloneHelper.disabled" $StandaloneHelper }
pnpm exec vitest run packages/cli/src/utils/runtime-doctor.spec.ts -t 'degrades to informational when macOS denies the Keychain read' | Tee-Object "$OUT\doctor-denied.txt"
pnpm exec vitest run packages/cli/src/utils/runtime-doctor.spec.ts -t 'reports a legacy Keychain account name without migrating it from doctor' | Tee-Object "$OUT\doctor-legacy-name.txt"
Copy-Item "$OUT\profiles.before.json" $Profiles -Force; Copy-Item "$OUT\credentials.before.json" $Legacy -Force
```

The `denied`, `malformed`, and `legacy-name` rows use their deterministic
simulators because the supported Credential Manager/helper interface cannot
write a corrupt item or ask the current owner to deny itself. The other four
rows are live mutations. All seven commands still run in this owner session.

Pass: Windows renders a credential-store row for every profile, never
`not-applicable`; every state and remediation is distinct; conflict repair
does not choose or delete either value. Use `doctor --fix` only for a safe
missing/write-back state. The rendering counterpart is
[`runtime-doctor.spec.ts`](../packages/cli/src/utils/runtime-doctor.spec.ts).

### Broker files and managed WSL distro

Sign in with a disposable agent credential and start once only to generate the
broker rule; this is credential-posture evidence, not certification of Windows
agent sandboxes.

```powershell
& $DesktopCli agent login --type codex
& $DesktopCli agent start --type codex --autonomous --wait --task 'Reply OK'
$VmRoot = Join-Path $ApplianceDir 'vm\appliance'
$Broker = Join-Path $VmRoot 'egress-credentials.json'
$Secrets = Join-Path $VmRoot 'egress-secrets.json'
Get-Content $Broker | Tee-Object "$OUT\egress-credentials.json"
if (Test-Path $Secrets) { Get-Content $Secrets | Tee-Object "$OUT\egress-secrets.json" }
$AclPaths = @($Broker,$Secrets) | Where-Object { Test-Path $_ }
$AclPaths | ForEach-Object { icacls $_ } | Tee-Object "$OUT\broker-icacls.txt"
$AclPaths | ForEach-Object { Get-Acl $_ } | Format-List Path,Owner,Access | Tee-Object "$OUT\broker-acl.txt"
& $DesktopCli doctor | Tee-Object "$OUT\doctor-broker.txt"
```

Pass R18: the rule's absolute argv ends in `agent print-key --type codex`,
uses `capture:false`, and neither file contains a real credential. Pass R19:
after the following disposable capture check, the header is visible in
`egress-secrets.json` and doctor names VM, host, and cleartext residual; then
the commands restore `capture:false` and delete the test secret.

```powershell
& $DesktopCli vm creds add ap200.invalid --name appliance --capture --header x-ap200
& $DesktopCli vm creds set ap200.invalid disposable-ap200-value --name appliance --header x-ap200
Get-Content $Secrets | Select-String 'disposable-ap200-value'
& $DesktopCli doctor | Tee-Object "$OUT\doctor-capture.txt"
& $DesktopCli vm creds rm ap200.invalid --name appliance
& $DesktopCli vm creds forget --name appliance
if ((Get-Content $Broker -Raw) -match '"capture"\s*:\s*true') { throw 'capture rule remains' }
if ((Test-Path $Secrets) -and (Get-Content $Secrets -Raw) -match 'disposable-ap200-value') { throw 'test secret remains' }
wsl.exe -d appliance-vm-appliance -u root -- sh -c 'cat /etc/wsl.conf; test ! -e /mnt/c && ! grep -qE "[[:space:]]/mnt/[a-z][[:space:]]" /proc/mounts'
"managed_distro_posture_rc=$LASTEXITCODE" # R20
```

Counterparts:
[`agent.spec.ts`](../packages/cli/src/utils/agent.spec.ts) and
[`creds.rs`](../packages/vm/src/creds.rs).

### Shipped Desktop surfaces

In Desktop, choose the Claude subscription OAuth sign-in and the Credentials
panel once. Keep the visible terminal open until `claude setup-token` launches,
then cancel before entering a token. Record `1` when the visible terminal
launched (R21). Copy the Credentials panel's emitted argv to
`$OUT\desktop-credential-argv.json`, then compare it with R18:

```powershell
$BrokerArgv = (Get-Content $Broker -Raw | ConvertFrom-Json).rules[0].helper
$PanelArgv = Get-Content "$OUT\desktop-credential-argv.json" -Raw | ConvertFrom-Json
"argv_equal=$(-not (Compare-Object $BrokerArgv $PanelArgv))" # R22
```

R20 records the managed-distro posture above. Pass requires
`[interop] enabled=false`, `appendWindowsPath=false`, and no Windows drive
automount. These controls do not constrain other distros or same-user Windows
execution. The counterpart is
[`wsl.rs`](../packages/vm/src/backend/wsl.rs).

### Long-path posture

```powershell
$LongPathsEnabled = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled).LongPathsEnabled
$LongRoot = Join-Path $env:TEMP 'ap200-long-install'
1..12 | ForEach-Object { $LongRoot = Join-Path $LongRoot ("segment-$_-" + ('x' * 14)) }
$longRc = 1
$longInstall = Measure-Command {
  try {
    New-Item -ItemType Directory -Force $LongRoot | Out-Null
    $p = Start-Process $Installer.FullName -ArgumentList @('/S',"/D=$LongRoot") -Wait -PassThru
    $longRc = $p.ExitCode
  } catch { $_ | Out-File "$OUT\long-path-error.txt" }
}
"LongPathsEnabled=$LongPathsEnabled path_length=$($LongRoot.Length) install_rc=$longRc seconds=$($longInstall.TotalSeconds)" # R23
if (Test-Path $LongRoot) { Get-ChildItem $LongRoot -Recurse | Select-Object FullName,Length | Tee-Object "$OUT\long-path-installed-files.txt" }
```

Record the registry value (0/1) and behavior beyond 260 characters; do not
infer that the residual is fixed. Attach redacted transcripts, hashes, doctor
outputs, ACL principals, installed-file list, and broker files to the evidence.
Any failed credential/Desktop step is a release blocker: do not weaken the
workflow digest guard or publish gate to work around it. R72 is complete only
when both this evidence and the Runtime evidence are retained.

## Dev machine path

Run from Git Bash. Start with no `appliance-vm-appliance` distro registered;
this makes R24 a cold first import. The example below covers the interactive
dev profile, `appliance up`, k3s deploy/hostname ingress, a one-shot shell, and
stop/destroy.

```sh
wsl.exe --unregister appliance-vm-appliance 2>/dev/null || true
time "$AP" vm dev up 2> >(tee "$OUT/dev-vm-up.txt" >&2) # R24
wsl.exe -d appliance-vm-appliance -u root -- sh -c 'cat /etc/wsl.conf; test ! -e /mnt/c && ! grep -qE "[[:space:]]/mnt/[a-z][[:space:]]" /proc/mounts'
DEV_DRIVE_RC=$?; echo "dev_drive_exposure_rc=$DEV_DRIVE_RC" # R25
if [ "$DEV_DRIVE_RC" -ne 0 ]; then { echo "HARD STOP: R25 — stop the run, see 'If a slot fails'"; false; }; fi

time "$AP" vm up --cluster 2> >(tee "$OUT/dev-cluster-up.txt" >&2) # R26
(cd examples/demo-node-container && time "$AP" up) 2>&1 | tee "$OUT/dev-appliance-up.txt"
(cd examples/demo-node-framework && time "$AP" deploy demo-node-framework dev --profile local) 2>&1 | tee "$OUT/dev-deploy.txt" # R27
DEV_URL=http://demo-node-framework-dev.appliance.localhost:8081
curl -fsS -o "$OUT/dev.body" -w '%{http_code} %{time_total}\n' "$DEV_URL" | tee "$OUT/dev-http.txt" # R28
"$AP" vm dev shell -- 'test -d /persist/workspace && printf "dev-shell-ok\n"' | tee "$OUT/dev-shell.txt" # R29
(cd examples/demo-node-container && time "$AP" down) 2>/dev/null || true
time "$AP" vm stop
"$AP" vm delete
echo "dev_stop_destroy_rc=$?" # R30
```

R25 is a hard stop unless it is 0. R26 records the k3s boot time. R27 requires
both `appliance up` and the sample deployment to succeed and records deploy
seconds; R28 requires HTTP 200 through `*.appliance.localhost:8081`; R29 prints
`dev-shell-ok`; R30 records stop time and successful destruction.

## App Runtime ordered run

### 1. Clean pool

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
wsl.exe --unregister appliance-vm-appliance-runtime 2>/dev/null || true
```

### 2. First import, drive gate, strict default, and samples

The first `vm up` must run on a host without an Appliance Runtime distro. Keep
its full first-import timing separately from later warm starts.

```sh
time "$AP" vm up --name appliance-runtime 2> >(tee "$OUT/runtime-first-import.txt" >&2) # R31
```

#### 0. Runtime drive-exposure gate

Run immediately after that first import and before any Runtime payload:

```sh
wsl.exe -d appliance-vm-appliance-runtime -u root -- sh -c 'cat /etc/wsl.conf; test ! -e /mnt/c && ! grep -qE "[[:space:]]/mnt/[a-z][[:space:]]" /proc/mounts'
RUNTIME_DRIVE_RC=$?; echo "runtime_drive_exposure_rc=$RUNTIME_DRIVE_RC" # R32
if [ "$RUNTIME_DRIVE_RC" -ne 0 ]; then { echo "HARD STOP: R32 — stop the run, see 'If a slot fails'"; false; }; fi
```

R32 must be 0; stop the run if it is non-zero.

```sh
"$AP" vm egress wsl-mode strict
"$AP" vm egress policy --name appliance-runtime | tee "$OUT/policy-strict.json"
"$AP" vm egress list --name appliance-runtime | tee "$OUT/list-strict.txt"
jq '[.allow[]] | length' "$OUT/policy-strict.json" | tee "$OUT/strict-allow-count.txt" # R33
```

Pass criterion: policy JSON says `boundary: "cooperative"`,
`enforcement.backend: "wsl"`, `enforcement.bypassable: true`, and
`wslMode: "strict"`. The list begins exactly `WSL NAT - strict: apps with
egress grants are refused` and never contains `host-enforced`.

Record R33; the strict policy `allow` count must be 0.

#### Cold and warm container and binary samples

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

Record Journal results in R34–R39, Dashboard results in R40–R45, and the
strict first-run notice count in R46.

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
"$AP" runtime ps --json | tee "$OUT/notes-suite-warm-ps.json"
jq '[.[] | select(.appId == "notes-suite") | .services[] | select(.health == "healthy")] | length' \
  "$OUT/notes-suite-warm-ps.json" | tee "$OUT/notes-healthy-count.txt"
"$APPLIANCE_VM" timings appliance-runtime | tee "$OUT/timings.txt"
```

Pass criterion: root state is `running`; both `api` and `web` are `healthy`;
the web dependency starts after the API; both service logs are non-empty; and
`timings.txt` contains phase and total timings comparable with
`docs/live-test-runbook.md`.

Record cold start R47, stop R48, `vm up` R49, warm start R50, and the healthy
service count R51.

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

Record the URL in R52, browser result in R53, Desktop-open result in R54, and
Desktop URL comparison in R55.

### 5. Strict refusal

Fixture A copies the Journal container and requests `example.com:443`; fixture
B requests no egress.

```sh
"$AP" vm egress wsl-mode strict
set +e
STRICT_OUTPUT=$("$AP" runtime run "$OUT/egress-probe.appliance.zip" --detach 2>&1)
STRICT_RC=$?
printf '%s\n' "$STRICT_OUTPUT" | tee "$OUT/strict-refusal.txt"
echo "strict_rc=$STRICT_RC"
if [ "$STRICT_RC" -ne 2 ]; then { echo "HARD STOP: R56 — stop the run, see 'If a slot fails'"; false; }; fi
```

Pass criterion: strict exits 2 with the exact setting name and
`appliance vm egress wsl-mode cooperative` remediation. Record R56 and stop
the run explicitly if it is not 2.

### 6. Cooperative opt-in

The proxy URLs are read from each task's environment into shell variables and
are not echoed or written to the Results record. `wget` enters the task
network namespaces so both requests traverse the WSL proxy path.

```sh
"$AP" vm egress wsl-mode cooperative
"$AP" runtime run "$OUT/egress-probe.appliance.zip" --detach \
  2> >(tee "$OUT/cooperative-warning.txt" >&2)
"$AP" runtime run "$OUT/egress-probe-b.appliance.zip" --detach
COOP_NOTICE_COUNT=$(grep -c 'WSL cooperative mode is bypassable' "$OUT/cooperative-warning.txt")
echo "cooperative_notice_count=$COOP_NOTICE_COUNT"
```

Pass criterion: cooperative mode is an explicit opt-in and the `runtime run`
command prints the prominent bypass warning exactly once. Record R57.

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
PROXY_SETUP_RC=$?; echo "proxy_setup_rc=$PROXY_SETUP_RC"
"$APPLIANCE_VM" shell appliance-runtime --root -- \
  "nsenter -t $TASK_A_PID -n env https_proxy='$PROXY_A' HTTPS_PROXY='$PROXY_A' wget -S --spider https://example.com" \
  2>&1 | tee "$OUT/proxy-allow.txt"
ALLOW_RC=${PIPESTATUS[0]}; echo "allow_rc=$ALLOW_RC"
"$APPLIANCE_VM" shell appliance-runtime --root -- \
  "nsenter -t $TASK_B_PID -n env https_proxy='$PROXY_B' HTTPS_PROXY='$PROXY_B' wget -S --spider https://example.com" \
  >"$OUT/proxy-cross-app-deny.txt" 2>&1
CROSS_APP_RC=$?
grep -E 'HTTP/[0-9.]+ 200' "$OUT/proxy-allow.txt"
ALLOW_GREP_RC=$?; echo "allow_200_grep_rc=$ALLOW_GREP_RC"
grep -E 'HTTP/[0-9.]+ 403' "$OUT/proxy-cross-app-deny.txt"
CROSS_APP_GREP_RC=$?; echo "cross_app_403_grep_rc=$CROSS_APP_GREP_RC"
if [ "$CROSS_APP_GREP_RC" -ne 0 ]; then { echo "HARD STOP: R59 — stop the run, see 'If a slot fails'"; false; }; fi

"$APPLIANCE_VM" shell appliance-runtime --root -- \
  "nsenter -t $TASK_A_PID -n env https_proxy='http://${PROXY_A#*@}' wget -S --spider https://example.com 2>&1 | grep -E 'HTTP/1\.[01] 407'" \
  >"$OUT/proxy-credentialless.txt" 2>&1
CREDENTIALLESS_RC=$?
test "$CREDENTIALLESS_RC" -eq 0
CREDENTIALLESS_TEST_RC=$?; echo "credentialless_407_grep_rc=$CREDENTIALLESS_TEST_RC"

"$AP" vm egress policy --name appliance-runtime | tee "$OUT/policy-cooperative.json"
"$AP" vm egress list --name appliance-runtime | tee "$OUT/list-cooperative.txt"
jq -e '.enforcement.scope == ["http","https","per-app"]' "$OUT/policy-cooperative.json"
SCOPE_RC=$?; echo "scope_check_rc=$SCOPE_RC"
jq -e '.apps[] | select(.app == "egress-probe") | .hosts[] | select(.host == "example.com" and .ports == [443])' \
  "$OUT/policy-cooperative.json"
GRANT_RC=$?; echo "app_a_grant_check_rc=$GRANT_RC"

REVOKED_PROXY="$PROXY_A"
"$AP" runtime stop egress-probe
"$APPLIANCE_VM" shell appliance-runtime --root -- \
  "nsenter -t $TASK_B_PID -n env https_proxy='$REVOKED_PROXY' HTTPS_PROXY='$REVOKED_PROXY' wget -S --spider https://example.com" \
  >"$OUT/proxy-revoked.txt" 2>&1
REVOKED_RC=$?
grep -E 'HTTP/[0-9.]+ 407' "$OUT/proxy-revoked.txt"
REVOKED_GREP_RC=$?; echo "revoked_407_grep_rc=$REVOKED_GREP_RC"
if [ "$REVOKED_GREP_RC" -ne 0 ]; then { echo "HARD STOP: R61 — stop the run, see 'If a slot fails'"; false; }; fi
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
policy enforcement. Record R58–R61. R59 and R61 are hard stops: stop the run
if their recorded HTTP status is not 403 and 407 respectively.

```sh
"$AP" vm egress traffic --name appliance-runtime | tee "$OUT/traffic.json"
jq '[.[] | select(.decision == "deny" and .app != null and .reason == "policy")] | length' \
  "$OUT/traffic.json"
jq '[.[] | select(.reason == "proxy-auth")] | length' "$OUT/traffic.json"
jq '[.[] | select(.reason == "proxy-auth" and .principal == null)] | length' \
  "$OUT/traffic.json"
```

Record the traffic counts in R62–R64.

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

```sh
grep '^  [^ ]' "$OUT/list-cooperative.txt" > "$OUT/list-app-rows.txt"
LIST_ROWS_RC=$?
LIST_ROWS=$(wc -l < "$OUT/list-app-rows.txt")
JSON_APPS=$(jq '.apps | length' "$OUT/policy-cooperative.json")
ROWS_EQUAL_RC=0; test "$LIST_ROWS" -eq "$JSON_APPS" || ROWS_EQUAL_RC=$?
printf 'list_rows=%s json_apps=%s grep_rc=%s rows_equal_rc=%s\n' \
  "$LIST_ROWS" "$JSON_APPS" "$LIST_ROWS_RC" "$ROWS_EQUAL_RC"
```

Record R65. The list must literally show `egress-probe-b … (no hosts)`; only
app A may have `example.com:443`, and the human row count must equal JSON
`.apps | length`.

### 9. Pool restart and same-URL reopen

Keep Notes Suite installed and use its URL from R52.

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
URL_STABLE_RC=$?; echo "url_stable_rc=$URL_STABLE_RC"
```

Pass criterion: after pool restart `runtime ps` reconciles Notes Suite to
stopped, no app/listener auto-starts, `runtime open` revalidates and starts it,
and the exact loopback URL is reused.

Record R66–R67. Reopen targets under 15 seconds; compare with R50.

### 10. Mirrored networking fails fast, then NAT recovers

From PowerShell, preserve the current NAT configuration, write the mirrored
negative-test configuration, and use the `$AP` variable rather than a bare
`appliance` command:

```powershell
$AP = "$PWD\packages\cli\dist\appliance.exe"
$OUT = "$PWD\.tmp\ap-205-runtime-samples"
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
--print` returns R52's URL. Record R68–R69.

### 11. Final teardown

```sh
"$AP" runtime stop notes-suite 2>/dev/null || true
"$AP" runtime stop egress-probe 2>/dev/null || true
"$AP" runtime stop egress-probe-b 2>/dev/null || true
"$AP" runtime uninstall journal dashboard notes-suite 2>/dev/null || true
"$AP" runtime uninstall egress-probe 2>/dev/null || true
"$AP" runtime uninstall egress-probe-b 2>/dev/null || true
"$AP" vm egress wsl-mode strict
"$AP" vm egress wsl-mode --name appliance-runtime | tee "$OUT/final-mode.txt" | grep -q ': strict$'
FINAL_STRICT_RC=$?; echo "final_strict_rc=$FINAL_STRICT_RC"
grep -Eiq '(://[^/ ]*:[^/ ]*@|proxy-authorization: *basic)' "$OUT"/proxy-*.txt
SECRET_MATCH_RC=$?; test "$SECRET_MATCH_RC" -eq 1; echo "secret_scan_rc=$?"
"$AP" vm stop --name appliance-runtime
CERT_TOTAL_MINUTES=$(( ($(date +%s) - CERT_STARTED_AT) / 60 ))
printf 'total_minutes=%s\n' "$CERT_TOTAL_MINUTES"
```

Do not leave the certification host in cooperative mode. Confirm the final
read prints `strict`, `.wslconfig` is restored to NAT (or its original absent
state), and all evidence files under `$OUT` have been retained. Put the printed
total in R06 and record R70–R72.

## MV1 in-place control-plane update addendum (AP-222)

Before final teardown, run the same signed N → crashing N+1 → healthy N+1
sequence from [the main runbook](live-test-runbook.md#mv1-control-plane-update-proof-ap-222--input-to-ap-223).
Steps 1–4 have the same trust precondition: production pin, or a development
build plus `APPLIANCE_RELEASE_TRUST_FILE` containing the test-key trust JSON.
Release builds ignore that escape hatch and must show the documented
fail-closed restart path instead.
Use `appliance-vm.exe stop appliance` followed by `appliance-vm.exe start
appliance` for the stale-media restart. Record that the WSL distro PID remains
unchanged for each in-place attempt, rollback restores N, the healthy retry
promotes N+1, and the distro-VHD one-line `current` pointer file survives the stale-media restart.
The control-plane tree must be Linux-owned inside the managed distro and no
copy may appear under `/mnt/*` or another drvfs mount. Attach the doctor JSON
showing staged version, signed keyId, persistent current, console, and running
version to AP-223.

## If a slot fails

File the failure on the epic card with its slot ID. Attach the redacted `$OUT`
directory only after R71's scan, plus `wsl.exe --version` and the R01/R02
engine/commit identity. Do not continue past the hard-stop gates R25, R32,
R56, R59, or R61; other failures remain `FAIL: <reason>` rows so the single
owner run still produces a complete diagnostic record.

## Results record

Fill only the **Actual** column. Each recorded value has one slot and an
explicit expected result; use `FAIL: <reason>` instead of omitting a failed
check. Paste this entire table back into the certification ticket.

| Slot | Result                                | Expected                                                                               | Actual |
| ---- | ------------------------------------- | -------------------------------------------------------------------------------------- | ------ |
| R01  | Engine SHA-256                        | 64 lowercase hex characters for `$APPLIANCE_VM`                                        |        |
| R02  | Feature commit                        | Short Git SHA for the checkout under test                                              |        |
| R03  | WSL version                           | First `wsl.exe --version` line; WSL2-capable release                                   |        |
| R04  | Windows build                         | Windows 11 build from `winver`                                                         |        |
| R05  | Certification date                    | ISO `YYYY-MM-DD`                                                                       |        |
| R06  | Total certification time              | Elapsed minutes; expected 90–120 excluding builds and firewall prompts                 |        |
| R07  | Release tag                           | Candidate Desktop and CLI tag; both packages match                                     |        |
| R08  | Engine version                        | Non-empty `$APPLIANCE_VM --version` output                                             |        |
| R09  | NSIS install and fresh-shell CLI      | Install seconds; bare PATH resolves matching non-empty `appliance --version`           |        |
| R10  | Standalone helper SHA-256             | 64 lowercase hex characters                                                            |        |
| R11  | Desktop helper SHA-256                | 64 lowercase hex characters                                                            |        |
| R12  | Helper digest comparison              | R10 = R11 = release checksum entry                                                     |        |
| R13  | Helper layout and fail-closed lookup  | Both helpers are CLI siblings; missing retries fail closed; restored retries pass      |        |
| R14  | Helper pipe bytes and statuses        | Exact byte round-trip; no argv/stderr leak; missing/denied/malformed statuses differ   |        |
| R15  | Lazy migration and idempotence        | Both cluster stores scrubbed; agent file removed after read-back; second run unchanged |        |
| R16  | Conflict and downgrade boundary       | Neither value overwritten; doctor says `conflict`; old CLI requires upgrade/re-login   |        |
| R17  | Doctor states                         | All seven states distinct; no `not-applicable`; conflict not auto-repaired             |        |
| R18  | Broker no-capture posture             | Absolute print-key argv, `capture:false`, no real credential in either VM file         |        |
| R19  | Explicit capture residual and cleanup | Warning names VM/host/residual; residual observed, deleted, and capture disabled       |        |
| R20  | Managed-distro posture                | Interop and PATH append off; no Windows drive automount                                |        |
| R21  | Setup-token visible-terminal launch   | `1`; terminal is visible and token is neither captured nor entered                     |        |
| R22  | Credentials-panel helper argv         | Exactly the argv recorded in R18                                                       |        |
| R23  | Long-path posture and install         | `LongPathsEnabled` is 0/1; >260-character path behavior and seconds recorded           |        |
| R24  | Dev VM cold first import              | Seconds recorded; image cached, no dev distro; excludes first download                 |        |
| R25  | Dev drive-exposure gate               | `0`; otherwise stop immediately                                                        |        |
| R26  | Dev cluster boot                      | `vm up --cluster` seconds recorded                                                     |        |
| R27  | Dev `up` and sample deploy            | Both commands succeed; deployment reaches ready and deploy seconds are recorded        |        |
| R28  | Dev hostname ingress                  | `200` and first-byte seconds at `*.appliance.localhost:8081`                           |        |
| R29  | Dev one-shot shell                    | `dev-shell-ok`                                                                         |        |
| R30  | Dev stop and destroy                  | Stop seconds recorded; destroy exit `0`                                                |        |
| R31  | Runtime first-ever import             | Seconds recorded; image cached, no Runtime distro; excludes first download             |        |
| R32  | Runtime drive-exposure gate           | `0`; otherwise stop immediately                                                        |        |
| R33  | Strict policy allow count             | `0`                                                                                    |        |
| R34  | Journal cold start                    | Seconds recorded                                                                       |        |
| R35  | Journal cold HTTP                     | `200` and first-byte seconds                                                           |        |
| R36  | Journal stop                          | Seconds recorded                                                                       |        |
| R37  | Journal `vm up`                       | Seconds recorded                                                                       |        |
| R38  | Journal warm start                    | Seconds recorded                                                                       |        |
| R39  | Journal warm HTTP                     | `200` and first-byte seconds                                                           |        |
| R40  | Dashboard cold start                  | Seconds recorded                                                                       |        |
| R41  | Dashboard cold HTTP                   | `200` and first-byte seconds                                                           |        |
| R42  | Dashboard stop                        | Seconds recorded                                                                       |        |
| R43  | Dashboard `vm up`                     | Seconds recorded                                                                       |        |
| R44  | Dashboard warm start                  | Seconds recorded                                                                       |        |
| R45  | Dashboard warm HTTP                   | `200` and first-byte seconds                                                           |        |
| R46  | Strict first-run notice count         | `1`                                                                                    |        |
| R47  | Notes Suite cold start                | Seconds recorded                                                                       |        |
| R48  | Notes Suite stop                      | Seconds recorded                                                                       |        |
| R49  | Notes Suite `vm up`                   | Seconds recorded                                                                       |        |
| R50  | Notes Suite warm start                | Seconds recorded                                                                       |        |
| R51  | Notes Suite healthy services          | `2`                                                                                    |        |
| R52  | Notes Suite printed URL               | Loopback URL with port 20000–29999                                                     |        |
| R53  | Browser HTTP                          | `200` and first-byte seconds                                                           |        |
| R54  | Desktop window opened                 | `1`                                                                                    |        |
| R55  | Desktop window URL                    | Exactly R52                                                                            |        |
| R56  | Strict refusal exit                   | `2`, with exact setting and cooperative remediation                                    |        |
| R57  | Cooperative bypass-warning count      | `cooperative_notice_count=1`                                                           |        |
| R58  | App A allowed HTTPS                   | `200`                                                                                  |        |
| R59  | Same host under app B                 | `403`                                                                                  |        |
| R60  | Credential-less 407 grep exit         | `0`                                                                                    |        |
| R61  | App A credential after stop           | `407`                                                                                  |        |
| R62  | Per-app policy-deny traffic count     | At least `1`                                                                           |        |
| R63  | Proxy-auth-failure traffic count      | At least `2` (credential-less and revoked)                                             |        |
| R64  | Credential-less traffic count         | At least `1`, with `principal == null`                                                 |        |
| R65  | Cooperative per-app rows              | Human row count equals JSON app count; B has no hosts; only A has `example.com:443`    |        |
| R66  | Reopen time                           | Seconds recorded; target under 15, compare with R50                                    |        |
| R67  | URL stable after pool restart         | `0` test exit; reopened URL exactly R52                                                |        |
| R68  | Mirrored fail-fast time               | Seconds; fails before provisioning/readiness and far below 600                         |        |
| R69  | NAT recovery                          | `1`; WSL2/NAT restored and URL exactly R52                                             |        |
| R70  | Final strict-mode restore             | `final_strict_rc=0`                                                                    |        |
| R71  | Proxy evidence secret scan            | `secret_scan_rc=0`; no credential URL or Basic authorization match                     |        |
| R72  | Teardown and retained evidence        | Samples uninstalled, Runtime VM stopped, config restored, evidence retained            |        |
