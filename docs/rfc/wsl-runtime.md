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

Only payload acquisition is backend-specific. Extract the supervisors' current
VirtioFS mount/unmount operations into generated `runtime-share-mount` and
`runtime-share-unmount` helpers. VZ keeps `mount -t virtiofs -o ro <tag>`; WSL
translates the host path with `wslpath`, bind-mounts the drvfs directory at the
same `/run/appliance/shares/<tag>` path, then remounts that bind read-only. The
host has already canonicalized the share and matched it to the persisted spec
before the request reaches the guest (`packages/vm/src/main.rs:1282-1287`,
`packages/vm/src/main.rs:1790-1810`). Non-translatable and UNC paths fail during
prepare, before the app starts, in v1. WSL does not add `runtime_mounts` as boot
devices and therefore does not restart the pool merely to add a payload; VZ
still must restart because its shares are boot-configured devices
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
(`packages/vm/src/main.rs:867-877`) and the VZ Runtime host-service contract
(`packages/vm/src/guest.rs:2927-2929`). A failed provision publishes a failed
bring-up phase immediately; no path waits 600 seconds for the agent handoff.

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
and the Runtime CA. WSL adds SNAT only for traffic to the host proxy so the
Windows listener sees the distro's admitted `eth0` lease; a per-app opaque proxy
credential, not the now-collapsed source IP, selects the corresponding resolved
`RuntimePolicy`. The credential is generated by the host, stored with effective
state, injected only into that principal, and revoked on stop. App grants must
never be merged into the VM-wide legacy policy. Runtime policies are already
normalized to default-deny hostname suffixes plus explicit TCP ports
(`packages/vm/src/egress.rs:335-413`). VZ currently selects that policy from the
principal `/32` source and fails an absent or duplicate identity closed
(`packages/vm/src/egress.rs:637-655`); the authenticated selector replaces only
that unavailable attribution step on WSL.

For traffic that uses the proxy, WSL can enforce the granted hostname and TCP
port, deny ungranted CONNECT/plain HTTP requests, attribute logs to the app, and
perform requested TLS inspection. It cannot prevent a hostile or proxy-unaware
process from removing the environment variables and using direct TCP, UDP, raw
IP, or its own DNS path through WSL NAT. Windows cannot recover the principal
identity at a host netstack boundary because there is no such boundary. The
existing legacy proxy is VM-scoped and loads only `load_policy(vm)` per request
(`packages/vm/src/egress.rs:890-927`); it is not sufficient for per-app policy
without the authenticated Runtime policy selector.

Decision: ship enforce-what-we-can, with no silent equivalence claim. Do not
refuse every WSL app that requests egress; that would make the owner-mandated
Runtime support unusable for networked apps. Grant prompts remain meaningful for
proxy-aware traffic, but must include the cooperative limitation.

`appliance vm egress policy appliance-runtime` must report effective capability,
not infer a host boundary from the persisted `netLink=netstack`. Its JSON becomes
an envelope containing `policy` and:

```json
{
  "policy": {
    "default": "deny",
    "allow": [],
    "deny": [],
    "mitm": true
  },
  "enforcement": {
    "backend": "wsl",
    "mode": "cooperative-proxy",
    "bypassable": true,
    "scope": ["http", "https"]
  }
}
```

The human `egress list` header must say `WSL NAT — cooperative proxy,
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
2. The drvfs share adapter quotes translated paths, rejects unsupported paths,
   bind-remounts read-only, and cannot escape the granted target.
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

One owner-run Windows 11/WSL2 NAT session is the release gate. From a clean pool
it must: cold-run and stop the container and binary samples; run the compound
Notes Suite and observe dependency health plus both service logs; open the
declared UI in the default browser and a Desktop app window; prove an allowed
HTTPS host succeeds through the app policy and a denied host returns 403; prove
the policy output carries the cooperative warning; stop/start the pool, observe
the app reconcile to stopped, then `runtime open` it on the same URL; and confirm
mirrored mode fails fast with remediation rather than hanging. Record the engine
and WSL versions with the result.

## Decision 6: deliver in three merge-ordered sub-issues

1. **WSL Runtime guest profile and drvfs payload adapter (L).** Acceptance: a
   networkless container and binary reach `core-ready`, start/status/log/stop
   through the shared supervisors, use read-only payloads, and never enter the
   `.dev-ready` wait.
2. **WSL Runtime TCP forward broker and open/restart reconciliation (M).**
   Acceptance: dynamic TCP bind/unbind is owner-only and idempotent; single and
   compound UI ports open at `127.0.0.1`; after a pool restart, `open` reuses the
   persisted port without restoring an unvalidated app.
3. **WSL cooperative per-app egress, truthful UX, and live certification (M).**
   Acceptance: proxy-aware HTTP(S) obeys each app's granted host/port policy,
   policy output says bypassable cooperative WSL, compound/app-window behavior
   passes, and the owner records the one live run above.

Merge in that order. Issue 2 needs the guest relay from issue 1; issue 3 needs
both a runnable principal and the final host URL surface.

## Alternatives considered

| Alternative                                                      | Decision            | Reason                                                                                                                         |
| ---------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| WSL NAT forwards + shared guest + cooperative proxy              | **Chosen**          | Uses the implemented WSL primitives and keeps the loopback product contract.                                                   |
| Require the VZ-style host netstack on Windows                    | Rejected            | WSL does not expose the raw NIC/socketpair the smoltcp boundary requires.                                                      |
| `netsh interface portproxy` for app ports                        | Rejected            | Adds administrator requirements and machine-global, failure-prone state.                                                       |
| Depend on WSL mirrored networking/automatic localhost forwarding | Rejected for v1     | Current guest-IP and gateway discovery require NAT; behavior varies by Windows/WSL version.                                    |
| Refuse all WSL apps with per-app egress grants                   | Rejected by default | Honest but makes common networked apps unusable; cooperative enforcement plus a prominent limitation meets the owner decision. |
| Fork both Runtime supervisors for WSL                            | Rejected            | The lifecycle/isolation logic would drift; only share acquisition and host networking differ.                                  |

## Owner gates and recommended defaults

1. **Security posture:** approve the bypassable cooperative egress downgrade.
   **Recommended default:** ship it with the policy envelope and grant-time
   warning above; do not market WSL as a hard sandbox boundary.
2. **Networking mode:** decide whether mirrored networking is release-blocking.
   **Recommended default:** NAT-only for v1 with the existing fail-fast
   remediation.
3. **Restart semantics:** decide whether apps should auto-start with the pool.
   **Recommended default:** no auto-start; revalidate bundle and grants on the
   next `runtime open`, retaining the same URL.
4. **Live evidence:** a Windows owner must perform and record the single run in
   Decision 5 because CI cannot certify WSL. This is owner-gated; no additional
   human wait is part of AP-190.
