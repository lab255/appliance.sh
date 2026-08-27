//! Host-side, per-VM userspace TCP/IP netstack for the egress firewall.
//!
//! When a VM runs with `net_link = Netstack`, its NIC is no longer a
//! framework NAT attachment but a `socketpair(AF_UNIX, SOCK_DGRAM)`
//! whose host end *this* netstack owns. Every guest frame arrives here
//! and nothing leaves except through here — the property the
//! egress-firewall design turns on (docs/egress-firewall.md §2, §8).
//!
//! Layering:
//!   * [`frame`] — the hostile-frame classifier + UDP/IPv4 frame
//!     synthesis (the F1 robustness gate, §8.1 #5).
//!   * [`dhcp`] — the single-client DHCP responder (deterministic lease).
//!   * [`dns`]  — the forwarding resolver (`.1:53` → host resolver).
//!   * `engine` (unix only) — the smoltcp driver loop that terminates
//!     guest TCP and bridges it to the host, plus `connect()` for the
//!     inbound published-port path.
//!
//! **F1 is behaviour-neutral default-ALLOW**: every terminated flow is
//! forwarded upstream, no policy, no filtering. The allow/deny core
//! (`egress.rs`) is wired onto this accept path in F2.
//!
//! Each VM gets its own netstack on its own thread; a panic in one is
//! isolated to that VM (the thread is wrapped in `catch_unwind`), never
//! taking down the host process or a sibling VM (§8.1 #5).

pub mod dhcp;
pub mod dns;
pub mod frame;
pub mod guard;

#[cfg(unix)]
mod engine;

/// Create the host/guest `socketpair` link and start the per-VM
/// netstack on its host end. Unix-only (the `VzBackend` is the sole
/// caller).
#[cfg(unix)]
pub use engine::{make_link, start};

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The deterministic private subnet the netstack owns. The gateway is
/// `.1` so the existing `guest_proxy_url` "gateway is `.1`" assumption
/// in `egress.rs` still holds; the single guest leases `.2`.
pub const GATEWAY_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 127, 1);
pub const GUEST_IP: Ipv4Addr = Ipv4Addr::new(192, 168, 127, 2);
pub const NETMASK: Ipv4Addr = Ipv4Addr::new(255, 255, 255, 0);
pub const PREFIX_LEN: u8 = 24;
/// The gateway's (host-owned) MAC: locally administered (bit 0x02 of the
/// first octet set), unicast (bit 0x01 clear). The guest ARPs for the
/// gateway and smoltcp answers with this.
pub const GATEWAY_MAC: [u8; 6] = [0x5a, 0x41, 0x50, 0x50, 0x00, 0x01];
/// DHCP lease time handed to the guest (24h); the netstack is the only
/// server it can reach so the exact value is immaterial.
pub const LEASE_SECS: u32 = 86_400;
/// MTU we advertise to the guest and configure on the link — 1500 in F1
/// for parity with NAT and to avoid PMTU surprises (§2.3).
pub const LINK_MTU: usize = 1500;

/// Per-VM link parameters.
#[derive(Debug, Clone)]
pub struct LinkConfig {
    /// The VM's name — the key into its egress policy, credential rules,
    /// MITM CA, and traffic log. The F2 boundary needs it to apply policy
    /// per VM.
    pub vm_name: String,
    pub guest_mac: [u8; 6],
    pub guest_ip: Ipv4Addr,
    pub gateway_ip: Ipv4Addr,
    pub gateway_mac: [u8; 6],
    pub netmask: Ipv4Addr,
    /// Upstream resolvers the DNS forwarder relays to (the host's own).
    pub dns_upstreams: Vec<SocketAddr>,
}

impl LinkConfig {
    /// Build the standard config for a VM with the given name + guest MAC.
    /// The guest IP, gateway, and subnet are fixed (single-client subnet);
    /// the upstream resolvers are the host's.
    pub fn for_guest_mac(vm_name: &str, mac: &str) -> Self {
        LinkConfig {
            vm_name: vm_name.to_string(),
            guest_mac: parse_mac(mac).unwrap_or([0x02, 0, 0, 0, 0, 0x02]),
            guest_ip: GUEST_IP,
            gateway_ip: GATEWAY_IP,
            gateway_mac: GATEWAY_MAC,
            netmask: NETMASK,
            dns_upstreams: dns::system_resolvers(),
        }
    }

    fn dhcp_lease(&self) -> dhcp::Lease {
        dhcp::Lease {
            guest_ip: self.guest_ip,
            gateway_ip: self.gateway_ip,
            netmask: self.netmask,
            lease_secs: LEASE_SECS,
        }
    }
}

/// Parse a colon-separated MAC (`aa:bb:cc:dd:ee:ff`) into six octets.
pub fn parse_mac(mac: &str) -> Option<[u8; 6]> {
    let mut out = [0u8; 6];
    let mut parts = mac.split(':');
    for slot in &mut out {
        *slot = u8::from_str_radix(parts.next()?, 16).ok()?;
    }
    parts.next().is_none().then_some(out)
}

// --- the cross-thread byte bridge -----------------------------------

/// A connection's byte buffers, shared between the smoltcp engine (the
/// *guest* side) and an external peer (the *ext* side — an upstream
/// `TcpStream` for a terminated guest flow, or the host listener for an
/// inbound published-port flow). Naming is from the engine's point of
/// view: `guest_to_ext` is what the guest sent; `ext_to_guest` is what
/// the engine should deliver to the guest.
#[derive(Default)]
struct Bridge {
    guest_to_ext: VecDeque<u8>,
    ext_to_guest: VecDeque<u8>,
    /// The guest closed its transmit half (engine saw FIN); no more
    /// `guest_to_ext` will arrive.
    guest_fin: bool,
    /// The ext side finished writing toward the guest; once
    /// `ext_to_guest` drains the engine closes the guest socket's send
    /// half.
    ext_fin: bool,
    /// The connection is up (guest socket sendable). `connect()` waits on
    /// this; the ext side may start once it's set.
    established: bool,
    /// The connection broke — either side errors out and the engine
    /// aborts the socket.
    aborted: bool,
}

/// Soft cap on the bytes buffered toward the guest before the ext writer
/// applies backpressure (sleeps). Keeps a fast upstream from ballooning
/// memory when the guest is slow.
const EXT_TO_GUEST_HIGH_WATER: usize = 256 * 1024;

/// Symmetric cap on the bytes buffered *from* the guest (what the guest
/// sent, awaiting the ext side). The engine stops draining smoltcp's recv
/// buffer once `guest_to_ext` reaches this, so smoltcp's receive window
/// closes and the guest is backpressured — a guest blasting a slow/stalled
/// upstream can't balloon host memory unbounded (memory-DoS guard, F5).
pub(super) const GUEST_TO_EXT_HIGH_WATER: usize = 256 * 1024;

/// The external (non-guest) end of a [`Bridge`], exposed as a blocking
/// `Read + Write` stream so the existing proxy/pump code can treat a
/// netstack flow exactly like a `TcpStream`. Cloneable so a reader and a
/// writer thread can share it.
#[derive(Clone)]
pub struct BridgeStream {
    inner: Arc<Mutex<Bridge>>,
}

impl BridgeStream {
    fn new(inner: Arc<Mutex<Bridge>>) -> Self {
        BridgeStream { inner }
    }

    /// Signal that the ext side has sent everything it will toward the
    /// guest (EOF in the ext→guest direction).
    pub(crate) fn mark_ext_fin(&self) {
        if let Ok(mut b) = self.inner.lock() {
            b.ext_fin = true;
        }
    }

    pub(crate) fn abort(&self) {
        if let Ok(mut b) = self.inner.lock() {
            b.aborted = true;
        }
    }

    /// Drain up to `max` bytes the guest has sent, returning as soon as
    /// `done(&buf)` is satisfied, the guest half-closes/aborts, `max` is
    /// reached, or `timeout` elapses — whichever first. The F2 boundary's
    /// fail-closed peek (§8.1 #4): a bounded read with a deadline so a
    /// silent guest can never hang classification, and the consumed bytes
    /// are returned so the caller can replay them upstream. The `bool`
    /// reports whether `done` was satisfied (a complete head).
    pub(crate) fn peek_until(
        &self,
        max: usize,
        timeout: Duration,
        done: impl Fn(&[u8]) -> bool,
    ) -> (Vec<u8>, bool) {
        let deadline = Instant::now() + timeout;
        let mut out = Vec::new();
        loop {
            let mut closed = false;
            if let Ok(mut b) = self.inner.lock() {
                while out.len() < max && !b.guest_to_ext.is_empty() {
                    out.push(b.guest_to_ext.pop_front().unwrap());
                }
                if b.guest_fin || b.aborted {
                    closed = true;
                }
            } else {
                return (out, false);
            }
            if done(&out) {
                return (out, true);
            }
            if out.len() >= max || closed || Instant::now() >= deadline {
                return (out, false);
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

impl Read for BridgeStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            {
                let mut b = self.inner.lock().map_err(poisoned)?;
                if !b.guest_to_ext.is_empty() {
                    let n = buf.len().min(b.guest_to_ext.len());
                    for slot in buf.iter_mut().take(n) {
                        *slot = b.guest_to_ext.pop_front().unwrap();
                    }
                    return Ok(n);
                }
                if b.aborted {
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "netstack flow aborted",
                    ));
                }
                if b.guest_fin {
                    return Ok(0); // clean EOF
                }
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

impl Write for BridgeStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        loop {
            {
                let mut b = self.inner.lock().map_err(poisoned)?;
                if b.aborted {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "netstack flow aborted",
                    ));
                }
                if b.ext_to_guest.len() < EXT_TO_GUEST_HIGH_WATER {
                    b.ext_to_guest.extend(buf.iter().copied());
                    return Ok(buf.len());
                }
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn poisoned<T>(_: T) -> io::Error {
    io::Error::other("netstack bridge mutex poisoned")
}

/// Bidirectional copy between a netstack flow's [`BridgeStream`] and a
/// real `TcpStream` — used by both the outbound upstream worker
/// (`tcp` = upstream) and the inbound published-port forward (`tcp` =
/// host-accepted client). One direction per thread; each propagates its
/// own half-close, and any error aborts the flow so the other half
/// unblocks.
pub fn bridge_pump(bridge: BridgeStream, tcp: std::net::TcpStream) {
    let tcp_w = match tcp.try_clone() {
        Ok(s) => s,
        Err(_) => {
            bridge.abort();
            return;
        }
    };

    // guest → ext → tcp
    let mut b_read = bridge.clone();
    let mut t_write = tcp_w;
    let up = std::thread::spawn(move || {
        let _ = io::copy(&mut b_read, &mut t_write);
        let _ = t_write.shutdown(std::net::Shutdown::Write);
    });

    // tcp → ext → guest
    let mut t_read = tcp;
    let mut b_write = bridge.clone();
    if io::copy(&mut t_read, &mut b_write).is_err() {
        bridge.abort();
    }
    // The upstream/client closed: no more bytes toward the guest.
    bridge.mark_ext_fin();
    let _ = up.join();
}

// --- the public handle ----------------------------------------------

/// A request from a forward thread to the engine to originate a TCP
/// connection *to the guest* (inbound published ports).
struct ConnectRequest {
    target_ip: Ipv4Addr,
    port: u16,
    bridge: Arc<Mutex<Bridge>>,
}

/// Handle to a running per-VM netstack. Cloneable and `Send`/`Sync` so
/// the published-port forwards can dial through it from their own
/// threads.
#[derive(Clone)]
pub struct Netstack {
    guest_ip: Ipv4Addr,
    connect_tx: Sender<ConnectRequest>,
}

impl Netstack {
    /// The address the netstack leased the guest — known deterministically
    /// at construction, so callers never scrape `dhcpd_leases`.
    pub fn guest_ip(&self) -> Ipv4Addr {
        self.guest_ip
    }

    /// Originate a TCP connection to the guest on `port` and return its
    /// host-side stream — the inbound (published-port) path. Blocks until
    /// the guest accepts or a short timeout elapses.
    pub fn connect(&self, port: u16) -> io::Result<BridgeStream> {
        self.connect_to(self.guest_ip, port)
    }

    /// Originate an inbound published-port connection to a selected runtime
    /// principal `/32`, rather than the VM root lease.
    pub fn connect_to(&self, target_ip: Ipv4Addr, port: u16) -> io::Result<BridgeStream> {
        let inner = Arc::new(Mutex::new(Bridge::default()));
        self.connect_tx
            .send(ConnectRequest {
                target_ip,
                port,
                bridge: inner.clone(),
            })
            .map_err(|_| io::Error::new(io::ErrorKind::NotConnected, "netstack engine is down"))?;

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            {
                let b = inner.lock().map_err(poisoned)?;
                if b.established {
                    return Ok(BridgeStream::new(inner.clone()));
                }
                if b.aborted {
                    return Err(io::Error::new(
                        io::ErrorKind::ConnectionRefused,
                        "guest refused connection",
                    ));
                }
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "guest did not accept in time",
                ));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

/// Run `f`, isolating a panic to the caller: returns `true` on normal
/// completion, `false` if `f` panicked. The per-VM netstack thread runs
/// through this so a hostile-frame-induced panic is contained to that
/// VM, never the host process or a sibling (§8.1 #5).
pub fn run_isolated<F: FnOnce() + std::panic::UnwindSafe>(f: F) -> bool {
    std::panic::catch_unwind(f).is_ok()
}

/// Test-only plumbing so the F2 boundary (`guard`) can drive the executor
/// over a synthetic terminated flow without a VM: build a [`BridgeStream`]
/// pre-loaded with the guest's bytes, and inspect the shared state the
/// executor mutates.
#[cfg(test)]
pub(crate) mod testkit {
    use super::*;

    /// An opaque handle to a synthetic flow's shared state — keeps the
    /// private `Bridge` from leaking through the test helper's signature.
    pub struct FlowProbe(Arc<Mutex<Bridge>>);

    impl FlowProbe {
        pub fn aborted(&self) -> bool {
            self.0.lock().map(|b| b.aborted).unwrap_or(false)
        }
    }

    /// A `(probe, ext)` pair for an established terminated flow carrying
    /// `guest_bytes` as the guest→ext payload. `fin` marks the guest's
    /// half closed so the boundary's peek returns promptly.
    pub fn bridge(guest_bytes: &[u8], fin: bool) -> (FlowProbe, BridgeStream) {
        let inner = Arc::new(Mutex::new(Bridge::default()));
        {
            let mut b = inner.lock().unwrap();
            b.guest_to_ext.extend(guest_bytes.iter().copied());
            b.established = true;
            b.guest_fin = fin;
        }
        (FlowProbe(inner.clone()), BridgeStream::new(inner))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mac_round_trips_and_rejects_garbage() {
        assert_eq!(parse_mac("02:00:00:00:00:01"), Some([2, 0, 0, 0, 0, 1]));
        assert_eq!(
            parse_mac("aa:bb:cc:dd:ee:ff"),
            Some([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])
        );
        assert_eq!(parse_mac("not-a-mac"), None);
        assert_eq!(parse_mac("02:00:00:00:00"), None); // too short
        assert_eq!(parse_mac("02:00:00:00:00:01:02"), None); // too long
    }

    #[test]
    fn gateway_mac_is_locally_administered_unicast() {
        assert_eq!(GATEWAY_MAC[0] & 0x01, 0, "unicast");
        assert_eq!(GATEWAY_MAC[0] & 0x02, 0x02, "locally administered");
    }

    #[test]
    fn link_config_lease_is_deterministic() {
        let cfg = LinkConfig::for_guest_mac("link-config-test", "52:54:00:11:22:33");
        assert_eq!(cfg.guest_mac, [0x52, 0x54, 0, 0x11, 0x22, 0x33]);
        let lease = cfg.dhcp_lease();
        assert_eq!(lease.guest_ip, GUEST_IP);
        assert_eq!(lease.gateway_ip, GATEWAY_IP);
        assert_eq!(lease.netmask, NETMASK);
    }

    #[test]
    fn run_isolated_contains_a_panic_and_the_caller_survives() {
        // A panicking unit of work returns false without unwinding into
        // the caller — the primitive the per-VM netstack thread relies on
        // so one VM's crash never reaches the host or a sibling.
        let ok = run_isolated(|| panic!("hostile frame blew up the parser"));
        assert!(!ok, "panic must be reported as failure");
        // Control returned here normally — the caller thread is alive.
        let ok = run_isolated(|| { /* normal work */ });
        assert!(ok);
    }

    #[test]
    fn bridge_stream_carries_bytes_and_eof_both_ways() {
        let inner = Arc::new(Mutex::new(Bridge::default()));
        let mut ext = BridgeStream::new(inner.clone());

        // Ext writes toward the guest: lands in ext_to_guest for the
        // engine to deliver.
        let n = ext.write(b"to-guest").unwrap();
        assert_eq!(n, 8);
        assert_eq!(inner.lock().unwrap().ext_to_guest.len(), 8);

        // Engine delivers guest bytes: ext reads them back.
        inner
            .lock()
            .unwrap()
            .guest_to_ext
            .extend(b"from-guest".iter().copied());
        let mut buf = [0u8; 32];
        let n = ext.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"from-guest");

        // Guest FIN with an empty buffer reads as clean EOF.
        inner.lock().unwrap().guest_fin = true;
        assert_eq!(ext.read(&mut buf).unwrap(), 0);
    }

    #[test]
    fn bridge_pump_forwards_a_flow_to_a_mock_upstream() {
        // The accept→forward path: a terminated guest flow's bytes
        // (guest_to_ext) are spliced to an upstream, and the upstream's
        // response lands in ext_to_guest for the engine to deliver back.
        // Here the "upstream" is a loopback echo server (the mock).
        use std::net::{TcpListener, TcpStream};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            // Reads until the forwarder shuts its write half (guest FIN),
            // echoes, then closes so the response direction sees EOF.
            s.read_to_end(&mut got).unwrap();
            s.write_all(&got).unwrap();
        });

        let inner = Arc::new(Mutex::new(Bridge::default()));
        {
            let mut b = inner.lock().unwrap();
            b.guest_to_ext.extend(b"GET / forwarded".iter().copied());
            b.guest_fin = true; // guest sent its request and closed its half
            b.established = true;
        }
        let ext = BridgeStream::new(inner.clone());
        let upstream = TcpStream::connect(addr).unwrap();

        bridge_pump(ext, upstream);
        server.join().unwrap();

        let b = inner.lock().unwrap();
        let echoed: Vec<u8> = b.ext_to_guest.iter().copied().collect();
        assert_eq!(
            echoed, b"GET / forwarded",
            "upstream response reached the guest side"
        );
        assert!(
            b.ext_fin,
            "upstream EOF was marked so the engine closes the guest socket"
        );
    }

    #[test]
    fn bridge_stream_read_errors_once_aborted() {
        let inner = Arc::new(Mutex::new(Bridge::default()));
        let mut ext = BridgeStream::new(inner.clone());
        inner.lock().unwrap().aborted = true;
        assert!(ext.read(&mut [0u8; 8]).is_err());
        assert!(ext.write(b"x").is_err());
    }
}
