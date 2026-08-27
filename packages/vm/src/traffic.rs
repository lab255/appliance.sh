//! Egress traffic recording.
//!
//! The proxy appends one JSON line per request decision to a bounded
//! log under the VM's state dir. The desktop reads the tail to show a
//! live traffic view — like Docker Desktop's network panel — where
//! each host can be allowed or blocked. Recording is best-effort: a
//! logging failure must never affect proxying.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::egress::RuntimePolicy;
use crate::spec::VmPaths;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrafficEvent {
    /// Unix epoch milliseconds.
    pub ts: u64,
    pub host: String,
    pub port: u16,
    /// HTTP method (CONNECT for the tunnel open, or the real verb when
    /// the request is intercepted / plain HTTP).
    pub method: String,
    /// Request path — present for intercepted (decrypted) HTTPS and
    /// plain HTTP; absent for blind CONNECT tunnels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// `allow` (blind tunnel / forwarded), `deny` (refused by policy),
    /// or `mitm` (allowed + TLS-intercepted).
    pub decision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default = "default_transport")]
    pub transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sni: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_in: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_out: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

fn default_transport() -> String {
    "tcp".to_string()
}

#[derive(Debug, Clone, Default)]
pub struct TrafficDetails<'a> {
    pub reason: Option<&'a str>,
    pub tls_version: Option<&'a str>,
    pub sni: Option<&'a str>,
    pub status: Option<u16>,
    pub bytes_in: Option<u64>,
    pub bytes_out: Option<u64>,
    pub duration_ms: Option<u64>,
}

fn events_path(name: &str) -> PathBuf {
    VmPaths::for_name(name).dir.join("egress-events.jsonl")
}

fn runtime_events_path(app: &str) -> PathBuf {
    crate::egress::runtime_root()
        .join(app)
        .join("egress-events.jsonl")
}

/// Keep the log bounded: when it grows past this, the oldest half is
/// dropped on the next write. Generous enough for an interactive
/// session's worth of traffic.
const MAX_EVENTS_BYTES: u64 = 512 * 1024;

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Append a decision to the VM's traffic log (best-effort).
pub fn record(name: &str, host: &str, port: u16, method: &str, path: Option<&str>, decision: &str) {
    let ev = TrafficEvent {
        ts: now_millis(),
        host: host.to_string(),
        port,
        method: method.to_string(),
        path: path.map(sanitize_path),
        decision: decision.to_string(),
        app: None,
        service: None,
        principal: None,
        reason: None,
        transport: default_transport(),
        tls_version: None,
        sni: None,
        status: None,
        bytes_in: None,
        bytes_out: None,
        duration_ms: None,
    };
    append_event(&events_path(name), &ev);
}

/// Record an app-scoped decision. Runtime records never share the VM log and
/// never persist query/fragment values, headers, cookies, or bodies.
pub fn record_runtime(
    runtime: &RuntimePolicy,
    host: &str,
    port: u16,
    method: &str,
    path: Option<&str>,
    decision: &str,
    details: TrafficDetails<'_>,
) {
    let ev = TrafficEvent {
        ts: now_millis(),
        host: host.to_string(),
        port,
        method: method.to_string(),
        path: path.map(sanitize_path),
        decision: decision.to_string(),
        app: Some(runtime.app.clone()),
        service: runtime.service.clone(),
        principal: Some(runtime.principal.clone()),
        reason: details.reason.map(str::to_string),
        transport: default_transport(),
        tls_version: details.tls_version.map(str::to_string),
        sni: details.sni.map(str::to_string),
        status: details.status,
        bytes_in: details.bytes_in,
        bytes_out: details.bytes_out,
        duration_ms: details.duration_ms,
    };
    append_event(&runtime_events_path(&runtime.app), &ev);
}

pub fn record_unknown(
    name: &str,
    principal: &str,
    host: &str,
    port: u16,
    method: &str,
    reason: &str,
) {
    let ev = TrafficEvent {
        ts: now_millis(),
        host: host.to_string(),
        port,
        method: method.to_string(),
        path: None,
        decision: "deny".to_string(),
        app: None,
        service: None,
        principal: Some(principal.to_string()),
        reason: Some(reason.to_string()),
        transport: default_transport(),
        tls_version: None,
        sni: None,
        status: None,
        bytes_in: None,
        bytes_out: None,
        duration_ms: None,
    };
    append_event(&events_path(name), &ev);
}

pub fn sanitize_path(target: &str) -> String {
    let without_sensitive = target.split(['?', '#']).next().unwrap_or("/");
    if let Some(scheme) = without_sensitive.find("://") {
        let after_authority = &without_sensitive[scheme + 3..];
        return after_authority
            .find('/')
            .map_or_else(|| "/".to_string(), |at| after_authority[at..].to_string());
    }
    if without_sensitive.is_empty() {
        "/".to_string()
    } else {
        without_sensitive.to_string()
    }
}

fn append_event(path: &std::path::Path, event: &TrafficEvent) {
    static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let Ok(_guard) = LOG_LOCK.get_or_init(|| Mutex::new(())).lock() else {
        return;
    };
    let Ok(line) = serde_json::to_string(event) else {
        return;
    };
    if line.len() + 1 > MAX_EVENTS_BYTES as usize {
        return;
    }
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let mut lines: Vec<String> = std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|existing| !existing.trim().is_empty())
        .map(str::to_string)
        .collect();
    lines.push(line);
    let mut bytes = lines.iter().map(|item| item.len() + 1).sum::<usize>();
    while bytes > MAX_EVENTS_BYTES as usize && !lines.is_empty() {
        bytes -= lines.remove(0).len() + 1;
    }
    let rendered = format!("{}\n", lines.join("\n"));
    let tmp = path.with_extension("jsonl.tmp");
    if write_log_file(&tmp, rendered.as_bytes()).is_ok() {
        let _ = std::fs::rename(tmp, path);
    }
}

#[cfg(unix)]
fn write_log_file(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_log_file(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

/// Drop the oldest half of the log, keeping the most recent lines.
/// Return the most recent `limit` events, oldest-first.
pub fn tail(name: &str, limit: usize) -> Vec<TrafficEvent> {
    let Ok(raw) = std::fs::read_to_string(events_path(name)) else {
        return Vec::new();
    };
    let mut events: Vec<TrafficEvent> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    if events.len() > limit {
        events.drain(0..events.len() - limit);
    }
    events
}

/// Forget all recorded traffic for a VM.
pub fn clear(name: &str) {
    let _ = std::fs::remove_file(events_path(name));
}

/// One destination's denied-egress summary, aggregated from the `deny`
/// records the boundary writes (`netstack::guard::log_deny`). Powers the
/// `egress denied` view — the blocked→allow loop that turns an opaque
/// "it hung" into "X was blocked; allow it with this command".
#[derive(Debug, Clone, PartialEq)]
pub struct DeniedHost {
    pub host: String,
    pub port: u16,
    /// How many times this destination was blocked in the scanned window.
    pub count: usize,
    /// Most-recent block, epoch milliseconds.
    pub last_seen: u64,
}

/// Aggregate the `deny` records in `events` into per-(host, port)
/// summaries, most-recently-seen first. Pure over the event slice so the
/// roll-up is unit-tested directly.
pub fn aggregate_denied(events: &[TrafficEvent]) -> Vec<DeniedHost> {
    use std::collections::BTreeMap;
    let mut by_dest: BTreeMap<(String, u16), DeniedHost> = BTreeMap::new();
    for e in events.iter().filter(|e| e.decision == "deny") {
        let entry = by_dest
            .entry((e.host.clone(), e.port))
            .or_insert(DeniedHost {
                host: e.host.clone(),
                port: e.port,
                count: 0,
                last_seen: 0,
            });
        entry.count += 1;
        entry.last_seen = entry.last_seen.max(e.ts);
    }
    let mut out: Vec<DeniedHost> = by_dest.into_values().collect();
    // Most-recent first; stable tiebreak on host so output is deterministic.
    out.sort_by(|a, b| {
        b.last_seen
            .cmp(&a.last_seen)
            .then_with(|| a.host.cmp(&b.host))
    });
    out
}

/// Read the VM's traffic log (most-recent `limit` events) and summarize
/// its denied attempts.
pub fn denied(name: &str, limit: usize) -> Vec<DeniedHost> {
    aggregate_denied(&tail(name, limit))
}

/// A coarse "N{s,m,h,d} ago" for the last-seen column. `now_ms` is passed
/// in so the rendering stays pure and deterministic under test.
fn human_ago(now_ms: u64, then_ms: u64) -> String {
    let secs = now_ms.saturating_sub(then_ms) / 1000;
    if secs < 60 {
        format!("{secs}s ago")
    } else if secs < 3600 {
        format!("{}m ago", secs / 60)
    } else if secs < 86_400 {
        format!("{}h ago", secs / 3600)
    } else {
        format!("{}d ago", secs / 86_400)
    }
}

/// Render the denied-egress report: the blocked destinations (host, port,
/// count, last-seen) followed by the exact `egress allow` command to
/// permit each — making the blocked→allow remediation loop obvious. Pure
/// (`now_ms` drives the relative last-seen) so it's unit-tested directly.
/// `is_default_vm` decides whether the hint carries a `--name <name>`.
pub fn render_denied_report(
    name: &str,
    is_default_vm: bool,
    denied: &[DeniedHost],
    now_ms: u64,
) -> String {
    if denied.is_empty() {
        return format!("No denied egress attempts recorded for '{name}'.\n");
    }
    let name_flag = if is_default_vm {
        String::new()
    } else {
        format!(" --name {name}")
    };
    let mut out = format!(
        "Denied egress attempts for '{name}' ({} blocked destination(s)):\n\n",
        denied.len()
    );
    out.push_str(&format!(
        "  {:<40} {:>5}  {:>5}  LAST SEEN\n",
        "HOST", "PORT", "COUNT"
    ));
    for d in denied {
        out.push_str(&format!(
            "  {:<40} {:>5}  {:>5}  {}\n",
            d.host,
            d.port,
            d.count,
            human_ago(now_ms, d.last_seen)
        ));
    }
    out.push_str("\nThese flows were BLOCKED by the egress boundary (default-deny).\n");
    out.push_str(
        "To permit one, allow its host and re-run the workload (the policy reloads live):\n",
    );
    for d in denied {
        out.push_str(&format!(
            "  appliance vm egress allow {}{}\n",
            d.host, name_flag
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_limits_and_parses() {
        let name = "traffic-test-unit";
        clear(name);
        // Ensure the dir exists.
        let _ = std::fs::create_dir_all(VmPaths::for_name(name).dir);
        for i in 0..5 {
            record(name, &format!("h{i}.test"), 443, "CONNECT", None, "allow");
        }
        let last3 = tail(name, 3);
        assert_eq!(last3.len(), 3);
        assert_eq!(last3[0].host, "h2.test");
        assert_eq!(last3[2].host, "h4.test");
        assert_eq!(last3[2].decision, "allow");
        clear(name);
    }

    #[test]
    fn records_path_for_intercepted() {
        let name = "traffic-test-path";
        clear(name);
        let _ = std::fs::create_dir_all(VmPaths::for_name(name).dir);
        record(
            name,
            "api.example.com",
            443,
            "GET",
            Some("/v1/models"),
            "mitm",
        );
        let evs = tail(name, 10);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].path.as_deref(), Some("/v1/models"));
        assert_eq!(evs[0].decision, "mitm");
        clear(name);
    }

    #[test]
    fn persisted_paths_strip_query_fragment_and_absolute_authority() {
        assert_eq!(sanitize_path("/v1/items?token=secret#part"), "/v1/items");
        assert_eq!(
            sanitize_path("https://api.example.com/v1/items?q=secret"),
            "/v1/items"
        );
        assert_eq!(sanitize_path("https://api.example.com?q=secret"), "/");
    }

    fn ev(host: &str, port: u16, decision: &str, ts: u64) -> TrafficEvent {
        TrafficEvent {
            ts,
            host: host.to_string(),
            port,
            method: if decision == "deny" {
                "DENY".into()
            } else {
                "CONNECT".into()
            },
            path: None,
            decision: decision.to_string(),
            app: None,
            service: None,
            principal: None,
            reason: None,
            transport: default_transport(),
            tls_version: None,
            sni: None,
            status: None,
            bytes_in: None,
            bytes_out: None,
            duration_ms: None,
        }
    }

    #[test]
    fn aggregate_denied_counts_groups_and_orders_by_recency() {
        let events = vec![
            ev("allowed.test", 443, "allow", 10), // ignored — only denies count
            ev("exfil.evil.test", 443, "deny", 100),
            ev("exfil.evil.test", 443, "deny", 300), // newest for this host
            ev("exfil.evil.test", 443, "deny", 200),
            ev("registry.example.com", 443, "deny", 150),
        ];
        let summary = aggregate_denied(&events);
        assert_eq!(summary.len(), 2);
        // exfil is most-recently-seen (ts=300) → first.
        assert_eq!(summary[0].host, "exfil.evil.test");
        assert_eq!(summary[0].count, 3);
        assert_eq!(summary[0].last_seen, 300);
        assert_eq!(summary[1].host, "registry.example.com");
        assert_eq!(summary[1].count, 1);
    }

    #[test]
    fn render_denied_report_shows_counts_and_remediation_hint() {
        let now = 1_000_000;
        let denied = vec![
            DeniedHost {
                host: "exfil.evil.test".into(),
                port: 443,
                count: 7,
                last_seen: now - 12_000,
            },
            DeniedHost {
                host: "registry.example.com".into(),
                port: 443,
                count: 2,
                last_seen: now - 5 * 60_000,
            },
        ];
        let out = render_denied_report("appliance", true, &denied, now);
        // The blocked destinations, with count + a relative last-seen.
        assert!(out.contains("exfil.evil.test"));
        assert!(out.contains("12s ago"));
        assert!(out.contains("5m ago"));
        assert!(out.contains("blocked destination(s)"));
        // The obvious blocked→allow remediation command (default VM: no --name).
        assert!(out.contains("appliance vm egress allow exfil.evil.test"));
        assert!(out.contains("appliance vm egress allow registry.example.com"));
        assert!(!out.contains("--name"));
    }

    #[test]
    fn render_denied_report_names_non_default_vm_in_hint() {
        let denied = vec![DeniedHost {
            host: "x.test".into(),
            port: 443,
            count: 1,
            last_seen: 0,
        }];
        let out = render_denied_report("agent", false, &denied, 1_000);
        assert!(out.contains("appliance vm egress allow x.test --name agent"));
    }

    #[test]
    fn render_denied_report_empty_is_reassuring() {
        let out = render_denied_report("appliance", true, &[], 1_000);
        assert!(out.contains("No denied egress attempts"));
        assert!(!out.contains("egress allow"));
    }
}
