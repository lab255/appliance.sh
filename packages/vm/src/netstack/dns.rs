//! A forwarding DNS resolver for the guest.
//!
//! With NAT gone the framework no longer answers DNS, so the netstack
//! does: it listens at the gateway (`.1:53`) and forwards the guest's
//! query to the host's real resolver, returning the answer verbatim.
//!
//! **F2 — the boundary.** The resolver is now a defense-in-depth + UX
//! layer in front of the hard TCP boundary (docs/egress-firewall.md §3):
//!
//!   * [`name_allowed`] applies the VM's effective default-deny policy to
//!     the queried name — a non-allowlisted name gets no answer (it fails
//!     fast and legibly instead of as an opaque TCP timeout).
//!   * [`answer_ok_and_record`] is the **§8.1 #1 anti-SSRF filter**: it
//!     drops any answer that resolves into a private/internal/host-LAN
//!     range (so an allowlisted name that resolves internal ⇒ DENIED, not
//!     forwarded — closing the DNS-rebinding pivot into the operator's
//!     LAN), and records the *public* answers so a later raw-IP connect
//!     can be back-referenced to the allowlisted name (§4a).
//!
//! We forward only to the host's own resolvers (local DNS), never to a
//! guest-steerable address — the classifier already drops any UDP/53 not
//! aimed at the gateway, so there is no guest-steerable passthrough.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::time::Duration;

use super::guard::{self, Resolved};
use crate::egress::EgressPolicy;

/// Upstream lookups are bounded so a slow/hostile resolver can neither
/// stall the netstack nor serve as an internal-host timing oracle (#1).
pub const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(5);

/// Does the VM's effective (default-deny + baked allowlist) policy admit
/// this queried name? Fail-closed: an unparseable / absent QNAME is
/// denied. Cluster/loopback names (`.svc`, `localhost`, …) are excluded
/// from policing and always allowed.
pub fn name_allowed(name: &Option<String>, policy: &EgressPolicy) -> bool {
    match name {
        Some(n) => guard::name_is_allowed(n, policy),
        None => false,
    }
}

/// §8.1 #1 — vet a resolved answer before it reaches the guest. Returns
/// `false` (⇒ drop the whole answer) if **any** A/AAAA record points at a
/// private/internal/host-LAN target; otherwise records the public answers
/// in the back-reference set and returns `true`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn answer_ok_and_record(resp: &[u8], resolved: &Resolved) -> bool {
    answer_ok_and_record_for(resp, resolved, "vm", None)
}

pub fn answer_ok_and_record_for(
    resp: &[u8],
    resolved: &Resolved,
    principal: &str,
    ports: Option<&[u16]>,
) -> bool {
    let ips = answer_ips(resp);
    if ips.iter().any(|ip| guard::is_forbidden_target(*ip)) {
        return false;
    }
    for ip in ips {
        match ports {
            Some(ports) => {
                for port in ports {
                    resolved.insert_for_port(principal, ip, Some(*port));
                }
            }
            None => resolved.insert_for(principal, ip),
        }
    }
    true
}

/// Extract every A (type 1) and AAAA (type 28) address from a DNS
/// response's answer section. Bounded and panic-free on hostile input —
/// it is in the data path a release before fuzzing (§8.1 #5).
pub fn answer_ips(resp: &[u8]) -> Vec<IpAddr> {
    let mut ips = Vec::new();
    if resp.len() < 12 {
        return ips;
    }
    let qd = u16::from_be_bytes([resp[4], resp[5]]) as usize;
    let an = u16::from_be_bytes([resp[6], resp[7]]) as usize;
    let mut p = 12usize;
    for _ in 0..qd.min(64) {
        p = match skip_name(resp, p) {
            Some(x) => x,
            None => return ips,
        };
        // QTYPE(2) + QCLASS(4) ... actually QTYPE(2)+QCLASS(2) = 4 bytes.
        match p.checked_add(4) {
            Some(x) if x <= resp.len() => p = x,
            _ => return ips,
        }
    }
    for _ in 0..an.min(256) {
        p = match skip_name(resp, p) {
            Some(x) => x,
            None => return ips,
        };
        if p + 10 > resp.len() {
            return ips;
        }
        let rtype = u16::from_be_bytes([resp[p], resp[p + 1]]);
        let rdlen = u16::from_be_bytes([resp[p + 8], resp[p + 9]]) as usize;
        let rd = p + 10;
        let end = match rd.checked_add(rdlen) {
            Some(x) if x <= resp.len() => x,
            _ => return ips,
        };
        match (rtype, rdlen) {
            (1, 4) => ips.push(IpAddr::V4(Ipv4Addr::new(
                resp[rd],
                resp[rd + 1],
                resp[rd + 2],
                resp[rd + 3],
            ))),
            (28, 16) => {
                let mut o = [0u8; 16];
                o.copy_from_slice(&resp[rd..end]);
                ips.push(IpAddr::V6(Ipv6Addr::from(o)));
            }
            _ => {}
        }
        p = end;
    }
    ips
}

/// Step over a (possibly compressed) DNS name, returning the offset just
/// past it. A compression pointer terminates the name in 2 bytes; a label
/// sequence ends at the zero length octet. Bounded; `None` on malformed.
fn skip_name(buf: &[u8], mut p: usize) -> Option<usize> {
    for _ in 0..128 {
        let len = *buf.get(p)? as usize;
        if len == 0 {
            return Some(p + 1);
        }
        if len & 0xc0 == 0xc0 {
            return p.checked_add(2).filter(|&x| x <= buf.len());
        }
        if len & 0xc0 != 0 {
            return None; // reserved label type
        }
        p = p.checked_add(1 + len)?;
        if p > buf.len() {
            return None;
        }
    }
    None
}

/// The host's configured resolvers, parsed from `/etc/resolv.conf`
/// (`nameserver <ip>` lines). Falls back to a public resolver only when
/// the file names none, so the guest always has working DNS.
pub fn system_resolvers() -> Vec<SocketAddr> {
    let mut out = Vec::new();
    if let Ok(conf) = std::fs::read_to_string("/etc/resolv.conf") {
        for line in conf.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("nameserver") {
                if let Ok(ip) = rest.trim().parse::<std::net::IpAddr>() {
                    out.push(SocketAddr::new(ip, 53));
                }
            }
        }
    }
    if out.is_empty() {
        out.push(SocketAddr::new(Ipv4Addr::new(1, 1, 1, 1).into(), 53));
    }
    out
}

/// Forward one query to the first responsive upstream and return its
/// raw response. Bounded by [`UPSTREAM_TIMEOUT`]; `None` if no upstream
/// answers in time. Each call uses its own ephemeral socket so concurrent
/// queries can't cross responses.
pub fn forward(query: &[u8], upstreams: &[SocketAddr], timeout: Duration) -> Option<Vec<u8>> {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    sock.set_read_timeout(Some(timeout)).ok()?;
    for up in upstreams {
        if sock.send_to(query, up).is_err() {
            continue;
        }
        let mut buf = vec![0u8; 4096];
        match sock.recv_from(&mut buf) {
            Ok((n, from)) if from.ip() == up.ip() && n >= 2 => {
                // Match the transaction id so a stray datagram can't be
                // mistaken for this query's answer.
                if n >= 2 && query.len() >= 2 && buf[0..2] == query[0..2] {
                    buf.truncate(n);
                    return Some(buf);
                }
            }
            _ => continue,
        }
    }
    None
}

/// Extract the first question's QNAME (dotted, lowercased) for logging
/// and the F2 allowlist check. Bounded and panic-free; compression
/// pointers are not followed (a query's QNAME is never compressed).
pub fn query_name(query: &[u8]) -> Option<String> {
    // Header is 12 bytes; the first question's labels start at 12.
    if query.len() < 12 {
        return None;
    }
    let mut i = 12usize;
    let mut labels: Vec<String> = Vec::new();
    loop {
        let len = *query.get(i)? as usize;
        if len == 0 {
            break;
        }
        // 0xC0 top bits mark a compression pointer — not expected in a
        // question; bail rather than chase it.
        if len & 0xC0 != 0 {
            return None;
        }
        let start = i + 1;
        let end = start.checked_add(len)?;
        if end > query.len() || labels.len() > 127 {
            return None;
        }
        labels.push(String::from_utf8_lossy(&query[start..end]).to_ascii_lowercase());
        i = end;
    }
    if labels.is_empty() {
        None
    } else {
        Some(labels.join("."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `example.com` A query (id 0x1234).
    fn example_query() -> Vec<u8> {
        let mut q = vec![0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
        for label in ["example", "com"] {
            q.push(label.len() as u8);
            q.extend_from_slice(label.as_bytes());
        }
        q.push(0); // root
        q.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]); // QTYPE A, QCLASS IN
        q
    }

    #[test]
    fn extracts_query_name() {
        assert_eq!(query_name(&example_query()).as_deref(), Some("example.com"));
    }

    #[test]
    fn query_name_bounded_on_garbage() {
        assert_eq!(query_name(&[]), None);
        assert_eq!(query_name(&[0u8; 5]), None);
        // A label length running past the end yields None, not a panic.
        let mut q = vec![0u8; 12];
        q.push(200); // claims 200 bytes
        q.extend_from_slice(b"short");
        assert_eq!(query_name(&q), None);
        // A compression pointer in the question is refused.
        let mut q = vec![0u8; 12];
        q.push(0xC0);
        q.push(0x0C);
        assert_eq!(query_name(&q), None);
    }

    #[test]
    fn fuzz_query_name_never_panics() {
        let mut seed = 0xb5297a4d_u64;
        for _ in 0..10_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let len = (seed as usize) % 300;
            let q: Vec<u8> = (0..len).map(|i| (seed >> (i % 56)) as u8).collect();
            let _ = query_name(&q);
        }
    }

    #[test]
    fn forward_relays_to_a_mock_upstream() {
        // Stand up a tiny UDP "resolver" that echoes the query id + a
        // canned answer, then prove forward() round-trips through it.
        let upstream = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = upstream.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut buf = [0u8; 1500];
            let (n, peer) = upstream.recv_from(&mut buf).unwrap();
            // Reply: echo the 2-byte id, set the response bit, append a marker.
            let mut resp = buf[..n].to_vec();
            resp[2] |= 0x80;
            resp.extend_from_slice(b"ANSWER");
            upstream.send_to(&resp, peer).unwrap();
        });

        let resp = forward(&example_query(), &[addr], UPSTREAM_TIMEOUT).expect("a response");
        assert_eq!(&resp[0..2], &[0x12, 0x34], "transaction id echoed");
        assert!(resp.ends_with(b"ANSWER"));
        server.join().unwrap();
    }

    /// Build a DNS response for `example.com` carrying the given A/AAAA
    /// answers (compressed name pointer to the question at offset 12).
    fn response_with(ips: &[IpAddr]) -> Vec<u8> {
        let mut r = vec![0x12, 0x34, 0x81, 0x80]; // id, QR+RD+RA
        r.extend_from_slice(&1u16.to_be_bytes()); // qdcount
        r.extend_from_slice(&(ips.len() as u16).to_be_bytes()); // ancount
        r.extend_from_slice(&[0, 0, 0, 0]); // ns + ar counts
        for label in ["example", "com"] {
            r.push(label.len() as u8);
            r.extend_from_slice(label.as_bytes());
        }
        r.push(0);
        r.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]); // QTYPE A, QCLASS IN
        for ip in ips {
            r.extend_from_slice(&[0xc0, 0x0c]); // name → question
            match ip {
                IpAddr::V4(v4) => {
                    r.extend_from_slice(&1u16.to_be_bytes()); // type A
                    r.extend_from_slice(&1u16.to_be_bytes()); // class IN
                    r.extend_from_slice(&60u32.to_be_bytes()); // ttl
                    r.extend_from_slice(&4u16.to_be_bytes()); // rdlength
                    r.extend_from_slice(&v4.octets());
                }
                IpAddr::V6(v6) => {
                    r.extend_from_slice(&28u16.to_be_bytes()); // type AAAA
                    r.extend_from_slice(&1u16.to_be_bytes());
                    r.extend_from_slice(&60u32.to_be_bytes());
                    r.extend_from_slice(&16u16.to_be_bytes());
                    r.extend_from_slice(&v6.octets());
                }
            }
        }
        r
    }

    #[test]
    fn answer_ips_parses_a_and_aaaa() {
        let ips = vec![
            "93.184.216.34".parse().unwrap(),
            "2606:2800:220:1:248:1893:25c8:1946".parse().unwrap(),
        ];
        assert_eq!(answer_ips(&response_with(&ips)), ips);
    }

    #[test]
    fn answer_filter_drops_private_resolving_answer() {
        // §8.1 #1: an answer that resolves into a private range is dropped
        // wholesale (DNS-rebinding into the operator's LAN ⇒ DENIED),
        // and nothing is recorded for the back-reference hatch.
        let resolved = Resolved::new();
        let private = response_with(&["10.0.0.5".parse().unwrap()]);
        assert!(!answer_ok_and_record(&private, &resolved));
        assert!(!resolved.contains_fresh("10.0.0.5".parse().unwrap()));

        // A mixed answer with even one forbidden record is rejected.
        let mixed = response_with(&[
            "93.184.216.34".parse().unwrap(),
            "192.168.1.9".parse().unwrap(),
        ]);
        assert!(!answer_ok_and_record(&mixed, &resolved));
        assert!(!resolved.contains_fresh("93.184.216.34".parse().unwrap()));
    }

    #[test]
    fn answer_filter_records_public_answers() {
        // A fully-public answer passes and seeds the back-reference set so
        // a later raw-IP connect to that address can be admitted (§4a).
        let resolved = Resolved::new();
        let public = response_with(&["93.184.216.34".parse().unwrap()]);
        assert!(answer_ok_and_record(&public, &resolved));
        assert!(resolved.contains_fresh("93.184.216.34".parse().unwrap()));
    }

    #[test]
    fn fuzz_answer_ips_never_panics() {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        for _ in 0..20_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let len = (seed as usize) % 400;
            let f: Vec<u8> = (0..len).map(|i| (seed >> (i % 56)) as u8).collect();
            let _ = answer_ips(&f);
        }
    }

    #[test]
    fn name_allowed_honors_default_deny() {
        // Netstack default-deny: an allowlisted name resolves, a
        // non-allowlisted one gets no answer, an absent QNAME fails closed.
        let policy = EgressPolicy {
            default: crate::egress::Action::Deny,
            allow: vec!["api.anthropic.com".into()],
            deny: vec![],
            mitm: false,
        };
        assert!(name_allowed(&Some("api.anthropic.com".into()), &policy));
        assert!(!name_allowed(&Some("evil.test".into()), &policy));
        assert!(!name_allowed(&None, &policy));
        // Cluster/loopback names are excluded from policing.
        assert!(name_allowed(
            &Some("kubernetes.default.svc".into()),
            &policy
        ));
    }

    #[test]
    fn forward_times_out_when_no_upstream_answers() {
        // A bound-but-silent socket: forward() must give up, not hang
        // forever. Use a very short window via a black-hole port.
        let black_hole = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let addr = black_hole.local_addr().unwrap();
        drop(black_hole); // nothing listening now
        let started = std::time::Instant::now();
        // A short timeout bounds the wait; the call must give up (None),
        // never hang.
        let out = forward(&example_query(), &[addr], Duration::from_millis(150));
        assert!(out.is_none());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "forward must respect the timeout"
        );
    }
}
