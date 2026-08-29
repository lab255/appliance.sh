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
    append_legacy_event(&events_path(name), &ev);
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
    append_runtime_event(&runtime_events_path(&runtime.app), &ev);
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
    append_legacy_event(&events_path(name), &ev);
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

fn serialized_event(event: &TrafficEvent) -> Option<String> {
    let line = serde_json::to_string(event).ok()?;
    (line.len() < MAX_EVENTS_BYTES as usize).then_some(line)
}

fn with_log_lock(operation: impl FnOnce()) {
    static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let Ok(_guard) = LOG_LOCK.get_or_init(|| Mutex::new(())).lock() else {
        return;
    };
    operation();
}

/// Preserve the historical VM log behavior: cheap O_APPEND writes and, once
/// oversized, discard the oldest half before the next append.
fn append_legacy_event(path: &std::path::Path, event: &TrafficEvent) {
    let Some(line) = serialized_event(event) else {
        return;
    };
    with_log_lock(|| {
        if std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > MAX_EVENTS_BYTES) {
            let _ = halve_log(path);
        }
        let _ = append_line(path, &line);
    });
}

/// Runtime logs append in the common case and compact to the exact ring cap
/// only after the append crosses 512 KiB.
fn append_runtime_event(path: &std::path::Path, event: &TrafficEvent) {
    let Some(line) = serialized_event(event) else {
        return;
    };
    with_log_lock(|| {
        if append_line(path, &line).is_ok_and(|len| len > MAX_EVENTS_BYTES) {
            let _ = compact_runtime_log(path);
        }
    });
}

fn append_line(path: &std::path::Path, line: &str) -> std::io::Result<u64> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    writeln!(file, "{line}")?;
    Ok(file.metadata()?.len())
}

fn halve_log(path: &std::path::Path) -> std::io::Result<()> {
    let raw = std::fs::read(path)?;
    let midpoint = raw.len() / 2;
    let keep_from = raw[midpoint..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(raw.len(), |offset| midpoint + offset + 1);
    write_log_file(path, &raw[keep_from..])
}

fn compact_runtime_log(path: &std::path::Path) -> std::io::Result<()> {
    let raw = std::fs::read(path)?;
    if raw.len() <= MAX_EVENTS_BYTES as usize {
        return Ok(());
    }
    let floor = raw.len() - MAX_EVENTS_BYTES as usize;
    let keep_from = raw[floor..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(raw.len(), |offset| floor + offset + 1);
    let tmp = path.with_extension("jsonl.tmp");
    write_log_file(&tmp, &raw[keep_from..])?;
    std::fs::rename(tmp, path)
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

/// Return the most recent `limit` events, oldest-first.
pub fn tail(name: &str, limit: usize) -> Vec<TrafficEvent> {
    tail_path(&events_path(name), limit)
}

/// Return the most recent app-scoped runtime events, oldest-first.
#[cfg(test)]
pub fn tail_runtime(app: &str, limit: usize) -> Vec<TrafficEvent> {
    tail_path(&runtime_events_path(app), limit)
}

fn tail_path(path: &std::path::Path, limit: usize) -> Vec<TrafficEvent> {
    let Ok(raw) = std::fs::read_to_string(path) else {
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
/// `netstack` distinguishes the hard boundary from the cooperative proxy.
pub fn render_denied_report(
    name: &str,
    is_default_vm: bool,
    netstack: bool,
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
    if netstack {
        out.push_str("\nThese flows were BLOCKED by the egress boundary (default-deny).\n");
    } else {
        out.push_str(
            "\nThese flows were BLOCKED by the cooperative egress proxy (bypassable from the guest).\n",
        );
    }
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
    fn legacy_halves_only_when_oversized_and_runtime_compacts_after_append() {
        let dir = std::env::temp_dir().join(format!(
            "appliance-traffic-ring-{}-{}",
            std::process::id(),
            now_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let seed = vec![b'x'; MAX_EVENTS_BYTES as usize + 100];

        let legacy = dir.join("legacy.jsonl");
        std::fs::write(&legacy, &seed).unwrap();
        append_legacy_event(&legacy, &ev("legacy.test", 443, "allow", 1));
        let legacy_len = std::fs::metadata(&legacy).unwrap().len();
        assert!(legacy_len < MAX_EVENTS_BYTES, "legacy log was halved");

        let runtime = dir.join("runtime.jsonl");
        let mut runtime_seed = Vec::with_capacity(seed.len());
        while runtime_seed.len() <= MAX_EVENTS_BYTES as usize {
            runtime_seed.extend_from_slice(b"{}\n");
        }
        std::fs::write(&runtime, runtime_seed).unwrap();
        let latest = ev("runtime.test", 443, "deny", 2);
        append_runtime_event(&runtime, &latest);
        assert!(std::fs::metadata(&runtime).unwrap().len() <= MAX_EVENTS_BYTES);
        let raw = std::fs::read_to_string(&runtime).unwrap();
        assert_eq!(
            serde_json::from_str::<TrafficEvent>(raw.lines().last().unwrap()).unwrap(),
            latest
        );

        std::fs::remove_dir_all(dir).unwrap();
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
        let out = render_denied_report("appliance", true, true, &denied, now);
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
        let out = render_denied_report("agent", false, false, &denied, 1_000);
        assert!(out.contains(
            "BLOCKED by the cooperative egress proxy (bypassable from the guest)."
        ));
        assert!(out.contains("appliance vm egress allow x.test --name agent"));
    }

    #[test]
    fn render_denied_report_empty_is_reassuring() {
        let out = render_denied_report("appliance", true, true, &[], 1_000);
        assert!(out.contains("No denied egress attempts"));
        assert!(!out.contains("egress allow"));
    }
}
