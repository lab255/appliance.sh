//! PTY-backed interactive terminals for the local engines.
//!
//! `kubectl exec -it` (and a guest shell) need a real TTY for job
//! control, line editing, and full-screen TUIs. This module spawns the
//! command in a pseudo-terminal and bridges it to the desktop's
//! xterm.js view: output bytes stream to the frontend over a Tauri
//! Channel; keystrokes and resizes come back through commands keyed by
//! a session id.
//!
//! It is deliberately transport-only and engine-agnostic — the caller
//! (lib.rs) builds the argv, so the k3d-vs-microVM target logic lives
//! in one place next to the other kube wiring.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermEvent {
    /// A chunk of terminal output (UTF-8 lossy — shells are UTF-8).
    Data { data: String },
    /// The child exited; the terminal is closed and the id is gone.
    Exit { code: Option<i32> },
}

struct Session {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Session>> {
    sessions().lock().unwrap_or_else(|p| p.into_inner())
}

fn command_builder(
    argv: &[String],
    process_path: Option<OsString>,
) -> Result<CommandBuilder, String> {
    let Some(program) = argv.first() else {
        return Err("empty terminal command".into());
    };
    let mut cmd = CommandBuilder::new(program);
    cmd.args(&argv[1..]);
    // A sensible TERM so curses apps and color work; the host env is
    // otherwise inherited (PATH already carries Desktop's composed paths).
    cmd.env("TERM", "xterm-256color");
    // On Windows portable-pty rebuilds the child env from the registry
    // (system + user Environment keys), which silently discards this
    // process's PATH — including the managed/user dirs prepended at startup.
    // Re-assert the live process PATH; a no-op on unix where the base
    // env already is the process env.
    if let Some(path) = process_path {
        cmd.env("PATH", path);
    }
    Ok(cmd)
}

/// Spawn `argv` in a PTY of the given size. Returns the session id;
/// output then streams on `on_event` until the child exits.
pub fn open(
    id: String,
    argv: Vec<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<TermEvent>,
) -> Result<(), String> {
    if argv.is_empty() {
        return Err("empty terminal command".into());
    }
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let cmd = command_builder(&argv, std::env::var_os("PATH"))?;

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {}: {e}", argv[0]))?;
    // Slave handle isn't needed once the child holds it; dropping it
    // lets the master see EOF when the child exits.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take pty writer: {e}"))?;

    lock().insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            child,
        },
    );

    // Pump output → frontend on a dedicated thread; on EOF, reap the
    // child, emit the exit code, and drop the session.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if on_event.send(TermEvent::Data { data }).is_err() {
                        break; // frontend hung up
                    }
                }
            }
        }
        let code = {
            let mut map = lock();
            map.remove(&id)
                .and_then(|mut s| s.child.wait().ok().map(|status| status.exit_code() as i32))
        };
        let _ = on_event.send(TermEvent::Exit { code });
    });

    Ok(())
}

pub fn write(id: &str, data: &str) -> Result<(), String> {
    let mut map = lock();
    let session = map.get_mut(id).ok_or("no such terminal session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    session.writer.flush().map_err(|e| format!("flush: {e}"))
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let map = lock();
    let session = map.get(id).ok_or("no such terminal session")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))
}

/// Kill and forget the *host* PTY session — the local child process
/// streaming this terminal. For a reattachable vsock shell that child is
/// `appliance-vm shell --session <id>`, so killing it merely *detaches*
/// from the guest tmux session; the in-guest session (and its processes)
/// keeps running, which is exactly what lets a desktop restart reconnect
/// (E3.4). Destroying the guest session is a separate, explicit step
/// (`terminal_kill_session` → `appliance-vm sessions kill`), not done here.
/// Idempotent — closing an already-exited terminal is a no-op.
pub fn close(id: &str) -> Result<(), String> {
    if let Some(mut session) = lock().remove(id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn command_builder_reasserts_the_process_path() {
        let process_path = OsString::from(r"C:\managed\bin;C:\Windows\System32");
        let cmd = command_builder(&["kubectl".to_string()], Some(process_path.clone())).unwrap();

        assert_eq!(cmd.get_env("PATH"), Some(OsStr::new(&process_path)));
    }
}
