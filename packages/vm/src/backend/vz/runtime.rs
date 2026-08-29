//! Owner-only Runtime control over a 0600 Unix socket on macOS.

use crate::netstack::Netstack;
use crate::runtime_forward::{
    serve_control_stream, ForwardTable, ForwardTarget, ListenerHandle, TargetMode,
};
use anyhow::{Context, Result};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Accept bind/unbind requests for the resident VM. The table reloads the
/// persisted spec for every request, so reconciliation is authoritative even
/// when it adds an app after the pooled VM booted.
pub fn spawn_forward_control(
    vm_name: String,
    netstack: Netstack,
    sock_path: PathBuf,
) -> Result<()> {
    let _ = std::fs::remove_file(&sock_path);
    let listener = UnixListener::bind(&sock_path)
        .with_context(|| format!("bind Runtime forward control {}", sock_path.display()))?;
    std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o600))?;
    std::thread::spawn(move || {
        let mut table = ForwardTable::default();
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let result = serve_control_stream(&mut stream, |request| {
                let spec = crate::store::load_spec(&vm_name)?
                    .with_context(|| format!("runtime pool '{vm_name}' does not exist"))?;
                table.apply(
                    &spec,
                    request,
                    TargetMode::Fixed {
                        target: crate::netstack::GUEST_IP,
                    },
                    || unreachable!("the fixed target does not resolve a WSL lease"),
                    |target| spawn_netstack_listener(request.host, target, netstack.clone()),
                )
            });
            if let Err(error) = result {
                eprintln!("Runtime forward control: {error:#}");
            }
        }
    });
    Ok(())
}

fn spawn_netstack_listener(
    host: u16,
    target: ForwardTarget,
    netstack: Netstack,
) -> Result<ListenerHandle> {
    let listener = TcpListener::bind(("127.0.0.1", host)).with_context(|| {
        format!(
            "bind Runtime forward 127.0.0.1:{host}->{}:{}",
            target.address, target.port
        )
    })?;
    listener.set_nonblocking(true)?;
    let running = Arc::new(AtomicBool::new(true));
    let thread_running = running.clone();
    let thread = std::thread::spawn(move || {
        while thread_running.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let netstack = netstack.clone();
                    std::thread::spawn(move || {
                        match netstack.connect_to(target.address, target.port) {
                            Ok(bridge) => crate::netstack::bridge_pump(bridge, stream),
                            Err(_) => drop(stream),
                        }
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(_) => break,
            }
        }
    });
    Ok(ListenerHandle::new(move || {
        running.store(false, Ordering::Release);
        let _ = thread.join();
    }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn runtime_control_socket_is_inside_the_vm_directory() {
        let paths = crate::spec::VmPaths::for_name("appliance-runtime");
        assert_eq!(
            paths.runtime_forward_sock(),
            paths.dir.join(std::path::Path::new("runtime-forward.sock"))
        );
    }
}
