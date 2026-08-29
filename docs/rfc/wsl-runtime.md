# RFC: App Runtime on the WSL2 backend

- **Status:** Proposed decision; implementation pending; owner gates noted below
- **Created:** 2026-08-29
- **Task:** AP-190

## Summary

App Runtime will run on Windows through the existing WSL2 NAT backend. The
runtime guest keeps the shared containerd supervisors and isolation model, but
uses drvfs bind mounts for payloads, ordinary WSL NAT TCP forwards for published
ports, and an explicitly cooperative egress proxy. Windows app URLs remain
`http://127.0.0.1:<allocated-port>`.

This is a deliberate capability downgrade from the macOS host-netstack path,
not a claim that WSL provides the same egress boundary. The CLI and Desktop must
label that downgrade wherever policy is displayed.

## Why this is needed

The product contract says packaged apps run in a pooled `appliance-runtime` VM
and expose only declared ports (`docs/runtime.md:83-90`). Windows already has an
implemented WSL2 backend with a persistent VHDX, drvfs instead of VirtioFS, a
ConPTY shell, and cooperative egress (`docs/microvm.md:103-112`). Runtime does
not currently honor that backend contract:

- Runtime reconciliation persists `runtime=true`, `agent_only=true`,
  `dev=false`, and requests `Netstack` (`packages/vm/src/main.rs:1307-1319`).
- WSL branches on `agent_only` without first checking `runtime`, so it installs
  the agent handoff (`packages/vm/src/backend/wsl.rs:647-650`). That handoff
  waits for `.dev-ready` (`packages/vm/src/backend/wsl.rs:571-599`), but Runtime
  deliberately has no dev provisioning.
- WSL removes `__RUNTIME_PROVISION__` instead of installing it
  (`packages/vm/src/backend/wsl.rs:719-726`).
- VZ rejects a Runtime VM without its in-process host netstack and starts the
  dynamic-forward controller on that netstack (`packages/vm/src/backend/vz/mod.rs:191-207`).
- Windows' `runtime_forward_request` is an unconditional error
  (`packages/vm/src/main.rs:1880-1889`).

Those facts explain the silent 600-second wait. The following decisions replace
that accidental agent profile with a real WSL Runtime profile.

## Decision 1: run the shared Runtime guest with WSL adapters

WSL must select `spec.runtime` before `spec.agent_only`. A Runtime bootstrap
installs the exact pinned `RUNTIME_WORLD` (containerd, runc, iproute2, nftables,
jq, socat, and their pinned dependencies) from the host-mirrored signed APK
closure, rather than the floating base-package path used by normal WSL guests.
The pins and mirror builder are already defined at
`packages/vm/src/images.rs:22-53` and `packages/vm/src/images.rs:576-628`.

The following guest code remains shared, with no WSL fork:

- `RUNTIME_PROVISION`: containerd startup, stale-state cleanup, cgroup setup,
  socat ABI check, and supervisor-ready log (`packages/vm/src/guest.rs:2276-2291`).
- The single-app and compound lifecycle supervisors: validation, UID/cgroup
  limits, network namespaces, nftables anti-spoof/inter-app rules, containerd
  tasks, health/restart behavior, and bounded logs
  (`packages/vm/src/guest.rs:1307-1721`, `packages/vm/src/guest.rs:1723-2274`).
- The root one-shot lifecycle transport. Windows already runs captured commands
  through `wsl.exe` (`packages/vm/src/shell.rs:148-161`), and Runtime requests
  already invoke the supervisor through that transport
  (`packages/vm/src/guest_exec.rs:62-72`).
- The principal `/32` allocator/validator is netstack-subnet-coupled
  (`guest.rs:1444-1447`); WSL keeps the same range as a guest-internal address
  space and therefore requires SNAT-to-`eth0` for any egress, not just proxy
  egress.

Only payload acquisition is backend-specific. Extract the supervisors' current
VirtioFS mount/unmount operations into generated `runtime-share-mount` and
`runtime-share-unmount` helpers. VZ keeps `mount -t virtiofs -o ro <tag>`; WSL
uses a targeted `mount -t drvfs <validated-Windows-path>` at the same
`/run/appliance/shares/<tag>` path with `ro,uid=1000,gid=1000,metadata`. Drive
automounting and Windows interop are disabled distro-wide; no `/mnt/c` bind is
involved. The host has already canonicalized the share, rejected any overlap
with the appliance state directory, and matched it to the persisted spec before
the request reaches the guest (`packages/vm/src/main.rs`). Non-local-drive, UNC,
automount-relative, and traversal paths fail during prepare, before the app
starts. WSL does not add `runtime_mounts` as boot devices and therefore does not
restart the pool merely to add a payload; VZ still must restart because its
shares are boot-configured devices
(`packages/vm/src/spec.rs:120-123`, `packages/vm/src/backend/vz/mod.rs:482-503`).

The WSL login user remains pinned to 1000:1000 because drvfs owns host mapping
(`packages/vm/src/guest.rs:700-712`). Runtime tasks still use their allocated
20000-20239 principal UIDs and `/32` namespaces; payload staging is root-owned,
so Windows has no host UID to mirror (`packages/vm/src/guest.rs:1433-1447`,
`packages/vm/src/guest.rs:1519-1557`). There is no WSL netstack. The guest's
UID, cgroup, namespace, seccomp, and nftables controls remain; outbound packets
leave through WSL NAT.

Readiness is `core-ready`, never `agent-ready` or `.dev-ready`. WSL writes it
only after the Runtime provision block completed, the supervisor is executable,
containerd's socket answers, and the socat self-check passed. This preserves the
existing Runtime marker selected for an agent-only/non-dev spec
(`packages/vm/src/main.rs:867-877`). WSL writes `core-ready` from its own
`host_services`, matching (not reusing) the vz vsock-gated write at
`guest.rs:2921-2927`; the supervisor's vsock SIGHUP comment at `:1626` becomes
transport-neutral. A failed provision publishes a failed bring-up phase
immediately; no path waits 600 seconds for the agent handoff.

## Decision 2: publish app ports with a resident WSL TCP-forward manager

The data path is:

```text
127.0.0.1:<host> -> <WSL guest IP>:<relay> -> <principal /32>:<guest port>
```

The last hop is already created by the shared supervisor
(`packages/vm/src/guest.rs:1599-1617`). Extend WSL host services from its fixed
k3s forward table (`packages/vm/src/backend/wsl.rs:781-808`) to a resident,
stoppable forward manager. Runtime rows bind only TCP host ports 20000-29999;
the CLI already rejects UDP (`packages/cli/src/appliance-runtime.ts:258-262`).
The manager resolves the current WSL guest IP itself and forwards to the relay
port, not to the logical netstack address in `RuntimeTarget`.
On WSL the `target` field of `runtime_app_forwards` (`main.rs:1906`, hardcoded
netstack `GUEST_IP`) is advisory and ignored; validation keys on `host`/`guest`
only.

On Windows, the resident VM process exposes the existing bind/unbind JSON
protocol over a current-user-only named pipe. `runtime_forward_request` connects
to that pipe, while Unix continues to use the mode-0600 Unix socket
(`packages/vm/src/backend/vz/runtime.rs:47-70`,
`packages/vm/src/main.rs:1847-1877`). The WSL manager validates every request
against the current `VmSpec.published` row before opening a listener, makes an
identical bind idempotent, rejects collisions, and removes the listener on stop
or failed start. No `netsh portproxy`, administrator privilege, or machine-global
Windows state is used.

`runtime open` continues to choose the manifest UI port, look up its persisted
host allocation, and derive `http://127.0.0.1:<host><path>`
(`packages/cli/src/appliance-runtime-open.ts:61-70`). Before treating a registry
record as warm, it reconciles actual pool and supervisor status; a stale
`running` record becomes stopped and follows the existing detached cold-start
path (`packages/cli/src/appliance-runtime-open.ts:163-191`). Browser and Desktop
therefore receive the same loopback URL on every backend.

Forward allocations survive a VM restart in the spec, but listeners and apps do
not auto-start. Blindly restoring them would bypass the bundle and entitlement
revalidation performed by `runtime run` (`packages/cli/src/appliance-runtime.ts:388-475`).
After a restart, `runtime open` revalidates and restarts the app, and the WSL
manager rebinds the same host port idempotently. `runtime ps` reports the app as
stopped until that happens.

## Decision 3: enforce cooperative per-app egress and label it honestly

The WSL host egress proxy is reachable at the guest's real default gateway; WSL
already records that gateway because its NAT is a `/20`, not the VZ `/24`
(`packages/vm/src/backend/wsl.rs:753-772`, `packages/vm/src/egress.rs:1172-1198`).
Every Runtime task receives `HTTP_PROXY`, `HTTPS_PROXY`, the minimal `NO_PROXY`,
and the Runtime CA. WSL adds SNAT-to-`eth0` for all outbound traffic; the host
proxy therefore sees the distro's admitted lease. A per-app opaque proxy
credential, not the now-collapsed source IP, selects the corresponding resolved
`RuntimePolicy`. The credential is generated by the host, stored with effective
state, injected only into that principal, and revoked on stop. Step 3a initially
used a VM-wide policy; 3b replaces it with per-app selection for every Runtime
proxy request. A request without a valid app credential receives `407 Proxy
Authentication Required` and never receives any app's grants. Runtime policies
are already normalized to default-deny
hostname suffixes plus explicit TCP ports
(`packages/vm/src/egress.rs:335-413`). VZ currently selects that policy from the
principal `/32` source and fails an absent or duplicate identity closed
(`packages/vm/src/egress.rs:637-655`). The standalone proxy today has no
per-principal path at all (`policy_for` is netstack-only); WSL adds proxy
authentication, a credential→principal table, per-request policy selection,
per-app MITM/log attribution and revocation to `handle_conn`, and admits the WSL
`/20` in `peer_allowed`.

The credential transport is standard proxy URL userinfo:
`HTTP(S)_PROXY=http://<app>:<base64url-credential>@<gateway>:<port>`. The Rust
host mints 32 random bytes only after the start plan matches persisted pool
state. Guest request, plan, and environment files are created under `umask 077`.
`ctr run --env-file` is reserved for proxy variables so the credential stays
out of the root launcher's command line; every non-proxy environment value uses
the newline-safe `--env KEY=VALUE` argument form. The credential is therefore
absent from CLI arguments, `/proc/<launcher>/cmdline`, and ordinary app launch
logs. CONNECT and absolute-form HTTP clients turn the userinfo into
`Proxy-Authorization: Basic`; the proxy parses it on both forms, strips the
header before forwarding plain HTTP, and never serializes credentials in
policy output, traffic events, or decision logs. Effective state remains the
sole persisted copy and uses the existing owner-only file ACL path. A present
but malformed, unknown, stale, revoked, or missing credential receives 407 and
never falls back to another policy. **RESIDUAL:** the credential necessarily
remains in the workload environment, visible to the workload itself and to
guest root (and therefore to a same-UID `appliance` process where guest `/proc`
permissions allow environment reads). The control protects app-to-app policy
selection, not a compromised guest root or same-UID process.

**RESIDUAL:** attribution on authentication-failure (`407`) events is claimed,
not verified: an attacker can choose the Basic username of a known revoked app,
so the event may carry that principal even though no valid credential proved
the request came from it. The request remains denied and gains no app policy.

Brokered credential injection is disabled on WSL v1: its exact-lease
re-attribution cannot survive SNAT. Only Runtime app policies apply.

For traffic that uses the proxy, WSL can enforce the granted hostname and TCP
port, deny ungranted CONNECT/plain HTTP requests, attribute logs to the app, and
perform requested TLS inspection. It cannot prevent a hostile or proxy-unaware
process from removing the environment variables and using direct TCP, UDP, raw
IP, or its own DNS path through WSL NAT. Windows cannot recover the principal
identity at a host netstack boundary because there is no such boundary. The
existing legacy proxy is VM-scoped and loads only `load_policy(vm)` per request
(`packages/vm/src/egress.rs:890-927`); it is not sufficient for per-app policy
without the authenticated Runtime policy selector.

Decision: make the downgrade configurable per VM or globally, for example
`appliance vm egress wsl-mode cooperative|strict`, and default to `strict`.
`strict` refuses to start any app whose manifest requests egress grants on WSL.
The user must explicitly opt into `cooperative`, which ships
enforce-what-we-can with no silent equivalence claim and displays the prominent
bypass warning. Grant prompts remain meaningful for proxy-aware traffic in
`cooperative` mode, but must include that limitation.

`appliance vm egress policy appliance-runtime` must report effective capability,
not infer a host boundary from the persisted `netLink=netstack`. When the user
opts into `cooperative`, its JSON uses AP-193's flattened policy fields and adds
effective enforcement metadata:

```json
{
  "default": "deny",
  "allow": [],
  "deny": [],
  "mitm": true,
  "boundary": "cooperative",
  "enforcement": {
    "backend": "wsl",
    "bypassable": true,
    "scope": ["http", "https"]
  }
}
```

AP-190 removes `backend::ensure_runtime_supported`'s WSL bail and extends
AP-193's `EgressPolicyOutput` rather than re-nesting it; `boundary` stays the
stable scalar key and is `"enforced"` or `"cooperative"`.

The human `egress list` header must say `WSL NAT - cooperative proxy,
bypassable; direct TCP/UDP is not blocked`. macOS Netstack continues to say
`host-enforced boundary`. Today the display keys only on the requested link and
would incorrectly call a WSL Runtime host-enforced
(`packages/vm/src/egress.rs:662-706`, `packages/vm/src/egress.rs:711-727`), so
backend capability must become the source of truth.

## Decision 4: keep compound apps and app windows backend-neutral

Compound apps need no WSL scheduler fork. They already share one app principal,
namespace, and payload while retaining per-service tasks, cgroups, logs, health,
and restart workers (`packages/vm/src/guest.rs:1723-1726`). Service discovery is
loopback inside that namespace (`packages/vm/src/guest.rs:2059-2068`). The drvfs
share helper is the only WSL-specific compound dependency.

The external window URL is always host loopback, never the WSL guest or gateway
IP. The Desktop explicitly accepts only uncredentialed
`http://127.0.0.1:<published-port>` URLs and pins navigation to that port
(`packages/desktop/src-tauri/src/lib.rs:864-899`). The CLI first offers the same
descriptor to Desktop over private loopback IPC, then falls back to the browser
(`packages/cli/src/appliance-runtime-open.ts:92-99`,
`packages/cli/src/appliance-runtime-open.ts:131-151`). That contract works
unchanged once the WSL host forward exists.

WSL mirrored networking remains unsupported in v1. The forward manager requires
the NAT `eth0` lease, and the backend already detects mirrored mode and gives the
exact NAT remediation (`packages/vm/src/backend/wsl.rs:853-881`). Runtime must
surface that error before provisioning or any 600-second readiness wait.

## Decision 5: unit-test the seams and require one owner WSL run

GitHub CI does not provide a WSL2 hypervisor. CI still covers all deterministic
pieces:

1. WSL bootstrap assembly selects Runtime before Agent, installs the shared
   provision/supervisor scripts and pinned world, leaves no template markers,
   and selects only `core-ready`.
2. The drvfs share adapter quotes direct local-drive paths, rejects unsupported
   and automount-relative paths, mounts only the payload read-only, and cannot
   escape the granted target.
3. A pure forward-table test covers bind/idempotent bind/collision/unbind,
   20000-29999 validation, and the WSL target derivation
   `<current guest IP>:<relay>` with a fake listener.
4. A transport-contract test feeds the same JSON through fake Unix and Windows
   control endpoints and checks identical success/error responses.
5. CLI tests use a fake Runtime backend to cover stale-state reconciliation,
   compound `service.port` selection, restart rebind, and URL derivation as
   `127.0.0.1` (the current routing tests start at
   `packages/cli/src/appliance-runtime-open.spec.ts:17-55`).
6. Egress rendering tests prove WSL never prints `host-enforced`, per-app proxy
   selection never unions grants, and direct-traffic limitations are present.

One owner-run Windows 11/WSL2 NAT session is the release gate. The dedicated
[Windows live-test runbook](../live-test-runbook-windows.md) runs each
guest-side drive-exposure gate immediately after importing its dev machine or
Runtime distro and before starting a payload:

```sh
wsl.exe -d appliance-vm-appliance -u root -- sh -c 'test ! -e /mnt/c && ! grep -qE "[[:space:]]/mnt/[a-z][[:space:]]" /proc/mounts'
wsl.exe -d appliance-vm-appliance-runtime -u root -- sh -c 'test ! -e /mnt/c && ! grep -qE "[[:space:]]/mnt/[a-z][[:space:]]" /proc/mounts'
```

The command must exit 0 before any payload is started. From a clean pool
it must: cold-run and stop the container and binary samples; run the compound
Notes Suite and observe dependency health plus both service logs; open the
declared UI in the default browser and a Desktop app window; prove an allowed
HTTPS host succeeds through the app policy and a denied host returns 403; prove
the policy output carries the cooperative warning; stop/start the pool, observe
the app reconcile to stopped, then `runtime open` it on the same URL; and confirm
mirrored mode fails fast with remediation rather than hanging. Record the engine
and WSL versions with the result.

## Decision 6: deliver in four merge-ordered sub-issues

- **1. WSL Runtime guest profile and drvfs payload adapter (L).** Acceptance: a
  networkless container and binary reach `core-ready`, start/status/log/stop
  through the shared supervisors, use read-only payloads, and never enter the
  `.dev-ready` wait.
- **2. WSL Runtime TCP forward broker and open/restart reconciliation (M).**
  Acceptance: dynamic TCP bind/unbind is owner-only and idempotent; single and
  compound UI ports open at `127.0.0.1`; after a pool restart, `open` reuses the
  persisted port without restoring an unvalidated app.
- **3a. Truthful capability labeling, VM-wide cooperative policy, configurable
  `wsl-mode`, and live certification (M).** Acceptance:
  proxy-aware HTTP(S) obeys the VM-wide policy; policy output says bypassable
  cooperative WSL; `strict` is the default and refuses apps that request egress
  grants; users can opt into `cooperative`, which carries the prominent warning;
  compound/app-window behavior passes; and the owner records the one live run
  above.
- **3b. Authenticated per-app selector and revocation (L).** Acceptance:
  each app's proxy credential selects only its granted host/port policy;
  MITM/log attribution is per app; and stopping an app revokes its credential.

Merge order is 1 → 2 → 3a → 3b. Issue 2 needs the guest relay from
issue 1; 3a needs both a runnable principal and the final host URL surface, and
unblocks the owner run; 3b builds on its truthful VM-wide policy.

## Alternatives considered

| Alternative                                                      | Decision           | Reason                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WSL NAT forwards + shared guest + cooperative proxy              | **Chosen**         | Uses the implemented WSL primitives and keeps the loopback product contract.                                                                                  |
| VM-wide cooperative policy only on WSL v1 (no per-app selector)  | Considered         | Ships in weeks not months, matches today's `load_policy` proxy exactly, but unions app grants; chosen as the FIRST step (3a) with the per-app selector as 3b. |
| Require the VZ-style host netstack on Windows                    | Rejected           | WSL does not expose the raw NIC/socketpair the smoltcp boundary requires.                                                                                     |
| `netsh interface portproxy` for app ports                        | Rejected           | Adds administrator requirements and machine-global, failure-prone state.                                                                                      |
| Depend on WSL mirrored networking/automatic localhost forwarding | Rejected for v1    | Current guest-IP and gateway discovery require NAT; behavior varies by Windows/WSL version.                                                                   |
| Default to refusing WSL apps with egress grants                  | **Chosen default** | `strict` is safe by default; users must explicitly opt into bypassable `cooperative` enforcement for networked apps.                                          |
| Fork both Runtime supervisors for WSL                            | Rejected           | The lifecycle/isolation logic would drift; only share acquisition and host networking differ.                                                                 |

## Owner decisions

1. **Security posture — DECIDED:** expose per-VM/global `wsl-mode` as described
   in Decision 3. Default to `strict`; users must opt into `cooperative`, which
   displays the prominent bypass warning. Never market WSL as a hard sandbox
   boundary.
2. **Networking mode — DECIDED:** NAT-only for v1 with the existing fail-fast
   remediation; mirrored networking is not release-blocking.
3. **Restart semantics — DECIDED:** no auto-start; revalidate bundle and grants
   on the next `runtime open`, retaining the same URL.
4. **Live evidence — DECIDED:** one owner-run Windows session at the end, as
   specified in Decision 5. No additional human wait is part of AP-190.
5. **Attribution model — DECIDED:** on WSL, audit/entitlement logs and grant
   prompts identify apps by credential, not source IP. Credential-based
   attribution is accepted on WSL.
6. **drvfs integrity — DECIDED:** a targeted read-only drvfs mount is not an
   integrity boundary because Windows can mutate payload bytes after
   verification. Verify-on-open and accept TOCTOU on drvfs.
