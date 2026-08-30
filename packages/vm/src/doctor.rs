//! Engine-side runtime doctor: `appliance-vm doctor --vm-checks <name>`.
//!
//! The engine owns the two probes only it can run — they ride the vsock
//! shell channel, which works before (and independently of) k3s and the
//! ingress:
//!
//!   * guest clock skew vs the host (the source of the opaque signed-
//!     request 401s: the api-server verifies signature timestamps with
//!     a 15s tolerance);
//!   * guest api-server reachability at 127.0.0.1:9091, bypassing the
//!     whole host→ingress path — which lets the CLI triangulate a 401
//!     ("server up + clock fine ⇒ the key is unknown").
//!
//! Output is a JSON report whose findings use the same shape the CLI's
//! runtime doctor renders ({id, title, severity, detail, remediation}),
//! so the CLI folds them in verbatim. The CLI feature-detects this
//! command (an old engine rejects the flag) and skips engine checks
//! gracefully.

use crate::guest_exec::run_wrapped;
use crate::{mint, store};
use serde::Serialize;

/// The api-server's signed-request clock tolerance (sdk signing
/// `tolerance: 15` — packages/sdk/src/signing/index.ts). Skew at or
/// beyond this means every signed request 401s.
const SIGNATURE_TOLERANCE_SECS: i64 = 15;
/// Skew worth flagging before it reaches the hard tolerance.
const SKEW_WARN_SECS: i64 = 10;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Ok,
    Info,
    Warn,
    Fail,
}

/// One finding, shaped exactly like the CLI runtime doctor's schema so
/// the CLI can merge engine findings without translation.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub title: String,
    pub severity: Severity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

impl Finding {
    fn new(id: &str, title: &str, severity: Severity, detail: String) -> Self {
        Self {
            id: id.to_string(),
            title: title.to_string(),
            severity,
            detail: Some(detail),
            remediation: None,
        }
    }
    fn remedy(mut self, r: String) -> Self {
        self.remediation = Some(r);
        self
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub vm: String,
    /// This engine binary's version — lets the CLI report host/engine
    /// version skew in one place.
    pub engine_version: &'static str,
    pub exists: bool,
    pub running: bool,
    /// guest clock minus host clock, seconds (positive = guest ahead).
    /// Absent when the guest probe couldn't run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clock_skew_seconds: Option<i64>,
    /// The guest api-server's own bootstrap state (has the key store
    /// ever been initialized?). Absent when unreachable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bootstrap_initialized: Option<bool>,
    pub findings: Vec<Finding>,
}

/// Run the engine's runtime checks against one VM. Never fails — every
/// probe error degrades to a finding, so the CLI always gets a full
/// report to fold in.
pub fn run_vm_checks(name: &str) -> Report {
    let spec = store::load_spec(name).ok().flatten();
    let running = store::read_live_pid(name).is_some();
    let mut report = Report {
        vm: name.to_string(),
        engine_version: env!("CARGO_PKG_VERSION"),
        exists: spec.is_some(),
        running,
        clock_skew_seconds: None,
        bootstrap_initialized: None,
        findings: Vec::new(),
    };

    if spec.is_none() {
        report.findings.push(
            Finding::new(
                "engine:vm",
                "VM definition",
                Severity::Fail,
                format!("no VM named '{name}' is defined on this host"),
            )
            .remedy(format!("appliance vm up{}", name_flag(name))),
        );
        return report;
    }
    if !running {
        report.findings.push(
            Finding::new(
                "engine:vm",
                "VM running",
                Severity::Info,
                format!("VM '{name}' is not running — guest checks skipped"),
            )
            .remedy(format!("appliance vm up{}", name_flag(name))),
        );
        return report;
    }
    report.findings.push(Finding::new(
        "engine:vm",
        "VM running",
        Severity::Ok,
        format!("VM '{name}' is running"),
    ));

    // --- clock skew (guest vs host) --------------------------------
    match guest_clock_skew(name) {
        Ok(skew) => {
            report.clock_skew_seconds = Some(skew);
            report.findings.push(skew_finding(skew));
        }
        Err(e) => report.findings.push(Finding::new(
            "engine:clock-skew",
            "Guest clock vs host",
            Severity::Warn,
            format!("could not read the guest clock: {e}"),
        )),
    }

    // WSL reaches the host-bound egress proxy through vEthernet (WSL).
    // Windows Defender Firewall can block that inbound hop even though
    // the proxy is correctly listening on 0.0.0.0, so probe from the
    // distro and name the firewall boundary explicitly.
    #[cfg(windows)]
    report.findings.push(wsl_host_proxy_finding(name, spec.as_ref().unwrap().egress_port));
    #[cfg(windows)]
    report.findings.push(wsl_guest_policy_finding(name));

    if let Some(finding) = guest_seed_warning_finding(name) {
        report.findings.push(finding);
    }

    // --- guest api-server reachability ------------------------------
    let agent_only = spec.as_ref().is_some_and(|s| s.agent_only);
    if agent_only {
        report.findings.push(Finding::new(
            "engine:apiserver",
            "Guest api-server (in-VM probe)",
            Severity::Info,
            "agent-only VM — no api-server control plane to probe".to_string(),
        ));
    } else {
        match mint::probe_initialized(name) {
            Ok(initialized) => {
                report.bootstrap_initialized = Some(initialized);
                report.findings.push(Finding::new(
                    "engine:apiserver",
                    "Guest api-server (in-VM probe)",
                    Severity::Ok,
                    format!(
                        "answering inside the guest (key store {})",
                        if initialized { "initialized" } else { "EMPTY — no keys minted yet" }
                    ),
                ));
            }
            Err(e) => report.findings.push(
                Finding::new(
                    "engine:apiserver",
                    "Guest api-server (in-VM probe)",
                    Severity::Fail,
                    format!("not answering inside the guest: {e}"),
                )
                .remedy(format!(
                    "check the guest log: appliance vm console{} (the api-server may still be starting, or was never staged)",
                    name_flag(name)
                )),
            ),
        }
    }

    report
}

/// ` --name <vm>` suffix for remediation commands — the default VM's
/// commands take no flag.
fn name_flag(name: &str) -> String {
    if name == crate::spec::DEFAULT_VM_NAME {
        String::new()
    } else {
        format!(" --name {name}")
    }
}

/// Guest epoch seconds via `date +%s`, compared against the host clock.
/// Positive = guest ahead of host. The vsock round-trip takes real time,
/// so the host clock is sampled before AND after and the guest reading
/// is compared against the midpoint — halving the round-trip's bias in
/// the reported skew.
fn guest_clock_skew(name: &str) -> Result<i64, String> {
    let before = host_epoch_secs()?;
    let out = run_wrapped(name, "date +%s")?;
    let after = host_epoch_secs()?;
    let guest: i64 = out
        .trim()
        .parse()
        .map_err(|e| format!("unparseable guest 'date +%s' output {out:?}: {e}"))?;
    let midpoint = before + (after - before) / 2;
    Ok(guest - midpoint)
}

fn host_epoch_secs() -> Result<i64, String> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "host clock is before the Unix epoch".to_string())?
        .as_secs() as i64)
}

/// Pure skew classification: within 10s is healthy; beyond the 15s
/// signature tolerance every signed request 401s.
fn skew_finding(skew: i64) -> Finding {
    let abs = skew.abs();
    let direction = if skew >= 0 { "ahead of" } else { "behind" };
    if abs <= SKEW_WARN_SECS {
        Finding::new(
            "engine:clock-skew",
            "Guest clock vs host",
            Severity::Ok,
            format!("guest clock is {abs}s {direction} the host (within tolerance)"),
        )
    } else if abs < SIGNATURE_TOLERANCE_SECS {
        Finding::new(
            "engine:clock-skew",
            "Guest clock vs host",
            Severity::Warn,
            format!(
                "guest clock is {abs}s {direction} the host — approaching the {SIGNATURE_TOLERANCE_SECS}s signature tolerance"
            ),
        )
        .remedy("restart the VM (`appliance vm stop && appliance vm up`) — the engine re-syncs the guest clock at boot and every 30s".to_string())
    } else {
        Finding::new(
            "engine:clock-skew",
            "Guest clock vs host",
            Severity::Fail,
            format!(
                "guest clock is {abs}s {direction} the host — beyond the {SIGNATURE_TOLERANCE_SECS}s signature tolerance, signed requests will 401"
            ),
        )
        .remedy("restart the VM (`appliance vm stop && appliance vm up`) — the engine re-syncs the guest clock at boot and every 30s".to_string())
    }
}

fn guest_seed_warning_finding(name: &str) -> Option<Finding> {
    let output = run_wrapped(
        name,
        "if [ -s /persist/.apiserver-seed-warning ]; then cat /persist/.apiserver-seed-warning; fi",
    )
    .ok()?;
    classify_seed_warning(output.trim())
}

fn classify_seed_warning(detail: &str) -> Option<Finding> {
    if detail.is_empty() {
        return None;
    }
    let refused = detail.contains("refused");
    Some(
        Finding::new(
            "engine:apiserver-seed",
            "Guest control-plane seed verification",
            if refused { Severity::Fail } else { Severity::Warn },
            detail.to_string(),
        )
        .remedy(
            "restage with `appliance vm up`, then restart the VM; inspect /var/log/appliance-api-server.log if the finding remains"
                .to_string(),
        ),
    )
}

#[cfg(windows)]
fn wsl_host_proxy_finding(name: &str, port: u16) -> Finding {
    let gateway = std::fs::read_to_string(crate::spec::VmPaths::for_name(name).gateway_ip())
        .ok()
        .and_then(|raw| raw.trim().parse::<std::net::Ipv4Addr>().ok());
    let Some(gateway) = gateway else {
        return proxy_reachability_finding(
            port,
            "the WSL gateway has not been recorded yet".to_string(),
            false,
        );
    };
    let command = format!("nc -z -w 3 {gateway} {port}");
    match run_wrapped(name, &command) {
        Ok(_) => proxy_reachability_finding(port, format!("{gateway}:{port} answered from WSL"), true),
        Err(error) => proxy_reachability_finding(
            port,
            format!("could not reach {gateway}:{port} from WSL: {error}"),
            false,
        ),
    }
}

/// Pure rendering seam for the Windows-only dial, kept host-independent so
/// the actionable Defender Firewall text is covered on every CI platform.
#[cfg_attr(not(windows), allow(dead_code))]
fn proxy_reachability_finding(port: u16, detail: String, reachable: bool) -> Finding {
    if reachable {
        Finding::new(
            "engine:wsl-host-proxy",
            "WSL access to host egress proxy",
            Severity::Ok,
            detail,
        )
    } else {
        Finding::new(
            "engine:wsl-host-proxy",
            "WSL access to host egress proxy",
            Severity::Fail,
            detail,
        )
        .remedy(format!(
            "allow inbound TCP port {port} for appliance-vm.exe on `vEthernet (WSL)` in Windows Defender Firewall, then retry"
        ))
    }
}

#[cfg(windows)]
fn wsl_guest_policy_finding(name: &str) -> Finding {
    const MARKER: &str = "__APPLIANCE_WSL_MOUNTS__\n";
    let probe = run_wrapped(
        name,
        "cat /etc/wsl.conf 2>&1; printf '__APPLIANCE_WSL_MOUNTS__\\n'; mount",
    );
    match probe
        .and_then(|output| evaluate_wsl_guest_policy(&output, crate::backend::WSL_CONF, MARKER))
    {
        Ok(detail) => Finding::new(
            "engine:wsl-guest-policy",
            "WSL automount confinement",
            Severity::Ok,
            detail,
        ),
        Err(detail) => Finding::new(
            "engine:wsl-guest-policy",
            "WSL automount confinement",
            Severity::Fail,
            detail,
        )
        .remedy(
            "appliance vm stop && appliance vm up (or destroy the VM and run appliance vm up)"
                .to_string(),
        ),
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn evaluate_wsl_guest_policy(
    output: &str,
    expected_conf: &str,
    marker: &str,
) -> Result<String, String> {
    let (actual_conf, mounts) = output
        .split_once(marker)
        .ok_or_else(|| "guest policy probe returned malformed output".to_string())?;
    if actual_conf != expected_conf {
        return Err("/etc/wsl.conf does not match the appliance automount policy".to_string());
    }
    let unexpected = unexpected_drvfs_mounts(mounts);
    if !unexpected.is_empty() {
        return Err(format!(
            "Windows-source shares are mounted outside appliance-managed targets: {}",
            unexpected.join(", ")
        ));
    }
    Ok("/etc/wsl.conf matches policy and Windows-source mounts are confined".to_string())
}

fn unexpected_drvfs_mounts(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let (mount, filesystem_and_options) = line.rsplit_once(" type ")?;
            let (source, target) = mount.rsplit_once(" on ")?;
            let filesystem = filesystem_and_options.split_whitespace().next().unwrap_or_default();
            let is_drvfs = filesystem == "drvfs"
                || filesystem_and_options.contains("aname=drvfs")
                || (matches!(filesystem, "9p" | "virtiofs") && is_windows_mount_source(source));
            let source_is_drive_root =
                crate::backend::runtime_guest::is_wsl_drive_root(source);
            let allowed = target == "/persist/workspace"
                || target
                    .strip_prefix("/run/appliance/shares/")
                    .is_some_and(|tag| {
                        let hex = tag.strip_prefix("ap-").unwrap_or_default();
                        !source_is_drive_root
                            && !hex.is_empty()
                            && hex.len() <= 32
                            && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
                    });
            (is_drvfs && !allowed).then(|| target.to_string())
        })
        .collect()
}

fn is_windows_mount_source(source: &str) -> bool {
    let source = crate::backend::runtime_guest::strip_verbatim(source);
    let bytes = source.as_bytes();
    source.starts_with(r"\\")
        || source.starts_with("//")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/'))
}

// --- support-bundle log tail -------------------------------------------

/// Tail the guest api-server log for a support bundle, scrubbed of
/// secret-shaped tokens. The log can carry auth diagnostics next to
/// requests that embedded credentials, so the scrub is unconditional.
pub fn apiserver_log_tail(name: &str, max_bytes: usize) -> Result<String, String> {
    let cmd = format!(
        "if [ -f /var/log/appliance-api-server.log ]; then tail -c {max_bytes} /var/log/appliance-api-server.log; else echo '(no api-server log in this VM)'; fi"
    );
    Ok(scrub_secrets(&run_wrapped(name, &cmd)?))
}

/// Replace secret-shaped tokens in free text:
///   * hex runs of 32+ chars (bootstrap tokens, api-key secrets);
///   * JWT-shaped `eyJ…` words (the api-server's ServiceAccount token).
///
/// Word-at-a-time scan over `[A-Za-z0-9_./-]` runs — no regex crate.
pub fn scrub_secrets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.') {
            word.push(c);
        } else {
            flush_word(&mut out, &mut word);
            out.push(c);
        }
    }
    flush_word(&mut out, &mut word);
    out
}

fn flush_word(out: &mut String, word: &mut String) {
    if word.is_empty() {
        return;
    }
    if is_secret_shaped(word) {
        out.push_str(&format!("<scrubbed:{}ch>", word.len()));
    } else {
        out.push_str(word);
    }
    word.clear();
}

/// Pure token classification for the scrubber. Keep in sync with
/// scrubLogText in packages/cli/src/utils/doctor-bundle.ts.
fn is_secret_shaped(word: &str) -> bool {
    // Long hex run: bootstrap token (64 hex).
    if word.len() >= 32 && word.chars().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    // Minted api-key secrets are `sk_` + 64 hex (api-key.service.ts) —
    // the s/k/_ keep the word from passing the plain hex test above, so
    // the prefix is stripped and the remainder hex-tested. `sk-` covers
    // the OpenAI-style spelling as well.
    if let Some(rest) = word.strip_prefix("sk_").or_else(|| word.strip_prefix("sk-")) {
        if rest.len() >= 32 && rest.chars().all(|c| c.is_ascii_hexdigit()) {
            return true;
        }
    }
    // JWT: three dot-separated base64url segments starting with the
    // `{"` header ("eyJ"). ServiceAccount tokens are exactly this.
    if word.starts_with("eyJ") && word.len() >= 20 && word.matches('.').count() >= 1 {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skew_within_ten_seconds_is_healthy() {
        for skew in [0, 3, -9, 10, -10] {
            assert_eq!(skew_finding(skew).severity, Severity::Ok, "skew {skew}");
        }
    }

    #[test]
    fn skew_between_tolerance_bounds_warns() {
        for skew in [11, -11, 14, -14] {
            let f = skew_finding(skew);
            assert_eq!(f.severity, Severity::Warn, "skew {skew}");
            assert!(f.remediation.is_some(), "a warn carries the restart remediation");
        }
    }

    #[test]
    fn skew_beyond_signature_tolerance_fails() {
        // 15s IS the api-server's tolerance: at/beyond it every signed
        // request 401s, so this is a hard failure, not a warning.
        for skew in [15, -15, 120, -3600] {
            let f = skew_finding(skew);
            assert_eq!(f.severity, Severity::Fail, "skew {skew}");
            assert!(f.detail.as_deref().unwrap_or("").contains("401"));
        }
    }

    #[test]
    fn refused_seed_marker_is_a_hard_doctor_finding() {
        let finding = classify_seed_warning(
            "signed control-plane seed digest/size mismatch; api-server start refused",
        )
        .unwrap();
        assert_eq!(finding.severity, Severity::Fail);
        assert_eq!(finding.id, "engine:apiserver-seed");
    }

    #[test]
    fn unsigned_pre_mv0_seed_marker_warns() {
        let finding = classify_seed_warning(
            "unsigned pre-MV0 control-plane seed accepted; self-update disabled",
        )
        .unwrap();
        assert_eq!(finding.severity, Severity::Warn);
    }

    #[test]
    fn console_only_seed_marker_warns_while_api_remains_available() {
        let finding = classify_seed_warning(
            "signed console bundle digest/size mismatch; console skipped (api-server remains headless)",
        )
        .unwrap();
        assert_eq!(finding.severity, Severity::Warn);
    }

    #[test]
    fn wsl_proxy_failure_names_the_defender_firewall_boundary() {
        let finding = proxy_reachability_finding(
            5053,
            "could not reach 172.25.64.1:5053 from WSL".to_string(),
            false,
        );
        assert_eq!(finding.severity, Severity::Fail);
        let remediation = finding.remediation.unwrap();
        assert!(remediation.contains("Windows Defender Firewall"));
        assert!(remediation.contains("vEthernet (WSL)"));
        assert!(remediation.contains("5053"));
    }

    #[test]
    fn findings_serialize_in_the_cli_schema() {
        // The CLI merges these verbatim: camelCase fields, lowercase
        // severity, absent optionals omitted (not null).
        let json = serde_json::to_string(&skew_finding(0)).unwrap();
        assert!(json.contains("\"id\":\"engine:clock-skew\""));
        assert!(json.contains("\"severity\":\"ok\""));
        assert!(!json.contains("remediation"), "absent remediation is omitted");
        let json = serde_json::to_string(&skew_finding(120)).unwrap();
        assert!(json.contains("\"severity\":\"fail\""));
        assert!(json.contains("\"remediation\":"));
    }

    #[test]
    fn parses_wsl_mount_output_and_rejects_drvfs_outside_managed_targets() {
        const CONF: &str = "[automount]\nenabled=false\n\n[interop]\nenabled=false\nappendWindowsPath=false\n";
        let mounts = "C:\\payload on /run/appliance/shares/ap-0123 type 9p (ro,aname=drvfs;path=C:\\payload)\n\
                      D:\\work on /persist/workspace type drvfs (rw,metadata)\n\
                      C:\\ on /mnt/c type 9p (rw,aname=drvfs;path=C:\\)\n\
                      tmpfs on /run type tmpfs (rw)\n";
        assert_eq!(unexpected_drvfs_mounts(mounts), vec!["/mnt/c"]);

        let output = format!("{CONF}__MARK__\n{mounts}");
        let error =
            evaluate_wsl_guest_policy(&output, CONF, "__MARK__\n").unwrap_err();
        assert!(error.contains("/mnt/c"));

        let allowed = mounts.replace(
            "C:\\ on /mnt/c type 9p (rw,aname=drvfs;path=C:\\)\n",
            "",
        );
        let output = format!("{CONF}__MARK__\n{allowed}");
        assert!(evaluate_wsl_guest_policy(&output, CONF, "__MARK__\n").is_ok());
    }

    #[test]
    fn rejects_plain_windows_mounts_and_drive_root_appliance_shares() {
        let mounts = "C:\\payload on /foreign type 9p (ro)\n\
                      D:\\payload on /foreign-vfs type virtiofs (ro)\n\
                      E:\\ on /run/appliance/shares/ap-0123 type drvfs (ro)\n\
                      appliance-tag on /run/appliance/shares/ap-abcd type virtiofs (ro)\n";
        assert_eq!(
            unexpected_drvfs_mounts(mounts),
            vec!["/foreign", "/foreign-vfs", "/run/appliance/shares/ap-0123"]
        );
    }

    #[test]
    fn scrubs_long_hex_tokens() {
        let token = "9f".repeat(32); // 64 hex chars, the bootstrap-token shape
        let text = format!("X-Bootstrap-Token: {token} accepted");
        let scrubbed = scrub_secrets(&text);
        assert!(!scrubbed.contains(&token), "the token must not survive");
        assert!(scrubbed.contains("<scrubbed:64ch>"));
        assert!(scrubbed.contains("X-Bootstrap-Token:"), "context survives");
    }

    #[test]
    fn scrubs_sk_prefixed_minted_secrets() {
        // Minted secrets are `sk_` + 64 hex (api-key.service.ts): the
        // `_` keeps the word intact and the s/k defeat a plain hex test,
        // so they need their own rule. A mint error path can paint the
        // full response — secret included — into host.log.
        let minted = format!("sk_{}", "5f".repeat(32));
        let scrubbed = scrub_secrets(&format!("mint response: secret={minted} status=500\n"));
        assert!(!scrubbed.contains(&minted), "the minted secret must not survive");
        assert!(scrubbed.contains("<scrubbed:67ch>"));
        assert!(scrubbed.contains("status=500"), "context survives");

        // OpenAI-style `sk-` + hex gets the same treatment.
        let openai = format!("sk-{}", "ab".repeat(20));
        assert!(!scrub_secrets(&openai).contains(&openai));

        // Short sk_-words are ordinary identifiers, not secrets.
        let text = "sk_live sk_test_short sk-1234abcd";
        assert_eq!(scrub_secrets(text), text);
    }

    #[test]
    fn scrubs_jwt_shaped_tokens() {
        let jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhcHBsaWFuY2UifQ.c2lnbmF0dXJl";
        let scrubbed = scrub_secrets(&format!("Authorization: Bearer {jwt}\n"));
        assert!(!scrubbed.contains(jwt));
        assert!(scrubbed.contains("Bearer <scrubbed:"));
    }

    #[test]
    fn leaves_ordinary_log_lines_alone() {
        let text = "2026-07-16T10:00:00Z info: listening on 0.0.0.0:9091\n\
                    GET /bootstrap/status 200 3ms request-id=req_01HZX\n\
                    key k-2b06a172 last used updated";
        assert_eq!(scrub_secrets(text), text);
    }

    #[test]
    fn short_hex_and_uuids_survive() {
        // Request ids / short hashes / uuids are diagnostics, not
        // secrets — a 32-char threshold keeps them readable.
        let text = "commit 548b1b1 uuid 2b06a172-1ea9-4410-b42c-e06eae91843b";
        assert_eq!(scrub_secrets(text), text);
    }
}
