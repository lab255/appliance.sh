//! The per-VM smoltcp driver loop (unix only).
//!
//! Owns the host end of the guest's `socketpair` link and a single
//! smoltcp `Interface`. Per iteration it: drains the fd of guest frames,
//! answers DHCP/DNS at the raw layer, feeds ARP + TCP to smoltcp,
//! terminates every guest TCP flow, and bridges each to an external peer
//! (an upstream `TcpStream` for guest-originated flows; the host
//! listener for inbound published ports). **F1 is behaviour-neutral
//! default-ALLOW** — every flow is forwarded, no policy yet.
//!
//! All work runs on one thread, wrapped by the caller in `catch_unwind`,
//! so a panic is contained to this VM (§8.1 #5).

use super::frame::{self, Class};
use super::{Bridge, BridgeStream, ConnectRequest, LinkConfig, Netstack};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{
    Checksum, ChecksumCapabilities, Device, DeviceCapabilities, Medium, RxToken, TxToken,
};
use smoltcp::socket::tcp;
use smoltcp::time::{Duration as SmolDuration, Instant as SmolInstant};
use smoltcp::wire::{
    EthernetAddress, HardwareAddress, IpAddress, IpCidr, IpEndpoint, IpListenEndpoint,
};
use std::collections::{HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddr};
use std::os::fd::RawFd;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// SO_SNDBUF on the link ends. Apple wants SO_RCVBUF ≥ 2× (ideally 4×)
/// SO_SNDBUF for the file-handle attachment (§2.3).
const SND_BUF: libc::c_int = 256 * 1024;
const RCV_BUF: libc::c_int = 1024 * 1024;
/// Per-flow smoltcp socket buffer (each direction).
const TCP_BUF: usize = 64 * 1024;
/// Cap on frames drained from the fd per iteration (bounds work).
const RX_BATCH: usize = 256;
/// Loop wait cap (ms): bounds added latency for bridge data that
/// smoltcp's own `poll_delay` can't see. Throughput tuning is F5.
const WAIT_CAP_MS: i32 = 5;

/// Default cap on concurrent terminated guest flows (SYN-flood guard, F5).
/// Each guest SYN eagerly allocates a 2×`TCP_BUF` (128 KiB) socket; a
/// SYN-flood across distinct 4-tuples would balloon socket memory before
/// smoltcp's retransmit/timeout reaps the half-open sockets. Past this many
/// live flows we refuse new SYNs (drop the frame — no socket is allocated;
/// the guest's stack retransmits then aborts), bounding worst-case smoltcp
/// socket memory to `max_flows × 2×TCP_BUF`. Override with
/// [`ENV_MAX_FLOWS`] when a legitimate heavy-fan-out workload needs more
/// (Quinn's F5 nit).
const DEFAULT_MAX_CONCURRENT_FLOWS: usize = 1024;
/// Default per-flow idle timeout (secs). A flow with no packets for this
/// long is reset — including a half-open SYN-flood socket stuck in
/// `SYN_RECEIVED` — so the eagerly-allocated sockets a flood leaves behind
/// don't linger. Generous enough that a live, keep-alive'd peer never trips
/// it. Override with [`ENV_IDLE_SECS`].
const DEFAULT_FLOW_IDLE_SECS: u64 = 60;
/// Keep-alive probe interval on established flows. Probes elicit ACKs that
/// reset the idle timeout for a *live* peer (so the idle timeout reaps only
/// dead/half-open sockets) and surface a dead upstream.
const FLOW_KEEPALIVE: SmolDuration = SmolDuration::from_secs(30);

/// Env override for the concurrent-flow cap (a positive integer).
const ENV_MAX_FLOWS: &str = "APPLIANCE_NETSTACK_MAX_FLOWS";
/// Env override for the per-flow idle timeout, in seconds (a positive
/// integer).
const ENV_IDLE_SECS: &str = "APPLIANCE_NETSTACK_IDLE_SECS";

/// Parse a positive-integer override, falling back to `default` when the
/// value is absent, empty, unparseable, or zero. Zero is treated as invalid
/// because a zero cap would refuse every SYN and a zero idle timeout would
/// reap flows instantly — either would wedge the stack. Pure (operates on
/// the raw string) so the precedence is unit-tested without touching the
/// process environment.
fn parse_positive<T>(raw: Option<&str>, default: T) -> T
where
    T: std::str::FromStr + PartialEq + From<u8>,
{
    raw.and_then(|v| v.trim().parse::<T>().ok())
        .filter(|n| *n != T::from(0u8))
        .unwrap_or(default)
}

/// The effective concurrent-flow cap: [`ENV_MAX_FLOWS`] or the default.
fn max_concurrent_flows() -> usize {
    parse_positive(
        std::env::var(ENV_MAX_FLOWS).ok().as_deref(),
        DEFAULT_MAX_CONCURRENT_FLOWS,
    )
}

/// The effective per-flow idle timeout: [`ENV_IDLE_SECS`] secs or the default.
fn flow_idle_timeout() -> SmolDuration {
    SmolDuration::from_secs(parse_positive(
        std::env::var(ENV_IDLE_SECS).ok().as_deref(),
        DEFAULT_FLOW_IDLE_SECS,
    ))
}
/// Rate-limit on the SYN-flood-refusal log so a flood can't also flood the
/// host log.
const FLOW_CAP_LOG_EVERY: Duration = Duration::from_secs(5);

/// Create the `socketpair(AF_UNIX, SOCK_DGRAM)` link. Returns
/// `(host_fd, vz_fd)`: the host end (owned by the netstack, made
/// non-blocking) and the guest/framework end (handed to the
/// `VZFileHandleNetworkDeviceAttachment`).
pub fn make_link() -> std::io::Result<(RawFd, RawFd)> {
    let mut fds = [0 as libc::c_int; 2];
    let rc = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_DGRAM, 0, fds.as_mut_ptr()) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let (host_fd, vz_fd) = (fds[0], fds[1]);
    for &fd in &[host_fd, vz_fd] {
        set_buf(fd, libc::SO_SNDBUF, SND_BUF);
        set_buf(fd, libc::SO_RCVBUF, RCV_BUF);
    }
    // Host end non-blocking so the engine drains without stalling on it.
    unsafe {
        let flags = libc::fcntl(host_fd, libc::F_GETFL);
        libc::fcntl(host_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    Ok((host_fd, vz_fd))
}

fn set_buf(fd: RawFd, name: libc::c_int, val: libc::c_int) {
    unsafe {
        libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            name,
            &val as *const libc::c_int as *const libc::c_void,
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
    }
}

/// Start the per-VM netstack on its own (panic-isolated) thread and
/// return the handle. The thread owns `host_fd` and closes it on exit.
pub fn start(host_fd: RawFd, cfg: LinkConfig) -> Netstack {
    let (connect_tx, connect_rx) = channel::<ConnectRequest>();
    let guest_ip = cfg.guest_ip;
    let mac = cfg.guest_mac;
    let _ = std::thread::Builder::new()
        .name(format!(
            "netstack-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
        ))
        .spawn(move || {
            let ok = super::run_isolated(std::panic::AssertUnwindSafe(|| {
                engine_loop(host_fd, cfg, connect_rx);
            }));
            if !ok {
                eprintln!(
                    "netstack: per-VM engine panicked — link down for this VM only (host + siblings unaffected)"
                );
            }
            unsafe { libc::close(host_fd) };
        });
    Netstack {
        guest_ip,
        connect_tx,
    }
}

// --- the smoltcp phy device over the host fd ------------------------

struct FdDevice {
    fd: RawFd,
    /// Guest frames staged by the driver for smoltcp to ingest. Filled
    /// from the fd each iteration; drained by `receive`.
    rx: VecDeque<Vec<u8>>,
}

struct RxTok {
    frame: Vec<u8>,
}
struct TxTok {
    fd: RawFd,
}

impl RxToken for RxTok {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.frame)
    }
}

impl TxToken for TxTok {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut buf = vec![0u8; len];
        let r = f(&mut buf);
        // One datagram == one Ethernet frame (the SOCK_DGRAM contract).
        // A full send buffer (EAGAIN) drops the frame; TCP retransmits.
        unsafe {
            libc::send(self.fd, buf.as_ptr() as *const libc::c_void, len, 0);
        }
        r
    }
}

impl Device for FdDevice {
    type RxToken<'a> = RxTok;
    type TxToken<'a> = TxTok;

    fn receive(&mut self, _t: SmolInstant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        self.rx
            .pop_front()
            .map(|frame| (RxTok { frame }, TxTok { fd: self.fd }))
    }

    fn transmit(&mut self, _t: SmolInstant) -> Option<Self::TxToken<'_>> {
        Some(TxTok { fd: self.fd })
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ethernet;
        caps.max_transmission_unit = super::LINK_MTU + 14; // + Ethernet header
                                                           // RX: do NOT verify — virtio-net offloads L4 checksums, so
                                                           // guest→host frames arrive with zero/partial checksums (§2.3).
                                                           // TX: compute, since the guest's stack verifies on receive.
        let mut cs = ChecksumCapabilities::ignored();
        cs.ipv4 = Checksum::Tx;
        cs.tcp = Checksum::Tx;
        cs.udp = Checksum::Tx;
        caps.checksum = cs;
        caps
    }
}

// --- flow bookkeeping ------------------------------------------------

type Tuple = (Ipv4Addr, u16, Ipv4Addr, u16);

enum FlowKind {
    /// Guest-originated (outbound): we terminated the guest's SYN and
    /// forward to `dst` upstream once established.
    Terminated {
        src: Ipv4Addr,
        dst: SocketAddr,
        upstream_spawned: bool,
    },
    /// Host-originated (inbound published port): the bridge's ext side is
    /// already held by the `connect()` caller.
    Originated,
}

struct Flow {
    bridge: Arc<Mutex<Bridge>>,
    kind: FlowKind,
    tuple: Option<Tuple>,
}

fn tcp_socket(idle_timeout: SmolDuration) -> tcp::Socket<'static> {
    let mut sock = tcp::Socket::new(
        tcp::SocketBuffer::new(vec![0u8; TCP_BUF]),
        tcp::SocketBuffer::new(vec![0u8; TCP_BUF]),
    );
    // Reap half-open / dead flows (SYN-flood guard + dead-upstream
    // detection): an idle timeout plus keep-alive probes that keep a live
    // peer's flow from tripping it. Applied to every socket the engine
    // creates — guest-terminated SYNs and host-originated connects alike.
    sock.set_timeout(Some(idle_timeout));
    sock.set_keep_alive(Some(FLOW_KEEPALIVE));
    sock
}

/// Fate of an incoming guest SYN under the SYN-flood guard.
#[derive(Debug, PartialEq, Eq)]
enum SynAdmit {
    /// A new 4-tuple under the cap — allocate a terminated flow.
    New,
    /// A retransmitted SYN for a flow we already track — let smoltcp
    /// handle it; don't allocate a second socket.
    Duplicate,
    /// At/over the (configurable) concurrent-flow cap — refuse (drop the
    /// SYN, no socket).
    RefusedAtCap,
}

/// Decide whether a guest SYN should allocate a new terminated flow.
/// Dedups retransmitted SYNs by 4-tuple and enforces the concurrent-flow
/// cap (`max_flows`) so a SYN-flood across distinct tuples can't balloon
/// socket memory.
fn admit_syn(tuple_live: bool, live_flows: usize, max_flows: usize) -> SynAdmit {
    if tuple_live {
        SynAdmit::Duplicate
    } else if live_flows >= max_flows {
        SynAdmit::RefusedAtCap
    } else {
        SynAdmit::New
    }
}

/// Log a SYN-flood refusal, rate-limited so the flood can't also flood the
/// host log. `last` is the engine-local timestamp of the previous warning.
fn warn_flow_cap(vm_name: &str, max_flows: usize, last: &mut Option<Instant>) {
    let now = Instant::now();
    if last.is_none_or(|t| now.duration_since(t) >= FLOW_CAP_LOG_EVERY) {
        *last = Some(now);
        eprintln!(
            "netstack[{vm_name}]: concurrent-flow cap ({max_flows}) reached — refusing new guest SYNs (SYN-flood guard; raise with {ENV_MAX_FLOWS})"
        );
    }
}

/// Drain the bytes the guest sent from its smoltcp socket into `buf`,
/// stopping once `buf` reaches [`GUEST_TO_EXT_HIGH_WATER`](super::GUEST_TO_EXT_HIGH_WATER).
/// Leaving bytes unread closes smoltcp's receive window, which backpressures
/// the guest — so a guest blasting a slow/stalled upstream can't balloon
/// host memory unbounded (memory-DoS guard, symmetric to the ext→guest cap).
fn drain_guest_to_ext(sock: &mut tcp::Socket, buf: &mut VecDeque<u8>) {
    while sock.can_recv() && buf.len() < super::GUEST_TO_EXT_HIGH_WATER {
        let mut tmp = [0u8; 8192];
        match sock.recv_slice(&mut tmp) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend(tmp[..n].iter().copied()),
        }
    }
}

fn smol_now(start: Instant) -> SmolInstant {
    SmolInstant::from_millis(start.elapsed().as_millis() as i64)
}

fn engine_loop(host_fd: RawFd, cfg: LinkConfig, connect_rx: Receiver<ConnectRequest>) {
    let start = Instant::now();
    // Resolve the configurable caps once per VM (env is fixed for the
    // process lifetime): the concurrent-flow cap and the per-flow idle
    // timeout applied to every socket the engine creates.
    let max_flows = max_concurrent_flows();
    let idle_timeout = flow_idle_timeout();
    let mut device = FdDevice {
        fd: host_fd,
        rx: VecDeque::new(),
    };

    let mut config = Config::new(HardwareAddress::Ethernet(EthernetAddress(cfg.gateway_mac)));
    config.random_seed = seed();
    let mut iface = Interface::new(config, &mut device, smol_now(start));
    iface.update_ip_addrs(|addrs| {
        let _ = addrs.push(IpCidr::new(
            IpAddress::Ipv4(cfg.gateway_ip),
            super::PREFIX_LEN,
        ));
    });
    // Default route via our own gateway address + AnyIP: the guest's
    // frames to public IPs arrive addressed to the gateway MAC but with a
    // foreign dst IP; this is what makes smoltcp accept and terminate
    // them (the transparent-terminator trick).
    let _ = iface.routes_mut().add_default_ipv4_route(cfg.gateway_ip);
    iface.set_any_ip(true);

    let mut sockets = SocketSet::new(Vec::new());
    let mut flows: HashMap<SocketHandle, Flow> = HashMap::new();
    let mut by_tuple: HashMap<Tuple, SocketHandle> = HashMap::new();
    let mut next_local_port: u16 = 49152;

    // The DNS→IP back-reference set (§4a): public A/AAAA answers the
    // resolver hands out, so a later raw-IP connect can be tied back to
    // the allowlisted name it came from. Shared between the DNS workers
    // (writers) and the per-flow guard (reader).
    let resolved = super::guard::Resolved::new();

    // DNS replies built off-thread are posted back here so only the
    // engine thread writes the fd.
    let (outframe_tx, outframe_rx) = channel::<Vec<u8>>();

    // Last time we logged a SYN-flood refusal (rate-limited).
    let mut flood_log_at: Option<Instant> = None;

    loop {
        // 1. Inbound connect requests (published ports) → originate sockets.
        while let Ok(req) = connect_rx.try_recv() {
            let mut sock = tcp_socket(idle_timeout);
            let local = next_local_port;
            next_local_port = next_local_port
                .checked_add(1)
                .filter(|p| *p != 0)
                .unwrap_or(49152);
            let remote = IpEndpoint::new(IpAddress::Ipv4(req.target_ip), req.port);
            let local = IpListenEndpoint {
                addr: Some(IpAddress::Ipv4(cfg.gateway_ip)),
                port: local,
            };
            match sock.connect(iface.context(), remote, local) {
                Ok(()) => {
                    let handle = sockets.add(sock);
                    flows.insert(
                        handle,
                        Flow {
                            bridge: req.bridge,
                            kind: FlowKind::Originated,
                            tuple: None,
                        },
                    );
                }
                Err(_) => {
                    if let Ok(mut b) = req.bridge.lock() {
                        b.aborted = true;
                    }
                }
            }
        }

        // 2. Drain guest frames, classify, answer DHCP/DNS, feed the rest.
        for f in read_frames(host_fd) {
            match frame::classify(&f, cfg.gateway_ip) {
                Class::Dhcp => answer_dhcp(&f, &cfg, host_fd),
                Class::Dns { src_ip, src_port } => spawn_dns(
                    &f,
                    src_ip,
                    src_port,
                    &cfg,
                    outframe_tx.clone(),
                    resolved.clone(),
                ),
                Class::Tcp(seg) => {
                    if seg.is_syn {
                        // Pre-create the LISTEN socket on the exact dst so
                        // the interface delivers the SYN instead of RSTing
                        // it. Dedupe by 4-tuple (retransmitted SYN) and cap
                        // concurrent flows (SYN-flood guard).
                        let tuple = seg.tuple();
                        match admit_syn(by_tuple.contains_key(&tuple), flows.len(), max_flows) {
                            SynAdmit::New => {
                                let mut sock = tcp_socket(idle_timeout);
                                let _ = sock.listen(IpListenEndpoint {
                                    addr: Some(IpAddress::Ipv4(seg.dst_ip)),
                                    port: seg.dst_port,
                                });
                                let handle = sockets.add(sock);
                                flows.insert(
                                    handle,
                                    Flow {
                                        bridge: Arc::new(Mutex::new(Bridge::default())),
                                        kind: FlowKind::Terminated {
                                            src: seg.src_ip,
                                            dst: SocketAddr::new(seg.dst_ip.into(), seg.dst_port),
                                            upstream_spawned: false,
                                        },
                                        tuple: Some(tuple),
                                    },
                                );
                                by_tuple.insert(tuple, handle);
                                device.rx.push_back(f);
                            }
                            // A retransmitted SYN: hand it to smoltcp (its
                            // existing socket completes the handshake), but
                            // allocate nothing new.
                            SynAdmit::Duplicate => device.rx.push_back(f),
                            // Past the cap: drop the SYN. No socket is
                            // allocated; the guest's stack retransmits then
                            // aborts. Live flows are untouched.
                            SynAdmit::RefusedAtCap => {
                                warn_flow_cap(&cfg.vm_name, max_flows, &mut flood_log_at)
                            }
                        }
                    } else {
                        device.rx.push_back(f);
                    }
                }
                Class::Passthrough => device.rx.push_back(f),
                Class::Drop => {}
            }
        }

        // 3. Process ingress (sockets receive) + egress (device transmits).
        iface.poll(smol_now(start), &mut device, &mut sockets);

        // 4. Shuttle bytes between each socket and its bridge; start
        //    upstreams for newly-established outbound flows.
        let handles: Vec<SocketHandle> = flows.keys().copied().collect();
        let mut dead: Vec<SocketHandle> = Vec::new();
        for handle in handles {
            if service_flow(handle, &mut flows, &mut sockets, &cfg.vm_name, &resolved) {
                dead.push(handle);
            }
        }

        // 5. Flush anything queued into sockets in step 4.
        iface.poll(smol_now(start), &mut device, &mut sockets);

        // 6. Emit DNS replies (engine-thread-only fd writes).
        while let Ok(out) = outframe_rx.try_recv() {
            send_frame(host_fd, &out);
        }

        // 7. Reap dead flows.
        for handle in dead {
            if let Some(flow) = flows.remove(&handle) {
                if let Some(t) = flow.tuple {
                    by_tuple.remove(&t);
                }
                // Any waiter on this flow must unblock with an error
                // rather than hang.
                if let Ok(mut b) = flow.bridge.lock() {
                    if !b.established {
                        b.aborted = true;
                    }
                }
            }
            sockets.remove(handle);
        }

        // 8. Wait for the next frame or a short cap (so bridge data, which
        //    smoltcp's poll_delay can't see, still moves promptly).
        let delay = iface
            .poll_delay(smol_now(start), &sockets)
            .map(|d| d.total_millis() as i32)
            .unwrap_or(WAIT_CAP_MS)
            .clamp(0, WAIT_CAP_MS);
        wait_readable(host_fd, delay);
    }
}

/// Move bytes between one flow's smoltcp socket and its bridge. Returns
/// `true` when the flow is finished and should be reaped.
fn service_flow(
    handle: SocketHandle,
    flows: &mut HashMap<SocketHandle, Flow>,
    sockets: &mut SocketSet<'static>,
    vm_name: &str,
    resolved: &super::guard::Resolved,
) -> bool {
    let flow = match flows.get_mut(&handle) {
        Some(f) => f,
        None => return true,
    };
    let sock = sockets.get_mut::<tcp::Socket>(handle);
    let bridge_arc = flow.bridge.clone();
    let mut bridge = match bridge_arc.lock() {
        Ok(b) => b,
        Err(_) => return true,
    };

    if !bridge.established && sock.may_send() {
        bridge.established = true;
    }

    // Hand a newly-established terminated (outbound) flow to the F2
    // boundary: classify (SNI/Host/IP), apply default-deny + allowlist,
    // and forward (to the re-resolved name, §8.1 #3) or drop+log. Runs on
    // its own thread so the bounded peek + re-resolution never blocks the
    // netstack loop. **This is the choke point** — every guest flow that
    // reaches upstream passes through here.
    if let FlowKind::Terminated {
        src,
        dst,
        upstream_spawned,
    } = &mut flow.kind
    {
        if bridge.established && !*upstream_spawned {
            *upstream_spawned = true;
            let dst = *dst;
            let source = *src;
            let ext = BridgeStream::new(bridge_arc.clone());
            let name = vm_name.to_string();
            let resolved = resolved.clone();
            std::thread::spawn(move || {
                super::guard::serve_outbound(&name, source, dst, ext, &resolved);
            });
        }
    }

    // guest → ext (bounded: stop draining smoltcp's recv buffer once
    // guest_to_ext hits the high-water, closing the TCP window so a slow/
    // stalled upstream backpressures the guest instead of ballooning host
    // memory — symmetric to the ext→guest cap).
    drain_guest_to_ext(sock, &mut bridge.guest_to_ext);
    // SYN-SENT/LISTEN sockets cannot receive yet, but that is not EOF. Only
    // publish guest FIN after this flow has actually established; otherwise
    // the bridge pump can close the host client's response half before a
    // slower principal-targeted guest relay has read the request.
    if bridge.established && !sock.may_recv() {
        bridge.guest_fin = true;
    }

    // ext → guest
    while sock.can_send() && !bridge.ext_to_guest.is_empty() {
        let mut tmp = [0u8; 8192];
        let n = bridge.ext_to_guest.len().min(tmp.len());
        for (i, slot) in tmp.iter_mut().enumerate().take(n) {
            *slot = bridge.ext_to_guest[i];
        }
        match sock.send_slice(&tmp[..n]) {
            Ok(0) | Err(_) => break,
            Ok(sent) => {
                bridge.ext_to_guest.drain(..sent);
            }
        }
    }
    if bridge.ext_fin && bridge.ext_to_guest.is_empty() && sock.may_send() {
        sock.close();
    }
    if bridge.aborted && sock.is_open() {
        sock.abort();
    }

    matches!(sock.state(), tcp::State::Closed)
}

fn answer_dhcp(frame: &[u8], cfg: &LinkConfig, fd: RawFd) {
    let Some(payload) = frame::udp_payload(frame) else {
        return;
    };
    let Some(req) = super::dhcp::parse(payload) else {
        return;
    };
    let reply = super::dhcp::build_reply(&req, &cfg.dhcp_lease());
    // Broadcast the OFFER/ACK at L2 (ff:ff:ff:ff:ff:ff) and L3
    // (255.255.255.255): the guest has no address yet and the initramfs
    // DHCP client typically sets the broadcast flag and listens for a
    // broadcast reply. Broadcasting works whether or not the flag is set
    // (one guest on the link), the maximally-compatible choice. Emitted
    // on the engine thread (no fd write contention).
    let out = frame::build_udp_ipv4(
        [0xff; 6],
        cfg.gateway_mac,
        cfg.gateway_ip,
        Ipv4Addr::BROADCAST,
        frame::DHCP_SERVER_PORT,
        frame::DHCP_CLIENT_PORT,
        &reply,
    );
    send_frame(fd, &out);
}

fn spawn_dns(
    frame: &[u8],
    src_ip: Ipv4Addr,
    src_port: u16,
    cfg: &LinkConfig,
    out_tx: Sender<Vec<u8>>,
    resolved: super::guard::Resolved,
) {
    let Some(query) = frame::udp_payload(frame) else {
        return;
    };
    let query = query.to_vec();
    let cfg = cfg.clone();
    std::thread::spawn(move || {
        let qname = super::dns::query_name(&query);
        // F2 (§8.1 #1): the resolver applies the VM's default-deny policy
        // to the name (denied/absent ⇒ no answer, fail-closed)...
        let context = crate::egress::policy_for(&cfg.vm_name, src_ip);
        let policy = context.policy();
        if matches!(context, crate::egress::PolicyContext::Unknown { .. }) {
            crate::traffic::record_unknown(
                &cfg.vm_name,
                &context.principal(),
                qname.as_deref().unwrap_or("<invalid-dns>"),
                53,
                "DNS",
                "unknown-principal",
            );
            return;
        }
        if !super::dns::name_allowed(&qname, &policy) {
            if let crate::egress::PolicyContext::Runtime(runtime) = &context {
                crate::traffic::record_runtime(
                    runtime,
                    qname.as_deref().unwrap_or("<invalid-dns>"),
                    53,
                    "DNS",
                    None,
                    "deny",
                    crate::traffic::TrafficDetails {
                        reason: Some("policy"),
                        ..Default::default()
                    },
                );
            }
            return;
        }
        let runtime_ports = match (&context, &qname) {
            (crate::egress::PolicyContext::Runtime(runtime), Some(host)) => {
                Some(runtime.allowed_ports_for(host))
            }
            _ => None,
        };
        if let Some(resp) =
            super::dns::forward(&query, &cfg.dns_upstreams, super::dns::UPSTREAM_TIMEOUT)
        {
            // ...and drops any answer that resolves into a private/
            // internal/host-LAN range (anti-rebind SSRF), recording the
            // public answers for the raw-IP back-reference hatch.
            if !super::dns::answer_ok_and_record_for(
                &resp,
                &resolved,
                &context.principal(),
                runtime_ports.as_deref(),
            ) {
                return;
            }
            let out = frame::build_udp_ipv4(
                cfg.guest_mac,
                cfg.gateway_mac,
                cfg.gateway_ip,
                src_ip,
                frame::DNS_PORT,
                src_port,
                &resp,
            );
            let _ = out_tx.send(out);
        }
    });
}

fn read_frames(fd: RawFd) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = [0u8; 65536];
    for _ in 0..RX_BATCH {
        let n = unsafe { libc::recv(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0) };
        if n > 0 {
            out.push(buf[..n as usize].to_vec());
        } else {
            break; // EAGAIN / closed / error
        }
    }
    out
}

fn send_frame(fd: RawFd, frame: &[u8]) {
    unsafe {
        libc::send(fd, frame.as_ptr() as *const libc::c_void, frame.len(), 0);
    }
}

fn wait_readable(fd: RawFd, timeout_ms: i32) {
    let mut pfd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    unsafe {
        libc::poll(&mut pfd, 1, timeout_ms);
    }
}

fn seed() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x1234_5678)
        ^ ((std::process::id() as u64) << 32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::time::Duration;

    #[test]
    fn principal_inbound_waits_for_request_and_preserves_half_close_response() {
        const PRINCIPAL: Ipv4Addr = Ipv4Addr::new(192, 168, 127, 10);
        const PORT: u16 = 18_080;
        const REQUEST: &[u8] = b"GET /ready HTTP/1.1\r\nHost: app.test\r\n\r\n";
        const RESPONSE: &[u8] =
            b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nprincipal-ok";

        let (host_fd, vz_fd) = make_link().unwrap();
        // The engine's fd reader is nonblocking; give the in-memory guest
        // peer the same behavior so its test loop can interleave poll/send.
        unsafe {
            let flags = libc::fcntl(vz_fd, libc::F_GETFL);
            libc::fcntl(vz_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        let guest_mac = [0x52, 0x54, 0x00, 0xaa, 0xbb, 0xdd];
        let cfg = LinkConfig::for_guest_mac("principal-inbound-test", "52:54:00:aa:bb:dd");
        let netstack = start(host_fd, cfg);

        // A tiny guest-side smoltcp server bound to the runtime principal
        // /32. Crucially, it sends nothing until the full request arrives;
        // an eager responder would hide the pre-establishment EOF race.
        let guest = std::thread::spawn(move || {
            let mut device = FdDevice {
                fd: vz_fd,
                rx: VecDeque::new(),
            };
            let mut config = Config::new(HardwareAddress::Ethernet(EthernetAddress(guest_mac)));
            config.random_seed = 7;
            let started = Instant::now();
            let mut iface = Interface::new(config, &mut device, smol_now(started));
            iface.update_ip_addrs(|addrs| {
                let _ = addrs.push(IpCidr::new(
                    IpAddress::Ipv4(PRINCIPAL),
                    super::super::PREFIX_LEN,
                ));
            });
            let _ = iface
                .routes_mut()
                .add_default_ipv4_route(super::super::GATEWAY_IP);

            let mut sockets = SocketSet::new(Vec::new());
            let server = sockets.add(tcp_socket(flow_idle_timeout()));
            sockets
                .get_mut::<tcp::Socket>(server)
                .listen(IpListenEndpoint {
                    addr: Some(IpAddress::Ipv4(PRINCIPAL)),
                    port: PORT,
                })
                .unwrap();

            let deadline = Instant::now() + Duration::from_secs(5);
            let mut request = Vec::new();
            let mut responded = false;
            let mut observed_peer = None;
            loop {
                for frame in read_frames(vz_fd) {
                    device.rx.push_back(frame);
                }
                iface.poll(smol_now(started), &mut device, &mut sockets);

                {
                    let socket = sockets.get_mut::<tcp::Socket>(server);
                    observed_peer = observed_peer.or_else(|| socket.remote_endpoint());
                    while socket.can_recv() {
                        let mut buf = [0u8; 1024];
                        let count = socket.recv_slice(&mut buf).unwrap();
                        if count == 0 {
                            break;
                        }
                        request.extend_from_slice(&buf[..count]);
                    }
                    if !responded && request.ends_with(b"\r\n\r\n") {
                        socket.send_slice(RESPONSE).unwrap();
                        socket.close();
                        responded = true;
                    }
                }

                iface.poll(smol_now(started), &mut device, &mut sockets);
                let socket = sockets.get::<tcp::Socket>(server);
                if responded
                    && socket.send_queue() == 0
                    && matches!(socket.state(), tcp::State::Closed | tcp::State::TimeWait)
                {
                    break;
                }
                assert!(Instant::now() < deadline, "guest server timed out");
                wait_readable(vz_fd, 2);
            }
            unsafe { libc::close(vz_fd) };
            (request, observed_peer)
        });

        // Model the published localhost listener/client pair, then splice its
        // accepted stream through connect_to(PRINCIPAL) exactly as net.rs does.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let (accepted, _) = listener.accept().unwrap();
        let bridge = netstack.connect_to(PRINCIPAL, PORT).unwrap();
        let pump = std::thread::spawn(move || super::super::bridge_pump(bridge, accepted));

        client.write_all(REQUEST).unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();

        pump.join().unwrap();
        assert_eq!(response, RESPONSE, "half-close must not drop the reply");
        let (request, peer) = guest.join().unwrap();
        assert_eq!(request, REQUEST);
        assert_eq!(
            peer.expect("guest observed originated peer").addr,
            IpAddress::Ipv4(super::super::GATEWAY_IP),
            "originated flow must come from the host gateway, never VM .2"
        );
    }

    #[test]
    fn runtime_inbound_nonblocking_forward_survives_two_hop_relay() {
        const RELAY_PORT: u16 = 22_000;
        const REQUEST: &[u8] = b"GET /relay HTTP/1.1\r\nHost: app.test\r\n\r\n";
        const RESPONSE: &[u8] =
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nrelay-ok";

        // Model the app namespace endpoint behind the root-namespace relay.
        // It deliberately waits for the complete request before replying.
        let onward_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        onward_listener.set_nonblocking(true).unwrap();
        let onward_addr = onward_listener.local_addr().unwrap();
        let onward = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match onward_listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "relay never dialed upstream");
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(error) => panic!("relay upstream accept failed: {error}"),
                }
            };
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut buf = [0u8; 1024];
                let count = stream.read(&mut buf).unwrap();
                assert_ne!(count, 0, "relay upstream closed before the request");
                request.extend_from_slice(&buf[..count]);
            }
            assert_eq!(request, REQUEST);
            std::thread::sleep(Duration::from_millis(25));
            stream.write_all(RESPONSE).unwrap();
            stream.shutdown(Shutdown::Write).unwrap();
        });

        let (host_fd, vz_fd) = make_link().unwrap();
        unsafe {
            let flags = libc::fcntl(vz_fd, libc::F_GETFL);
            libc::fcntl(vz_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        let guest_mac = [0x52, 0x54, 0x00, 0xaa, 0xbb, 0xde];
        let cfg = LinkConfig::for_guest_mac("runtime-relay-test", "52:54:00:aa:bb:de");
        let netstack = start(host_fd, cfg);

        // Model the guest's root-namespace listener (.2:22000). Once it has
        // the request it dials the app endpoint onward, waits for that reply,
        // and only then returns bytes on the originated connection.
        let guest = std::thread::spawn(move || {
            let mut device = FdDevice {
                fd: vz_fd,
                rx: VecDeque::new(),
            };
            let mut config = Config::new(HardwareAddress::Ethernet(EthernetAddress(guest_mac)));
            config.random_seed = 8;
            let started = Instant::now();
            let mut iface = Interface::new(config, &mut device, smol_now(started));
            iface.update_ip_addrs(|addrs| {
                let _ = addrs.push(IpCidr::new(
                    IpAddress::Ipv4(super::super::GUEST_IP),
                    super::super::PREFIX_LEN,
                ));
            });
            let _ = iface
                .routes_mut()
                .add_default_ipv4_route(super::super::GATEWAY_IP);

            let mut sockets = SocketSet::new(Vec::new());
            let relay = sockets.add(tcp_socket(flow_idle_timeout()));
            sockets
                .get_mut::<tcp::Socket>(relay)
                .listen(IpListenEndpoint {
                    addr: Some(IpAddress::Ipv4(super::super::GUEST_IP)),
                    port: RELAY_PORT,
                })
                .unwrap();

            let deadline = Instant::now() + Duration::from_secs(5);
            let mut request = Vec::new();
            let mut response = None;
            let mut response_sent = false;
            loop {
                for frame in read_frames(vz_fd) {
                    device.rx.push_back(frame);
                }
                iface.poll(smol_now(started), &mut device, &mut sockets);

                {
                    let socket = sockets.get_mut::<tcp::Socket>(relay);
                    while socket.can_recv() {
                        let mut buf = [0u8; 1024];
                        let count = socket.recv_slice(&mut buf).unwrap();
                        if count == 0 {
                            break;
                        }
                        request.extend_from_slice(&buf[..count]);
                    }
                    if response.is_none() && request.ends_with(b"\r\n\r\n") {
                        let mut upstream = TcpStream::connect(onward_addr).unwrap();
                        upstream.write_all(&request).unwrap();
                        upstream.shutdown(Shutdown::Write).unwrap();
                        let mut reply = Vec::new();
                        upstream.read_to_end(&mut reply).unwrap();
                        response = Some(reply);
                    }
                    if !response_sent && socket.can_send() {
                        if let Some(reply) = response.as_deref() {
                            socket.send_slice(reply).unwrap();
                            socket.close();
                            response_sent = true;
                        }
                    }
                }

                iface.poll(smol_now(started), &mut device, &mut sockets);
                let socket = sockets.get::<tcp::Socket>(relay);
                if response_sent
                    && socket.send_queue() == 0
                    && matches!(socket.state(), tcp::State::Closed | tcp::State::TimeWait)
                {
                    break;
                }
                assert!(Instant::now() < deadline, "guest relay timed out");
                wait_readable(vz_fd, 2);
            }
            unsafe { libc::close(vz_fd) };
            request
        });

        // The production Runtime listener is nonblocking so it can service
        // unbinds. Force the accepted stream into that exact mode and let the
        // pump start before curl-like request bytes arrive.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let (accepted, _) = listener.accept().unwrap();
        accepted.set_nonblocking(true).unwrap();
        let bridge = netstack.connect(RELAY_PORT).unwrap();
        let pump = std::thread::spawn(move || super::super::bridge_pump(bridge, accepted));

        std::thread::sleep(Duration::from_millis(10));
        client.write_all(REQUEST).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        drop(client);

        pump.join().unwrap();
        onward.join().unwrap();
        assert_eq!(guest.join().unwrap(), REQUEST);
        assert_eq!(
            response, RESPONSE,
            "relay response must reach the host client"
        );
    }

    /// Drive the engine over a real socketpair: write a DHCP DISCOVER as
    /// the "guest" and read back the OFFER the engine builds. Exercises
    /// the whole loop — fd I/O, classification, the DHCP responder, and
    /// frame synthesis — without a VM.
    #[test]
    fn engine_answers_dhcp_over_the_link() {
        let (host_fd, vz_fd) = make_link().unwrap();
        // Give the guest end a read timeout so a regression can't hang CI.
        let tv = libc::timeval {
            tv_sec: 3,
            tv_usec: 0,
        };
        unsafe {
            libc::setsockopt(
                vz_fd,
                libc::SOL_SOCKET,
                libc::SO_RCVTIMEO,
                &tv as *const libc::timeval as *const libc::c_void,
                std::mem::size_of::<libc::timeval>() as libc::socklen_t,
            );
        }

        let mac = [0x52, 0x54, 0x00, 0xaa, 0xbb, 0xcc];
        let cfg = LinkConfig::for_guest_mac("engine-dhcp-test", "52:54:00:aa:bb:cc");
        let _ns = start(host_fd, cfg);

        // Build a DHCP DISCOVER BOOTP payload.
        let mut bootp = vec![0u8; 240];
        bootp[0] = 1; // BOOTREQUEST
        bootp[4..8].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]); // xid
        bootp[28..34].copy_from_slice(&mac); // chaddr
        bootp[236..240].copy_from_slice(&[99, 130, 83, 99]); // magic cookie
        bootp.extend_from_slice(&[53, 1, 1]); // DHCPDISCOVER
        bootp.push(255);
        let discover = frame::build_udp_ipv4(
            [0xff; 6],
            mac,
            Ipv4Addr::UNSPECIFIED,
            Ipv4Addr::BROADCAST,
            68,
            67,
            &bootp,
        );
        send_frame(vz_fd, &discover);

        // Read the OFFER back off the guest end.
        let mut buf = [0u8; 2048];
        let n = unsafe { libc::recv(vz_fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0) };
        assert!(n > 0, "engine should have answered the DISCOVER");
        let reply = &buf[..n as usize];
        let offer_payload = frame::udp_payload(reply).expect("a UDP/IPv4 reply frame");
        let req = super::super::dhcp::parse(offer_payload);
        // It's a BOOTREPLY OFFER leasing the deterministic guest IP.
        assert!(req.is_none(), "a reply is not itself a parseable request");
        // yiaddr (offset 16) is the leased guest address.
        assert_eq!(&offer_payload[16..20], &super::super::GUEST_IP.octets());

        unsafe { libc::close(vz_fd) };
        let _ = Duration::from_millis(0);
    }

    #[test]
    fn admit_syn_caps_concurrent_flows_and_dedups_retransmits() {
        let cap = DEFAULT_MAX_CONCURRENT_FLOWS;
        // A fresh 4-tuple under the cap allocates a flow...
        assert_eq!(admit_syn(false, 0, cap), SynAdmit::New);
        assert_eq!(admit_syn(false, cap - 1, cap), SynAdmit::New);
        // ...a retransmitted SYN for a live tuple never allocates a second
        // socket, regardless of the flow count...
        assert_eq!(admit_syn(true, 0, cap), SynAdmit::Duplicate);
        assert_eq!(admit_syn(true, cap + 9, cap), SynAdmit::Duplicate);
        // ...and a new tuple AT/OVER the cap is refused (SYN-flood guard).
        assert_eq!(admit_syn(false, cap, cap), SynAdmit::RefusedAtCap);
        assert_eq!(admit_syn(false, cap + 100, cap), SynAdmit::RefusedAtCap);
        // The cap is the configurable knob: a raised cap admits where the
        // default would refuse; a lowered cap refuses where it would admit.
        assert_eq!(admit_syn(false, cap, cap * 2), SynAdmit::New);
        assert_eq!(admit_syn(false, 8, 8), SynAdmit::RefusedAtCap);
    }

    #[test]
    fn parse_positive_takes_override_else_default_and_rejects_invalid() {
        // Unset → default.
        assert_eq!(parse_positive(None, DEFAULT_MAX_CONCURRENT_FLOWS), 1024);
        // A valid positive override wins (whitespace tolerated).
        assert_eq!(
            parse_positive(Some("4096"), DEFAULT_MAX_CONCURRENT_FLOWS),
            4096
        );
        assert_eq!(
            parse_positive(Some("  256 "), DEFAULT_MAX_CONCURRENT_FLOWS),
            256
        );
        // Invalid → default: non-numeric, empty, negative, and zero (zero
        // would wedge the stack, so it's rejected like garbage).
        assert_eq!(
            parse_positive(Some("lots"), DEFAULT_MAX_CONCURRENT_FLOWS),
            1024
        );
        assert_eq!(parse_positive(Some(""), DEFAULT_MAX_CONCURRENT_FLOWS), 1024);
        assert_eq!(
            parse_positive(Some("-5"), DEFAULT_MAX_CONCURRENT_FLOWS),
            1024
        );
        assert_eq!(
            parse_positive(Some("0"), DEFAULT_MAX_CONCURRENT_FLOWS),
            1024
        );
        // Same precedence holds for the u64 idle-secs knob.
        assert_eq!(parse_positive(Some("120"), DEFAULT_FLOW_IDLE_SECS), 120u64);
        assert_eq!(parse_positive(Some("0"), DEFAULT_FLOW_IDLE_SECS), 60u64);
        assert_eq!(parse_positive(None, DEFAULT_FLOW_IDLE_SECS), 60u64);
    }

    #[test]
    fn guest_to_ext_backpressure_stops_draining_at_high_water() {
        use smoltcp::phy::Loopback;

        // Stand up a real smoltcp loopback with a server + client socket on
        // one interface, so the test drives the actual recv path the engine
        // drains (can_recv / recv_slice) rather than a stand-in.
        let mut device = Loopback::new(Medium::Ethernet);
        let mut config = Config::new(HardwareAddress::Ethernet(EthernetAddress([
            0x02, 0, 0, 0, 0, 1,
        ])));
        config.random_seed = 1;
        let mut iface = Interface::new(config, &mut device, SmolInstant::from_millis(0));
        let ip = Ipv4Addr::new(192, 168, 69, 1);
        iface.update_ip_addrs(|a| {
            let _ = a.push(IpCidr::new(IpAddress::Ipv4(ip), 24));
        });

        let mut sockets = SocketSet::new(Vec::new());
        let server = sockets.add(tcp_socket(flow_idle_timeout()));
        let client = sockets.add(tcp_socket(flow_idle_timeout()));
        sockets
            .get_mut::<tcp::Socket>(server)
            .listen(IpListenEndpoint {
                addr: Some(IpAddress::Ipv4(ip)),
                port: 7777,
            })
            .unwrap();
        sockets
            .get_mut::<tcp::Socket>(client)
            .connect(
                iface.context(),
                IpEndpoint::new(IpAddress::Ipv4(ip), 7777),
                49000,
            )
            .unwrap();

        let mut t = 1i64;
        for _ in 0..40 {
            iface.poll(SmolInstant::from_millis(t), &mut device, &mut sockets);
            t += 1;
        }
        assert!(
            sockets.get::<tcp::Socket>(client).may_send(),
            "handshake completed"
        );

        // Client sends a blob; pump so the server has it buffered to read.
        let blob = vec![7u8; 8 * 1024];
        sockets
            .get_mut::<tcp::Socket>(client)
            .send_slice(&blob)
            .unwrap();
        for _ in 0..40 {
            iface.poll(SmolInstant::from_millis(t), &mut device, &mut sockets);
            t += 1;
        }
        assert!(
            sockets.get::<tcp::Socket>(server).can_recv(),
            "server has data buffered"
        );

        // Buffer already AT the high-water: draining must pull NOTHING, and
        // the bytes stay in smoltcp (receive window closed ⇒ the guest is
        // backpressured rather than ballooning host memory).
        let mut buf: VecDeque<u8> = vec![0u8; crate::netstack::GUEST_TO_EXT_HIGH_WATER].into();
        drain_guest_to_ext(sockets.get_mut::<tcp::Socket>(server), &mut buf);
        assert_eq!(
            buf.len(),
            crate::netstack::GUEST_TO_EXT_HIGH_WATER,
            "nothing drained past the cap"
        );
        assert!(
            sockets.get::<tcp::Socket>(server).can_recv(),
            "data held in smoltcp == window closed == backpressure"
        );

        // Below the high-water the same socket drains normally (no false cap).
        let mut buf2: VecDeque<u8> = VecDeque::new();
        drain_guest_to_ext(sockets.get_mut::<tcp::Socket>(server), &mut buf2);
        assert!(!buf2.is_empty(), "below the cap, draining proceeds");
    }
}
