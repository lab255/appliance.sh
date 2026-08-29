//! Cross-platform Runtime published-port control contract and listener table.
//!
//! The resident backend owns the actual listeners. This module owns the parts
//! that must stay identical between the Unix-socket and Windows named-pipe
//! transports: JSON framing, persisted-spec authorization, idempotency, and
//! collision/unbind semantics.

use crate::spec::VmSpec;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::Ipv4Addr;

pub const MIN_RUNTIME_HOST_PORT: u16 = 20_000;
pub const MAX_RUNTIME_HOST_PORT: u16 = 29_999;
const MAX_CONTROL_FRAME: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRequest {
    pub action: ForwardAction,
    pub host: u16,
    pub target: Ipv4Addr,
    pub guest: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ForwardAction {
    Bind,
    Unbind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetMode {
    /// The host-mediated netstack dials the fixed guest relay address supplied
    /// by the caller; the persisted principal /32 is the relay's last hop.
    #[cfg_attr(windows, allow(dead_code))]
    Fixed { target: Ipv4Addr },
    /// WSL ignores the advisory request target and dials the current NAT lease.
    #[cfg_attr(not(windows), allow(dead_code))]
    Wsl { guest_ip: Ipv4Addr },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ForwardTarget {
    pub address: Ipv4Addr,
    pub port: u16,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl ForwardRequest {
    pub fn new(action: &str, host: u16, target: Ipv4Addr, guest: u16) -> Result<Self> {
        let action = match action {
            "bind" => ForwardAction::Bind,
            "unbind" => ForwardAction::Unbind,
            _ => bail!("invalid Runtime forward action '{action}'"),
        };
        Ok(Self {
            action,
            host,
            target,
            guest,
        })
    }
}

/// Stable per-VM pipe name used by the Windows resident process and clients.
/// VM names are already constrained by the CLI before reaching this surface.
#[cfg(windows)]
pub fn windows_pipe_name(vm_name: &str) -> String {
    format!(r"\\.\pipe\appliance-runtime-forward-{vm_name}")
}

/// Backend listener ownership. Dropping the handle synchronously requests
/// shutdown; the accept thread owns and eventually closes the OS listener.
pub struct ListenerHandle {
    stop: Option<Box<dyn FnOnce() + Send + 'static>>,
}

impl ListenerHandle {
    pub fn new(stop: impl FnOnce() + Send + 'static) -> Self {
        Self {
            stop: Some(Box::new(stop)),
        }
    }
}

impl Drop for ListenerHandle {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            stop();
        }
    }
}

struct ForwardBinding {
    target: ForwardTarget,
    _listener: ListenerHandle,
}

#[derive(Default)]
pub struct ForwardTable {
    bound: BTreeMap<u16, ForwardBinding>,
}

impl ForwardTable {
    /// Apply one already-decoded request. Bind authorization is re-evaluated
    /// from the current persisted spec; a bound table row authorizes unbind.
    pub fn apply(
        &mut self,
        spec: &VmSpec,
        request: ForwardRequest,
        mode: TargetMode,
        start: impl FnOnce(ForwardTarget) -> Result<ListenerHandle>,
    ) -> Result<()> {
        match request.action {
            ForwardAction::Bind => {
                let target = authorized_target(spec, request, mode)?;
                self.bind(request.host, target, start)
            }
            ForwardAction::Unbind => {
                validate_request(spec, request)?;
                self.unbind(request.host)
            }
        }
    }

    fn bind(
        &mut self,
        host: u16,
        target: ForwardTarget,
        start: impl FnOnce(ForwardTarget) -> Result<ListenerHandle>,
    ) -> Result<()> {
        if let Some(existing) = self.bound.get(&host) {
            if existing.target == target {
                return Ok(());
            }
            bail!(
                "Runtime host port {host} is already mapped to {}:{}",
                existing.target.address,
                existing.target.port
            );
        }
        // Bind before publishing the row. A failed start leaves neither a
        // table entry nor a retained listener handle.
        let listener = start(target)?;
        self.bound.insert(
            host,
            ForwardBinding {
                target,
                _listener: listener,
            },
        );
        Ok(())
    }

    fn unbind(&mut self, host: u16) -> Result<()> {
        self.bound.remove(&host);
        Ok(())
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.bound.len()
    }
}

fn authorized_target(
    spec: &VmSpec,
    request: ForwardRequest,
    mode: TargetMode,
) -> Result<ForwardTarget> {
    validate_request(spec, request)?;
    let published = spec
        .published
        .iter()
        .find(|port| {
            port.host == request.host
                && port.container == request.guest
                && port.runtime_target.is_some()
        })
        .with_context(|| {
            format!(
                "Runtime forward {}->{} is not authorized by the persisted VM spec",
                request.host, request.guest
            )
        })?;
    let address = match mode {
        TargetMode::Fixed { target } => {
            if target != request.target {
                bail!(
                    "Runtime forward {}->{}:{} does not match backend relay target {}",
                    request.host,
                    request.target,
                    request.guest,
                    target
                );
            }
            target
        }
        TargetMode::Wsl { guest_ip } => guest_ip,
    };
    debug_assert!(published.runtime_target.is_some());
    Ok(ForwardTarget {
        address,
        port: request.guest,
    })
}

fn validate_request(spec: &VmSpec, request: ForwardRequest) -> Result<()> {
    if !(MIN_RUNTIME_HOST_PORT..=MAX_RUNTIME_HOST_PORT).contains(&request.host)
        || request.guest == 0
    {
        bail!(
            "invalid Runtime forward {}->{}:{}",
            request.host,
            request.target,
            request.guest
        );
    }
    if !spec.runtime {
        bail!("VM '{}' is not an Appliance Runtime pool", spec.name);
    }
    Ok(())
}

/// Serve one newline-delimited request on either control transport. A handler
/// failure is encoded as the same `{ok:false,message}` response on every host.
pub fn serve_control_stream(
    stream: &mut (impl Read + Write),
    handle: impl FnOnce(ForwardRequest) -> Result<()>,
) -> Result<()> {
    let mut input = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        if input.len() == MAX_CONTROL_FRAME {
            bail!("Runtime forward control request exceeds {MAX_CONTROL_FRAME} bytes");
        }
        match stream.read(&mut byte)? {
            0 => break,
            1 if byte[0] == b'\n' => break,
            1 => input.push(byte[0]),
            _ => unreachable!("single-byte control read"),
        }
    }
    let outcome = serde_json::from_slice::<ForwardRequest>(&input)
        .context("parse Runtime forward request")
        .and_then(handle);
    let response = match outcome {
        Ok(()) => ForwardResponse {
            ok: true,
            message: None,
        },
        Err(error) => ForwardResponse {
            ok: false,
            message: Some(format!("{error:#}")),
        },
    };
    serde_json::to_writer(&mut *stream, &response)?;
    stream.write_all(b"\n")?;
    stream.flush()?;
    Ok(())
}

/// Send one request through either a Unix socket or a Windows named-pipe file.
pub fn send_control_request(
    stream: &mut (impl Read + Write),
    request: ForwardRequest,
) -> Result<()> {
    serde_json::to_writer(&mut *stream, &request)?;
    stream.write_all(b"\n")?;
    stream.flush()?;

    let mut response = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        if response.len() == MAX_CONTROL_FRAME {
            bail!("Runtime forward control response exceeds {MAX_CONTROL_FRAME} bytes");
        }
        match stream.read(&mut byte)? {
            0 => break,
            1 if byte[0] == b'\n' => break,
            1 => response.push(byte[0]),
            _ => unreachable!("single-byte control read"),
        }
    }
    let response: ForwardResponse =
        serde_json::from_slice(&response).context("parse Runtime forward response")?;
    if !response.ok {
        bail!(
            "Runtime forward {}->{} failed: {}",
            request.host,
            request.guest,
            response.message.as_deref().unwrap_or("unknown error")
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::PublishedPort;
    use std::io;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    const PRINCIPAL: Ipv4Addr = Ipv4Addr::new(192, 168, 127, 10);
    const WSL_GUEST: Ipv4Addr = Ipv4Addr::new(172, 23, 32, 41);

    fn runtime_spec(rows: &[(u16, u16)]) -> VmSpec {
        let mut spec = VmSpec::runtime_defaults("appliance-runtime");
        spec.published = rows
            .iter()
            .map(|(host, relay)| {
                PublishedPort::for_runtime(*host, *relay, "journal", PRINCIPAL).unwrap()
            })
            .collect();
        spec
    }

    fn request(action: ForwardAction, host: u16, target: Ipv4Addr, guest: u16) -> ForwardRequest {
        ForwardRequest {
            action,
            host,
            target,
            guest,
        }
    }

    #[test]
    fn wsl_bind_derives_current_guest_ip_and_relay() {
        let spec = runtime_spec(&[(20_000, 22_000)]);
        let mut table = ForwardTable::default();
        let observed = Arc::new(std::sync::Mutex::new(None));
        let captured = observed.clone();
        table
            .apply(
                &spec,
                request(ForwardAction::Bind, 20_000, PRINCIPAL, 22_000),
                TargetMode::Wsl {
                    guest_ip: WSL_GUEST,
                },
                move |target| {
                    *captured.lock().unwrap() = Some(target);
                    Ok(ListenerHandle::new(|| {}))
                },
            )
            .unwrap();
        assert_eq!(
            *observed.lock().unwrap(),
            Some(ForwardTarget {
                address: WSL_GUEST,
                port: 22_000
            })
        );
    }

    #[test]
    fn identical_bind_is_idempotent_and_wsl_ignores_advisory_target() {
        let spec = runtime_spec(&[(20_000, 22_000)]);
        let mut table = ForwardTable::default();
        let starts = Arc::new(AtomicUsize::new(0));
        for advisory in [PRINCIPAL, Ipv4Addr::new(10, 0, 0, 99)] {
            let starts = starts.clone();
            table
                .apply(
                    &spec,
                    request(ForwardAction::Bind, 20_000, advisory, 22_000),
                    TargetMode::Wsl {
                        guest_ip: WSL_GUEST,
                    },
                    move |_| {
                        starts.fetch_add(1, Ordering::SeqCst);
                        Ok(ListenerHandle::new(|| {}))
                    },
                )
                .unwrap();
        }
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn collision_is_rejected() {
        let spec = runtime_spec(&[(20_000, 22_000), (20_000, 22_001)]);
        let mut table = ForwardTable::default();
        table
            .apply(
                &spec,
                request(ForwardAction::Bind, 20_000, PRINCIPAL, 22_000),
                TargetMode::Wsl {
                    guest_ip: WSL_GUEST,
                },
                |_| Ok(ListenerHandle::new(|| {})),
            )
            .unwrap();
        let error = table
            .apply(
                &spec,
                request(ForwardAction::Bind, 20_000, PRINCIPAL, 22_001),
                TargetMode::Wsl {
                    guest_ip: WSL_GUEST,
                },
                |_| Ok(ListenerHandle::new(|| {})),
            )
            .unwrap_err();
        assert!(error.to_string().contains("already mapped"));
    }

    #[test]
    fn unbind_stops_and_removes_listener() {
        let spec = runtime_spec(&[(20_000, 22_000)]);
        let mut table = ForwardTable::default();
        let stopped = Arc::new(AtomicBool::new(false));
        let listener_stopped = stopped.clone();
        table
            .apply(
                &spec,
                request(ForwardAction::Bind, 20_000, PRINCIPAL, 22_000),
                TargetMode::Fixed { target: PRINCIPAL },
                move |_| {
                    Ok(ListenerHandle::new(move || {
                        listener_stopped.store(true, Ordering::SeqCst);
                    }))
                },
            )
            .unwrap();
        table
            .apply(
                &spec,
                request(ForwardAction::Unbind, 20_000, PRINCIPAL, 22_000),
                TargetMode::Fixed { target: PRINCIPAL },
                |_| unreachable!("unbind never starts a listener"),
            )
            .unwrap();
        assert_eq!(table.len(), 0);
        assert!(stopped.load(Ordering::SeqCst));
    }

    #[test]
    fn unbind_survives_removed_spec_row_and_changed_wsl_lease() {
        let mut spec = runtime_spec(&[(20_000, 22_000)]);
        let mut table = ForwardTable::default();
        table
            .apply(
                &spec,
                request(ForwardAction::Bind, 20_000, PRINCIPAL, 22_000),
                TargetMode::Wsl { guest_ip: WSL_GUEST },
                |_| Ok(ListenerHandle::new(|| {})),
            )
            .unwrap();
        spec.published.clear();
        table
            .apply(
                &spec,
                request(ForwardAction::Unbind, 20_000, PRINCIPAL, 22_000),
                TargetMode::Wsl { guest_ip: Ipv4Addr::new(172, 23, 48, 12) },
                |_| unreachable!("unbind never starts a listener"),
            )
            .unwrap();
        assert_eq!(table.len(), 0);
    }

    #[test]
    fn host_port_range_is_enforced() {
        let spec = runtime_spec(&[(19_999, 22_000), (30_000, 22_001)]);
        for (host, relay) in [(19_999, 22_000), (30_000, 22_001)] {
            let error = ForwardTable::default()
                .apply(
                    &spec,
                    request(ForwardAction::Bind, host, PRINCIPAL, relay),
                    TargetMode::Fixed { target: PRINCIPAL },
                    |_| Ok(ListenerHandle::new(|| {})),
                )
                .unwrap_err();
            assert!(error.to_string().contains("invalid Runtime forward"));
        }
    }

    #[test]
    fn failed_listener_start_leaves_no_table_entry() {
        let spec = runtime_spec(&[(20_000, 22_000)]);
        let mut table = ForwardTable::default();
        table
            .apply(
                &spec,
                request(ForwardAction::Bind, 20_000, PRINCIPAL, 22_000),
                TargetMode::Fixed { target: PRINCIPAL },
                |_| bail!("fake bind failure"),
            )
            .unwrap_err();
        assert_eq!(table.len(), 0);
    }

    struct MemoryTransport {
        input: io::Cursor<Vec<u8>>,
        output: Vec<u8>,
    }

    impl MemoryTransport {
        fn new(input: &[u8]) -> Self {
            Self {
                input: io::Cursor::new(input.to_vec()),
                output: Vec::new(),
            }
        }
    }

    impl Read for MemoryTransport {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.input.read(buf)
        }
    }

    impl Write for MemoryTransport {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.output.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn fake_endpoint(input: &[u8]) -> Vec<u8> {
        let mut transport = MemoryTransport::new(input);
        serve_control_stream(&mut transport, |request| {
            if request.host == 20_000 {
                Ok(())
            } else {
                bail!("fake collision")
            }
        })
        .unwrap();
        transport.output
    }

    #[test]
    fn unix_and_windows_control_transports_share_the_json_contract() {
        let request =
            b"{\"action\":\"bind\",\"host\":20000,\"target\":\"192.168.127.10\",\"guest\":22000}\n";
        let fake_unix = fake_endpoint(request);
        let fake_windows = fake_endpoint(request);
        assert_eq!(fake_unix, fake_windows);
        assert_eq!(fake_unix, b"{\"ok\":true}\n");

        let rejected =
            b"{\"action\":\"bind\",\"host\":20001,\"target\":\"192.168.127.10\",\"guest\":22000}\n";
        assert_eq!(
            fake_endpoint(rejected),
            b"{\"ok\":false,\"message\":\"fake collision\"}\n"
        );
    }
}
