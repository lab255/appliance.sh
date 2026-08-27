# Host-enforced guest egress firewall

**Status:** Design (F0 spike). **Owner-locked.** This document is the contract
F1–F5 build to; it writes no feature code. The decisions in **bold** are
settled — do not relitigate them downstream, refine the _how_.

## 0. Why

Today a microVM's egress is **unconfined**. The guest NIC is a
`VZNATNetworkDeviceAttachment` (`backend/vz/mod.rs:192-201`): the
framework runs NAT internally, the host never sees a packet, and the
guest has a direct, unrestricted path to the internet. The only "egress
control" we have is **cooperative** — `HTTP(S)_PROXY` env vars injected
into dockerd (`guest.rs:451-485`) and into k3s workloads via the
`appliance-egress` ConfigMap (`egress.rs:507-584`). A process that drops
the env, uses `--network host`, dials a raw IP, or speaks a non-HTTP
protocol simply bypasses it. Worse, the **shell-agent path — where Phase
5 agents run — injects no proxy at all**. A rooted guest, or an agent
told to exfiltrate, has nothing in its way.

This design makes the **host the egress boundary**. We replace the
framework NAT with a host-resident userspace TCP/IP netstack that owns
the _only_ path off-box, and force every guest flow through the existing
`egress.rs` allow/deny + MITM/creds machinery. A rooted/jailbroken guest
can forge any frame it likes; it still cannot reach anything except
through our netstack, which forwards a flow only after the allowlist says
yes. The policy stops being a suggestion.

Scope: **all managed microVMs** (agent + dev) on the macOS `VzBackend`.
**Out of scope and explicitly untouched: BYO-k8s and cloud deployment
paths** (§7).

## 1. Netstack choice — **smoltcp**

**Decision: a host-side userspace TCP/IP stack built on
[`smoltcp`](https://github.com/smoltcp-rs/smoltcp)** (pure Rust, MIT),
operated as a transparent terminator in the `tun2proxy` mode: feed it the
guest's raw Ethernet frames, let it terminate every guest TCP connection
locally, and forward the accepted byte-stream into `egress.rs`.

Evaluated:

| Option                      | TCP correctness                                                                                          | Integration                                                                                    | Maintenance                          | Verdict    |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------ | ---------- |
| **smoltcp**                 | Good — window scaling, reassembly, RTO, used in anger by `tun2proxy`, embedded fleets                    | In-process pure-Rust crate; preserves the single-binary `VzBackend` ethos                      | One crate, active, no FFI            | **Chosen** |
| gVisor `netstack/tcpip`     | Excellent — conformance-grade                                                                            | Go. CGo FFI is heavy and loses the single static binary, or it runs as a sidecar process + IPC | Large Go dep tree, language boundary | Rejected   |
| Hand-rolled L3/L4 forwarder | The hard part — SACK/RTO/window-scaling/reassembly/RST/MSS is months of work and a permanent bug surface | Trivial deps                                                                                   | We own a TCP stack forever           | Rejected   |

**Rationale (one paragraph).** The genuinely hard, correctness-critical
part of this project is terminating arbitrary guest TCP correctly at line
rate; everything else (DHCP-for-one-host, a DNS forwarder, the allowlist)
is small. smoltcp gives us exactly that hard part as a vetted, pure-Rust,
in-process library, and the `tun2proxy` project is a direct existence
proof of the shape we need — take raw IP/Ethernet from one side, accept
connections to _arbitrary_ destination addresses, and splice them to a
proxy. gVisor's stack is more conformant but Go: pulling it in means
either CGo (kills our single signed Mach-O and complicates the
entitlement story) or a sidecar process, both of which betray the
in-process `VZVirtualMachine` model the backend is built around. Rolling
our own TCP is the classic trap the brief flags — we would reimplement
smoltcp, worse, and maintain it. smoltcp's only gaps for us are that its
DHCP and DNS sockets are _client_-side; we supply a ~50-line DHCP
responder and a small DNS forwarder ourselves (§3), which is trivial next
to a TCP stack.

smoltcp runs **one instance per VM**, on the per-VM thread that already
owns guest-facing host services (`guest.rs:831`). It is not shared
across VMs — each VM has its own netstack bound to its own link, which
also structurally closes the cross-VM key-theft window the current
`peer_allowed`/`should_intercept` guards work around (§8).

## 2. The file-handle link

**Decision: swap `VZNATNetworkDeviceAttachment` →
`VZFileHandleNetworkDeviceAttachment`** (`backend/vz/mod.rs:194-201`),
backed by a `socketpair`, with the host end owned by the smoltcp
netstack.

### 2.1 Creating + wiring the fd

```
let (host_fd, vz_fd) = socketpair(AF_UNIX, SOCK_DGRAM, 0);   // two ends
// vz end → NSFileHandle → the attachment → the virtio-net device:
let nsfh = NSFileHandle::initWithFileDescriptor_closeOnDealloc(vz_fd, true);
let attach = VZFileHandleNetworkDeviceAttachment::initWithFileHandle(&nsfh);
attach.setMaximumTransmissionUnit(1500);                     // F1: keep 1500
net.setAttachment(Some(&attach));
// host_fd → the netstack's smoltcp Device (read/write raw frames).
```

The binding is already vendored (`objc2-virtualization` 0.3.2:
`VZFileHandleNetworkDeviceAttachment::initWithFileHandle`,
`setMaximumTransmissionUnit`); F1 only adds the
`VZFileHandleNetworkDeviceAttachment` + `NSFileHandle` cargo features
next to the existing network features in `packages/vm/Cargo.toml:33-49`.

### 2.2 Frame flow (host ↔ guest)

`VZFileHandleNetworkDeviceAttachment`'s contract is **one datagram = one
raw Ethernet frame** (full L2, no length prefix). That is exactly why the
link is `SOCK_DGRAM`, not `SOCK_STREAM`: the framework relies on datagram
boundaries to delimit frames, and a stream socket would force us to
re-frame a byte pipe the framework does not length-prefix.

- **Guest → host (TX):** the framework `write()`s each frame the guest's
  virtio-net emits to its end; the netstack `read()`s it from `host_fd`
  and pushes it into smoltcp as a received frame.
- **Host → guest (RX):** smoltcp produces a frame to transmit; the
  netstack `write()`s it to `host_fd`; the framework delivers it to the
  guest's virtio-net RX queue.

The netstack is the guest's L2 peer: it answers ARP for the gateway
address, owns the gateway MAC, and routes every IP packet through its
sockets. There is **no second NIC and no NAT** — `host_fd` is the entire
world the guest's NIC can see.

### 2.3 Link hygiene (tracked, finalized in F5)

- **Socket buffers.** DGRAM socketpair defaults are small; a burst of
  full-MTU frames can drop silently. Raise `SO_SNDBUF`/`SO_RCVBUF` on
  both ends and drain `host_fd` promptly on a dedicated reader.
- **Checksum offload.** virtio-net commonly offloads L4 checksums, so
  guest→host frames can arrive with zero/partial checksums. smoltcp must
  be configured to **not reject** RX checksums (`ChecksumCapabilities`)
  and to **compute** them on TX, or the guest must disable offload
  (`ethtool -K eth0 tx off rx off`). We take the netstack-side option so
  the guest needs no cooperation.
- **MTU.** Keep 1500 in F1 for parity and to avoid PMTU surprises; revisit
  larger MTU for throughput in F5.

## 3. DHCP + DNS (host-side, replacing the framework)

With NAT gone, the framework no longer leases the guest an address or
answers DNS — the netstack must. Both live inside the per-VM netstack on
a fixed private subnet (we pick our own deterministic /24, e.g.
`192.168.127.0/24`, gateway/host `=.1`, so the existing
`guest_proxy_url` "gateway is `.1`" assumption in `egress.rs:449-459`
still holds).

**DHCP (the lease).** A minimal single-client DHCP responder: the guest
DHCPs in initramfs (`ip=dhcp`, `guest.rs:638`), we answer DISCOVER/REQUEST
for the VM's known MAC with a fixed lease — `192.168.127.2/24`,
`router=192.168.127.1`, `dns=192.168.127.1`. **Because the netstack
_assigns_ the lease, the guest IP is known deterministically the instant
it is handed out** (indeed a-priori, since we allocate it per VM).

> **This replaces the `/var/db/dhcpd_leases` scrape entirely**
> (`net.rs:23-112`, `discover_guest_ip`). No plist parsing, no 120 s
> poll, no MAC-lookup race. The netstack writes `guest-ip` at lease-grant
> time (the same file `egress.rs` and the forwards already read), and
> `discover_guest_ip` collapses to "read the IP the netstack assigned."

**DNS (the resolver).** The netstack listens on UDP/53 **and** TCP/53 at
`192.168.127.1`. It is a forwarding resolver: it consults the
`EgressPolicy` allowlist for the queried name, and for **allowed** names
forwards to the host's real resolver (host `getaddrinfo` / system DNS),
returning the answer to the guest; **denied** names get `NXDOMAIN`/refused.
**It MUST also drop answers that resolve into private/internal/host-LAN
ranges (anti-SSRF, §8.1 #1)** and bound the upstream lookup with a short
timeout — this is the pre-F2 blocker.

**DNS's role — defense-in-depth + UX, NOT the boundary.** DNS filtering
is bypassable on its own (a guest can hardcode IPs or speak DoH to an
allowed host), so we never _rely_ on it. We filter DNS anyway because it
(1) fails non-allowlisted egress fast and legibly instead of as an opaque
TCP timeout, (2) means the only nameserver the guest can reach is ours —
DNS-tunnelling to an arbitrary resolver is just another flow that hits
default-deny, and (3) lets us remember `name → resolved A/AAAA` so a
later raw-IP connect can be back-referenced to the allowlisted name it
came from (§4). The hard boundary is still the TCP terminator.

## 4. Transparent forward + classification

The netstack accepts **every** guest TCP SYN to **any** destination
IP:port and terminates it locally (smoltcp listening socket on the catch-
all); **non-TCP / non-DNS traffic — UDP, ICMP, all IPv6, custom
EtherTypes — is dropped, not forwarded** (§8.1 #2). On accept we know
`dst_ip:dst_port`; we then classify (**fail-closed** — un-parseable ⇒
deny, §8.1 #4) and feed **allowed** flows into the existing `egress.rs`
core (reused wholesale — `EgressPolicy::allows()`/`host_matches()`,
`mitm.rs` SNI extraction at `mitm.rs:135`, `creds.rs`), connecting to the
**re-resolved validated name, never the guest's `dst_ip`** (§8.1 #3):

- **443 / TLS ports** — peek the TLS ClientHello, extract **SNI**
  (`hello.server_name()`, `mitm.rs:135`). Allowlist by SNI. Allowed →
  hand the terminated stream to the existing tunnel path as if it were a
  `CONNECT sni:443`: `EgressPolicy::allows()` → `should_intercept` →
  blind splice **or** `mitm::intercept` (+ `creds`) exactly as today.
- **80 / HTTP** — read the request head, take the **Host** header,
  allowlist by Host, feed the plain-HTTP forward path.
- **Raw IP / non-TLS / non-HTTP / other ports** — **default-deny.**
  Two opt-in hatches, **both private-range-rejected (§8.1 #1)**: (a) the
  dst IP matches an A/AAAA we resolved for an _allowlisted_ name within a
  short TTL (the legitimate "app dialed the IP our DNS just gave it"
  case); (b) an explicit **IP/CIDR allow rule** in `EgressPolicy.allow`.
  Both reject any private/internal/host-LAN target; otherwise refuse.
- **UDP (non-DNS)** — **default-deny in F2** (and dropped at the
  netstack, §8.1 #2). This denies QUIC/HTTP-3 on UDP/443 (clients fall
  back to TCP/443, which we _can_ SNI-inspect) and also UDP-only services
  like **NTP/123** — clock sync must use the host path, not in-guest NTP
  (§8.1 #6). Revisit as a policy knob in F5. DNS to the gateway
  (`.1:53`) is the one allowed UDP.

This is the load-bearing reuse: the netstack's accept path is a new
_front door_ onto the **same** allow/deny + MITM/creds core that
`egress.rs::handle_conn` already implements (F3 extracts that core so
both share it).

## 5. Default-deny + the sane default allowlist

**Decision: flip `EgressPolicy` default `Allow → Deny`**
(`egress.rs:41-46`; the data model and the
`default_deny_blocks_unless_allowlisted` test already exist) in **F2**,
and ship a baked default allowlist for fresh VMs:

```
# api / model
api.anthropic.com
# alpine packages
dl-cdn.alpinelinux.org
# language package registries
registry.npmjs.org                       # npm
pypi.org   files.pythonhosted.org        # pip
crates.io  static.crates.io              # cargo
# git
github.com  codeload.github.com  *.githubusercontent.com
# container registries
registry-1.docker.io  auth.docker.io  production.cloudflare.docker.com  ghcr.io
```

(Suffix-matched by `host_matches` — `github.com` already covers
`api.github.com`; `*.githubusercontent.com` is the wildcard the matcher
handles as the `githubusercontent.com` suffix.)

**Exclusions — never policed, always local** (mirrors and extends
`default_no_proxy`, `egress.rs:492-494`): loopback (`127.0.0.0/8`, `::1`,
`localhost`); the k3s pod/service CIDRs `10.42.0.0/16` & `10.43.0.0/16`;
`.svc` / `.svc.cluster.local`; the docker bridge `172.17.0.0/16`. **Most
of these never reach the host link at all** — pod-to-pod (`10.42`),
service (`10.43`), and docker-bridge (`172.17`) traffic is _intra-guest_
and is switched inside the guest kernel; it never crosses `host_fd`, so
default-deny at the boundary structurally cannot touch it. That is
precisely why in-VM k3s keeps working under a host-side firewall (§7
risk). The exclusions are belt-and-suspenders for any such packet that
_does_ reach the netstack (e.g. addressed to the gateway).

The in-guest cooperative layer (the `appliance-egress` ConfigMap +
dockerd env, `egress.rs:507-584`, `guest.rs:451-485`) **stays** — it now
sits _behind_ the hard host boundary as defense-in-depth (and keeps
giving workloads a tidy `HTTPS_PROXY` rather than relying on transparent
interception for everything), but it is no longer load-bearing for
confinement.

## 6. Published-port inbound forwarding

Inbound forwarding (`net.rs:spawn_proxy`, wired in `guest.rs:848-863`)
must keep working: api `:6443`, ingress `:80`, registry NodePort, the
`30000-30050` window, and the dev `published` ports
(`spec.rs:PublishedPort`).

Today `spawn_proxy` does `TcpStream::connect((guest_ip, port))` — the OS
routes that over the vz NAT subnet. **Under the new link there is no OS
route to the guest** (the guest lives entirely inside our userspace
stack). So the inbound path is re-homed: the netstack exposes a
**`connect(guest_ip, port) -> host-side stream`** primitive (smoltcp
originates a SYN to the guest as a client), and `spawn_proxy` dials
_through the netstack_ instead of the OS TCP stack. The listener side
(`127.0.0.1:<hostPort>`) and the bidirectional `pump` are unchanged; only
the "connect to guest" leg swaps from `TcpStream::connect` to
`netstack.connect`. This is the one change point for point 6, and it is
covered by F1 (behavior-neutral): published ports must work identically
before any filtering is added.

## 7. Rollout / migration (LOAD-BEARING)

This swaps the network for **every managed microVM**, so it ships staged
and flag-gated, behavior-neutral first.

**Feature flag:** a per-VM spec field **`VmSpec.net_link: { Nat,
Netstack }`** (serde default `Nat` in F1→F3, flipped to `Netstack` in
F4). Per-VM so existing VMs keep NAT until recreated; a global
`APPLIANCE_NETSTACK=1` env override for testing/CI. The `Nat` path stays
compiled and selectable for one release after the default flips, as the
escape hatch.

**Build contracts (one line each):**

- **F1 — Behavior-neutral host netstack (default-ALLOW, opt-in).** Swap
  NAT → `VZFileHandleNetworkDeviceAttachment` over a `socketpair(DGRAM)`;
  smoltcp netstack with the single-client DHCP responder (deterministic
  lease → writes `guest-ip`, **deletes the `dhcpd_leases` scrape**),
  forwarding DNS, and transparent TCP terminate-and-forward upstream with
  **every flow allowed**; re-home `net.rs` inbound forwards through the
  netstack `connect`. Gated `net_link=Netstack`. **F1 GATE (§8.1 #5):**
  exactly one network device (no residual NAT attachment / second NIC),
  and frame-parser robustness (bounded reads, no panic on malformed
  frames) + per-VM netstack panic isolation — the hostile-frame parser is
  in the data path a release before F5 fuzzing. **Accept:** boot, DNS,
  k3s `Ready`, kubeconfig handoff, and published ports are identical to
  NAT — zero breakage.
- **F2 — Default-deny + allowlist filtering.** **PRE-F2 BLOCKER (§8.1
  #1):** resolver SSRF / private-range filtering MUST land first — the
  DNS resolver and both raw-IP hatches reject private/internal/host-LAN
  targets, host-resolver calls are timeout-bounded. Then flip
  `EgressPolicy::default()` → `Deny`; bake the §5 allowlist + exclusions;
  classify SNI(443)/Host(80)/IP(raw) on the accept path through
  `EgressPolicy::allows()`, connecting to the **re-resolved validated
  name, never `dst_ip`** (§8.1 #3) and **failing closed** on un-parseable
  SNI/Host (§8.1 #4); drop all non-allowlisted-TCP / non-DNS L3/L4 incl.
  UDP/ICMP/IPv6 (§8.1 #2). **Accept:** allowlisted endpoints (apk/npm/pip/
  cargo/git/docker/anthropic) succeed; everything else is refused —
  raw-IP, a proxy-env-dropping process, a name-resolves-internal rebind,
  and a `SNI=allowed` → `dst_ip=evil` flow.
- **F3 — Unify the policy core.** Extract `serve_tunnel(name, host, port,
stream)` / `serve_http(name, host, stream)` from
  `egress.rs::handle_conn` so the netstack accept-path and the legacy
  CONNECT proxy share one allow/deny + `mitm::intercept` + `creds` core;
  move the egress proxy off its `0.0.0.0` TCP listener
  (`main.rs:581-582`) to per-VM in-process/loopback-only invocation
  (closes the open-proxy + sibling-reachability surface, §8).
- **F4 — Netstack becomes the default.** Flip `net_link` default →
  `Netstack` for all managed microVMs (agent + dev); NAT remains
  selectable for one release; `doctor`/`up` surface the active link.
  **BYO-k8s + cloud paths stay on their current networking, untouched.**
- **F5 — Hardening + observability.** Checksum/MTU/offload handling,
  socketpair buffer tuning, **fuzz** the hostile-frame parser (whose
  baseline robustness + panic isolation already gated F1, §8.1 #5),
  deny/allow events into the existing `traffic` view, finalize the
  UDP/QUIC policy knob, throughput validation, then retire NAT.

**Untouched (must not regress):**

- **BYO-k8s** — runs against the user's own cluster; never starts the vz
  link, must not get default-deny and must not depend on the netstack.
- **Cloud deployment / promotion** (`docs/cloud-promotion-contract.md`,
  `control-plane.md`) — a different runtime entirely; the egress firewall
  is a local-`VzBackend`-only concern and must not touch it.
- The in-guest cooperative egress ConfigMap remains as it is (demoted to
  defense-in-depth, §5).

**Risk list:**

1. **DNS** — correctness/latency of the host forwarder; must answer fast
   (initramfs and apk are sensitive to slow DNS) and not deadlock on the
   host resolver. Mitigate: short upstream timeouts, cache, TCP/53 too.
2. **k3s in-VM** — relies on intra-guest pod/service traffic _never_
   crossing the link (§5). Verify with a multi-pod workload under
   default-deny; a regression here breaks the cluster silently.
3. **Published ports** — the re-homed `netstack.connect` inbound leg is a
   new code path for ingress/api/registry/NodePort/dev-published; prove
   it in F1 before any filtering lands.
4. **MTU / checksums on the virtio link** — offloaded/zero checksums and
   datagram-socket frame drops are the most likely "works then mysteriously
   stalls" failure; handle checksum capabilities + buffer sizing
   explicitly (§2.3), don't assume.

## 8. Security

**The boundary today** is cooperative and effectively absent: NAT gives
the guest direct egress, the only control is `HTTP(S)_PROXY` env a
process can drop, and the agent/shell path injects nothing. A rooted
guest has unrestricted egress.

**The boundary after** is the host netstack at the hypervisor link. The
guest's NIC is wired to a single `SOCK_DGRAM` socketpair whose only peer
is our smoltcp instance. There is **no NAT, no second NIC, no host route**
from the guest subnet to anything. A rooted/jailbroken guest can forge
arbitrary Ethernet/IP/TCP frames, drop the proxy env, use `--network
host`, dial a raw IP, or speak a custom protocol — and every one of those
frames still arrives in our userspace netstack, which **originates an
upstream flow only after `EgressPolicy::allows()` returns true** for its
validated SNI/Host/IP, and **drops everything else**. **There is no other
path off-box**, which is the property the brief requires.

### 8.1 Security invariants (review must-adds — the contract F1/F5 build to)

Sasha's conditional clearance turns on these six. **#1 is a hard pre-F2
blocker; #5 is an F1 acceptance gate.** They refine §3 (DNS), §4
(classification) and the F1/F2/F5 contracts (§7).

1. **(pre-F2 BLOCKER) Resolver SSRF / private-range filtering.** The
   forwarding DNS resolver MUST drop/refuse any resolved answer that
   falls in a private/internal range — `10/8`, `172.16/12`,
   `192.168/16`, `100.64/10` (CGNAT), `169.254/16` (link-local), `::1`,
   `fc00::/7` (ULA), `fe80::/10` (v6 link-local), **and the host's own
   LAN** — treating an allowlisted name that resolves to such an address
   as **DENIED**, not forwarded. The two raw-IP hatches (the explicit
   `IP/CIDR` allow rule **and** the DNS→IP back-reference set) likewise
   **REJECT** any private/internal/host-LAN target: the netstack **never
   originates an upstream connection — nor admits a back-ref allow — to a
   non-public address.** Bound the host-resolver lookup with a short
   timeout so it cannot serve as an internal-host **timing oracle**.
   (Cluster CIDRs `10.42`/`10.43`/`172.17` are switched inside the guest
   and never cross `host_fd`, so they need no upstream path and are
   unaffected.) Without this, DNS rebinding turns the internet-confinement
   boundary into a pivot into the operator's LAN (SSRF).

2. **Boundary invariant — originate only allowlisted TCP (+ local DNS);
   drop the rest.** The netstack originates an upstream flow for **only
   allowlisted TCP** connections, plus DNS via the local gateway
   resolver. **Every other L3/L4/EtherType is dropped at the netstack**,
   never forwarded: non-DNS **UDP** (incl. QUIC on UDP/443 and NTP),
   **ICMP / ICMPv6**, **all unclassified IPv6** (SLAAC/RA, link-local,
   global v6), ARP to anything but the gateway, and any custom
   protocol/EtherType. The rest of this doc is IPv4-centric; **IPv6 and
   ICMP are explicitly in the drop set** — a v6 path must never silently
   bypass the v4 allowlist.

3. **Connect to the name, re-resolved host-side — never the guest's
   `dst_ip`.** An allowed TLS(443)/HTTP(80) flow connects to the
   **validated hostname, re-resolved on the host**, never the
   guest-supplied `dst_ip`. Otherwise a guest sends `SYN → evil_ip:443`
   carrying `SNI: api.anthropic.com` and rides an allowed label to an
   arbitrary IP. `dst_ip` is the connect target **only** in the two
   opt-in raw `IP/CIDR` hatches — which are themselves private-range-
   rejected per #1.

4. **Fail-closed classification.** A bounded read with a timeout; an
   **un-parseable / incomplete / absent** ClientHello SNI (443) or `Host`
   header (80) ⇒ **DENY**, never a blind forward. A flow that will not
   classify is refused, not passed through.

5. **(F1 acceptance gate — NOT deferred to F5) One device + parser
   robustness + panic isolation.** Exactly **one** network device is
   configured on the VM — no residual `VZNATNetworkDeviceAttachment`, no
   second NIC — so there is provably one path off-box. And because F1
   already puts the hostile-frame parser in the data path (a release
   before F5's fuzzing), **minimal frame-parser robustness (bounded
   reads, no panics on malformed L2/L3/L4) and per-VM netstack panic
   isolation are F1 gates.** A malformed frame from a rooted guest must
   fail the flow, never the host process; a panic is contained to that
   VM's own thread.

6. **Doc honesty — default-deny shrinks, does not eliminate, exfil.** The
   baked default allowlist (§5) includes **write-capable exfil
   channels**: `github.com` suffix-matches `gist.github.com` (anonymous
   gist creation), and any allowed/brokered model API has a **writable
   request body**. So default-deny **shrinks but does not eliminate**
   exfil for a compromised agent — it controls **WHERE** traffic may go,
   not **WHAT** leaves; this is **not DLP**. The registry/CDN defaults
   (apk/npm/pip/cargo/docker) are **read-mostly**, an asymmetry worth
   leaning on. **Trimming the allowlist is the operator's exfil lever**:
   for an untrusted-code agent, **drop `github.com` (or pin a single git
   remote)** and keep only the package mirrors the task needs — the
   recommended hardening. Note the functional cost too: denying non-DNS
   UDP (#2) breaks UDP-only services such as **NTP (123)**, so clock sync
   must ride the host path (`shell::spawn_clock_sync`) or a TCP/allowlisted
   alternative, not in-guest NTP.

### 8.2 Structural bonus + remaining residual risks

A structural bonus: because each VM has its **own** netstack and its
**own** link, a sibling VM cannot reach this VM's egress proxy at all —
the cross-VM brokered-key-theft window that `peer_allowed` /
`should_intercept` defend against (`egress.rs:386-424`) closes by
construction once F3 moves the proxy off `0.0.0.0` to per-VM in-process.

Remaining residual risks (after the six invariants above):

1. **Covert/allowed-channel exfil** (see #6). MITM/creds only inspect
   _brokered_ hosts; allowed-but-blind hosts are opaque tunnels by design
   (to preserve streaming/keep-alive). WHERE-not-WHAT; trim the allowlist
   to shrink it further.
2. **DNS→IP back-reference TTL race.** Even with the #1 private-range
   reject, a guest could race the TTL to ride a back-ref allow to a
   public-but-non-allowlisted IP that briefly shared a resolved address.
   Keep the TTL short; treat IP allow as coarse.
3. **Netstack in the data path.** A logic bug is a confinement bug even
   with #5 robustness; smoltcp's track record plus F5 fuzzing mitigate,
   but the parser ingests hostile input from a rooted guest.

## 9. F5 netstack hardening (pre-default-flip)

These are the gating hardening items that MUST land before the F4
default-flip makes `Netstack` the default link (§7). They harden the
netstack against a **hostile guest** (resource-exhaustion DoS) and restore
a behavior parity the F2 brokered-dial refactor regressed — all on
`packages/vm`, none of it changing the confinement contract above.

### 9.1 Resource-exhaustion (DoS) caps

A rooted guest drives the netstack directly; without caps it can exhaust
host memory or threads while staying inside the boundary. The caps make
each resource the guest can provoke **bounded**:

- **`guest → ext` backpressure (memory).** The engine now stops draining
  smoltcp's recv buffer once the per-flow `guest_to_ext` buffer reaches
  `GUEST_TO_EXT_HIGH_WATER` (256 KiB) — closing the TCP receive window so a
  guest blasting a slow/stalled upstream is backpressured instead of
  ballooning host memory. **Symmetric** to the existing
  `EXT_TO_GUEST_HIGH_WATER` cap on the other direction
  (`netstack/engine.rs::drain_guest_to_ext`).
- **Concurrent-flow cap + per-socket reaping (memory, SYN-flood).** Each
  guest SYN eagerly allocates a 2×`TCP_BUF` (128 KiB) socket. The engine
  now refuses new SYNs past `MAX_CONCURRENT_FLOWS` (1024) — dropping the
  SYN so no socket is allocated, the guest's stack retransmits then aborts,
  and the refusal is logged rate-limited — bounding worst-case smoltcp
  socket memory to `MAX_CONCURRENT_FLOWS × 2×TCP_BUF`. Every socket also
  carries `set_timeout` (60 s idle) + `set_keep_alive` (30 s), so a
  half-open SYN-flood socket stuck in `SYN_RECEIVED` is reaped while a
  live, keep-alive'd peer never trips the idle timeout
  (`admit_syn`, `tcp_socket`).
- **Bounded resolver pool (threads).** Host-side name re-resolution
  (`getaddrinfo`) ran on a **detached thread per allowed flow** — a hung
  resolver leaked one thread per flow. It now runs on a fixed,
  process-wide pool of `RESOLVER_WORKERS` (8) workers; the caller still
  bounds its wait with `RESOLVE_TIMEOUT`. A hung resolver wedges at most 8
  threads, reused across every flow, never growing without bound
  (`guard.rs::resolver_pool`). (`dns::forward` is UDP with a read timeout,
  so its per-query worker already self-reaps — the unbounded leak was only
  the `getaddrinfo` path.)

### 9.2 Brokered-dial parity fix

- **Legacy multi-addr connect fallback restored.** On the legacy (`None`
  upstream) CONNECT path, `mitm::dial_upstream` again iterates **all**
  public resolved candidates in order until one connects, rather than
  trying only the first — while preserving the §8.1 #1 private-range reject
  on each candidate (`public_upstreams` + `dial_first`). The netstack
  accept-path is unchanged: it still dials **exactly** the one pre-validated
  public addr, never re-resolving.

### 9.3 Blast-radius / live-test matrix (OWED-LIVE)

The DoS caps and the fallback fix are **unit-verified** (backpressure stops
at the high-water; the flow cap refuses past N and dedups retransmits;
`dial_first` iterates public candidates until one connects and still
rejects private ones; the resolver pool is bounded/reaped). The **compat
matrix below is owed-live** — it must be confirmed on a real
`net_link=Netstack` VM under **default-deny** before the F4 flip, because a
silent regression here (e.g. a cap throttling a legitimate heavy workload,
or k3s intra-cluster traffic mistakenly crossing the boundary) breaks the
appliance quietly. Owner runs this pass on a `Netstack` VM.

**Must still WORK under default-deny + the §5 baked allowlist:**

| #   | Scenario                                                                                                                       | Confirms                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The **broker**: an agent/curl call to `api.anthropic.com` (brokered MITM + cred injection)                                     | the allowlisted brokered path round-trips through the accept-path interceptor                                                             |
| 2   | **apk** add (`dl-cdn.alpinelinux.org`)                                                                                         | Alpine package install over the allowlist                                                                                                 |
| 3   | **npm** install (`registry.npmjs.org`)                                                                                         | npm registry fetch                                                                                                                        |
| 4   | **pip** install (`pypi.org`, `files.pythonhosted.org`)                                                                         | PyPI + the CDN host                                                                                                                       |
| 5   | **cargo** fetch (`crates.io`, `static.crates.io`)                                                                              | crate index + downloads                                                                                                                   |
| 6   | **git** clone/fetch (`github.com`, `codeload.github.com`, `*.githubusercontent.com`) over HTTPS                                | git smart-HTTP, incl. the codeload + raw CDNs                                                                                             |
| 7   | **dockerd image pulls** (`registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`, `ghcr.io`)              | the in-guest docker daemon pulling through the boundary                                                                                   |
| 8   | **k3s multi-pod intra-cluster**: a 2+ pod workload talking pod→pod (`10.42/16`) and pod→service (`10.43/16`)                   | intra-guest traffic is switched in-kernel and **never crosses `host_fd`** — default-deny structurally cannot touch it (§5, §7 risk 2)     |
| 9   | **cluster-internal names**: `*.svc` / `*.svc.cluster.local`, `localhost`                                                       | excluded names resolve/route without being policed                                                                                        |
| 10  | **published-port round-trips**: ingress `:80`, api `:6443`, registry NodePort, the `30000–30050` window, dev `published` ports | the re-homed `netstack.connect` inbound leg under filtering (§6) — and that the flow cap / backpressure don't throttle legitimate inbound |
| 11  | **BYO-k8s + cloud paths**                                                                                                      | **untouched** — never start the vz link, never get default-deny, don't depend on the netstack (§7 "Untouched")                            |

**Must be DENIED (adversarial):**

| #   | Attack                                                                                                                                                  | Expected                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | A **rooted guest** dials a **raw public IP** (no allowlisted name, no fresh back-ref) to exfiltrate                                                     | dropped at default-deny (§4 raw-IP path); no upstream originated                                                                                                                    |
| B   | A **brokered host** whose DNS **rebinds to a private/host-LAN addr** (allowlisted name → internal answer, or a multi-A record carrying a private entry) | refused — the resolver drops the private-resolving answer and `resolve_public`/`public_upstreams` reject the forbidden target (§8.1 #1); the brokered credential is never disclosed |
| C   | A process that **drops the proxy env** (`--network host`, no `HTTPS_PROXY`) and egresses directly                                                       | still confined — every frame still arrives in the netstack and hits default-deny; the cooperative proxy env was never the boundary (§8)                                             |

**Caps must not throttle legitimate use** (watch during 1–10): the
concurrent-flow cap (1024) and the per-flow backpressure high-water
(256 KiB) are sized well above interactive/dev workloads; the live pass
should confirm a heavy `npm`/`docker`/multi-pod run completes without the
SYN-flood refusal log firing or flows stalling.

## 10. Desktop egress surface (F4 — `packages/app` + `packages/desktop`)

The GUI counterpart to the CLI's `egress policy` / `egress denied` /
`egress allow`. It lives in the **Local Runtime** page, per running VM, as
the `EgressPanel` (`packages/app/src/pages/local-runtime/index.tsx`) — so an
operator can see the boundary and unblock a host **without a terminal**. It
is read + incremental-edit only; it never recreates a VM or flips
`net_link` (that stays the engine's job).

**Firewall status + effective policy (read-only).** The panel reads the
**effective** policy through the existing `microvm_egress_get` Tauri
command (`egress policy` → `egress::effective_policy`): for a
`net_link=Netstack` VM that's the host-enforced **default-DENY + baked
allowlist** merged over the operator's rules; for `net_link=Nat` it's the
persisted cooperative policy. To label the boundary honestly the desktop
also resolves the VM's link host-side — `microvm_egress_get` enriches the
response with `enforced` / `netLink`, read from the engine's persisted spec
(`~/.appliance/vm/<name>/vm.json` `netLink`, honoring the
`APPLIANCE_NETSTACK=1` force-on override exactly as `VmSpec::net_link()`
does). The panel renders an **Enforced boundary** banner (net_link=Netstack,
default-DENY, the only path off-box) vs a **Cooperative proxy** banner
(net_link=Nat, bypassable) and partitions the allowlist into the **baked**
set (always-on, struck through when an operator deny overrides it — a mirror
of `NETSTACK_ALLOWLIST` / `render_effective_policy`), **operator allow**, and
**operator deny**. For a Netstack VM the default action is shown read-only
(it is host-enforced; offering a toggle would persist `default=Deny` into the
file).

**Denied-attempts view.** A `DeniedAttempts` roll-up consumes the existing
`egress log` JSON feed (`microvm_egress_log`, the `deny` records written by
`netstack::guard::log_deny`) and aggregates them per `(host, port)` into
**host : port · count · last-seen, most-recent-first** — a direct mirror of
`traffic.rs::aggregate_denied` so the GUI matches the CLI's `egress denied`.

**"Allow this host?" affordance + the incremental guarantee (Quinn's F3
review).** Each denied row (and the live-traffic feed, and the manual add
box) has a one-click **Allow** that calls `microvm_egress_rule(name,
"allow", host)`, which drives the engine's typed `egress allow <host>`
subcommand → `load_policy` → push the one rule → `save_policy` on the
**persisted** `egress-policy.json`. It is **never** a
get-effective→modify→`set` round-trip: `microvm_egress_get` returns the
effective merge (default=Deny + baked hosts for Netstack), and writing that
whole object back would persist `default=Deny` + the baked allowlist into
the file and mis-enforce if the VM were later switched to NAT. All the other
edit paths (`microvm_egress_default` / `_rule` / `_mitm` / `_reset`) are the
same shape — thin wrappers over the engine's incremental subcommands, no
effective-JSON write-back anywhere.

**Graceful degradation.** The egress panel only mounts for a running,
cluster-ready VM; the web/mock shell (`packages/desktop/src/mock-host.ts`)
exercises both a Netstack (enforced) and a NAT (cooperative) VM with seeded
deny records, so the surface is QA-able in a browser with no microVM host.

**OWED-LIVE.** The real denied→allow loop in the GUI against a live
`net_link=Netstack` VM under default-deny (block a host, watch it appear in
Denied attempts, click Allow, confirm it now connects) is **owed-live** —
the surface is implemented, typechecked, and build-verified, but the
end-to-end GUI pass against a running Netstack VM has not been run.

## 11. Packaged-app runtime policies

Packaged apps do not inherit the development VM's baked allowlist. Each
runnable app/service has a stable `192.168.127.0/24` source `/32` and an
effective policy record under `~/.appliance/runtime/<app>/effective.json`.
The engine reserves `.0`-`.9` for gateway/root/infrastructure use and accepts
runtime principal addresses `.10`-`.254` (the chosen initial infrastructure
range pending a shared allocator constant).
The runtime controller installs a validated principal record with:

```sh
appliance-vm runtime-policy set <vm> <app-or-app/service> < effective-principal.json
appliance-vm runtime-policy get <vm> <app-or-app/service>
```

The input identifies `version`, `app`, optional `service`, `vm`, `principal`,
`source`, an `EgressPolicy`-shaped `policy`, and `allowPorts`, whose keys must
exactly match the normalized allow suffixes and whose values are the granted
TCP ports. The engine normalizes DNS
suffixes, rejects URLs, IP/CIDR literals, ports, and public-suffix-only names,
and always forces `default: deny`. Missing/invalid files and unknown source
addresses fail closed. Effective files are atomically replaced with mode 0600
and may contain multiple service-principal records for one compound app.

Allowed HTTPS is inspected when `policy.mitm && allowed`; this runtime path is
inspection-only and never calls credential capture/injection or rewrites HTTP
bytes. It offers HTTP/1.1 ALPN only. A user may set `mitm: false` without
weakening destination enforcement.

App events are kept separately at
`~/.appliance/runtime/<app>/egress-events.jsonl` as a newest-records 512 KiB
ring. Records contain timestamp, app/service/principal, decision and reason,
host/port/transport, and—when observed—SNI, TLS version, HTTP method,
query/fragment-stripped path, status, bytes in/out, and duration. Headers,
cookies, authorization values, query values, and bodies are never persisted.
