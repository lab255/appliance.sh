//! `appliance-vm shell` client.
//!
//! Unix: connects to a VM's per-VM Unix socket (served by the resident
//! host process, bridged to a guest vsock PTY), puts the local terminal
//! in raw mode, and relays bytes both ways — an interactive shell with
//! no SSH and no dependency on k3s. The guest agent reads one leading
//! `rows R cols C` line and applies it as the PTY size before exec'ing
//! the login shell, so the shell starts at the caller's terminal size.
//!
//! Windows: the WSL2 backend's guest *is* a WSL distro, and `wsl.exe`
//! already provides a ConPTY-backed interactive channel into it — so
//! the client drives `wsl.exe -d <distro>` directly (no relay socket,
//! no raw-mode handling of our own). Sessions ride the same in-guest
//! tmux sockets the vsock agent uses, so semantics match.

use anyhow::{bail, Result};
use std::io::{Read, Write};

#[cfg(unix)]
use crate::spec::VmPaths;
#[cfg(unix)]
use anyhow::anyhow;
#[cfg(windows)]
use anyhow::Context;
#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::net::Shutdown;
#[cfg(unix)]
use std::os::fd::{FromRawFd, RawFd};
#[cfg(unix)]
use std::os::unix::net::UnixStream;

/// Connect to a VM's shell socket, or a clear error when the relay isn't
/// up (VM down, or booted by a non-vsock engine).
#[cfg(unix)]
fn connect(name: &str) -> Result<UnixStream> {
    let sock = VmPaths::for_name(name).shell_sock();
    UnixStream::connect(&sock).map_err(|e| {
        anyhow!(
            "no shell channel for VM '{name}' ({e}).\n\
             Is it running? (appliance vm up) — the vsock shell needs a VM booted with this engine."
        )
    })
}

/// Connect to the VM's shell socket and run a shell. With `command`,
/// run it and exit; otherwise an interactive login shell. `root` lands a
/// root shell (the escape hatch) instead of dropping to the non-root
/// `appliance` user. `session` attaches to (or creates) a reattachable
/// tmux session `<id>` that survives this client disconnecting — an
/// interactive-only addition, so it's silently dropped when a one-shot
/// `command` is given (that path must stay the byte-for-byte sentinel
/// shell). Returns the process exit code to propagate.
#[cfg(unix)]
pub fn run_client(name: &str, command: Option<&str>, root: bool, session: Option<&str>) -> Result<i32> {
    let mut stream = connect(name)?;

    // The agent applies this as the guest PTY size before the shell. A
    // trailing `root` token requests a root shell; the agent strips it
    // and skips the `su` drop to the appliance user. An optional `attach
    // <id>` verb (interactive only) routes to a reattachable tmux session
    // instead — never on the one-shot path, which keeps the pristine
    // sentinel shell.
    let (rows, cols) = term_size();
    let verb = match (command, session) {
        (None, Some(id)) => {
            validate_session_id(id)?;
            format!(" attach {id}")
        }
        _ => String::new(),
    };
    writeln!(stream, "rows {rows} cols {cols}{}{}", if root { " root" } else { "" }, verb)?;
    if let Some(cmd) = command {
        // The vsock relay is a raw byte pipe with no status channel, so
        // carry the command's exit code back in-band: run it, print a
        // sentinel holding `$?`, then drop the login shell. The client
        // parses the sentinel below to propagate the real exit code (a
        // bare `exit` would only ever surface the login shell's status,
        // which the relay then discards).
        writeln!(stream, "{}; printf '\\n{}%d__END__\\n' \"$?\"\nexit", cmd, RC_MARK)?;
    }

    let interactive = command.is_none() && is_tty(libc::STDIN_FILENO);
    let _raw = if interactive {
        Some(RawMode::enable()?)
    } else {
        None
    };

    // Own dup'd copies of stdin/stdout so the relay does unbuffered
    // read/write without ever closing the real std fds.
    let mut sock_to_out = stream.try_clone()?;
    let mut out = dup_file(libc::STDOUT_FILENO)?;
    let mut in_ = dup_file(libc::STDIN_FILENO)?;
    let mut in_to_sock = stream;

    // stdin -> guest, on a detached thread (it may block in read until
    // the process exits once the shell closes).
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut in_, &mut in_to_sock);
        let _ = in_to_sock.shutdown(Shutdown::Write);
    });

    // guest -> stdout, on this thread: it returns when the shell exits
    // and the socket closes, at which point the terminal is restored.
    if command.is_some() {
        // One-shot: stream output through, but intercept the exit-code
        // sentinel and propagate the command's real exit code.
        return Ok(pump_until_sentinel(&mut sock_to_out, &mut out));
    }
    let _ = std::io::copy(&mut sock_to_out, &mut out);
    Ok(0)
}

/// Run a one-shot command over the shell channel with the output
/// CAPTURED instead of streamed to stdout — for host-internal callers
/// (the bring-up credential mint) that need to parse what the guest
/// said. Same protocol as `run_client`'s one-shot path: handshake,
/// command + exit-code sentinel, half-close, drain. `root` keeps the
/// root shell (also the path that works before the appliance user is
/// fully provisioned). Returns the guest command's exit code and the
/// raw PTY output (echo included — callers delimit their payload).
#[cfg(unix)]
pub fn run_captured(name: &str, command: &str, root: bool) -> Result<(i32, String)> {
    let mut stream = connect(name)?;
    writeln!(stream, "rows 24 cols 80{}", if root { " root" } else { "" })?;
    writeln!(stream, "{}; printf '\\n{}%d__END__\\n' \"$?\"\nexit", command, RC_MARK)?;
    // Half-close so the guest shell sees EOF on stdin once the command
    // and `exit` are consumed; then drain its output to the sentinel.
    stream.shutdown(Shutdown::Write)?;
    let mut out: Vec<u8> = Vec::new();
    let code = pump_until_sentinel(&mut stream, &mut out);
    Ok((code, String::from_utf8_lossy(&out).to_string()))
}

/// Windows: `wsl.exe` is the channel and propagates the exit code
/// natively, so capture is a plain piped `sh -lc`.
#[cfg(windows)]
pub fn run_captured(name: &str, command: &str, root: bool) -> Result<(i32, String)> {
    let mut cmd = wsl_command(name, root)?;
    hide_console(&mut cmd);
    cmd.args(["--cd", "~", "--", "sh", "-lc", command]);
    let out = cmd.output().context("run wsl.exe")?;
    // Guest output is UTF-8, but when wsl.exe itself fails (distro
    // missing, WSL broken) its diagnostics are UTF-16LE — decode_wsl
    // sniffs per stream so those messages don't come back NUL-riddled.
    let mut text = crate::backend::wsl::decode_wsl(&out.stdout);
    text.push_str(&crate::backend::wsl::decode_wsl(&out.stderr));
    Ok((out.status.code().unwrap_or(255), text))
}

/// A reattachable tmux session, as reported by `sessions list`.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct SessionInfo {
    /// The host-minted id (the in-guest `appliance-` prefix stripped).
    pub id: String,
    /// tmux `session_activity` (Unix epoch seconds), when parseable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity: Option<i64>,
}

/// The agent's `kill` verb echoes one of these so the host can report the
/// real outcome over the status-less byte pipe: `KILL_MARK` when `tmux
/// kill-session` actually removed a session (exit 0), the no-session
/// marker otherwise. Kept in sync with `guest.rs`'s SHELL_AGENT.
#[cfg(unix)]
const KILL_MARK: &str = "__APPLIANCE_VM_KILLED__";

/// List the VM's reattachable sessions. `root` enumerates the separate
/// root-owned `appliance-root` tmux socket — where `vm shell --root
/// --session <id>` lands — instead of the default non-root `appliance`
/// one; the two privilege levels never share a socket. A short-lived
/// connection: send the `[root] list` verb, read the agent's
/// `appliance-<id> <activity>` lines to EOF, parse them clean. No raw
/// mode, no sentinel — the connection closing is the whole protocol.
#[cfg(unix)]
pub fn list_sessions(name: &str, root: bool) -> Result<Vec<SessionInfo>> {
    let mut stream = connect(name)?;
    let (rows, cols) = term_size();
    // Grammar is `rows R cols C [root] [verb]`: the root token precedes the
    // verb, matching the agent's parse order (verb stripped first, then root).
    writeln!(stream, "rows {rows} cols {cols}{} list", if root { " root" } else { "" })?;
    stream.shutdown(Shutdown::Write)?;
    let mut out = String::new();
    stream.read_to_string(&mut out)?;
    Ok(parse_session_list(&out))
}

/// Kill one reattachable session by id. `root` targets the separate
/// root-owned `appliance-root` socket instead of the non-root `appliance`
/// one. Returns whether a session was actually killed: the agent runs
/// `tmux kill-session` and echoes a marker keyed on its exit status, so
/// killing a non-existent id reports honestly rather than a blanket
/// success.
#[cfg(unix)]
pub fn kill_session(name: &str, id: &str, root: bool) -> Result<bool> {
    validate_session_id(id)?;
    let mut stream = connect(name)?;
    let (rows, cols) = term_size();
    writeln!(stream, "rows {rows} cols {cols}{} kill {id}", if root { " root" } else { "" })?;
    stream.shutdown(Shutdown::Write)?;
    // Drain to EOF so the kill actually runs before we drop the socket, and
    // read back the agent's marker: `KILL_MARK` only when tmux removed a
    // real session (exit 0).
    let mut sink = Vec::new();
    stream.read_to_end(&mut sink)?;
    Ok(String::from_utf8_lossy(&sink).contains(KILL_MARK))
}

/// Parse the agent's `list` output — one `appliance-<id> <activity>` line
/// per session — into clean `SessionInfo`s. The PTY translates `\n` to
/// `\r\n`, so trim the carriage return; lines without the `appliance-`
/// prefix (a blank line, a stray banner) are dropped.
fn parse_session_list(raw: &str) -> Vec<SessionInfo> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r').trim();
            let (sess_name, activity) = match line.split_once(' ') {
                Some((n, a)) => (n, Some(a)),
                None => (line, None),
            };
            let id = sess_name.strip_prefix("appliance-")?;
            if id.is_empty() {
                return None;
            }
            Some(SessionInfo {
                id: id.to_string(),
                last_activity: activity.and_then(|s| s.trim().parse::<i64>().ok()),
            })
        })
        .collect()
}

/// Session ids ride verbatim into the single-line handshake and the
/// in-guest `appliance-<id>` tmux session name. Restrict the charset so a
/// stray space (which would split the handshake) or newline (which would
/// inject a second line onto the agent's stdin) can never get through.
/// Host-minted ids — desktop tab uuids, CLI names — already satisfy this.
fn validate_session_id(id: &str) -> Result<()> {
    if id.is_empty() {
        bail!("session id must not be empty");
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        bail!("invalid session id '{id}': use only letters, digits, '-', '_', '.'");
    }
    Ok(())
}

/// Marker the one-shot command appends as `\n<RC_MARK><n>__END__\n`.
/// (Unix relay only — on Windows `wsl.exe` propagates the guest exit
/// code natively — but compiled everywhere so the parser tests run on
/// every platform.)
#[cfg_attr(windows, allow(dead_code))]
const RC_MARK: &str = "__APPLIANCE_VM_RC__";

/// Stream guest output to `w`, watching for the exit-code sentinel. Lines
/// carrying the marker are withheld — both the echoed command line (which
/// keeps a literal `%d`, so it won't parse) and the real sentinel — and
/// the parsed code is returned. Streams line-by-line so long-running
/// commands (`logs -f`, builds) still show progress as it arrives.
///
/// This is the one-shot path only (`command.is_some()`). If the stream
/// hits EOF without ever yielding the sentinel, the shell died before the
/// command's exit code could be reported — e.g. the `su -l appliance`
/// drop failed — so return a non-zero code (255) rather than a silent
/// success-with-empty-output that would mask such breakage.
#[cfg_attr(windows, allow(dead_code))]
fn pump_until_sentinel(r: &mut impl Read, w: &mut impl Write) -> i32 {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&line);
            if text.contains(RC_MARK) {
                if let Some(code) = parse_rc(&text) {
                    return code;
                }
                continue; // echoed command line — drop it
            }
            let _ = w.write_all(&line);
            let _ = w.flush();
        }
    }
    if !buf.is_empty() {
        let text = String::from_utf8_lossy(&buf);
        if let Some(code) = parse_rc(&text) {
            return code;
        }
        if !text.contains(RC_MARK) {
            let _ = w.write_all(&buf);
        }
    }
    // EOF without a sentinel: the shell never reported the command's exit
    // code (it died first). Surface failure, not silent success.
    255
}

/// Parse `<RC_MARK><digits>__END__` out of a line, if the code is present
/// and expanded (the echoed command keeps a literal `%d` and won't parse).
#[cfg_attr(windows, allow(dead_code))]
fn parse_rc(line: &str) -> Option<i32> {
    let start = line.find(RC_MARK)? + RC_MARK.len();
    let rest = &line[start..];
    let end = rest.find("__END__")?;
    rest[..end].trim().parse::<i32>().ok()
}

/// dup a std fd into an owned `File` (unbuffered, and closing it never
/// touches the original descriptor).
#[cfg(unix)]
fn dup_file(fd: RawFd) -> Result<File> {
    let dup = unsafe { libc::dup(fd) };
    if dup < 0 {
        bail!("dup fd {fd} failed");
    }
    Ok(unsafe { File::from_raw_fd(dup) })
}

#[cfg(unix)]
fn is_tty(fd: RawFd) -> bool {
    unsafe { libc::isatty(fd) == 1 }
}

/// The controlling terminal's size, or a sane 24x80 fallback when stdout
/// isn't a tty (piped/CI).
#[cfg(unix)]
fn term_size() -> (u16, u16) {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) };
    if rc == 0 && ws.ws_row > 0 && ws.ws_col > 0 {
        (ws.ws_row, ws.ws_col)
    } else {
        (24, 80)
    }
}

/// RAII raw-mode guard for the local terminal: restores the saved
/// termios on drop (clean exit, error, or panic).
#[cfg(unix)]
struct RawMode {
    fd: RawFd,
    orig: libc::termios,
}

#[cfg(unix)]
impl RawMode {
    fn enable() -> Result<Self> {
        let fd = libc::STDIN_FILENO;
        let mut orig: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(fd, &mut orig) } != 0 {
            bail!("tcgetattr failed — is stdin a terminal?");
        }
        let mut raw = orig;
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
            bail!("tcsetattr failed");
        }
        Ok(RawMode { fd, orig })
    }
}

#[cfg(unix)]
impl Drop for RawMode {
    fn drop(&mut self) {
        unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.orig) };
    }
}

/// Base `wsl.exe -d <distro> -u <user>` invocation for the named VM,
/// with the same "is it even running?" gate the Unix client gets from
/// its socket connect.
#[cfg(windows)]
fn wsl_command(name: &str, root: bool) -> Result<std::process::Command> {
    if crate::store::read_live_pid(name).is_none() {
        bail!(
            "no shell channel for VM '{name}' — is it running? (appliance vm up)"
        );
    }
    let distro = crate::backend::wsl::distro_name(name);
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-d", &distro, "-u", if root { "root" } else { "appliance" }]);
    Ok(cmd)
}

/// The tmux socket for a privilege level — matches the vsock agent's
/// `appliance` / `appliance-root` split so the two privilege levels
/// never cross-attach, whichever client created the session.
#[cfg(windows)]
fn tmux_socket(root: bool) -> &'static str {
    if root {
        "appliance-root"
    } else {
        "appliance"
    }
}

/// Windows client: `wsl.exe` IS the PTY channel (ConPTY + exit-code
/// propagation for free), so the shell runs the same in-guest shapes
/// the vsock agent would — a login shell as the `appliance` user, a
/// one-shot `sh -lc`, or an attach-or-create tmux session.
#[cfg(windows)]
pub fn run_client(name: &str, command: Option<&str>, root: bool, session: Option<&str>) -> Result<i32> {
    let mut cmd = wsl_command(name, root)?;
    match (command, session) {
        (Some(one_shot), _) => {
            // One-shot: session is interactive-only (dropped, like the
            // Unix client); wsl.exe returns the guest command's code.
            cmd.args(["--cd", "~", "--", "sh", "-lc", one_shot]);
        }
        (None, Some(id)) => {
            validate_session_id(id)?;
            cmd.args([
                "--cd", "~", "--",
                "tmux", "-L", tmux_socket(root), "-f", "/etc/appliance/tmux.conf",
                "new-session", "-A", "-s",
            ]);
            cmd.arg(format!("appliance-{id}"));
        }
        (None, None) => {
            // Login shell: bash if the dev toolchain installed it, else sh.
            cmd.args([
                "--cd", "~", "--",
                "sh", "-lc", "command -v bash >/dev/null 2>&1 && exec bash -l; exec sh -l",
            ]);
        }
    }
    let status = cmd.status().context("run wsl.exe")?;
    Ok(status.code().unwrap_or(255))
}

/// Piped (non-interactive) wsl.exe call: never pop a console window —
/// the desktop calls these with no console of its own.
#[cfg(windows)]
fn hide_console(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// Windows session list: ask the in-guest tmux directly. A missing tmux
/// server (no sessions yet) exits non-zero — that is an empty list, not
/// an error; `parse_session_list` drops the noise either way.
#[cfg(windows)]
pub fn list_sessions(name: &str, root: bool) -> Result<Vec<SessionInfo>> {
    let mut cmd = wsl_command(name, root)?;
    hide_console(&mut cmd);
    cmd.args([
        "--",
        "tmux", "-L", tmux_socket(root), "-f", "/etc/appliance/tmux.conf",
        "list-sessions", "-F", "#{session_name} #{session_activity}",
    ]);
    let out = cmd.output().context("run wsl.exe")?;
    Ok(parse_session_list(&String::from_utf8_lossy(&out.stdout)))
}

/// Windows session kill: tmux's own exit status is the honest outcome
/// (`kill-session` exits non-zero when the id doesn't exist), so no
/// marker protocol is needed here.
#[cfg(windows)]
pub fn kill_session(name: &str, id: &str, root: bool) -> Result<bool> {
    validate_session_id(id)?;
    let mut cmd = wsl_command(name, root)?;
    hide_console(&mut cmd);
    cmd.args(["--", "tmux", "-L", tmux_socket(root), "kill-session", "-t"]);
    cmd.arg(format!("appliance-{id}"));
    let out = cmd.output().context("run wsl.exe")?;
    Ok(out.status.success())
}

// ---------------------------------------------------------------------
// Guest clock-set command. Platform-neutral (the guest is Linux under
// every backend): shared by the vz backend's resident clock-sync thread
// and the one-shot `appliance-vm sync-clock` subcommand.
// ---------------------------------------------------------------------

/// Build the busybox-compatible command that sets the guest clock to the
/// given Unix epoch seconds. Tries the epoch form first; on the busybox
/// builds where `date -s @EPOCH` isn't honoured, falls back to a
/// `-D`-typed formatted UTC string built from the same instant. Both are
/// UTC (`-u`) so the guest's timezone never enters into it.
pub fn clock_set_command(epoch_secs: u64) -> String {
    let formatted = format_utc(epoch_secs);
    format!(
        "date -u -s @{epoch_secs} 2>/dev/null \
         || date -u -D '%Y-%m-%d %H:%M:%S' -s '{formatted}' 2>/dev/null \
         || true"
    )
}

/// Parse the guest's reply to `date -u +%s` out of raw one-shot PTY
/// output (echo included): the last line that is purely ASCII digits.
/// The echoed command line contains `+%s` (non-digit) so it can never
/// match; shell banners/logout lines are skipped the same way. `None`
/// when no such line exists — callers must treat that as "clock state
/// unknown", i.e. failure, not success.
pub fn parse_epoch_output(raw: &str) -> Option<u64> {
    raw.lines().rev().find_map(|line| {
        let t = line.trim_end_matches('\r').trim();
        if t.is_empty() || !t.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        t.parse::<u64>().ok()
    })
}

/// Convert Unix epoch seconds to a `YYYY-MM-DD HH:MM:SS` UTC string, with
/// no dependency: a Howard Hinnant civil-from-days calculation for the
/// date plus plain modular arithmetic for the time of day.
fn format_utc(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let secs_of_day = epoch_secs % 86_400;
    let (hour, min, sec) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{min:02}:{sec:02}")
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian.
/// Howard Hinnant's `civil_from_days` algorithm (public domain).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_expanded_exit_code() {
        assert_eq!(parse_rc("__APPLIANCE_VM_RC__0__END__\r\n"), Some(0));
        assert_eq!(parse_rc("__APPLIANCE_VM_RC__7__END__"), Some(7));
        assert_eq!(parse_rc("x __APPLIANCE_VM_RC__42__END__ y"), Some(42));
    }

    #[test]
    fn ignores_echoed_literal_marker() {
        // The echoed command keeps a literal `%d`, which must not parse.
        assert_eq!(parse_rc("printf '__APPLIANCE_VM_RC__%d__END__' \"$?\""), None);
        assert_eq!(parse_rc("plain output line"), None);
    }

    #[test]
    fn pump_returns_code_and_withholds_sentinel() {
        let input = b"hello\n__APPLIANCE_VM_RC__3__END__\nlogout\n";
        let mut out: Vec<u8> = Vec::new();
        let code = pump_until_sentinel(&mut &input[..], &mut out);
        assert_eq!(code, 3);
        // The sentinel line (and anything after it) is withheld.
        assert_eq!(out, b"hello\n");
    }

    #[test]
    fn pump_eof_without_sentinel_is_failure() {
        // A shell that dies before the sentinel prints (e.g. the `su -l`
        // drop failed) must surface as failure, not silent success — any
        // partial output is still flushed through.
        let input = b"partial output, no sentinel\n";
        let mut out: Vec<u8> = Vec::new();
        let code = pump_until_sentinel(&mut &input[..], &mut out);
        assert_eq!(code, 255);
        assert_eq!(out, b"partial output, no sentinel\n");

        // Empty stream (shell died immediately) is failure too.
        let mut out: Vec<u8> = Vec::new();
        let code = pump_until_sentinel(&mut &b""[..], &mut out);
        assert_eq!(code, 255);
        assert!(out.is_empty());
    }

    #[test]
    fn parses_session_list_stripping_prefix_and_cr() {
        // PTY output: `appliance-<id> <activity>\r\n` per session.
        let raw = "appliance-build 1700000000\r\nappliance-notes 1700000123\r\n";
        let got = parse_session_list(raw);
        assert_eq!(
            got,
            vec![
                SessionInfo { id: "build".into(), last_activity: Some(1_700_000_000) },
                SessionInfo { id: "notes".into(), last_activity: Some(1_700_000_123) },
            ]
        );
    }

    #[test]
    fn session_list_drops_noise_and_tolerates_missing_activity() {
        // Blank lines, a non-appliance banner, and a bare name (no
        // activity field) must not crash or leak — only real sessions
        // survive, with a missing activity left as None.
        let raw = "\nno server running on /tmp/tmux-1000/appliance\nappliance-solo\n\r\n";
        let got = parse_session_list(raw);
        assert_eq!(got, vec![SessionInfo { id: "solo".into(), last_activity: None }]);
        // Empty input → empty list.
        assert!(parse_session_list("").is_empty());
    }

    #[test]
    fn session_info_serializes_compactly() {
        // The desktop/CLI consume this as JSON; a missing activity is
        // omitted rather than serialized as null.
        let with = serde_json::to_string(&SessionInfo { id: "a".into(), last_activity: Some(42) }).unwrap();
        assert_eq!(with, r#"{"id":"a","last_activity":42}"#);
        let without = serde_json::to_string(&SessionInfo { id: "a".into(), last_activity: None }).unwrap();
        assert_eq!(without, r#"{"id":"a"}"#);
    }

    #[test]
    fn validates_session_ids() {
        // Safe ids: uuids, names, dotted/underscored.
        for ok in ["build", "tab-1", "a_b.c", "550e8400-e29b-41d4-a716-446655440000"] {
            assert!(validate_session_id(ok).is_ok(), "{ok} should be valid");
        }
        // Rejected: empty, and anything that could break the single-line
        // handshake (space, newline) or the tmux target (slash, colon).
        for bad in ["", "has space", "two\nlines", "a/b", "a:b", "semi;rm"] {
            assert!(validate_session_id(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn formats_known_epochs_as_utc() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00");
        // 2009-02-13T23:31:30Z — the classic 1234567890 timestamp.
        assert_eq!(format_utc(1_234_567_890), "2009-02-13 23:31:30");
        // A leap day: 2020-02-29T12:00:00Z.
        assert_eq!(format_utc(1_582_977_600), "2020-02-29 12:00:00");
        // End-of-year boundary: 2023-12-31T23:59:59Z.
        assert_eq!(format_utc(1_704_067_199), "2023-12-31 23:59:59");
    }

    #[test]
    fn command_tries_epoch_then_formatted_fallback() {
        let cmd = clock_set_command(1_234_567_890);
        assert!(cmd.contains("date -u -s @1234567890 2>/dev/null"));
        assert!(cmd.contains("date -u -D '%Y-%m-%d %H:%M:%S' -s '2009-02-13 23:31:30' 2>/dev/null"));
        assert!(cmd.ends_with("|| true"));
    }

    #[test]
    fn parses_epoch_from_echoed_pty_output() {
        // Real one-shot shape: echoed command, the reply, a logout line —
        // with PTY \r\n endings throughout.
        let raw = "date -u +%s\r\n1234567890\r\nlogout\r\n";
        assert_eq!(parse_epoch_output(raw), Some(1_234_567_890));
        // Bare reply, no echo.
        assert_eq!(parse_epoch_output("42\n"), Some(42));
        // The LAST digit line wins (a banner containing digits+text is
        // skipped; an earlier stray number is superseded by the reply).
        assert_eq!(parse_epoch_output("999\nWelcome to VM 3\n1000\n"), Some(1000));
    }

    #[test]
    fn epoch_parse_fails_closed_without_a_digit_line() {
        // The read-back verifying a clock set must not fabricate success.
        assert_eq!(parse_epoch_output(""), None);
        assert_eq!(parse_epoch_output("date -u +%s\r\nsh: date: not found\r\n"), None);
        assert_eq!(parse_epoch_output("date: invalid option\n"), None);
    }
}
