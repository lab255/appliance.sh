//! The egress boundary — default-deny + allowlist over the F1 netstack.
//!
//! This is the security payload of the egress-firewall epic
//! (docs/egress-firewall.md §4, §8.1). For every guest TCP flow the
//! netstack terminated (`FlowKind::Terminated`) the engine hands us its
//! byte stream; we **classify** it (SNI on 443, Host on 80, raw IP
//! otherwise), consult the VM's effective policy (hard default-DENY +
//! the baked allowlist, `egress::netstack_policy`), and either:
//!
//!   * **forward** an allowed flow through the *same* allow/deny +
//!     MITM/creds core the legacy `egress.rs` CONNECT proxy uses —
//!     connecting to the **re-resolved validated name, never the guest's
//!     `dst_ip`** (§8.1 #3); or
//!   * **drop** everything else (default-deny / unclassifiable /
//!     forbidden-target) and log a structured denied-egress event.
//!
//! Sasha's four invariants live here:
//!   * **#1** — [`is_forbidden_target`] rejects any private/internal/
//!     host-LAN address. It gates the DNS answer filter (`dns.rs`), the
//!     DNS→IP back-reference set, the raw-IP/CIDR hatch, the host-side
//!     re-resolution ([`resolve_public`]), AND the MITM upstream dial:
//!     [`crate::mitm::intercept`] receives that pre-validated
//!     `resolve_public` address and connects only to it (re-checking the
//!     filter), instead of independently re-resolving `host` — so a
//!     DNS-rebind / multi-A private record cannot relocate the brokered
//!     dial. The netstack never originates an upstream connection — nor
//!     admits a back-ref allow, nor injects a brokered credential — to a
//!     non-public address.
//!   * **#2** — only allowlisted TCP (+ local DNS) is ever forwarded;
//!     every other L3/L4 is already dropped by `frame::classify` and we
//!     open none of it back up here.
//!   * **#3** — [`decide`] returns the validated *name* for TLS/HTTP
//!     flows; the executor connects to that name re-resolved host-side,
//!     discarding `dst_ip`. `dst_ip` is the target only in the two
//!     public-only raw-IP hatches.
//!   * **#4** — classification is fail-closed: a bounded peek with a
//!     timeout, and an un-parseable / incomplete / absent ClientHello
//!     SNI or `Host` header is **denied**, never blind-forwarded.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::{bridge_pump, BridgeStream};
use crate::egress::{self, EgressPolicy};

/// Cap on bytes peeked to classify one flow (the ClientHello / HTTP
/// head). Bounds the fail-closed read (§8.1 #4).
const PEEK_MAX: usize = 16 * 1024;
/// How long we wait for a classifiable head before failing closed.
const PEEK_TIMEOUT: Duration = Duration::from_secs(4);
/// Bound on host-side name re-resolution so a slow/hostile resolver
/// can't stall a flow or serve as an internal-host timing oracle (#1).
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(4);
/// Upstream connect bound.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a DNS→IP back-reference stays valid for the raw-IP hatch
/// (§4a). Short by design — IP allow is coarse (residual risk §8.2 #2).
const BACKREF_TTL: Duration = Duration::from_secs(120);

// --- the DNS→IP back-reference set (§4 hatch a) ----------------------

/// Public A/AAAA answers the DNS resolver handed the guest for an
/// allowlisted name, kept briefly so a later raw-IP connect to "the IP
/// our DNS just gave you" can be back-referenced to the allowlisted name
/// it came from. Only **public** addresses are ever inserted (the
/// resolver rejects private answers per #1), and the raw-IP hatch
/// re-checks [`is_forbidden_target`] anyway.
type ResolvedKey = (String, IpAddr, Option<u16>);

#[derive(Clone, Default)]
pub struct Resolved {
    inner: Arc<Mutex<HashMap<ResolvedKey, Instant>>>,
}

impl Resolved {
    pub fn new() -> Self {
        Resolved::default()
    }

    /// Remember a public resolved address (expires after [`BACKREF_TTL`]).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn insert(&self, ip: IpAddr) {
        self.insert_for("vm", ip);
    }

    pub fn insert_for(&self, principal: &str, ip: IpAddr) {
        self.insert_for_port(principal, ip, None);
    }

    pub fn insert_for_port(&self, principal: &str, ip: IpAddr, port: Option<u16>) {
        if let Ok(mut m) = self.inner.lock() {
            m.insert((principal.to_string(), ip, port), Instant::now() + BACKREF_TTL);
        }
    }

    /// Was `ip` resolved for an allowlisted name within the TTL?
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn contains_fresh(&self, ip: IpAddr) -> bool {
        self.contains_fresh_for("vm", ip)
    }

    pub fn contains_fresh_for(&self, principal: &str, ip: IpAddr) -> bool {
        self.contains_fresh_for_port(principal, ip, None)
    }

    pub fn contains_fresh_for_port(&self, principal: &str, ip: IpAddr, port: Option<u16>) -> bool {
        if let Ok(mut m) = self.inner.lock() {
            let now = Instant::now();
            m.retain(|_, exp| *exp > now);
            let principal = principal.to_string();
            return m.contains_key(&(principal.clone(), ip, port))
                || m.contains_key(&(principal, ip, None));
        }
        false
    }
}

// --- §8.1 #1 private/internal/host-LAN target filter -----------------

/// Is `ip` a *public*, globally-routable address the netstack may
/// originate to? Everything private, loopback, link-local, CGNAT, ULA,
/// multicast, unspecified, or reserved is **not** public.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    if ip.is_private()        // 10/8, 172.16/12, 192.168/16
        || ip.is_loopback()   // 127/8
        || ip.is_link_local() // 169.254/16
        || ip.is_broadcast()  // 255.255.255.255
        || ip.is_unspecified()// 0.0.0.0
        || ip.is_multicast()
    {
        return false;
    }
    if o[0] == 0 {
        return false; // 0.0.0.0/8 "this network"
    }
    if o[0] == 100 && (o[1] & 0xc0) == 0x40 {
        return false; // 100.64.0.0/10 CGNAT (RFC 6598)
    }
    if o[0] >= 240 {
        return false; // 240.0.0.0/4 reserved
    }
    true
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return false;
    }
    // IPv4-mapped (::ffff:a.b.c.d) — judge by the embedded v4 so a v6
    // wrapper can't smuggle a private v4 past the filter.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let seg = ip.segments();
    let s = seg[0];
    if (s & 0xffc0) == 0xfe80 {
        return false; // fe80::/10 link-local
    }
    if (s & 0xfe00) == 0xfc00 {
        return false; // fc00::/7 ULA
    }
    // 6to4 (2002::/16) embeds an IPv4 in segs[1..3]; judge by it so a
    // private v4 can't tunnel out wrapped in a 6to4 address.
    if s == 0x2002 {
        let v4 = Ipv4Addr::from((u32::from(seg[1]) << 16) | u32::from(seg[2]));
        return is_public_v4(v4);
    }
    // NAT64 well-known prefix (64:ff9b::/96) embeds an IPv4 in the low 32
    // bits; judge by it for the same reason.
    if seg[0] == 0x0064 && seg[1] == 0xff9b && seg[2..6] == [0, 0, 0, 0] {
        let v4 = Ipv4Addr::from((u32::from(seg[6]) << 16) | u32::from(seg[7]));
        return is_public_v4(v4);
    }
    true
}

/// The §8.1 #1 gate: reject any non-public address **or** any address in
/// the host's own LAN. This is the one function the resolver, the
/// back-reference set, the raw-IP hatch, and the re-resolution all funnel
/// through — the netstack never originates to a target this rejects.
pub fn is_forbidden_target(ip: IpAddr) -> bool {
    !is_public_ip(ip) || host_lan().iter().any(|n| n.contains(ip))
}

#[derive(Clone, Copy)]
enum Net {
    V4(u32, u32),
    V6(u128, u128),
}

impl Net {
    fn contains(&self, ip: IpAddr) -> bool {
        match (self, ip) {
            (Net::V4(net, mask), IpAddr::V4(x)) => (u32::from(x) & mask) == (net & mask),
            (Net::V6(net, mask), IpAddr::V6(x)) => (u128::from(x) & mask) == (net & mask),
            _ => false,
        }
    }
}

/// The host's own attached networks (addr & netmask), discovered once.
/// Used to reject the operator's LAN as an egress target (#1) even when
/// it is publicly addressed. Over-broad / zero masks are skipped so a
/// point-to-point or default-route interface can't accidentally forbid
/// the whole internet.
///
/// Cache-at-start limitation: the set is discovered on first use and
/// cached in this `OnceLock` for the process lifetime — never refreshed.
/// A LAN attached *after* netstack start (e.g. plugging in a new
/// interface / joining a new network) is therefore NOT treated as
/// host-LAN until the process restarts. This only narrows the
/// publicly-addressed-LAN reject; the RFC1918 / loopback / link-local /
/// CGNAT / ULA ranges are always rejected by `is_public_ip` regardless
/// of this cache, so invariant #1's core never depends on it.
fn host_lan() -> &'static Vec<Net> {
    static LAN: OnceLock<Vec<Net>> = OnceLock::new();
    LAN.get_or_init(discover_host_lan)
}

#[cfg(unix)]
fn discover_host_lan() -> Vec<Net> {
    let mut nets = Vec::new();
    unsafe {
        let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut ifap) != 0 {
            return nets;
        }
        let mut cur = ifap;
        while !cur.is_null() {
            let ifa = &*cur;
            cur = ifa.ifa_next;
            if ifa.ifa_addr.is_null() || ifa.ifa_netmask.is_null() {
                continue;
            }
            match (*ifa.ifa_addr).sa_family as i32 {
                libc::AF_INET => {
                    let a = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                    let m = &*(ifa.ifa_netmask as *const libc::sockaddr_in);
                    let net = u32::from_be(a.sin_addr.s_addr);
                    let mask = u32::from_be(m.sin_addr.s_addr);
                    // Skip masks shorter than /8 (incl. 0) so a weird
                    // interface can't forbid huge public ranges.
                    if mask.count_ones() >= 8 {
                        nets.push(Net::V4(net, mask));
                    }
                }
                libc::AF_INET6 => {
                    let a = &*(ifa.ifa_addr as *const libc::sockaddr_in6);
                    let m = &*(ifa.ifa_netmask as *const libc::sockaddr_in6);
                    let net = u128::from_be_bytes(a.sin6_addr.s6_addr);
                    let mask = u128::from_be_bytes(m.sin6_addr.s6_addr);
                    if mask.count_ones() >= 16 {
                        nets.push(Net::V6(net, mask));
                    }
                }
                _ => {}
            }
        }
        libc::freeifaddrs(ifap);
    }
    nets
}

#[cfg(not(unix))]
fn discover_host_lan() -> Vec<Net> {
    Vec::new()
}

// --- exclusions (never policed; intra-guest, never legitimately egress) -

/// Names that are always local (cluster / loopback) — excluded from
/// policing so they resolve/route normally if they ever reach us
/// (docs §5). They are switched inside the guest and seldom cross the
/// link; this is belt-and-suspenders.
fn is_excluded_name(host: &str) -> bool {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".svc")
        || h.ends_with(".svc.cluster.local")
        || h.ends_with(".cluster.local")
}

/// Intra-guest CIDRs (k3s pod/service, docker bridge, loopback). These
/// are switched inside the guest kernel and never legitimately cross
/// `host_fd`; if one does reach the netstack we drop it silently rather
/// than originate a (forbidden, useless) host-side connection or emit a
/// scary denial.
fn is_excluded_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || (o[0] == 10 && o[1] == 42) // k3s pod CIDR 10.42/16
                || (o[0] == 10 && o[1] == 43) // k3s service CIDR 10.43/16
                || (o[0] == 172 && o[1] == 17) // docker bridge 172.17/16
        }
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

/// Allowlist decision for a name: excluded names are always allowed;
/// otherwise the effective (default-deny + baked allowlist) policy
/// decides. Deny rules win (handled inside `allows`). Shared by the flow
/// classifier and the DNS resolver so name policy is decided one way.
pub fn name_is_allowed(host: &str, policy: &EgressPolicy) -> bool {
    is_excluded_name(host) || policy.allows(host)
}

/// An explicit IP / CIDR allow rule in the policy (§4 hatch b). Entries
/// that parse as a bare IP or `addr/len` CIDR are matched against the
/// raw destination; name-suffix entries are ignored here.
fn ip_cidr_allows(policy: &EgressPolicy, ip: IpAddr) -> bool {
    policy.allow.iter().any(|rule| cidr_match(rule.trim(), ip))
}

fn cidr_match(rule: &str, ip: IpAddr) -> bool {
    if let Ok(exact) = rule.parse::<IpAddr>() {
        return exact == ip;
    }
    let Some((addr, len)) = rule.split_once('/') else {
        return false;
    };
    let Ok(prefix) = len.parse::<u32>() else {
        return false;
    };
    match (addr.parse::<IpAddr>(), ip) {
        (Ok(IpAddr::V4(net)), IpAddr::V4(x)) if prefix <= 32 => {
            let mask = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix)
            };
            (u32::from(net) & mask) == (u32::from(x) & mask)
        }
        (Ok(IpAddr::V6(net)), IpAddr::V6(x)) if prefix <= 128 => {
            let mask = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - prefix)
            };
            (u128::from(net) & mask) == (u128::from(x) & mask)
        }
        _ => false,
    }
}

// --- the policy decision (pure — the §8.1 #3/#4/#1 unit-test seam) ----

/// What to do with one classified flow.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Allowed TLS(443)/HTTP(80): connect to this **name**, re-resolved
    /// host-side (§8.1 #3) — `dst_ip` is discarded. `tls` distinguishes
    /// the (maybe-MITM) HTTPS path from the plain-HTTP forward.
    ForwardName { host: String, port: u16, tls: bool },
    /// Allowed raw IP via a public-only hatch (back-ref or IP/CIDR rule).
    ForwardIp { addr: SocketAddr },
    /// Dropped: default-deny, unclassifiable (fail-closed), or a
    /// forbidden target. `label` is the best host/IP name for the log.
    Deny { label: String, port: u16, tls: bool },
}

/// Decide a flow's fate from its already-peeked head + destination +
/// policy + back-reference set. **Pure** (no IO): the re-resolution and
/// the private-range reject on the *resolved* address happen in the
/// executor ([`resolve_public`]). This function proves #3 (an allowed
/// TLS/HTTP flow yields the validated *name*, never `dst`) and #4 (an
/// un-parseable head is denied).
#[cfg_attr(not(test), allow(dead_code))]
pub fn decide(
    dst: SocketAddr,
    head: &[u8],
    head_complete: bool,
    policy: &EgressPolicy,
    resolved: &Resolved,
) -> Decision {
    decide_for(dst, head, head_complete, policy, resolved, "vm", true)
}

pub fn decide_for(
    dst: SocketAddr,
    head: &[u8],
    head_complete: bool,
    policy: &EgressPolicy,
    resolved: &Resolved,
    principal: &str,
    allow_ip_rules: bool,
) -> Decision {
    let port = dst.port();
    match port {
        443 => {
            // Fail closed: incomplete/unparseable ClientHello ⇒ deny.
            let sni = if head_complete { parse_sni(head) } else { None };
            match sni {
                Some(host) if name_is_allowed(&host, policy) => Decision::ForwardName {
                    host,
                    port,
                    tls: true,
                },
                Some(host) => Decision::Deny {
                    label: host,
                    port,
                    tls: true,
                },
                None => Decision::Deny {
                    label: "<no-sni>".into(),
                    port,
                    tls: true,
                },
            }
        }
        80 => {
            let host = if head_complete {
                parse_host(head)
            } else {
                None
            };
            match host {
                Some(h) if name_is_allowed(&h, policy) => Decision::ForwardName {
                    host: h,
                    port,
                    tls: false,
                },
                Some(h) => Decision::Deny {
                    label: h,
                    port,
                    tls: false,
                },
                None => Decision::Deny {
                    label: "<no-host>".into(),
                    port,
                    tls: false,
                },
            }
        }
        _ => {
            let ip = dst.ip();
            // Both raw-IP hatches reject any private/internal/host-LAN
            // target (#1), then admit only a fresh back-ref or an
            // explicit IP/CIDR allow.
            if !is_forbidden_target(ip)
                && (resolved.contains_fresh_for_port(principal, ip, Some(port))
                    || (allow_ip_rules && ip_cidr_allows(policy, ip)))
            {
                Decision::ForwardIp { addr: dst }
            } else {
                Decision::Deny {
                    label: ip.to_string(),
                    port,
                    tls: false,
                }
            }
        }
    }
}

// --- the executor (IO) -----------------------------------------------

/// Classify, decide, and forward-or-drop one terminated guest flow. Runs
/// on its own thread (spawned by the engine), so the bounded peek +
/// re-resolution + splice never block the netstack loop.
pub fn serve_outbound(
    name: &str,
    source: Ipv4Addr,
    dst: SocketAddr,
    ext: BridgeStream,
    resolved: &Resolved,
) {
    if is_excluded_ip(dst.ip()) {
        ext.abort();
        return;
    }
    let context = egress::policy_for(name, source);
    let policy = context.policy();
    let principal = context.principal();
    if let egress::PolicyContext::Unknown { .. } = &context {
        log_deny(
            &context,
            name,
            &dst.ip().to_string(),
            dst.port(),
            "unknown-principal",
        );
        ext.abort();
        return;
    }
    let port = dst.port();
    let (head, complete) = match port {
        443 => ext.peek_until(PEEK_MAX, PEEK_TIMEOUT, tls_hello_ready),
        80 => ext.peek_until(PEEK_MAX, PEEK_TIMEOUT, http_head_ready),
        _ => (Vec::new(), true),
    };
    let decision = decide_for(
        dst,
        &head,
        complete,
        &policy,
        resolved,
        &principal,
        !context.is_runtime(),
    );
    let decision = match (&context, decision) {
        (
            egress::PolicyContext::Runtime(runtime),
            Decision::ForwardName { host, port, tls },
        ) if !runtime.allows_host_port(&host, port) => Decision::Deny {
            label: host,
            port,
            tls,
        },
        (_, decision) => decision,
    };
    match decision {
        Decision::ForwardName { host, port, tls } => {
            forward_name(name, &context, &host, port, tls, head, ext)
        }
        Decision::ForwardIp { addr } => forward_ip(name, &context, addr, ext),
        Decision::Deny { label, port, tls } => deny(name, &context, &label, port, tls, ext),
    }
}

/// Forward an allowed TLS/HTTP flow to the **re-resolved validated name**
/// (#3). The guest-supplied `dst_ip` is never the connect target here.
fn forward_name(
    name: &str,
    context: &egress::PolicyContext,
    host: &str,
    port: u16,
    tls: bool,
    head: Vec<u8>,
    ext: BridgeStream,
) {
    let policy = context.policy();
    // Re-resolve host-side, bounded, and reject a non-public result
    // (allowlisted-name-resolves-internal ⇒ denied, #1).
    let Some(addr) = resolve_public(host, port, RESOLVE_TIMEOUT) else {
        log_deny(context, name, host, port, "resolves-non-public");
        ext.abort();
        return;
    };

    // MITM only brokered hosts (reuse the egress.rs gate): every other
    // allowed host stays a blind, streaming-preserving tunnel. The peer is
    // this VM's own deterministic guest (the per-VM netstack link is
    // L2-isolated — there is no cross-VM peer to re-attribute), so the
    // exact-lease injection gate is satisfied by `super::GUEST_IP`.
    let inspect = tls
        && if context.is_runtime() {
            egress::should_inspect_runtime(&policy, true)
        } else {
            egress::should_intercept(
                name,
                std::net::IpAddr::V4(source_for_context(context)),
                true,
                policy.mitm,
                host,
            )
        };
    if inspect {
        match inspection_configs(name, context, host, port, &ext) {
            Ok(Some((server_cfg, client_cfg))) => {
                // Replay the peeked ClientHello into rustls, which drives
                // the handshake from the first byte.
                let client = Prefixed::new(head, ext.clone());
                // Thread the **pre-validated public addr** (from
                // `resolve_public` above) into the interceptor so its
                // upstream dial lands on the filtered target, NOT an
                // independent re-resolution of `host` that a DNS rebind /
                // multi-A private record could relocate (#1, brokered path).
                let target = crate::mitm::MitmTarget {
                    host,
                    port,
                    upstream: Some(addr),
                };
                let result = match context {
                    egress::PolicyContext::Runtime(runtime) => crate::mitm::intercept_observe(
                        name, runtime, client, target, server_cfg, client_cfg, false,
                    ),
                    _ => {
                        crate::mitm::intercept(name, client, target, server_cfg, client_cfg, false)
                    }
                };
                let _ = result;
                ext.mark_ext_fin();
                return;
            }
            Err(()) => return,
            Ok(None) => {}
        }
    }

    record_context(
        context,
        name,
        host,
        port,
        if tls { "CONNECT" } else { "HTTP" },
        "allow",
        None,
    );
    match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
        Ok(mut up) => {
            // Replay the peeked head (ClientHello / HTTP request line +
            // headers) before splicing the remainder.
            if up.write_all(&head).is_ok() {
                bridge_pump(ext, up);
            } else {
                ext.abort();
            }
        }
        Err(_) => ext.abort(),
    }
}

type InspectionConfigs = (
    std::sync::Arc<rustls::ServerConfig>,
    std::sync::Arc<rustls::ClientConfig>,
);

/// Runtime inspection cannot degrade to a blind tunnel when CA/config
/// material is unavailable. Legacy retains its historical blind fallback.
fn inspection_configs(
    name: &str,
    context: &egress::PolicyContext,
    host: &str,
    port: u16,
    ext: &BridgeStream,
) -> std::result::Result<Option<InspectionConfigs>, ()> {
    match crate::mitm::configs(name) {
        Ok(configs) => Ok(Some(configs)),
        Err(_) if context.is_runtime() => {
            abort_inspection_unavailable(context, name, host, port, ext);
            Err(())
        }
        Err(_) => Ok(None),
    }
}

fn abort_inspection_unavailable(
    context: &egress::PolicyContext,
    name: &str,
    host: &str,
    port: u16,
    ext: &BridgeStream,
) {
    log_deny(context, name, host, port, "inspection-unavailable");
    ext.abort();
}

/// Forward an allowed raw-IP flow (a public-only hatch). Nothing was
/// peeked, so there is no head to replay — connect to the (already
/// public, already-validated) address and splice.
fn forward_ip(name: &str, context: &egress::PolicyContext, addr: SocketAddr, ext: BridgeStream) {
    record_context(
        context,
        name,
        &addr.ip().to_string(),
        addr.port(),
        "RAW",
        "allow",
        None,
    );
    match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
        Ok(up) => bridge_pump(ext, up),
        Err(_) => ext.abort(),
    }
}

/// Drop a denied flow and record the structured denied-egress event
/// (F3 surfaces it). For plain HTTP we can answer a legible 403 over the
/// cleartext stream; TLS/raw flows are simply reset.
fn deny(
    name: &str,
    context: &egress::PolicyContext,
    label: &str,
    port: u16,
    tls: bool,
    ext: BridgeStream,
) {
    log_deny(context, name, label, port, "policy");
    if !tls && port == 80 {
        let body = format!("egress blocked by policy: {label}\n");
        let resp = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let mut ext = ext;
        let _ = ext.write_all(resp.as_bytes());
        ext.mark_ext_fin();
    } else {
        ext.abort();
    }
}

fn source_for_context(context: &egress::PolicyContext) -> Ipv4Addr {
    match context {
        egress::PolicyContext::Runtime(runtime) => runtime.source,
        _ => super::GUEST_IP,
    }
}

fn record_context(
    context: &egress::PolicyContext,
    name: &str,
    host: &str,
    port: u16,
    method: &str,
    decision: &str,
    reason: Option<&str>,
) {
    if let egress::PolicyContext::Runtime(runtime) = context {
        crate::traffic::record_runtime(
            runtime,
            host,
            port,
            method,
            None,
            decision,
            crate::traffic::TrafficDetails {
                reason,
                sni: (port == 443).then_some(host),
                ..Default::default()
            },
        );
    } else {
        crate::traffic::record(name, host, port, method, None, decision);
    }
}

fn log_deny(context: &egress::PolicyContext, name: &str, label: &str, port: u16, reason: &str) {
    if let egress::PolicyContext::Unknown { source } = context {
        crate::traffic::record_unknown(name, &context.principal(), label, port, "DENY", reason);
        eprintln!("egress[{name}/unknown:{source}]: DENY {label}:{port} ({reason})");
        return;
    }
    record_context(
        context,
        name,
        label,
        port,
        "DENY",
        "deny",
        Some(reason),
    );
    eprintln!(
        "egress[{name}/{}]: DENY {label}:{port} ({reason})",
        context.principal()
    );
}

/// Size of the shared resolver worker pool. A hung host `getaddrinfo`
/// wedges at most this many threads process-wide — never one-per-flow.
const RESOLVER_WORKERS: usize = 8;

/// One host-resolution job submitted to the [`resolver_pool`]: resolve
/// `host:port` and post the addresses back on `reply` (whose receiver may
/// have already timed out — the worker tolerates a dropped receiver).
struct ResolveJob {
    host: String,
    port: u16,
    reply: mpsc::Sender<Vec<SocketAddr>>,
}

/// A small, process-wide **bounded** pool of resolver worker threads.
///
/// The host `getaddrinfo` (`to_socket_addrs`) can hang indefinitely on a
/// slow/hostile resolver. Running it on a detached thread-per-flow leaks
/// one thread per allowed flow whenever it hangs (the bug this replaces).
/// Instead, resolutions are submitted to a fixed set of workers and the
/// caller bounds its wait with a timeout: a hung resolver can wedge at most
/// `RESOLVER_WORKERS` threads, reused across every flow, never growing
/// without bound. The pool is created once and lives for the process.
fn resolver_pool() -> &'static mpsc::Sender<ResolveJob> {
    static POOL: OnceLock<mpsc::Sender<ResolveJob>> = OnceLock::new();
    POOL.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<ResolveJob>();
        // Workers share one queue via a Mutex<Receiver>; each locks only to
        // dequeue, then releases the lock BEFORE the (possibly slow)
        // getaddrinfo, so a hung resolution never blocks the others.
        let rx = Arc::new(Mutex::new(rx));
        for _ in 0..RESOLVER_WORKERS {
            let rx = rx.clone();
            let _ = std::thread::Builder::new()
                .name("egress-resolver".into())
                .spawn(move || loop {
                    let job = {
                        let guard = rx.lock().unwrap_or_else(|p| p.into_inner());
                        match guard.recv() {
                            Ok(job) => job,
                            Err(_) => return, // channel closed — pool gone
                        }
                    };
                    let addrs = (job.host.as_str(), job.port)
                        .to_socket_addrs()
                        .map(|it| it.collect::<Vec<_>>())
                        .unwrap_or_default();
                    // The caller may have timed out and dropped its
                    // receiver; that's fine — drop the result and loop.
                    let _ = job.reply.send(addrs);
                });
        }
        tx
    })
}

/// Bounded, host-side re-resolution of a validated name. Resolves on the
/// shared, **bounded** resolver pool (above) — never a per-flow detached
/// thread — so a slow resolver can neither stall the flow, leak a thread,
/// nor act as an internal-host timing oracle (#1). Returns the first
/// **public, non-host-LAN** address; `None` if it resolves only to
/// forbidden targets, fails, or times out (all ⇒ deny).
fn resolve_public(host: &str, port: u16, timeout: Duration) -> Option<SocketAddr> {
    let (tx, rx) = mpsc::channel();
    let job = ResolveJob {
        host: host.to_string(),
        port,
        reply: tx,
    };
    resolver_pool().send(job).ok()?;
    let addrs = rx.recv_timeout(timeout).ok()?;
    addrs.into_iter().find(|a| !is_forbidden_target(a.ip()))
}

// --- a stream that replays already-peeked bytes ----------------------

/// Wraps a stream so a prefix of already-consumed bytes (the peeked
/// ClientHello) is yielded first, then reads delegate to the inner
/// stream. Lets the MITM path hand rustls the handshake from byte zero
/// even though we peeked the SNI out of band.
struct Prefixed<S> {
    pre: VecDeque<u8>,
    inner: S,
}

impl<S> Prefixed<S> {
    fn new(pre: Vec<u8>, inner: S) -> Self {
        Prefixed {
            pre: pre.into(),
            inner,
        }
    }
}

impl<S: Read> Read for Prefixed<S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if !self.pre.is_empty() {
            let n = buf.len().min(self.pre.len());
            for slot in buf.iter_mut().take(n) {
                *slot = self.pre.pop_front().unwrap();
            }
            return Ok(n);
        }
        self.inner.read(buf)
    }
}

impl<S: Write> Write for Prefixed<S> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

// --- fail-closed classifiers (bounded, panic-free) -------------------

/// Have we peeked enough to classify a TLS flow? A non-handshake first
/// byte is decided immediately (so we can deny without waiting out the
/// timeout); otherwise we need the full first record.
fn tls_hello_ready(buf: &[u8]) -> bool {
    match buf.first() {
        None => false,
        Some(&0x16) => {
            if buf.len() < 5 {
                return false;
            }
            let rec_len = u16::from_be_bytes([buf[3], buf[4]]) as usize;
            buf.len() >= 5 + rec_len
        }
        Some(_) => true, // not a TLS handshake — decide now (→ deny)
    }
}

/// Have we peeked a complete HTTP request head (through the blank line)?
fn http_head_ready(buf: &[u8]) -> bool {
    buf.windows(4).any(|w| w == b"\r\n\r\n")
}

fn read_u16(b: &[u8], at: usize) -> Option<usize> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]) as usize)
}

/// Extract the SNI host_name from a raw TLS ClientHello record. Bounded
/// and panic-free on hostile input (every access is checked); returns
/// `None` (⇒ deny) for anything that isn't a parseable ClientHello with
/// a host_name SNI (#4).
pub fn parse_sni(rec: &[u8]) -> Option<String> {
    if rec.first() != Some(&0x16) {
        return None; // not a handshake record
    }
    let rec_len = read_u16(rec, 3)?;
    let hs = rec.get(5..5usize.checked_add(rec_len)?)?;
    if hs.first() != Some(&0x01) {
        return None; // not a ClientHello
    }
    let hs_len =
        ((*hs.get(1)? as usize) << 16) | ((*hs.get(2)? as usize) << 8) | *hs.get(3)? as usize;
    let body = hs.get(4..4usize.checked_add(hs_len)?)?;

    // client_version(2) + random(32)
    let mut p = 34usize;
    // session_id
    let sid = *body.get(p)? as usize;
    p = p.checked_add(1 + sid)?;
    // cipher_suites
    let cs = read_u16(body, p)?;
    p = p.checked_add(2 + cs)?;
    // compression_methods
    let cm = *body.get(p)? as usize;
    p = p.checked_add(1 + cm)?;
    // extensions
    let ext_total = read_u16(body, p)?;
    p = p.checked_add(2)?;
    let ext_end = p.checked_add(ext_total)?;
    if ext_end > body.len() {
        return None;
    }
    while p + 4 <= ext_end {
        let etype = read_u16(body, p)?;
        let elen = read_u16(body, p + 2)?;
        let data_start = p + 4;
        let data_end = data_start.checked_add(elen)?;
        if data_end > ext_end {
            return None;
        }
        if etype == 0x0000 {
            return parse_server_name_list(&body[data_start..data_end]);
        }
        p = data_end;
    }
    None
}

fn parse_server_name_list(sn: &[u8]) -> Option<String> {
    let list_len = read_u16(sn, 0)?;
    let list = sn.get(2..2usize.checked_add(list_len)?)?;
    let mut p = 0usize;
    while p + 3 <= list.len() {
        let name_type = list[p];
        let nlen = read_u16(list, p + 1)?;
        let start = p + 3;
        let end = start.checked_add(nlen)?;
        if end > list.len() {
            return None;
        }
        if name_type == 0 {
            let host = std::str::from_utf8(&list[start..end])
                .ok()?
                .trim()
                .to_ascii_lowercase();
            if host.is_empty() || host.len() > 253 || !host.bytes().all(valid_host_byte) {
                return None;
            }
            return Some(host);
        }
        p = end;
    }
    None
}

fn valid_host_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_' || b == b'*'
}

/// Extract the `Host` header from a peeked HTTP request head. `None`
/// (⇒ deny) when absent/empty (#4). The port suffix is stripped.
pub fn parse_host(head: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(head);
    for line in text.lines().skip(1) {
        if line.is_empty() {
            break;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        if k.trim().eq_ignore_ascii_case("host") {
            let v = v.trim();
            let host = v.rsplit_once(':').map_or(v, |(h, _)| h);
            let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
            if host.is_empty() || !host.bytes().all(valid_host_byte) {
                return None;
            }
            return Some(host);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::egress::Action;

    fn policy(allow: &[&str], mitm: bool) -> EgressPolicy {
        EgressPolicy {
            default: Action::Deny,
            allow: allow.iter().map(|s| s.to_string()).collect(),
            deny: Vec::new(),
            mitm,
        }
    }

    fn runtime_context(app: &str) -> egress::PolicyContext {
        egress::PolicyContext::Runtime(egress::RuntimePolicy {
            version: 1,
            app: app.to_string(),
            service: None,
            vm: "appliance-runtime".to_string(),
            principal: app.to_string(),
            source: Ipv4Addr::new(192, 168, 127, 10),
            policy: policy(&["example.com"], true),
            allow_ports: std::collections::BTreeMap::from([("example.com".to_string(), vec![443])]),
        })
    }

    /// Build a minimal but valid TLS ClientHello record carrying `sni`.
    fn client_hello(sni: &str) -> Vec<u8> {
        // server_name extension body.
        let mut sn = Vec::new();
        sn.extend_from_slice(&((sni.len() + 3) as u16).to_be_bytes()); // list len
        sn.push(0); // name_type host_name
        sn.extend_from_slice(&(sni.len() as u16).to_be_bytes());
        sn.extend_from_slice(sni.as_bytes());

        let mut ext = Vec::new();
        ext.extend_from_slice(&0x0000u16.to_be_bytes()); // type server_name
        ext.extend_from_slice(&(sn.len() as u16).to_be_bytes());
        ext.extend_from_slice(&sn);

        let mut body = Vec::new();
        body.extend_from_slice(&[0x03, 0x03]); // client_version TLS1.2
        body.extend_from_slice(&[0u8; 32]); // random
        body.push(0); // session_id len
        body.extend_from_slice(&2u16.to_be_bytes()); // cipher_suites len
        body.extend_from_slice(&[0x13, 0x01]); // one suite
        body.push(1); // compression methods len
        body.push(0); // null
        body.extend_from_slice(&(ext.len() as u16).to_be_bytes());
        body.extend_from_slice(&ext);

        let mut hs = Vec::new();
        hs.push(0x01); // ClientHello
        let l = body.len();
        hs.extend_from_slice(&[(l >> 16) as u8, (l >> 8) as u8, l as u8]);
        hs.extend_from_slice(&body);

        let mut rec = Vec::new();
        rec.push(0x16); // handshake
        rec.extend_from_slice(&[0x03, 0x01]); // record version
        rec.extend_from_slice(&(hs.len() as u16).to_be_bytes());
        rec.extend_from_slice(&hs);
        rec
    }

    #[test]
    fn parse_sni_extracts_host() {
        let hello = client_hello("api.anthropic.com");
        assert!(tls_hello_ready(&hello));
        assert_eq!(parse_sni(&hello).as_deref(), Some("api.anthropic.com"));
    }

    #[test]
    fn parse_sni_fails_closed_on_garbage() {
        // Empty, runt, non-handshake, and truncated records all yield
        // None (→ deny) rather than panic (#4).
        assert_eq!(parse_sni(&[]), None);
        assert_eq!(parse_sni(&[0x16]), None);
        assert_eq!(parse_sni(b"GET / HTTP/1.1\r\n"), None);
        let hello = client_hello("api.anthropic.com");
        for cut in 0..hello.len() {
            // Never panics; a truncated hello is unparseable.
            let _ = parse_sni(&hello[..cut]);
        }
    }

    #[test]
    fn fuzz_parse_sni_never_panics() {
        let mut seed = 0x1234_5678_9abc_def0u64;
        for _ in 0..20_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let len = (seed as usize) % 600;
            let f: Vec<u8> = (0..len).map(|i| (seed >> (i % 56)) as u8).collect();
            let _ = parse_sni(&f);
            let _ = tls_hello_ready(&f);
        }
    }

    #[test]
    fn sni_forged_ip_connects_to_name_not_dst() {
        // SYN → evil_ip:443 carrying SNI=api.anthropic.com. The decision
        // MUST be ForwardName(api.anthropic.com), discarding the guest's
        // evil dst_ip (#3) — the re-point that stops riding an allowed
        // label to an arbitrary IP.
        let p = policy(&["api.anthropic.com"], false);
        let evil: SocketAddr = "203.0.113.66:443".parse().unwrap();
        let hello = client_hello("api.anthropic.com");
        let d = decide(evil, &hello, true, &p, &Resolved::new());
        assert_eq!(
            d,
            Decision::ForwardName {
                host: "api.anthropic.com".into(),
                port: 443,
                tls: true
            }
        );
    }

    #[test]
    fn sni_denied_host_is_dropped() {
        let p = policy(&["api.anthropic.com"], false);
        let dst: SocketAddr = "93.184.216.34:443".parse().unwrap();
        let hello = client_hello("evil.test");
        match decide(dst, &hello, true, &p, &Resolved::new()) {
            Decision::Deny { label, .. } => assert_eq!(label, "evil.test"),
            other => panic!("expected deny, got {other:?}"),
        }
    }

    #[test]
    fn unparseable_clienthello_denied() {
        // Fail-closed (#4): a complete-but-garbled / absent SNI ⇒ deny,
        // never a blind forward.
        let p = policy(&["api.anthropic.com"], false);
        let dst: SocketAddr = "93.184.216.34:443".parse().unwrap();
        // Incomplete peek ⇒ deny.
        assert!(matches!(
            decide(dst, b"\x16\x03\x01", false, &p, &Resolved::new()),
            Decision::Deny { .. }
        ));
        // Complete but not a ClientHello ⇒ deny.
        assert!(matches!(
            decide(dst, b"garbage-bytes-not-tls", true, &p, &Resolved::new()),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn http_host_allow_and_deny() {
        let p = policy(&["github.com"], false);
        let dst: SocketAddr = "140.82.121.3:80".parse().unwrap();
        let allowed = b"GET / HTTP/1.1\r\nHost: codeload.github.com\r\n\r\n";
        assert_eq!(
            decide(dst, allowed, true, &p, &Resolved::new()),
            Decision::ForwardName {
                host: "codeload.github.com".into(),
                port: 80,
                tls: false
            }
        );
        let denied = b"GET / HTTP/1.1\r\nHost: evil.test\r\n\r\n";
        assert!(matches!(
            decide(dst, denied, true, &p, &Resolved::new()),
            Decision::Deny { .. }
        ));
        // Missing Host ⇒ deny (#4).
        let nohost = b"GET / HTTP/1.1\r\nAccept: */*\r\n\r\n";
        assert!(matches!(
            decide(dst, nohost, true, &p, &Resolved::new()),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn private_range_filter_rejects_internal() {
        // §8.1 #1: every private/internal/link-local/CGNAT/ULA/loopback
        // range is non-public; only real public addresses pass.
        for s in [
            "10.0.0.5",
            "10.42.0.1",
            "172.16.9.9",
            "172.31.255.1",
            "192.168.1.50",
            "127.0.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "100.127.255.255",
            "0.0.0.0",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!is_public_ip(s.parse().unwrap()), "{s} must be non-public");
        }
        for s in [
            "::1",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "::ffff:10.0.0.1",
            // 6to4 embedding a private v4: 2002:0a00:0001:: == 10.0.0.1.
            "2002:0a00:0001::1",
            // NAT64 well-known prefix embedding a private v4:
            // 64:ff9b::c0a8:0101 == 192.168.1.1.
            "64:ff9b::c0a8:0101",
        ] {
            assert!(!is_public_ip(s.parse().unwrap()), "{s} must be non-public");
        }
        for s in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "140.82.121.3"] {
            assert!(is_public_ip(s.parse().unwrap()), "{s} must be public");
        }
        // 6to4 / NAT64 embedding a PUBLIC v4 stays public (no over-block):
        // 2002:0808:0808:: == 8.8.8.8; 64:ff9b::0808:0808 == 8.8.8.8.
        for s in ["2002:0808:0808::1", "64:ff9b::0808:0808"] {
            assert!(is_public_ip(s.parse().unwrap()), "{s} must be public");
        }
        // is_forbidden_target subsumes is_public for non-public addrs.
        assert!(is_forbidden_target("10.0.0.1".parse().unwrap()));
        assert!(is_forbidden_target("169.254.0.1".parse().unwrap()));
    }

    #[test]
    fn raw_ip_to_private_range_denied() {
        // A raw-IP connect to a private target is denied even if it were
        // somehow back-referenced — the hatch rejects forbidden targets.
        let p = policy(&[], false);
        let resolved = Resolved::new();
        resolved.insert("10.0.0.9".parse().unwrap()); // (shouldn't ever happen)
        let dst: SocketAddr = "10.0.0.9:8080".parse().unwrap();
        assert!(matches!(
            decide(dst, &[], true, &p, &resolved),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn raw_ip_backref_allows_public_recently_resolved() {
        // §4a: a raw connect to a public IP our DNS just handed out for an
        // allowlisted name is admitted; an unknown public IP is denied.
        let p = policy(&[], false);
        let resolved = Resolved::new();
        let good: IpAddr = "93.184.216.34".parse().unwrap();
        resolved.insert(good);
        let dst: SocketAddr = "93.184.216.34:8443".parse().unwrap();
        assert_eq!(
            decide(dst, &[], true, &p, &resolved),
            Decision::ForwardIp { addr: dst }
        );
        let unknown: SocketAddr = "198.51.100.7:8443".parse().unwrap();
        assert!(matches!(
            decide(unknown, &[], true, &p, &resolved),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn raw_ip_backrefs_are_isolated_by_principal() {
        let p = policy(&[], false);
        let resolved = Resolved::new();
        let ip: IpAddr = "93.184.216.34".parse().unwrap();
        let dst: SocketAddr = "93.184.216.34:8443".parse().unwrap();
        resolved.insert_for_port("app-a", ip, Some(8443));
        assert_eq!(
            decide_for(dst, &[], true, &p, &resolved, "app-a", false),
            Decision::ForwardIp { addr: dst }
        );
        assert!(matches!(
            decide_for(dst, &[], true, &p, &resolved, "app-b", false),
            Decision::Deny { .. }
        ));
        let wrong_port: SocketAddr = "93.184.216.34:9443".parse().unwrap();
        assert!(matches!(
            decide_for(wrong_port, &[], true, &p, &resolved, "app-a", false),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn raw_ip_cidr_allow_rule_public_only() {
        // §4b: an explicit IP/CIDR allow rule admits a public target...
        let p = policy(&["198.51.100.0/24"], false);
        let dst: SocketAddr = "198.51.100.9:9000".parse().unwrap();
        assert_eq!(
            decide(dst, &[], true, &p, &Resolved::new()),
            Decision::ForwardIp { addr: dst }
        );
        // ...but never a private one, even if a rule names it (#1).
        let p2 = policy(&["10.0.0.0/8"], false);
        let priv_dst: SocketAddr = "10.0.0.9:9000".parse().unwrap();
        assert!(matches!(
            decide(priv_dst, &[], true, &p2, &Resolved::new()),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn resolve_public_rejects_internal_names() {
        // localhost resolves to loopback only ⇒ no public address ⇒ None
        // (the allowlisted-name-resolves-internal deny, #1).
        assert!(resolve_public("localhost", 443, Duration::from_secs(3)).is_none());
        // A name that cannot resolve ⇒ None, bounded by the timeout.
        assert!(resolve_public("nonexistent.invalid.", 443, Duration::from_secs(3)).is_none());
    }

    #[test]
    fn resolver_pool_is_bounded_and_reaped() {
        // Submit many more jobs than there are workers: every one must be
        // serviced, which proves the fixed worker set is REUSED (reaped
        // back to the queue) rather than leaking a thread per job. A reply
        // receiver dropped mid-flight (the caller timed out) must not wedge
        // a worker — the next job still gets through.
        let jobs = RESOLVER_WORKERS * 4;
        let mut rxs = Vec::with_capacity(jobs);
        for i in 0..jobs {
            let (tx, rx) = mpsc::channel();
            resolver_pool()
                .send(ResolveJob {
                    host: "localhost".into(),
                    port: 80,
                    reply: tx,
                })
                .unwrap();
            // Drop a few receivers immediately to model a timed-out caller.
            if i % 5 == 0 {
                drop(rx);
            } else {
                rxs.push(rx);
            }
        }
        for rx in rxs {
            assert!(
                rx.recv_timeout(Duration::from_secs(5)).is_ok(),
                "every queued resolution is serviced by the bounded pool"
            );
        }
    }

    #[test]
    fn excluded_names_and_ips() {
        assert!(is_excluded_name("kubernetes.default.svc"));
        assert!(is_excluded_name("foo.svc.cluster.local"));
        assert!(is_excluded_name("localhost"));
        assert!(!is_excluded_name("api.anthropic.com"));
        assert!(is_excluded_ip("10.42.0.7".parse().unwrap()));
        assert!(is_excluded_ip("10.43.0.1".parse().unwrap()));
        assert!(is_excluded_ip("172.17.0.2".parse().unwrap()));
        assert!(!is_excluded_ip("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn denied_flow_is_dropped_and_logged() {
        // End-to-end executor: a guest TLS flow to a non-allowlisted SNI
        // is aborted (the guest's connection is reset) AND a structured
        // denied-egress event is recorded for F3 to surface.
        let name = "guard-deny-executor-test";
        let dir = crate::spec::VmPaths::for_name(name).dir;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::traffic::clear(name);

        let hello = client_hello("exfil.evil.test");
        let (probe, ext) = crate::netstack::testkit::bridge(&hello, true);
        let dst: SocketAddr = "93.184.216.34:443".parse().unwrap();

        serve_outbound(name, crate::netstack::GUEST_IP, dst, ext, &Resolved::new());

        assert!(probe.aborted(), "denied flow must be reset");
        let events = crate::traffic::tail(name, 10);
        let deny = events
            .iter()
            .find(|e| e.decision == "deny")
            .expect("a deny event");
        assert_eq!(deny.host, "exfil.evil.test");
        assert_eq!(deny.port, 443);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unavailable_runtime_ca_aborts_and_logs_fail_closed() {
        crate::egress::with_runtime_test_root("ca-unavailable", |_root| {
            let name = "runtime-ca-unavailable-test";
            let vm_dir = crate::spec::VmPaths::for_name(name).dir;
            let _ = std::fs::remove_dir_all(&vm_dir);
            let _ = std::fs::remove_file(&vm_dir);
            std::fs::create_dir_all(vm_dir.parent().unwrap()).unwrap();
            // A regular file where the CA directory must be is a portable,
            // deterministic unwritable-directory failure.
            std::fs::write(&vm_dir, b"not a directory").unwrap();
            let context = runtime_context("journal-ca-failure");
            let (probe, ext) = crate::netstack::testkit::bridge(&[], true);
            assert!(inspection_configs(name, &context, "example.com", 443, &ext).is_err());
            assert!(probe.aborted());
            let events = crate::traffic::tail_runtime("journal-ca-failure", 10);
            let denied = events.last().expect("inspection failure log");
            assert_eq!(denied.decision, "deny");
            assert_eq!(denied.principal.as_deref(), Some("journal-ca-failure"));
            assert_eq!(denied.reason.as_deref(), Some("inspection-unavailable"));

            std::fs::remove_file(vm_dir).unwrap();
        });
    }

    #[test]
    fn cluster_cidr_names_resolve_through_default_deny() {
        // A `.svc` name reaching the classifier is treated as allowed
        // (excluded) — default-deny never touches intra-guest traffic.
        let p = policy(&[], false);
        let dst: SocketAddr = "10.43.0.1:80".parse().unwrap();
        // (is_excluded_ip would short-circuit in serve_outbound; here we
        // assert name exclusion via the HTTP path.)
        let head = b"GET / HTTP/1.1\r\nHost: kubernetes.default.svc\r\n\r\n";
        assert_eq!(
            decide(
                SocketAddr::from(([93, 184, 216, 34], 80)),
                head,
                true,
                &p,
                &Resolved::new()
            ),
            Decision::ForwardName {
                host: "kubernetes.default.svc".into(),
                port: 80,
                tls: false
            }
        );
        let _ = dst;
    }
}
