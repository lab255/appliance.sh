//! One-shot guest command transport over the vsock shell channel.
//!
//! Lifted verbatim from the bring-up credential mint (mint.rs) so other
//! host-internal callers — the runtime doctor's clock-skew probe, the
//! support-bundle log tail — can run a command inside the guest and
//! parse what it said, without duplicating the marker protocol.
//!
//! The one-shot shell channel is a PTY: it echoes the command line
//! (which may wrap at the guest terminal width, scattering fragments of
//! it into the stream). The payload is delimited with markers the guest
//! EXPANDS from a variable — `"$M"` in the echoed command never matches
//! the expanded marker in the real output, so extraction is unambiguous
//! without any echo-suppression games.

use crate::shell;

const MARK: &str = "APPLIANCE-EXEC-7f3a";

fn begin_mark() -> String {
    format!("{MARK}:BEGIN")
}
fn end_mark() -> String {
    format!("{MARK}:END")
}

/// Wrap `cmd` so its stdout+stderr travel between expanded markers and
/// its exit status becomes the one-shot's exit code.
fn wrap_command(cmd: &str) -> String {
    format!(
        "M={MARK}; OUT=$({cmd} 2>&1); RC=$?; printf '%s:BEGIN\\n%s\\n%s:END\\n' \"$M\" \"$OUT\" \"$M\"; [ \"$RC\" -eq 0 ]"
    )
}

/// Extract the payload between the LAST begin marker and the first end
/// marker after it, with PTY carriage returns stripped. `None` when the
/// markers never made it through (shell died, wrapping mangled).
fn extract_payload(raw: &str) -> Option<String> {
    let cleaned = raw.replace('\r', "");
    let begin = begin_mark();
    let start = cleaned.rfind(&begin)? + begin.len();
    let rest = &cleaned[start..];
    let end = rest.find(&end_mark())?;
    Some(rest[..end].trim().to_string())
}

/// Run a command inside the guest as root over the shell channel and
/// return its output. Errors cover: no channel yet, the command failing
/// (non-zero exit), or the payload markers not surviving the PTY.
pub fn run_wrapped(name: &str, cmd: &str) -> Result<String, String> {
    let (code, raw) = shell::run_captured(name, &wrap_command(cmd), true)
        .map_err(|e| format!("shell channel: {e:#}"))?;
    let payload = extract_payload(&raw);
    if code != 0 {
        return Err(format!(
            "guest command exited {code}: {}",
            payload.unwrap_or_else(|| "<no output>".to_string())
        ));
    }
    payload.ok_or_else(|| "guest output markers missing".to_string())
}

/// Send one structured Runtime lifecycle request over the existing
/// root vsock one-shot. JSON is shell-quoted as data; the guest
/// supervisor parses it with jq and returns either structured status
/// or captured log text. Long-lived lifecycle is guest-owned — this
/// transport never keeps the PTY connection open after reconciliation.
pub fn runtime_request(name: &str, request_json: &str) -> Result<String, String> {
    let quoted = shell_single_quote(request_json);
    run_wrapped(
        name,
        &format!("/usr/local/bin/appliance-runtime-supervisor {quoted}"),
    )
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_payload_between_expanded_markers() {
        // Simulated PTY stream: echoed (wrapped) command line carrying
        // the UNexpanded "$M" forms, then the real expanded markers.
        let raw = "M=APPLIANCE-EXEC-7f3a; OUT=$(wget -qO- http://127.0.0.1:9\r\n\
                   091/bootstrap/status 2>&1); printf '%s:BEGIN\\n%s\\n%s:END\r\n\
                   APPLIANCE-EXEC-7f3a:BEGIN\r\n\
                   {\"initialized\":false}\r\n\
                   APPLIANCE-EXEC-7f3a:END\r\n";
        assert_eq!(
            extract_payload(raw).as_deref(),
            Some("{\"initialized\":false}")
        );
    }

    #[test]
    fn missing_markers_yield_none() {
        assert_eq!(extract_payload("shell died before printing\n"), None);
        // A begin without an end (stream truncated) is also a miss.
        assert_eq!(
            extract_payload("APPLIANCE-EXEC-7f3a:BEGIN\npartial"),
            None
        );
    }

    #[test]
    fn wrapped_command_binds_payload_to_exit_status() {
        let wrapped = wrap_command("wget -qO- http://x/status");
        // The guest expands $M; the literal marker with suffix must not
        // appear pre-expansion, or the echoed command would false-match.
        assert!(!wrapped.contains(&begin_mark()));
        assert!(wrapped.contains("RC=$?"));
        assert!(wrapped.ends_with("[ \"$RC\" -eq 0 ]"));
    }

    #[test]
    fn runtime_json_is_shell_quoted_as_data() {
        assert_eq!(shell_single_quote(r#"{"env":"it's data"}"#), r#"'{"env":"it'\''s data"}'"#);
    }
}
