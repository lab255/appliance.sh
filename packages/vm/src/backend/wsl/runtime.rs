//! Resident WSL Runtime TCP-forward manager and owner-only named-pipe control.

use crate::runtime_forward::{
    serve_control_stream, ForwardTable, ForwardTarget, ListenerHandle, TargetMode,
};
use anyhow::{bail, Context, Result};
use std::ffi::c_void;
use std::fs::File;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const PIPE_BUFFER_BYTES: u32 = 16 * 1024;

pub fn spawn_forward_control(vm_name: String, guest_ip: Ipv4Addr) -> Result<()> {
    let pipe_name = crate::runtime_forward::windows_pipe_name(&vm_name);
    let sddl = owner_only_pipe_sddl(&current_user_sid()?);
    // Create the first instance before returning so Runtime readiness never
    // races a missing or insecure control endpoint.
    let first = PipeServer::create(&pipe_name, &sddl)?;
    std::thread::spawn(move || {
        let mut table = ForwardTable::default();
        let mut server = first;
        loop {
            if let Err(error) = server.connect().and_then(|()| {
                serve_control_stream(&mut server.file, |request| {
                    let spec = crate::store::load_spec(&vm_name)?
                        .with_context(|| format!("runtime pool '{vm_name}' does not exist"))?;
                    table.apply(&spec, request, TargetMode::Wsl { guest_ip }, |target| {
                        spawn_tcp_listener(request.host, target)
                    })
                })
            }) {
                eprintln!("Runtime forward named pipe: {error:#}");
            }
            server.disconnect();
            drop(server);
            match PipeServer::create(&pipe_name, &sddl) {
                Ok(next) => server = next,
                Err(error) => {
                    eprintln!("Runtime forward named pipe stopped: {error:#}");
                    break;
                }
            }
        }
    });
    Ok(())
}

fn spawn_tcp_listener(host: u16, target: ForwardTarget) -> Result<ListenerHandle> {
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
        let upstream = SocketAddr::from((target.address, target.port));
        while thread_running.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => {
                    std::thread::spawn(move || {
                        match TcpStream::connect_timeout(&upstream, Duration::from_secs(5)) {
                            Ok(guest) => crate::net::pump(stream, guest),
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

struct PipeServer {
    file: File,
}

impl PipeServer {
    fn create(pipe_name: &str, sddl: &str) -> Result<Self> {
        let descriptor = SecurityDescriptor::from_sddl(sddl)?;
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let wide = wide_null(pipe_name);
        let handle = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                PIPE_BUFFER_BYTES,
                PIPE_BUFFER_BYTES,
                0,
                &mut attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("create owner-only Runtime named pipe {pipe_name}"));
        }
        let file = unsafe { File::from_raw_handle(handle) };
        Ok(Self { file })
    }

    fn connect(&mut self) -> Result<()> {
        let handle = self.file.as_raw_handle();
        let connected = unsafe { ConnectNamedPipe(handle, null_mut()) };
        if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
            return Err(std::io::Error::last_os_error())
                .context("accept Runtime named-pipe client");
        }
        Ok(())
    }

    fn disconnect(&mut self) {
        unsafe {
            DisconnectNamedPipe(self.file.as_raw_handle());
        }
    }
}

struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

impl SecurityDescriptor {
    fn from_sddl(sddl: &str) -> Result<Self> {
        let wide = wide_null(sddl);
        let mut descriptor = null_mut();
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SECURITY_DESCRIPTOR_REVISION,
                &mut descriptor,
                null_mut(),
            )
        };
        if converted == 0 {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("build Runtime named-pipe security descriptor {sddl}"));
        }
        Ok(Self(descriptor))
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn current_user_sid() -> Result<String> {
    let mut raw_token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) } == 0 {
        return Err(std::io::Error::last_os_error()).context("open current-user process token");
    }
    let token = OwnedHandle(raw_token);
    let mut required = 0u32;
    unsafe {
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut required);
    }
    if required < std::mem::size_of::<TOKEN_USER>() as u32 {
        bail!("current-user token did not contain a user SID");
    }
    let mut buffer = vec![0u8; required as usize];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error()).context("read current-user SID");
    }
    let user = unsafe { std::ptr::read_unaligned(buffer.as_ptr().cast::<TOKEN_USER>()) };
    let mut string_sid = null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut string_sid) } == 0 {
        return Err(std::io::Error::last_os_error()).context("format current-user SID");
    }
    let sid = wide_ptr_to_string(string_sid);
    unsafe {
        LocalFree(string_sid.cast::<c_void>());
    }
    Ok(sid)
}

fn owner_only_pipe_sddl(owner_sid: &str) -> String {
    // Protected DACL, no inherited or ambient group ACEs: only the actual
    // token-user SID owns and receives generic-all access to the pipe.
    format!("O:{owner_sid}D:P(A;;GA;;;{owner_sid})")
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_ptr_to_string(value: *const u16) -> String {
    let mut len = 0usize;
    while unsafe { *value.add(len) } != 0 {
        len += 1;
    }
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(value, len) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_pipe_sddl_grants_only_the_owner_sid() {
        let sid = "S-1-5-21-111-222-333-1001";
        assert_eq!(
            owner_only_pipe_sddl(sid),
            "O:S-1-5-21-111-222-333-1001D:P(A;;GA;;;S-1-5-21-111-222-333-1001)"
        );
        let sddl = owner_only_pipe_sddl(sid);
        assert_eq!(sddl.matches("(A;;GA;;;").count(), 1);
        assert!(!sddl.contains(";;;WD"));
        assert!(!sddl.contains(";;;AU"));
        assert!(!sddl.contains(";;;BA"));
        assert!(!sddl.contains(";;;SY"));
    }
}
