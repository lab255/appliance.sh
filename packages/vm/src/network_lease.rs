//! Small, platform-neutral helpers for host/guest IPv4 lease ranges.

use std::net::Ipv4Addr;

/// Parse the first non-loopback `inet ADDRESS/PREFIX` line emitted by
/// `ip addr`, retaining the prefix WSL assigns (normally /20).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_inet_v4(raw: &str) -> Option<(Ipv4Addr, u8)> {
    for line in raw.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("inet ") else {
            continue;
        };
        let cidr = rest.split_whitespace().next()?;
        let (address, prefix) = cidr.split_once('/')?;
        let address = address.parse::<Ipv4Addr>().ok()?;
        let prefix = prefix.parse::<u8>().ok()?;
        if !address.is_loopback() && prefix <= 32 {
            return Some((address, prefix));
        }
    }
    None
}

/// Whether two IPv4 addresses occupy the same CIDR prefix.
pub fn same_prefix(left: Ipv4Addr, right: Ipv4Addr, prefix_len: u8) -> bool {
    if prefix_len > 32 {
        return false;
    }
    let mask = if prefix_len == 0 {
        0
    } else {
        u32::MAX << (32 - prefix_len)
    };
    u32::from(left) & mask == u32::from(right) & mask
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wsl_prefix_length_from_ip_addr() {
        let raw = "5: eth0: <BROADCAST,MULTICAST,UP> mtu 1500\n    \
                   inet 172.25.66.42/20 brd 172.25.79.255 scope global eth0\n";
        assert_eq!(
            parse_inet_v4(raw),
            Some(("172.25.66.42".parse().unwrap(), 20))
        );
        assert_eq!(parse_inet_v4("inet 127.0.0.1/8 scope host lo"), None);
        assert_eq!(
            parse_inet_v4("inet 172.25.66.42/99 scope global eth0"),
            None
        );
    }

    #[test]
    fn wsl_slash_20_admission_range_uses_the_recorded_prefix() {
        let gateway = "172.25.64.1".parse().unwrap();
        assert!(same_prefix(gateway, "172.25.66.42".parse().unwrap(), 20));
        assert!(same_prefix(gateway, "172.25.79.254".parse().unwrap(), 20));
        assert!(!same_prefix(gateway, "172.25.80.1".parse().unwrap(), 20));
        assert!(!same_prefix(gateway, "192.168.1.1".parse().unwrap(), 20));
    }
}
