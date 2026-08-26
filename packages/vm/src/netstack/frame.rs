//! Raw Ethernet/IPv4 frame classification and synthesis for the
//! host-side netstack.
//!
//! This is the hostile-frame parser the brief flags as an **F1
//! acceptance gate** (docs/egress-firewall.md §8.1 #5): it ingests
//! attacker-controlled L2 frames straight off the guest's virtio-net,
//! so it MUST be bounded and panic-free on malformed/truncated/hostile
//! input. We lean on smoltcp's own *checked* wire parsers
//! (`*_checked`), which validate lengths and return `Err` rather than
//! ever indexing out of bounds — a malformed frame becomes [`Class::Drop`]
//! (or is handed to smoltcp, which drops it), never a panic.
//!
//! Classification decides, per frame, whether the netstack answers it
//! directly (DHCP, DNS), feeds it to the smoltcp interface (ARP + TCP,
//! which is where termination happens), or drops it (everything else —
//! ICMP, non-DNS UDP, IPv6, custom EtherTypes — the §8.1 #2 drop set).

use smoltcp::wire::{
    EthernetFrame, EthernetProtocol, IpProtocol, Ipv4Packet, TcpPacket, UdpPacket,
};
use std::net::Ipv4Addr;

/// What the engine should do with one received frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Class {
    /// A DHCP DISCOVER/REQUEST (UDP 68→67). The payload is the BOOTP
    /// message; the responder leases the deterministic address. Handled
    /// at the raw layer, never fed to smoltcp.
    Dhcp,
    /// A DNS query to the gateway resolver (UDP guest→gateway:53).
    /// Forwarded host-side; never fed to smoltcp.
    Dns {
        src_ip: Ipv4Addr,
        src_port: u16,
    },
    /// A TCP segment. `is_syn` marks a fresh connection attempt (SYN
    /// without ACK), which tells the engine to pre-create the listening
    /// socket before the frame reaches the interface. Either way the
    /// frame is fed to smoltcp, which terminates the flow.
    Tcp(TcpSegment),
    /// ARP (and anything else we want smoltcp to see): fed to the
    /// interface, which answers ARP for the gateway and ignores the rest.
    Passthrough,
    /// Malformed, truncated, non-IPv4/ARP, or in the explicit drop set
    /// (ICMP, non-DNS UDP, IPv6, custom EtherTypes). Never forwarded.
    Drop,
}

/// The connection-identifying tuple of a TCP segment, plus whether it
/// opens a new flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TcpSegment {
    pub src_ip: Ipv4Addr,
    pub src_port: u16,
    pub dst_ip: Ipv4Addr,
    pub dst_port: u16,
    pub is_syn: bool,
}

impl TcpSegment {
    /// The 4-tuple identifying this flow.
    pub fn tuple(&self) -> (Ipv4Addr, u16, Ipv4Addr, u16) {
        (self.src_ip, self.src_port, self.dst_ip, self.dst_port)
    }
}

/// Classify one raw Ethernet frame. Never panics: every structural
/// assumption is gated through a smoltcp `*_checked` constructor, so a
/// hostile or truncated frame falls through to [`Class::Drop`].
pub fn classify(frame: &[u8], gateway_ip: Ipv4Addr) -> Class {
    let Ok(eth) = EthernetFrame::new_checked(frame) else {
        return Class::Drop;
    };
    match eth.ethertype() {
        // ARP is the one non-IP thing we want the interface to answer
        // (the guest resolves the gateway MAC through it).
        EthernetProtocol::Arp => Class::Passthrough,
        EthernetProtocol::Ipv4 => classify_ipv4(eth.payload(), gateway_ip),
        // IPv6 / unknown EtherTypes are in the drop set (§8.1 #2): a v6
        // path must never silently bypass the v4 allowlist.
        _ => Class::Drop,
    }
}

fn classify_ipv4(payload: &[u8], gateway_ip: Ipv4Addr) -> Class {
    let Ok(ip) = Ipv4Packet::new_checked(payload) else {
        return Class::Drop;
    };
    let src_ip = ip.src_addr();
    let dst_ip = ip.dst_addr();
    // `payload()` on a checked packet is bounded by the validated header
    // length / total length, so the L4 slice can never run past the
    // frame.
    match ip.next_header() {
        IpProtocol::Udp => classify_udp(ip.payload(), src_ip, dst_ip, gateway_ip),
        IpProtocol::Tcp => match TcpPacket::new_checked(ip.payload()) {
            Ok(tcp) => Class::Tcp(TcpSegment {
                src_ip,
                src_port: tcp.src_port(),
                dst_ip,
                dst_port: tcp.dst_port(),
                // A connection-opening SYN carries no ACK; SYN-ACK and
                // mid-flow segments do, and need no fresh socket.
                is_syn: tcp.syn() && !tcp.ack(),
            }),
            Err(_) => Class::Drop,
        },
        // ICMP and every other L4 protocol: dropped.
        _ => Class::Drop,
    }
}

fn classify_udp(
    payload: &[u8],
    src_ip: Ipv4Addr,
    dst_ip: Ipv4Addr,
    gateway_ip: Ipv4Addr,
) -> Class {
    let Ok(udp) = UdpPacket::new_checked(payload) else {
        return Class::Drop;
    };
    let (src_port, dst_port) = (udp.src_port(), udp.dst_port());
    if src_port == DHCP_CLIENT_PORT && dst_port == DHCP_SERVER_PORT {
        Class::Dhcp
    } else if dst_ip == gateway_ip && dst_port == DNS_PORT {
        Class::Dns { src_ip, src_port }
    } else {
        // Non-DNS UDP (incl. QUIC on UDP/443, NTP) is dropped (§8.1 #2).
        Class::Drop
    }
}

/// Extract the UDP payload (the BOOTP/DHCP message or DNS query) from a
/// classified UDP frame. Bounded via the same checked parsers as
/// [`classify`]; `None` on anything that isn't a UDP/IPv4 Ethernet frame.
pub fn udp_payload(frame: &[u8]) -> Option<&[u8]> {
    // smoltcp's `payload()` accessors return the underlying *buffer*
    // lifetime (the input `frame`), not a borrow of the temporary packet
    // wrappers, so the returned slice outlives them.
    let eth = EthernetFrame::new_checked(frame).ok()?;
    if eth.ethertype() != EthernetProtocol::Ipv4 {
        return None;
    }
    let ip = Ipv4Packet::new_checked(eth.payload()).ok()?;
    if ip.next_header() != IpProtocol::Udp {
        return None;
    }
    let udp = UdpPacket::new_checked(ip.payload()).ok()?;
    Some(udp.payload())
}

pub const DHCP_SERVER_PORT: u16 = 67;
pub const DHCP_CLIENT_PORT: u16 = 68;
pub const DNS_PORT: u16 = 53;

const ETH_HEADER_LEN: usize = 14;
const IPV4_HEADER_LEN: usize = 20;
const UDP_HEADER_LEN: usize = 8;

/// The one-datagram-per-frame UDP/IPv4/Ethernet packet the netstack
/// emits for its DHCP and DNS replies. Builds a complete L2 frame with
/// correct IPv4 and UDP checksums (the guest's stack *does* verify
/// these on the receive path, unlike our offload-tolerant RX). Returned
/// as a single `Vec` so the caller can `send()` it as one datagram.
pub fn build_udp_ipv4(
    dst_mac: [u8; 6],
    src_mac: [u8; 6],
    src_ip: Ipv4Addr,
    dst_ip: Ipv4Addr,
    src_port: u16,
    dst_port: u16,
    udp_payload: &[u8],
) -> Vec<u8> {
    let total_ip_len = IPV4_HEADER_LEN + UDP_HEADER_LEN + udp_payload.len();
    let mut buf = Vec::with_capacity(ETH_HEADER_LEN + total_ip_len);

    // --- Ethernet header ---
    buf.extend_from_slice(&dst_mac);
    buf.extend_from_slice(&src_mac);
    buf.extend_from_slice(&[0x08, 0x00]); // EtherType IPv4

    // --- IPv4 header ---
    let ip_start = buf.len();
    buf.push(0x45); // version 4, IHL 5 (no options)
    buf.push(0x00); // DSCP/ECN
    buf.extend_from_slice(&(total_ip_len as u16).to_be_bytes());
    buf.extend_from_slice(&[0x00, 0x00]); // identification
    buf.extend_from_slice(&[0x00, 0x00]); // flags + fragment offset
    buf.push(64); // TTL
    buf.push(17); // protocol UDP
    buf.extend_from_slice(&[0x00, 0x00]); // checksum placeholder
    buf.extend_from_slice(&src_ip.octets());
    buf.extend_from_slice(&dst_ip.octets());
    let ip_checksum = checksum(&buf[ip_start..ip_start + IPV4_HEADER_LEN], 0);
    buf[ip_start + 10..ip_start + 12].copy_from_slice(&ip_checksum.to_be_bytes());

    // --- UDP header ---
    let udp_start = buf.len();
    let udp_len = (UDP_HEADER_LEN + udp_payload.len()) as u16;
    buf.extend_from_slice(&src_port.to_be_bytes());
    buf.extend_from_slice(&dst_port.to_be_bytes());
    buf.extend_from_slice(&udp_len.to_be_bytes());
    buf.extend_from_slice(&[0x00, 0x00]); // checksum placeholder
    buf.extend_from_slice(udp_payload);

    // UDP checksum covers a pseudo-header (src/dst IP, protocol, UDP
    // length) plus the UDP header and payload.
    let mut pseudo = 0u32;
    pseudo += sum_words(&src_ip.octets());
    pseudo += sum_words(&dst_ip.octets());
    pseudo += 17; // protocol
    pseudo += udp_len as u32;
    let udp_checksum = checksum(&buf[udp_start..], pseudo);
    // A computed UDP checksum of 0 is transmitted as 0xffff (RFC 768).
    let udp_checksum = if udp_checksum == 0 { 0xffff } else { udp_checksum };
    buf[udp_start + 6..udp_start + 8].copy_from_slice(&udp_checksum.to_be_bytes());

    buf
}

/// Sum a byte slice as big-endian 16-bit words (odd trailing byte
/// padded with zero), folded into a 32-bit accumulator.
fn sum_words(data: &[u8]) -> u32 {
    let mut sum = 0u32;
    let (chunks, remainder) = data.as_chunks::<2>();
    for c in chunks {
        sum += u16::from_be_bytes(*c) as u32;
    }
    if let [last] = remainder {
        sum += (*last as u32) << 8;
    }
    sum
}

/// One's-complement Internet checksum over `data`, seeded with the
/// already-summed `initial` (e.g. a UDP pseudo-header).
fn checksum(data: &[u8], initial: u32) -> u16 {
    let mut sum = initial + sum_words(data);
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GW: Ipv4Addr = Ipv4Addr::new(192, 168, 127, 1);
    const GUEST: Ipv4Addr = Ipv4Addr::new(192, 168, 127, 2);

    fn eth(ethertype: [u8; 2], payload: &[u8]) -> Vec<u8> {
        let mut f = Vec::new();
        f.extend_from_slice(&[0xff; 6]); // dst
        f.extend_from_slice(&[0x02, 0, 0, 0, 0, 1]); // src
        f.extend_from_slice(&ethertype);
        f.extend_from_slice(payload);
        f
    }

    // --- robustness: the F1 hostile-frame gate -----------------------

    #[test]
    fn empty_and_runt_frames_drop_without_panic() {
        assert_eq!(classify(&[], GW), Class::Drop);
        for len in 1..14 {
            assert_eq!(classify(&vec![0u8; len], GW), Class::Drop, "len {len}");
        }
    }

    #[test]
    fn ipv4_header_claims_more_than_present_drops() {
        // EtherType IPv4 but only a few payload bytes — new_checked must
        // reject it rather than read past the buffer.
        for n in 0..20 {
            let f = eth([0x08, 0x00], &vec![0x45u8; n]);
            assert_eq!(classify(&f, GW), Class::Drop, "ipv4 payload {n}");
        }
    }

    #[test]
    fn truncated_tcp_and_udp_headers_drop() {
        // A valid-ish IPv4 header announcing TCP/UDP but with a stub L4
        // header must not panic.
        for proto in [6u8 /*tcp*/, 17 /*udp*/] {
            for l4 in 0..8 {
                let mut ip = vec![0u8; 20 + l4];
                ip[0] = 0x45;
                let total = (20 + l4) as u16;
                ip[2..4].copy_from_slice(&total.to_be_bytes());
                ip[9] = proto;
                ip[12..16].copy_from_slice(&GUEST.octets());
                ip[16..20].copy_from_slice(&GW.octets());
                let f = eth([0x08, 0x00], &ip);
                let c = classify(&f, GW);
                assert!(matches!(c, Class::Drop), "proto {proto} l4 {l4} -> {c:?}");
            }
        }
    }

    #[test]
    fn fuzz_random_frames_never_panic() {
        // Deterministic pseudo-random frames of every length: the only
        // contract is "returns a Class, never panics".
        let mut seed = 0x9e3779b97f4a7c15u64;
        for _ in 0..20_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let len = (seed as usize) % 1600;
            let frame: Vec<u8> = (0..len)
                .map(|i| (seed.rotate_left(i as u32 % 64) & 0xff) as u8)
                .collect();
            let _ = classify(&frame, GW);
        }
    }

    #[test]
    fn ipv6_and_unknown_ethertypes_drop() {
        assert_eq!(classify(&eth([0x86, 0xdd], &[0u8; 60]), GW), Class::Drop);
        assert_eq!(classify(&eth([0x12, 0x34], &[0u8; 60]), GW), Class::Drop);
    }

    #[test]
    fn arp_is_passthrough() {
        assert_eq!(classify(&eth([0x08, 0x06], &[0u8; 28]), GW), Class::Passthrough);
    }

    // --- classification of well-formed traffic -----------------------

    fn ipv4_udp(src_ip: Ipv4Addr, dst_ip: Ipv4Addr, src_port: u16, dst_port: u16, body: &[u8]) -> Vec<u8> {
        // Reuse the builder, then strip the Ethernet header to feed the
        // IPv4 portion under a fresh Ethernet wrapper in the test.
        let full = build_udp_ipv4([0xff; 6], [0x02, 0, 0, 0, 0, 1], src_ip, dst_ip, src_port, dst_port, body);
        full[14..].to_vec()
    }

    #[test]
    fn dhcp_discover_is_recognised() {
        let f = eth([0x08, 0x00], &ipv4_udp(Ipv4Addr::UNSPECIFIED, Ipv4Addr::BROADCAST, 68, 67, &[0u8; 240]));
        assert_eq!(classify(&f, GW), Class::Dhcp);
    }

    #[test]
    fn dns_to_gateway_is_recognised_but_not_elsewhere() {
        let to_gw = eth([0x08, 0x00], &ipv4_udp(GUEST, GW, 5353, 53, &[0u8; 12]));
        assert_eq!(classify(&to_gw, GW), Class::Dns { src_ip: GUEST, src_port: 5353 });
        // DNS to anything but the gateway is not our resolver → dropped
        // (no guest-steerable UDP passthrough).
        let elsewhere = eth([0x08, 0x00], &ipv4_udp(GUEST, Ipv4Addr::new(8, 8, 8, 8), 5353, 53, &[0u8; 12]));
        assert_eq!(classify(&elsewhere, GW), Class::Drop);
    }

    #[test]
    fn non_dns_udp_drops() {
        // e.g. NTP/123 to the gateway.
        let f = eth([0x08, 0x00], &ipv4_udp(GUEST, GW, 40000, 123, &[0u8; 48]));
        assert_eq!(classify(&f, GW), Class::Drop);
    }

    fn ipv4_tcp(dst_ip: Ipv4Addr, dst_port: u16, syn: bool, ack: bool) -> Vec<u8> {
        let mut ip = vec![0u8; 20 + 20];
        ip[0] = 0x45;
        ip[2..4].copy_from_slice(&40u16.to_be_bytes());
        ip[9] = 6; // tcp
        ip[12..16].copy_from_slice(&GUEST.octets());
        ip[16..20].copy_from_slice(&dst_ip.octets());
        // TCP header at offset 20.
        ip[20..22].copy_from_slice(&44444u16.to_be_bytes()); // src port
        ip[22..24].copy_from_slice(&dst_port.to_be_bytes());
        ip[32] = 0x50; // data offset 5 words
        let mut flags = 0u8;
        if syn {
            flags |= 0x02;
        }
        if ack {
            flags |= 0x10;
        }
        ip[33] = flags;
        eth([0x08, 0x00], &ip)
    }

    #[test]
    fn tcp_syn_and_midflow_classified() {
        let dst = Ipv4Addr::new(140, 82, 121, 3);
        let syn = classify(&ipv4_tcp(dst, 443, true, false), GW);
        assert_eq!(
            syn,
            Class::Tcp(TcpSegment { src_ip: GUEST, src_port: 44444, dst_ip: dst, dst_port: 443, is_syn: true })
        );
        // SYN-ACK and plain ACK are mid-flow, not new flows.
        let synack = classify(&ipv4_tcp(dst, 443, true, true), GW);
        assert!(matches!(synack, Class::Tcp(TcpSegment { is_syn: false, .. })));
        let ack = classify(&ipv4_tcp(dst, 443, false, true), GW);
        assert!(matches!(ack, Class::Tcp(TcpSegment { is_syn: false, .. })));
    }

    // --- checksum correctness: cross-checked against smoltcp ----------

    #[test]
    fn built_udp_frame_has_valid_checksums() {
        let frame = build_udp_ipv4(
            [0x52, 0x54, 0, 0, 0, 2],
            [0x5a, 0x41, 0x50, 0x50, 0, 1],
            GW,
            GUEST,
            53,
            5353,
            b"hello dns payload",
        );
        // smoltcp validates our hand-rolled IPv4 + UDP checksums.
        let eth = EthernetFrame::new_checked(&frame).unwrap();
        assert_eq!(eth.ethertype(), EthernetProtocol::Ipv4);
        let ip = Ipv4Packet::new_checked(eth.payload()).unwrap();
        assert!(ip.verify_checksum(), "IPv4 header checksum");
        assert_eq!(ip.src_addr(), GW);
        assert_eq!(ip.dst_addr(), GUEST);
        let udp = UdpPacket::new_checked(ip.payload()).unwrap();
        assert!(udp.verify_checksum(&smoltcp::wire::IpAddress::Ipv4(GW), &smoltcp::wire::IpAddress::Ipv4(GUEST)), "UDP checksum");
        assert_eq!(udp.src_port(), 53);
        assert_eq!(udp.dst_port(), 5353);
    }

    #[test]
    fn built_udp_frame_zero_length_payload_is_valid() {
        let frame = build_udp_ipv4([0xff; 6], [0x02, 0, 0, 0, 0, 1], GW, GUEST, 67, 68, &[]);
        let eth = EthernetFrame::new_checked(&frame).unwrap();
        let ip = Ipv4Packet::new_checked(eth.payload()).unwrap();
        assert!(ip.verify_checksum());
        let udp = UdpPacket::new_checked(ip.payload()).unwrap();
        assert!(udp.verify_checksum(&smoltcp::wire::IpAddress::Ipv4(GW), &smoltcp::wire::IpAddress::Ipv4(GUEST)));
    }
}
