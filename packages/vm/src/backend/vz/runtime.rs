//! Owner-only Runtime host control: dynamically bind published loopback
//! forwards against the resident VM's in-process netstack.

use crate::netstack::Netstack;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForwardRequest {
    action: ForwardAction,
    host: u16,
    guest: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ForwardAction {
    Bind,
    Unbind,
}

struct ForwardHandle {
    guest: u16,
    running: Arc<AtomicBool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// Accept bind/unbind requests for the resident VM. Persisted mappings
/// authorize Runtime plans, but listeners exist only while the matching
/// app is running so a recycled principal can never inherit an old socket.
pub fn spawn_forward_control(netstack: Netstack, sock_path: PathBuf) -> Result<()> {
    let _ = std::fs::remove_file(&sock_path);
    let listener = UnixListener::bind(&sock_path)
        .with_context(|| format!("bind Runtime forward control {}", sock_path.display()))?;
    std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o600))?;
    std::thread::spawn(move || {
        let mut bound = BTreeMap::new();
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let response = handle_request(&netstack, &mut bound, &mut stream);
            let body = match response {
                Ok(()) => ForwardResponse { ok: true, message: None },
                Err(error) => ForwardResponse { ok: false, message: Some(format!("{error:#}")) },
            };
            if let Ok(json) = serde_json::to_vec(&body) {
                let _ = stream.write_all(&json);
                let _ = stream.write_all(b"\n");
            }
        }
    });
    Ok(())
}

fn handle_request(
    netstack: &Netstack,
    bound: &mut BTreeMap<u16, ForwardHandle>,
    stream: &mut UnixStream,
) -> Result<()> {
    let mut input = Vec::new();
    stream.take(16 * 1024).read_to_end(&mut input)?;
    let request: ForwardRequest = serde_json::from_slice(&input).context("parse Runtime forward request")?;
    match request.action {
        ForwardAction::Bind => bind_forward(netstack, bound, request.host, request.guest),
        ForwardAction::Unbind => unbind_forward(bound, request.host, request.guest),
    }
}

fn bind_forward(
    netstack: &Netstack,
    bound: &mut BTreeMap<u16, ForwardHandle>,
    host: u16,
    guest: u16,
) -> Result<()> {
    if !(20_000..=29_999).contains(&host) || guest == 0 {
        bail!("invalid Runtime forward {host}->{guest}");
    }
    if let Some(existing) = bound.get(&host) {
        if existing.guest == guest {
            return Ok(());
        }
        bail!("Runtime host port {host} is already mapped to guest port {}", existing.guest);
    }
    let listener = TcpListener::bind(("127.0.0.1", host))
        .with_context(|| format!("bind Runtime forward 127.0.0.1:{host}->{guest}"))?;
    listener.set_nonblocking(true)?;
    let running = Arc::new(AtomicBool::new(true));
    let thread_running = running.clone();
    let thread_netstack = netstack.clone();
    std::thread::spawn(move || {
        while thread_running.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let connection_netstack = thread_netstack.clone();
                    std::thread::spawn(move || match connection_netstack.connect(guest) {
                        Ok(bridge) => crate::netstack::bridge_pump(bridge, stream),
                        Err(_) => drop(stream),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(_) => break,
            }
        }
    });
    bound.insert(host, ForwardHandle { guest, running });
    Ok(())
}

fn unbind_forward(bound: &mut BTreeMap<u16, ForwardHandle>, host: u16, guest: u16) -> Result<()> {
    let Some(existing) = bound.get(&host) else { return Ok(()) };
    if existing.guest != guest {
        bail!("Runtime host port {host} is mapped to guest port {}, not {guest}", existing.guest);
    }
    let existing = bound.remove(&host).expect("checked Runtime forward");
    existing.running.store(false, Ordering::Release);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_omits_message_on_success() {
        let json = serde_json::to_string(&ForwardResponse { ok: true, message: None }).unwrap();
        assert_eq!(json, r#"{"ok":true}"#);
    }

    #[test]
    fn runtime_control_socket_is_inside_the_vm_directory() {
        let paths = crate::spec::VmPaths::for_name("appliance-runtime");
        assert_eq!(
            paths.runtime_forward_sock(),
            paths.dir.join(std::path::Path::new("runtime-forward.sock"))
        );
    }

    #[test]
    fn unbind_revokes_the_listener_handle() {
        let running = Arc::new(AtomicBool::new(true));
        let mut bound = BTreeMap::from([(
            20_000,
            ForwardHandle {
                guest: 22_000,
                running: running.clone(),
            },
        )]);
        unbind_forward(&mut bound, 20_000, 22_000).unwrap();
        assert!(bound.is_empty());
        assert!(!running.load(Ordering::Acquire));
    }
}
