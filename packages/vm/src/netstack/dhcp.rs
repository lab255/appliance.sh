//! A single-client DHCP responder.
//!
//! With the framework NAT gone, nothing leases the guest an address —
//! the netstack does. Because we *assign* the lease, the guest IP is
//! known deterministically the instant it is handed out (indeed
//! a-priori, per VM). This replaces the `/var/db/dhcpd_leases` scrape
//! entirely (docs/egress-firewall.md): no plist parsing, no 120 s
//! poll, no MAC-lookup race.
//!
//! Only the bytes are here (parse a DISCOVER/REQUEST, build an
//! OFFER/ACK BOOTP message). Wrapping the reply in UDP/IPv4/Ethernet and
//! putting it on the wire is the engine's job ([`super::frame::build_udp_ipv4`]).

use std::net::Ipv4Addr;

/// Fixed BOOTP layout offsets (RFC 951 / RFC 2131).
const OP: usize = 0;
const XID: usize = 4;
const FLAGS: usize = 10;
const CHADDR: usize = 28;
const MAGIC_COOKIE: usize = 236;
const OPTIONS: usize = 240;

const MAGIC: [u8; 4] = [99, 130, 83, 99];

const OP_REQUEST: u8 = 1;
const OP_REPLY: u8 = 2;

// DHCP option 53 (message type) values.
const DHCPDISCOVER: u8 = 1;
const DHCPOFFER: u8 = 2;
const DHCPREQUEST: u8 = 3;
const DHCPACK: u8 = 5;

/// The lease parameters the responder hands the guest. Deterministic
/// per VM: gateway/server/DNS all collapse to the netstack's gateway
/// address on the chosen `/24`.
#[derive(Debug, Clone, Copy)]
pub struct Lease {
    pub guest_ip: Ipv4Addr,
    pub gateway_ip: Ipv4Addr,
    pub netmask: Ipv4Addr,
    /// Lease time in seconds.
    pub lease_secs: u32,
}

/// What the guest asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Discover,
    Request,
}

/// A parsed DHCP request we should answer.
#[derive(Debug, Clone)]
pub struct Request {
    pub kind: Kind,
    pub xid: [u8; 4],
    pub flags: [u8; 2],
    pub chaddr: [u8; 6],
}

/// Parse a BOOTP/DHCP message from the guest, returning the request to
/// answer (DISCOVER → OFFER, REQUEST → ACK). Anything else — a reply,
/// an INFORM/RELEASE, a truncated or non-DHCP datagram — returns `None`
/// and is ignored. Bounded and panic-free on hostile input.
pub fn parse(payload: &[u8]) -> Option<Request> {
    // Must reach at least the start of the options and carry the magic
    // cookie, or it isn't a DHCP message.
    if payload.len() < OPTIONS || payload[OP] != OP_REQUEST {
        return None;
    }
    if payload[MAGIC_COOKIE..MAGIC_COOKIE + 4] != MAGIC {
        return None;
    }

    let kind = match option(payload, 53)? {
        [DHCPDISCOVER] => Kind::Discover,
        [DHCPREQUEST] => Kind::Request,
        _ => return None,
    };

    let mut xid = [0u8; 4];
    xid.copy_from_slice(&payload[XID..XID + 4]);
    let mut flags = [0u8; 2];
    flags.copy_from_slice(&payload[FLAGS..FLAGS + 2]);
    let mut chaddr = [0u8; 6];
    chaddr.copy_from_slice(&payload[CHADDR..CHADDR + 6]);

    Some(Request { kind, xid, flags, chaddr })
}

/// Walk the option TLVs after the magic cookie and return the value of
/// option `code`. Bounded: a length that would run off the end stops
/// the walk rather than reading past it.
fn option(payload: &[u8], code: u8) -> Option<&[u8]> {
    let mut i = OPTIONS;
    while i < payload.len() {
        let opt = payload[i];
        if opt == 255 {
            break; // end
        }
        if opt == 0 {
            i += 1; // pad
            continue;
        }
        let len = *payload.get(i + 1)? as usize;
        let start = i + 2;
        let end = start.checked_add(len)?;
        if end > payload.len() {
            break;
        }
        if opt == code {
            return Some(&payload[start..end]);
        }
        i = end;
    }
    None
}

/// Build the BOOTP reply message (OFFER for a DISCOVER, ACK for a
/// REQUEST) leasing `lease` to the requesting client.
pub fn build_reply(req: &Request, lease: &Lease) -> Vec<u8> {
    let msg_type = match req.kind {
        Kind::Discover => DHCPOFFER,
        Kind::Request => DHCPACK,
    };

    let mut m = vec![0u8; OPTIONS];
    m[OP] = OP_REPLY;
    m[1] = 1; // htype: ethernet
    m[2] = 6; // hlen
                  // hops (3) = 0
    m[XID..XID + 4].copy_from_slice(&req.xid);
    // secs (8..10) = 0
    m[FLAGS..FLAGS + 2].copy_from_slice(&req.flags);
    // ciaddr (12..16) = 0
    m[16..20].copy_from_slice(&lease.guest_ip.octets()); // yiaddr
    m[20..24].copy_from_slice(&lease.gateway_ip.octets()); // siaddr (next server)
                                                           // giaddr (24..28) = 0
    m[CHADDR..CHADDR + 6].copy_from_slice(&req.chaddr);
    m[MAGIC_COOKIE..MAGIC_COOKIE + 4].copy_from_slice(&MAGIC);

    // Options.
    m.extend_from_slice(&[53, 1, msg_type]); // message type
    m.extend_from_slice(&[54, 4]); // server identifier
    m.extend_from_slice(&lease.gateway_ip.octets());
    m.extend_from_slice(&[51, 4]); // lease time
    m.extend_from_slice(&lease.lease_secs.to_be_bytes());
    m.extend_from_slice(&[1, 4]); // subnet mask
    m.extend_from_slice(&lease.netmask.octets());
    m.extend_from_slice(&[3, 4]); // router
    m.extend_from_slice(&lease.gateway_ip.octets());
    m.extend_from_slice(&[6, 4]); // DNS server
    m.extend_from_slice(&lease.gateway_ip.octets());
    m.push(255); // end

    m
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEASE: Lease = Lease {
        guest_ip: Ipv4Addr::new(192, 168, 127, 2),
        gateway_ip: Ipv4Addr::new(192, 168, 127, 1),
        netmask: Ipv4Addr::new(255, 255, 255, 0),
        lease_secs: 86_400,
    };

    fn discover(mac: [u8; 6], msg_type: u8) -> Vec<u8> {
        let mut p = vec![0u8; OPTIONS];
        p[OP] = OP_REQUEST;
        p[XID..XID + 4].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        p[FLAGS] = 0x80; // broadcast flag
        p[CHADDR..CHADDR + 6].copy_from_slice(&mac);
        p[MAGIC_COOKIE..MAGIC_COOKIE + 4].copy_from_slice(&MAGIC);
        p.extend_from_slice(&[53, 1, msg_type]);
        p.push(255);
        p
    }

    #[test]
    fn parses_discover_and_request() {
        let mac = [0x52, 0x54, 0, 1, 2, 3];
        let d = parse(&discover(mac, DHCPDISCOVER)).unwrap();
        assert_eq!(d.kind, Kind::Discover);
        assert_eq!(d.xid, [0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(d.flags, [0x80, 0x00]);
        assert_eq!(d.chaddr, mac);

        let r = parse(&discover(mac, DHCPREQUEST)).unwrap();
        assert_eq!(r.kind, Kind::Request);
    }

    #[test]
    fn rejects_non_dhcp_and_truncated() {
        // Too short for the options/cookie.
        assert!(parse(&[0u8; 10]).is_none());
        assert!(parse(&[]).is_none());
        // Right length but no magic cookie.
        let mut p = vec![0u8; OPTIONS];
        p[OP] = OP_REQUEST;
        assert!(parse(&p).is_none());
        // A BOOTREPLY (op 2) is not a request to answer.
        let mut reply = discover([0; 6], DHCPDISCOVER);
        reply[OP] = OP_REPLY;
        assert!(parse(&reply).is_none());
    }

    #[test]
    fn option_walk_is_bounded_on_hostile_lengths() {
        // An option claiming a length that overflows the buffer must not
        // panic or read past the end.
        let mut p = vec![0u8; OPTIONS];
        p[OP] = OP_REQUEST;
        p[MAGIC_COOKIE..MAGIC_COOKIE + 4].copy_from_slice(&MAGIC);
        p.extend_from_slice(&[53, 250, 1]); // claims 250 bytes, only 1 present
        assert!(parse(&p).is_none()); // walk stops, msg-type unresolved
    }

    #[test]
    fn discover_yields_offer_request_yields_ack() {
        let mac = [0x52, 0x54, 0, 1, 2, 3];
        let d = parse(&discover(mac, DHCPDISCOVER)).unwrap();
        let offer = build_reply(&d, &LEASE);
        assert_eq!(offer[OP], OP_REPLY);
        assert_eq!(offer[XID..XID + 4], [0xde, 0xad, 0xbe, 0xef]);
        // yiaddr is the leased address; chaddr echoes the client MAC.
        assert_eq!(offer[16..20], LEASE.guest_ip.octets());
        assert_eq!(offer[CHADDR..CHADDR + 6], mac);
        assert_eq!(option(&offer, 53), Some(&[DHCPOFFER][..]));
        // Router, DNS, server-id all collapse to the gateway.
        assert_eq!(option(&offer, 54), Some(&LEASE.gateway_ip.octets()[..]));
        assert_eq!(option(&offer, 3), Some(&LEASE.gateway_ip.octets()[..]));
        assert_eq!(option(&offer, 6), Some(&LEASE.gateway_ip.octets()[..]));
        assert_eq!(option(&offer, 1), Some(&LEASE.netmask.octets()[..]));
        assert_eq!(option(&offer, 51), Some(&86_400u32.to_be_bytes()[..]));

        let r = parse(&discover(mac, DHCPREQUEST)).unwrap();
        let ack = build_reply(&r, &LEASE);
        assert_eq!(option(&ack, 53), Some(&[DHCPACK][..]));
    }

    #[test]
    fn fuzz_parse_never_panics() {
        let mut seed = 0x243f6a8885a308d3u64;
        for _ in 0..10_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let len = (seed as usize) % 600;
            let p: Vec<u8> = (0..len).map(|i| (seed >> (i % 56)) as u8).collect();
            let _ = parse(&p);
        }
    }
}
