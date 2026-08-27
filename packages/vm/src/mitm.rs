//! TLS interception for egress control.
//!
//! Docker's sandbox decrypts outbound TLS by presenting workloads a
//! certificate it minted from a CA the guest trusts; we do the same.
//! `appliance-vm` generates a per-VM CA once, injects it into the
//! guest trust store, and the egress proxy mints a short-lived leaf
//! per destination host on the fly — so it can see (and apply
//! policy to) the decrypted HTTP, then re-originate a real TLS
//! connection upstream.
//!
//! This module owns the crypto: CA generation/persistence and the
//! rustls cert resolver that mints leaves on demand. The proxy wiring
//! that uses it lives in egress.rs.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result};
use rcgen::{
    BasicConstraints, Certificate, CertificateParams, DnType, IsCa, KeyPair, KeyUsagePurpose,
};
use rustls::pki_types::{PrivateKeyDer, ServerName};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::{
    ClientConfig, ClientConnection, RootCertStore, ServerConfig, ServerConnection, StreamOwned,
};

use crate::netstack::guard::is_forbidden_target;
use crate::spec::VmPaths;

pub fn ca_cert_path(name: &str) -> PathBuf {
    VmPaths::for_name(name).dir.join("egress-ca.pem")
}

fn ca_key_path(name: &str) -> PathBuf {
    VmPaths::for_name(name).dir.join("egress-ca-key.pem")
}

/// The persisted CA, reconstructed as an rcgen `Certificate` +
/// `KeyPair` ready to sign leaf certs.
pub struct Ca {
    cert: Certificate,
    key: KeyPair,
}

/// Load the VM's egress CA, generating + persisting it on first use.
pub fn ensure_ca(name: &str) -> Result<Ca> {
    let cert_path = ca_cert_path(name);
    let key_path = ca_key_path(name);

    if cert_path.exists() && key_path.exists() {
        let cert_pem = std::fs::read_to_string(&cert_path)?;
        let key_pem = std::fs::read_to_string(&key_path)?;
        let key = KeyPair::from_pem(&key_pem).context("parse CA key")?;
        // Reconstruct the issuer cert from the persisted PEM. Leaves
        // are signed by `key` with this cert's DN as the issuer, so
        // they chain to the same trust anchor curl/the guest holds.
        let params = CertificateParams::from_ca_cert_pem(&cert_pem).context("parse CA cert")?;
        let cert = params.self_signed(&key).context("rebuild CA cert")?;
        return Ok(Ca { cert, key });
    }

    let mut params = CertificateParams::new(Vec::new())?;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params
        .distinguished_name
        .push(DnType::CommonName, "Appliance Egress CA");
    params
        .distinguished_name
        .push(DnType::OrganizationName, "Appliance");
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let key = KeyPair::generate()?;
    let cert = params.self_signed(&key)?;
    let cert_pem = cert.pem();

    if let Some(parent) = cert_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&cert_path, &cert_pem)
        .with_context(|| format!("write {}", cert_path.display()))?;
    std::fs::write(&key_path, key.serialize_pem())
        .with_context(|| format!("write {}", key_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(Ca { cert, key })
}

impl Ca {
    /// Mint a leaf certificate for `host`, signed by this CA.
    fn mint_leaf(&self, host: &str) -> Result<CertifiedKey> {
        let mut params = CertificateParams::new(vec![host.to_string()])?;
        params.distinguished_name.push(DnType::CommonName, host);
        let leaf_key = KeyPair::generate()?;
        let leaf = params.signed_by(&leaf_key, &self.cert, &self.key)?;

        let chain = vec![leaf.der().clone()];
        let key_der = PrivateKeyDer::try_from(leaf_key.serialize_der())
            .map_err(|e| anyhow::anyhow!("leaf key der: {e}"))?;
        let signing_key =
            rustls::crypto::ring::sign::any_supported_type(&key_der).context("leaf signing key")?;
        Ok(CertifiedKey::new(chain, signing_key))
    }
}

/// rustls cert resolver that mints (and caches) a leaf per SNI host,
/// so a single proxy serves any destination the workload reaches.
pub struct MintingResolver {
    ca: Arc<Ca>,
    cache: Mutex<HashMap<String, Arc<CertifiedKey>>>,
}

impl MintingResolver {
    pub fn new(ca: Arc<Ca>) -> Self {
        Self {
            ca,
            cache: Mutex::new(HashMap::new()),
        }
    }
}

impl std::fmt::Debug for MintingResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MintingResolver")
    }
}

impl ResolvesServerCert for MintingResolver {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let host = hello.server_name()?.to_string();
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = cache.get(&host) {
            return Some(existing.clone());
        }
        let minted = Arc::new(self.ca.mint_leaf(&host).ok()?);
        cache.insert(host, minted.clone());
        Some(minted)
    }
}

// --- TLS configs ----------------------------------------------------

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// A server config that presents minted leaves for any SNI — the
/// client (guest workload, trusting our CA) terminates TLS here.
pub fn server_config(ca: Arc<Ca>) -> Result<Arc<ServerConfig>> {
    let mut cfg = ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .context("server tls versions")?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(MintingResolver::new(ca)));
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(cfg))
}

/// Build the TLS material for one intercepted flow: the per-VM CA's
/// server config (mints a leaf per SNI) plus the shared upstream client
/// config. The netstack accept-path has no long-lived `ProxyCtx` to hang
/// these on, so it asks for them per brokered flow (cheap: the CA is
/// cached on disk, the client config is a global `OnceLock`).
pub fn configs(name: &str) -> Result<(Arc<ServerConfig>, Arc<ClientConfig>)> {
    let ca = Arc::new(ensure_ca(name)?);
    Ok((server_config(ca)?, client_config()?))
}

/// The client config used to re-originate TLS to the real upstream,
/// validating against the webpki trust roots. Built once.
pub fn client_config() -> Result<Arc<ClientConfig>> {
    static CFG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    if let Some(c) = CFG.get() {
        return Ok(c.clone());
    }
    let roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let mut cfg = ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .context("client tls versions")?
        .with_root_certificates(roots)
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    let arc = Arc::new(cfg);
    let _ = CFG.set(arc.clone());
    Ok(arc)
}

// --- interception ---------------------------------------------------

/// The upstream a single intercepted flow targets — the host name, port,
/// and the optional **pre-validated public addr** the netstack already
/// filtered through [`is_forbidden_target`]. Folds what used to be three
/// positional args (and the `too_many_arguments` allow on `intercept`)
/// into one. `upstream = Some(addr)` (netstack accept-path) dials exactly
/// that addr; `None` (legacy CONNECT) resolves `host:port` host-side,
/// still private-range-rejected.
pub struct MitmTarget<'a> {
    pub host: &'a str,
    pub port: u16,
    pub upstream: Option<SocketAddr>,
}

/// Intercept one CONNECT tunnel: terminate the client's TLS with a
/// minted leaf, re-originate TLS to `host:port`, and forward a single
/// HTTP/1 request/response. We force `Connection: close` upstream so
/// the response is delimited by EOF — no fragile keep-alive framing —
/// which is correct for the typical one-shot calls workloads make.
///
/// `client_tcp` has already received the proxy's `200` and is about
/// to start its TLS handshake.
///
/// Generic over the client transport so the **same** interceptor serves
/// both the legacy CONNECT proxy (a `TcpStream`) and the netstack
/// accept-path (a netstack flow whose peeked ClientHello is replayed in
/// front of it) — one allow/deny + capture/inject core, no duplication.
///
/// The upstream is described by [`MitmTarget`]: its `upstream` is the
/// **pre-validated public `SocketAddr`** the netstack already filtered
/// through [`is_forbidden_target`] (its `resolve_public` result). When
/// `Some`, we dial **exactly that addr** — never re-resolve `host` — so a
/// DNS rebind / multi-A private record can't relocate the dial after the
/// credential decision (§8.1 #1 on the brokered path). When `None` (the
/// legacy CONNECT front door) we resolve `host:port` here, but still
/// reject any forbidden (private/internal/host-LAN) result and iterate the
/// public candidates until one connects. Either way the dial is gated by
/// the private-range filter and `intercept` never originates — nor injects
/// a brokered credential into a request — to a forbidden target.
pub fn intercept<S: Read + Write>(
    name: &str,
    client_tcp: S,
    target: MitmTarget<'_>,
    server_cfg: Arc<ServerConfig>,
    client_cfg: Arc<ClientConfig>,
    log: bool,
) -> Result<()> {
    let MitmTarget {
        host,
        port,
        upstream,
    } = target;
    let server_conn = ServerConnection::new(server_cfg).context("server tls conn")?;
    let mut client_tls = StreamOwned::new(server_conn, client_tcp);

    // Read the decrypted request head from the client (this drives the
    // client-side TLS handshake against our minted leaf).
    let head = read_http_head(&mut client_tls)?;
    let request_line = head.lines().next().unwrap_or_default().to_string();
    // A real request line has at least METHOD + TARGET. Bail on an
    // empty/garbled head (client hung up, or spoke non-HTTP) rather
    // than dialing upstream and forwarding nonsense.
    if request_line.split_whitespace().count() < 2 {
        return Ok(());
    }
    if log {
        eprintln!("egress mitm: {host} :: {request_line}");
    }
    // Record the decrypted request for the desktop traffic view.
    {
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default();
        let path = parts.next().unwrap_or("/");
        crate::traffic::record(name, host, port, method, Some(path), "mitm");
    }

    // Load the credential config ONCE for this intercepted request and
    // thread it through both capture and injection — no per-phase re-read.
    let cfg = crate::creds::load_config(name);

    // Credential capture: lift a configured credential header off the
    // request into the host-side secret store (best-effort). The broker
    // rule for api.anthropic.com is capture:false, so the in-guest
    // placeholder x-api-key is never lifted into egress-secrets.json.
    crate::creds::capture_from_head(&cfg, name, host, &head);

    // Resolve the credential to inject BEFORE dialing upstream so we can
    // fail CLOSED, atomically: classifying "no rule" vs "rule but
    // unresolved" vs "resolved" from the SAME single config load avoids a
    // TOCTOU where the rule is seen but the value isn't (or vice versa). A
    // host that HAS an inject rule but whose credential can't be resolved
    // (host helper failed / Anthropic key not configured / Keychain
    // locked) must NEVER forward the in-guest placeholder credential to
    // the real upstream — refuse with a clear, actionable error and dial
    // no upstream, so the placeholder leaves the host zero times.
    let injection = match crate::creds::resolve_injection(&cfg, name, host) {
        crate::creds::Injection::Resolved(header, value) => Some((header, value)),
        crate::creds::Injection::RuleButUnresolved => {
            if log {
                eprintln!(
                    "egress mitm: {host} :: credential not configured — refusing (fail closed)"
                );
            }
            return write_cred_unconfigured(&mut client_tls, host);
        }
        crate::creds::Injection::NoRule => None,
    };

    // Only now dial upstream — no wasted connection on a dead client.
    // Dial the pre-validated public addr (netstack) or a freshly resolved
    // public one (legacy CONNECT); never a forbidden target. The dial is
    // reached only AFTER the injection decision above, so a refusal here
    // returns before any credential is written upstream.
    let upstream_tcp = dial_upstream(host, port, upstream)?;
    let sni = ServerName::try_from(host.to_string()).context("server name")?;
    let client_conn = ClientConnection::new(client_cfg, sni).context("client tls conn")?;
    let mut up_tls = StreamOwned::new(client_conn, upstream_tcp);

    // Force a single request/response, then close. Credential
    // injection (if configured) sets the header on the outbound copy,
    // so the workload need never hold the secret itself.
    let mut rewritten = force_connection_close(&head);
    if let Some((header, value)) = injection {
        rewritten = crate::creds::set_header(&rewritten, &header, &value);
    }
    up_tls.write_all(rewritten.as_bytes())?;
    copy_request_body(&mut client_tls, &mut up_tls, &head)?;
    up_tls.flush()?;

    // Upstream now EOF-delimits the response — stream it straight back.
    std::io::copy(&mut up_tls, &mut client_tls).ok();
    client_tls.flush().ok();
    Ok(())
}

/// Runtime-principal TLS observation. This path is intentionally separate
/// from the legacy credential broker above: it preserves the HTTP/1.1 request
/// and response bytes exactly and never calls capture/injection helpers.
pub fn intercept_observe<S: Read + Write>(
    _name: &str,
    runtime: &crate::egress::RuntimePolicy,
    client_tcp: S,
    target: MitmTarget<'_>,
    server_cfg: Arc<ServerConfig>,
    client_cfg: Arc<ClientConfig>,
    log: bool,
) -> Result<()> {
    let started = std::time::Instant::now();
    let MitmTarget {
        host,
        port,
        upstream,
    } = target;
    let server_conn = ServerConnection::new(server_cfg).context("server tls conn")?;
    let mut client_tls = StreamOwned::new(server_conn, client_tcp);
    let head = read_http_head(&mut client_tls)?;
    let request_line = head.lines().next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let target_path = request_parts.next().unwrap_or("/");
    let version = request_parts.next().unwrap_or_default();
    if method.is_empty() || version != "HTTP/1.1" || request_parts.next().is_some() {
        anyhow::bail!("runtime inspection supports HTTP/1.1 requests only");
    }
    if log {
        eprintln!(
            "egress inspect [{}]: {host} :: {request_line}",
            runtime.principal
        );
    }
    let tls_version = client_tls
        .conn
        .protocol_version()
        .map(|value| format!("{value:?}"));

    let upstream_tcp = dial_upstream(host, port, upstream)?;
    let sni = ServerName::try_from(host.to_string()).context("server name")?;
    let client_conn = ClientConnection::new(client_cfg, sni).context("client tls conn")?;
    let mut up_tls = StreamOwned::new(client_conn, upstream_tcp);

    // Byte-for-byte forwarding: unlike the broker path, do not add
    // Connection: close and do not inspect or rewrite any header/body.
    up_tls.write_all(head.as_bytes())?;
    let request_body = copy_request_body_count(&mut client_tls, &mut up_tls, &head)?;
    up_tls.flush()?;

    let response_head = read_http_head(&mut up_tls)?;
    let status = response_head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok());
    client_tls.write_all(response_head.as_bytes())?;
    let response_body =
        copy_response_body_count(&mut up_tls, &mut client_tls, &response_head, method, status)?;
    client_tls.flush()?;

    crate::traffic::record_runtime(
        runtime,
        host,
        port,
        method,
        Some(target_path),
        "inspect",
        crate::traffic::TrafficDetails {
            reason: Some("policy.mitm && allowed"),
            tls_version: tls_version.as_deref(),
            sni: Some(host),
            status,
            bytes_in: Some((head.len() as u64).saturating_add(request_body)),
            bytes_out: Some((response_head.len() as u64).saturating_add(response_body)),
            duration_ms: Some(started.elapsed().as_millis() as u64),
        },
    );
    Ok(())
}

fn copy_request_body_count<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    head: &str,
) -> Result<u64> {
    if header_value(head, "transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        return copy_chunked_count(reader, writer);
    }
    if let Some(len) =
        header_value(head, "content-length").and_then(|value| value.parse::<u64>().ok())
    {
        return copy_n_count(reader, writer, len);
    }
    Ok(0)
}

fn copy_response_body_count<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    head: &str,
    method: &str,
    status: Option<u16>,
) -> Result<u64> {
    if method.eq_ignore_ascii_case("HEAD")
        || status.is_some_and(|code| (100..200).contains(&code) || matches!(code, 204 | 304))
    {
        return Ok(0);
    }
    if header_value(head, "transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        return copy_chunked_count(reader, writer);
    }
    if let Some(len) =
        header_value(head, "content-length").and_then(|value| value.parse::<u64>().ok())
    {
        return copy_n_count(reader, writer, len);
    }
    std::io::copy(reader, writer).context("copy EOF-delimited response")
}

fn copy_n_count<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    mut remaining: u64,
) -> Result<u64> {
    let original = remaining;
    let mut buf = [0u8; 8192];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = reader.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        remaining -= n as u64;
    }
    Ok(original - remaining)
}

fn copy_chunked_count<R: Read, W: Write>(reader: &mut R, writer: &mut W) -> Result<u64> {
    let mut total = 0u64;
    loop {
        let size_line = read_line(reader)?;
        writer.write_all(size_line.as_bytes())?;
        total = total.saturating_add(size_line.len() as u64);
        let hex = size_line.trim_end().split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(hex, 16).context("invalid chunk size")?;
        if size == 0 {
            loop {
                let line = read_line(reader)?;
                writer.write_all(line.as_bytes())?;
                total = total.saturating_add(line.len() as u64);
                if line == "\r\n" || line.is_empty() {
                    return Ok(total);
                }
            }
        }
        total = total.saturating_add(copy_n_count(reader, writer, size)?);
        let crlf = read_line(reader)?;
        writer.write_all(crlf.as_bytes())?;
        total = total.saturating_add(crlf.len() as u64);
    }
}

/// The single first-choice upstream (the head of [`public_upstreams`]),
/// gated by the §8.1 #1 private-range filter ([`is_forbidden_target`]):
/// `None` when nothing public is available. `dial_upstream` now iterates
/// the full candidate list; this stays as the test seam for the per-pick
/// reject semantics (validated-private ⇒ None, multi-A never picks
/// private, legit public ⇒ kept).
#[cfg(test)]
fn pick_upstream(validated: Option<SocketAddr>, resolved: &[SocketAddr]) -> Option<SocketAddr> {
    public_upstreams(validated, resolved).into_iter().next()
}

/// All public (non-forbidden, §8.1 #1) upstream candidates to try, **in
/// order**. A netstack pre-validated addr is the sole candidate (re-checked
/// here as defense-in-depth); otherwise every public host-side resolution,
/// to be tried in turn until one connects. Empty ⇒ refuse the dial (nothing
/// public). This is what restores the legacy iterate-all-until-connect
/// fallback while keeping the private-range reject on each candidate.
fn public_upstreams(validated: Option<SocketAddr>, resolved: &[SocketAddr]) -> Vec<SocketAddr> {
    match validated {
        Some(addr) if !is_forbidden_target(addr.ip()) => vec![addr],
        Some(_) => Vec::new(),
        None => resolved
            .iter()
            .copied()
            .filter(|a| !is_forbidden_target(a.ip()))
            .collect(),
    }
}

/// Try each candidate in order, returning the first that connects. On
/// all-failures returns the last error (tagged with the addr that produced
/// it) so the caller surfaces a real cause. Generic over the connect fn so
/// the iterate-until-connect behavior is unit-testable without a network.
fn dial_first<S>(
    candidates: &[SocketAddr],
    mut connect: impl FnMut(SocketAddr) -> std::io::Result<S>,
) -> Result<S> {
    let mut last: Option<(SocketAddr, std::io::Error)> = None;
    for &addr in candidates {
        match connect(addr) {
            Ok(s) => return Ok(s),
            Err(e) => last = Some((addr, e)),
        }
    }
    match last {
        Some((addr, e)) => Err(e).with_context(|| format!("connect {addr}")),
        None => anyhow::bail!("no upstream candidates"),
    }
}

/// Dial the upstream for an intercepted flow. When the netstack threaded a
/// pre-validated public addr, connect to exactly that (no re-resolve);
/// otherwise resolve `host:port` host-side and **iterate the public
/// candidates until one connects** (the legacy multi-addr fallback). Either
/// way [`public_upstreams`] filters every candidate through the private-
/// range gate, so we refuse rather than dial a forbidden target.
fn dial_upstream(host: &str, port: u16, validated: Option<SocketAddr>) -> Result<TcpStream> {
    let resolved: Vec<SocketAddr> = if validated.is_some() {
        Vec::new()
    } else {
        (host, port)
            .to_socket_addrs()
            .with_context(|| format!("resolve {host}:{port}"))?
            .collect()
    };
    let candidates = public_upstreams(validated, &resolved);
    if candidates.is_empty() {
        anyhow::bail!("refusing intercept dial: {host}:{port} has no public upstream");
    }
    dial_first(&candidates, TcpStream::connect)
}

/// Read an HTTP message head (through the blank line) from a stream.
fn read_http_head<R: Read>(r: &mut R) -> Result<String> {
    let mut buf = Vec::with_capacity(512);
    let mut byte = [0u8; 1];
    loop {
        let n = r.read(&mut byte)?;
        if n == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() > 256 * 1024 {
            anyhow::bail!("request head too large");
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Replace any Connection/Proxy-Connection headers with a single
/// `Connection: close`, preserving the rest of the head verbatim.
fn force_connection_close(head: &str) -> String {
    let mut out = String::with_capacity(head.len() + 20);
    let mut lines = head.split("\r\n");
    if let Some(request_line) = lines.next() {
        out.push_str(request_line);
        out.push_str("\r\n");
    }
    for line in lines {
        if line.is_empty() {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("connection:") || lower.starts_with("proxy-connection:") {
            continue;
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str("Connection: close\r\n\r\n");
    out
}

/// Fail-closed response for an intercepted host that has a
/// credential-injection rule the broker can't satisfy (host helper
/// failed / the key isn't configured). Writes a clear, actionable HTTP
/// error back to the guest over the already-terminated TLS — and
/// crucially returns WITHOUT dialing the real upstream, so the in-guest
/// placeholder credential never crosses the host boundary. The message
/// never contains a credential.
fn write_cred_unconfigured<W: Write>(client_tls: &mut W, host: &str) -> Result<()> {
    let body = format!("Anthropic key not configured for {host} (run `appliance agent login`).\n");
    let resp = format!(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    client_tls.write_all(resp.as_bytes())?;
    client_tls.flush().ok();
    Ok(())
}

fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim())
}

/// Forward a request body (if any) by Content-Length or chunked
/// encoding. Requests without either carry no body.
fn copy_request_body<R: Read, W: Write>(reader: &mut R, writer: &mut W, head: &str) -> Result<()> {
    if header_value(head, "transfer-encoding")
        .map(|v| v.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        return copy_chunked(reader, writer);
    }
    if let Some(len) =
        header_value(head, "content-length").and_then(|v| v.trim().parse::<u64>().ok())
    {
        copy_n(reader, writer, len)?;
    }
    Ok(())
}

fn copy_n<R: Read, W: Write>(reader: &mut R, writer: &mut W, mut remaining: u64) -> Result<()> {
    let mut buf = [0u8; 8192];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = reader.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        remaining -= n as u64;
    }
    Ok(())
}

/// Copy a chunked-encoded body verbatim (size lines + data) through to
/// the terminating zero-size chunk.
fn copy_chunked<R: Read, W: Write>(reader: &mut R, writer: &mut W) -> Result<()> {
    loop {
        let size_line = read_line(reader)?;
        writer.write_all(size_line.as_bytes())?;
        let hex = size_line.trim_end().split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(hex, 16).unwrap_or(0);
        if size == 0 {
            // Trailer (possibly empty) up to the final blank line.
            loop {
                let line = read_line(reader)?;
                writer.write_all(line.as_bytes())?;
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            break;
        }
        copy_n(reader, writer, size)?;
        // Trailing CRLF after the chunk data.
        let crlf = read_line(reader)?;
        writer.write_all(crlf.as_bytes())?;
    }
    Ok(())
}

fn read_line<R: Read>(reader: &mut R) -> Result<String> {
    let mut buf = Vec::with_capacity(32);
    let mut byte = [0u8; 1];
    loop {
        let n = reader.read(&mut byte)?;
        if n == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\n") {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn force_close_replaces_existing_connection_header() {
        let head = "GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n";
        let out = force_connection_close(head);
        // Request line + non-Connection headers preserved.
        assert!(out.starts_with("GET / HTTP/1.1\r\n"));
        assert!(out.contains("Host: x\r\n"));
        assert!(out.contains("Accept: */*\r\n"));
        // Exactly one Connection header, and it's close.
        assert_eq!(out.matches("Connection:").count(), 1);
        assert!(out.contains("Connection: close\r\n"));
        assert!(!out.to_ascii_lowercase().contains("keep-alive"));
        assert!(out.ends_with("\r\n\r\n"));
    }

    #[test]
    fn force_close_strips_proxy_connection_and_adds_when_absent() {
        let with_proxy = "GET / HTTP/1.1\r\nProxy-Connection: keep-alive\r\n\r\n";
        let out = force_connection_close(with_proxy);
        assert!(!out.to_ascii_lowercase().contains("proxy-connection:"));
        assert!(out.contains("Connection: close\r\n"));

        let bare = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
        let out = force_connection_close(bare);
        assert_eq!(out.matches("Connection: close").count(), 1);
    }

    #[test]
    fn header_value_is_case_insensitive_and_trims() {
        let head = "POST / HTTP/1.1\r\nContent-Length:  12 \r\nHost: x\r\n\r\n";
        assert_eq!(header_value(head, "content-length"), Some("12"));
        assert_eq!(header_value(head, "Content-Length"), Some("12"));
        assert_eq!(header_value(head, "missing"), None);
    }

    #[test]
    fn copy_request_body_honors_content_length() {
        // Body has trailing bytes beyond Content-Length that must NOT
        // be copied (they belong to the next request on the stream).
        let head = "POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\n";
        let mut reader = Cursor::new(b"helloEXTRA".to_vec());
        let mut out: Vec<u8> = Vec::new();
        copy_request_body(&mut reader, &mut out, head).unwrap();
        assert_eq!(out, b"hello");
    }

    #[test]
    fn copy_request_body_none_when_no_length() {
        let head = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
        let mut reader = Cursor::new(b"unexpected".to_vec());
        let mut out: Vec<u8> = Vec::new();
        copy_request_body(&mut reader, &mut out, head).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn observation_body_copies_are_byte_exact_and_counted() {
        let request_head = "POST /upload HTTP/1.1\r\nContent-Length: 5\r\n\r\n";
        let mut request = Cursor::new(b"a\0b\r\n".to_vec());
        let mut request_out = Vec::new();
        assert_eq!(
            copy_request_body_count(&mut request, &mut request_out, request_head).unwrap(),
            5
        );
        assert_eq!(request_out, b"a\0b\r\n");

        let response_head = "HTTP/1.1 201 Created\r\nContent-Length: 4\r\n\r\n";
        let mut response = Cursor::new(b"x\0y\n".to_vec());
        let mut response_out = Vec::new();
        assert_eq!(
            copy_response_body_count(
                &mut response,
                &mut response_out,
                response_head,
                "POST",
                Some(201),
            )
            .unwrap(),
            4
        );
        assert_eq!(response_out, b"x\0y\n");
    }

    #[test]
    fn cred_unconfigured_is_actionable_and_keyless() {
        let mut out: Vec<u8> = Vec::new();
        write_cred_unconfigured(&mut out, "api.anthropic.com").unwrap();
        let resp = String::from_utf8(out).unwrap();
        assert!(resp.starts_with("HTTP/1.1 502 Bad Gateway\r\n"));
        assert!(resp.contains("Connection: close\r\n"));
        assert!(resp.contains("appliance agent login"));
        assert!(resp.contains("api.anthropic.com"));
        // A well-formed Content-Length so the client frames the body.
        assert!(resp.contains("Content-Length: "));
    }

    #[test]
    fn copy_chunked_forwards_body_verbatim() {
        let body = "4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        let mut reader = Cursor::new(body.as_bytes().to_vec());
        let mut out: Vec<u8> = Vec::new();
        copy_chunked(&mut reader, &mut out).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), body);
    }

    #[test]
    fn pick_upstream_refuses_validated_private_addr() {
        // The netstack belt-and-suspenders reject: even a "pre-validated"
        // addr that turns out private/internal is refused, so `intercept`
        // never originates to a forbidden target — and the dial fails
        // BEFORE the credential injection write, so no cred is disclosed.
        for s in [
            "10.0.0.5:443",
            "127.0.0.1:443",
            "192.168.1.9:443",
            "169.254.1.1:443",
        ] {
            let addr: SocketAddr = s.parse().unwrap();
            assert_eq!(pick_upstream(Some(addr), &[]), None, "{s} must be refused");
        }
    }

    #[test]
    fn pick_upstream_legacy_refuses_private_resolution() {
        // The legacy CONNECT front door: a brokered host that resolves
        // host-side only to a private IP yields no public upstream ⇒
        // refuse (no connect, no cred injection).
        let resolved: [SocketAddr; 1] = ["10.0.0.9:443".parse().unwrap()];
        assert_eq!(pick_upstream(None, &resolved), None);
    }

    #[test]
    fn pick_upstream_multi_a_never_dials_private() {
        // A multi-A name carrying one private and one public record: the
        // private record is NEVER selected; the dial lands on the public
        // one (order-independent).
        let private: SocketAddr = "192.168.1.50:443".parse().unwrap();
        let public: SocketAddr = "93.184.216.34:443".parse().unwrap();
        let picked = pick_upstream(None, &[private, public]).expect("a public upstream");
        assert_eq!(picked, public);
        assert_ne!(picked, private);
        // Even if the private record sorts first.
        assert_eq!(pick_upstream(None, &[private, public]), Some(public));
    }

    #[test]
    fn pick_upstream_allows_legit_public_hosts() {
        // No regression to A1/A2: a legit public host passes both the
        // netstack (pre-validated) and the legacy (resolved) path.
        let public: SocketAddr = "93.184.216.34:443".parse().unwrap();
        assert_eq!(pick_upstream(Some(public), &[]), Some(public)); // netstack
        assert_eq!(pick_upstream(None, &[public]), Some(public)); // legacy CONNECT
    }

    #[test]
    fn public_upstreams_filters_private_and_preserves_order() {
        let priv1: SocketAddr = "10.0.0.1:443".parse().unwrap();
        let pub1: SocketAddr = "93.184.216.34:443".parse().unwrap();
        let pub2: SocketAddr = "198.51.100.7:443".parse().unwrap();
        // Legacy path: private entries dropped, public ones kept in order.
        assert_eq!(
            public_upstreams(None, &[priv1, pub1, pub2]),
            vec![pub1, pub2]
        );
        // A private record interleaved first is skipped, not selected.
        assert_eq!(
            public_upstreams(None, &[pub1, priv1, pub2]),
            vec![pub1, pub2]
        );
        // A validated private addr yields no candidates (refuse the dial).
        assert!(public_upstreams(Some(priv1), &[]).is_empty());
        // A validated public addr is the sole candidate.
        assert_eq!(public_upstreams(Some(pub1), &[]), vec![pub1]);
    }

    #[test]
    fn dial_first_iterates_public_candidates_until_one_connects() {
        // The restored legacy fallback: the first public candidate refuses,
        // so dial_first falls through to the second — having tried both, in
        // order. (Generic over the connect fn; the "stream" is the addr.)
        let a: SocketAddr = "192.0.2.1:443".parse().unwrap(); // TEST-NET-1
        let b: SocketAddr = "93.184.216.34:443".parse().unwrap();
        let mut attempted: Vec<SocketAddr> = Vec::new();
        let got = dial_first(&[a, b], |addr| {
            attempted.push(addr);
            if addr == a {
                Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionRefused,
                    "refused",
                ))
            } else {
                Ok(addr)
            }
        })
        .unwrap();
        assert_eq!(got, b, "fell through to the second candidate");
        assert_eq!(attempted, vec![a, b], "tried both candidates, in order");

        // All-fail surfaces the last real error, not a generic message.
        let err = dial_first(&[a, b], |_addr| -> std::io::Result<SocketAddr> {
            Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionRefused,
                "nope",
            ))
        })
        .unwrap_err();
        assert!(
            err.to_string().contains("connect 93.184.216.34:443"),
            "got: {err}"
        );
    }

    #[test]
    fn dial_upstream_refuses_forbidden_host_without_connecting() {
        // End-to-end on the legacy path: "localhost" resolves only to
        // loopback (forbidden), so the dial is refused with no TcpStream
        // ever opened — `intercept` would return before injecting a cred.
        let err = dial_upstream("localhost", 443, None).unwrap_err();
        assert!(err.to_string().contains("no public upstream"), "got: {err}");
    }
}
