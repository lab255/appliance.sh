//! Host-side networking for a running microVM.
//!
//! Virtualization.framework's NAT attachment puts the guest on a
//! host-only shared subnet (192.168.64.0/24 by default). The host can
//! reach the guest's address directly, but nothing on the guest is
//! reachable at `127.0.0.1` — and `*.appliance.localhost` resolves to
//! 127.0.0.1. So the resident VM host process runs plain TCP proxies:
//!
//!   127.0.0.1:<hostPort> → guest:80     (Traefik ingress in k3s)
//!   127.0.0.1:<apiPort>  → guest:6443   (Kubernetes API)
//!
//! The guest's address is discovered from macOS's own DHCP lease
//! table (`/var/db/dhcpd_leases`) using the VM's fixed MAC — the same
//! approach Lima uses. Leases are written by the framework's embedded
//! DHCP server, so no privileges are needed to read them.

use anyhow::{bail, Context, Result};
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::time::{Duration, Instant};

const DHCPD_LEASES: &str = "/var/db/dhcpd_leases";

/// Normalize a MAC for lease-table comparison. The lease file strips
/// leading zeros per octet (`0c` → `c`), so compare octet-by-octet as
/// parsed integers rather than strings.
fn mac_octets(mac: &str) -> Option<[u8; 6]> {
    let mut out = [0u8; 6];
    let mut parts = mac.split(':');
    for slot in &mut out {
        *slot = u8::from_str_radix(parts.next()?, 16).ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// One pass over the lease table looking for `mac`.
fn lookup_lease(mac: &str) -> Result<Option<IpAddr>> {
    let raw = match std::fs::read_to_string(DHCPD_LEASES) {
        Ok(raw) => raw,
        // Absent until the framework's DHCP server hands out its
        // first-ever lease on this machine.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).context(DHCPD_LEASES),
    };
    parse_leases(&raw, mac)
}

/// Parse macOS's `dhcpd_leases` plist-ish format: repeated
/// `{\n\tname=…\n\tip_address=…\n\thw_address=1,<mac>\n…}` blocks.
fn parse_leases(raw: &str, mac: &str) -> Result<Option<IpAddr>> {
    let needle = mac_octets(mac).context("invalid MAC")?;
    let mut current_ip: Option<IpAddr> = None;
    for line in raw.lines() {
        let line = line.trim();
        if line.starts_with('{') {
            current_ip = None;
        } else if let Some(ip) = line.strip_prefix("ip_address=") {
            current_ip = ip.parse().ok();
        } else if let Some(hw) = line.strip_prefix("hw_address=") {
            // `1,aa:bb:c:d:ee:ff` — type prefix, then the MAC.
            if let Some(found) = hw.split_once(',').and_then(|(_, m)| mac_octets(m)) {
                if found == needle {
                    if let Some(ip) = current_ip {
                        return Ok(Some(ip));
                    }
                }
            }
        }
    }
    Ok(None)
}

/// Poll the lease table until the VM's MAC shows up (the guest DHCPs
/// early in initramfs, so this resolves within a few seconds of boot).
pub fn discover_guest_ip(mac: &str, timeout: Duration) -> Result<IpAddr> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(ip) = lookup_lease(mac)? {
            return Ok(ip);
        }
        if Instant::now() >= deadline {
            bail!("guest with MAC {mac} did not appear in {DHCPD_LEASES} within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Wait for a TCP endpoint to accept connections.
pub fn wait_tcp(addr: SocketAddr, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("{addr} did not accept connections within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Fetch the guest's admin kubeconfig over the handoff endpoint and
/// rewrite its server address to the host-forwarded port.
pub fn fetch_kubeconfig(guest_ip: IpAddr, handoff_port: u16, api_port: u16) -> Result<String> {
    let url = format!("http://{guest_ip}:{handoff_port}/k3s.yaml");
    let body = ureq::get(&url)
        .timeout(Duration::from_secs(5))
        .call()
        .with_context(|| format!("GET {url}"))?
        .into_string()?;
    // k3s writes `server: https://127.0.0.1:6443`; our forward keeps
    // the same loopback shape, only the port can differ.
    Ok(body.replace(
        "server: https://127.0.0.1:6443",
        &format!("server: https://127.0.0.1:{api_port}"),
    ))
}

/// Bidirectional byte pump for one proxied connection.
fn pump(mut a: TcpStream, mut b: TcpStream) {
    let mut a2 = match a.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut b2 = match b.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let t = std::thread::spawn(move || {
        let _ = std::io::copy(&mut a, &mut b);
        let _ = b.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut b2, &mut a2);
    let _ = a2.shutdown(std::net::Shutdown::Write);
    let _ = t.join();
}

/// Run a localhost→guest TCP forward for the lifetime of the host
/// process. One OS thread per active connection — connection counts
/// here are interactive-development sized.
pub fn spawn_proxy(listen_port: u16, target: SocketAddr) -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", listen_port))
        .with_context(|| format!("bind 127.0.0.1:{listen_port}"))?;
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            match TcpStream::connect_timeout(&target, Duration::from_secs(5)) {
                Ok(upstream) => {
                    std::thread::spawn(move || pump(stream, upstream));
                }
                Err(_) => drop(stream),
            }
        }
    });
    Ok(())
}

/// Under `net_link = Netstack` there is **no OS route to the guest** —
/// it lives entirely inside our userspace stack — so an inbound forward
/// can't `TcpStream::connect((guest_ip, port))` the way the NAT path
/// does. Instead each accepted host connection is dialed *through* the
/// netstack (`Netstack::connect`, which originates a SYN to the guest),
/// and the two streams are spliced by the same bidirectional pump. The
/// listener side (`127.0.0.1:<port>`) is identical to the NAT forward —
/// only the "connect to guest" leg swaps (docs/egress-firewall.md §6).
pub fn spawn_proxy_netstack(
    listen_port: u16,
    guest_port: u16,
    netstack: crate::netstack::Netstack,
) -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", listen_port))
        .with_context(|| format!("bind 127.0.0.1:{listen_port}"))?;
    spawn_netstack_accept_loop(listener, guest_port, netstack);
    Ok(())
}

/// Runtime published-port forward: the host listener targets the principal's
/// stable namespace address, so two apps may safely publish the same guest
/// port from one pooled VM.
#[allow(dead_code)]
pub fn spawn_proxy_netstack_principal(
    listen_port: u16,
    target_ip: std::net::Ipv4Addr,
    guest_port: u16,
    netstack: crate::netstack::Netstack,
) -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", listen_port))
        .with_context(|| format!("bind 127.0.0.1:{listen_port}"))?;
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let netstack = netstack.clone();
            std::thread::spawn(move || match netstack.connect_to(target_ip, guest_port) {
                Ok(bridge) => crate::netstack::bridge_pump(bridge, stream),
                Err(_) => drop(stream),
            });
        }
    });
    Ok(())
}

/// Like [`spawn_proxy_netstack`] but on an OS-chosen loopback port,
/// returned to the caller. Used for the one-shot kubeconfig handoff,
/// which under the netstack must also be reached through the stack
/// rather than at `guest_ip:9991` directly.
pub fn spawn_proxy_netstack_ephemeral(
    guest_port: u16,
    netstack: crate::netstack::Netstack,
) -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).context("bind 127.0.0.1:0")?;
    let port = listener
        .local_addr()
        .context("ephemeral local addr")?
        .port();
    spawn_netstack_accept_loop(listener, guest_port, netstack);
    Ok(port)
}

fn spawn_netstack_accept_loop(
    listener: TcpListener,
    guest_port: u16,
    netstack: crate::netstack::Netstack,
) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let netstack = netstack.clone();
            std::thread::spawn(move || match netstack.connect(guest_port) {
                Ok(bridge) => crate::netstack::bridge_pump(bridge, stream),
                Err(_) => drop(stream),
            });
        }
    });
}

/// One short-timeout HTTP probe, returning the body on a 2xx answer and
/// `None` otherwise. The polling building block for the bring-up
/// progress handoff (the guest's grippable /progress markers).
pub fn http_get_text(url: &str) -> Option<String> {
    ureq::get(url)
        .timeout(Duration::from_secs(2))
        .call()
        .ok()
        .and_then(|r| r.into_string().ok())
}

/// Probe an HTTP endpoint through a localhost forward while routing by
/// NAME: the explicit `Host` header drives traefik's name-based routing
/// without depending on the host resolver knowing `*.appliance.localhost`.
pub fn wait_http_host(url: &str, host_header: &str, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let ok = ureq::get(url)
            .set("Host", host_header)
            .timeout(Duration::from_secs(2))
            .call()
            .is_ok();
        if ok {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("{url} (Host: {host_header}) not answering within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Probe an HTTP endpoint until it answers anything at all.
pub fn wait_http(url: &str, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let ok = ureq::get(url)
            .timeout(Duration::from_secs(2))
            .call()
            .map(|_| true)
            .unwrap_or(false);
        if ok {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("{url} not reachable within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

// Quiet "unused" for shapes only the macOS backend exercises today.
#[allow(dead_code)]
fn _unused(_: fn(&mut dyn Read, &mut dyn Write)) {}
#[allow(dead_code)]
fn _unused_path(_: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    const LEASES: &str = "{\n\tname=appliance\n\tip_address=192.168.64.7\n\thw_address=1,5e:94:ef:e4:c:ee\n\tlease=0x12345\n}\n{\n\tname=other\n\tip_address=192.168.64.2\n\thw_address=1,aa:bb:cc:dd:ee:ff\n}\n";

    #[test]
    fn finds_lease_with_zero_stripped_octets() {
        // The lease file writes `c` where the spec MAC says `0c`.
        let ip = parse_leases(LEASES, "5e:94:ef:e4:0c:ee").unwrap();
        assert_eq!(ip, Some("192.168.64.7".parse().unwrap()));
    }

    #[test]
    fn misses_unknown_mac() {
        let ip = parse_leases(LEASES, "02:00:00:00:00:01").unwrap();
        assert_eq!(ip, None);
    }

    #[test]
    fn rejects_invalid_mac() {
        assert!(parse_leases(LEASES, "not-a-mac").is_err());
    }
}
