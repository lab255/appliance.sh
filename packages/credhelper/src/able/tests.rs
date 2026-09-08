use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::sync::Mutex;

// The transport is replaced at compile time in tests. No test can call live able.
// This server implements the registered public client's wire contract and signs real JWTs.
#[derive(Default)]
struct Server {
    nonce: String,
    challenge: String,
    redirect: String,
    tamper: String,
    refresh: usize,
    code_used: bool,
    family_dead: bool,
    calls: Vec<String>,
}
thread_local! { static SERVER: RefCell<Server> = RefCell::new(Server::default()); }
static PORTS: Mutex<()> = Mutex::new(());
fn reply(status: u16, value: Value) -> openidconnect::HttpResponse {
    openidconnect::http::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&value).unwrap())
        .unwrap()
}
fn jwt(server: &Server) -> String {
    let key = SigningKey::from_bytes(&[7; 32]);
    let header = B64.encode(br#"{"alg":"EdDSA","kid":"test-key"}"#);
    let mut claims = json!({"iss": ISSUER, "aud": CLIENT_ID, "sub": "able-user", "iat": now(), "exp": now()+3600, "nonce": server.nonce, "email": "User@Example.com", "email_verified": true});
    match server.tamper.as_str() {
        "issuer" => claims["iss"] = json!("https://account.able.online"),
        "aud" => claims["aud"] = json!("appliance"),
        "nonce" => claims["nonce"] = json!("wrong"),
        "expired" => claims["exp"] = json!(now() - 3600),
        "email" => claims["email_verified"] = json!(false),
        "subject" => claims["sub"] = json!("another-user"),
        _ => (),
    }
    let body = format!(
        "{header}.{}",
        B64.encode(serde_json::to_vec(&claims).unwrap())
    );
    let key = if server.tamper == "signature" {
        SigningKey::from_bytes(&[8; 32])
    } else {
        key
    };
    format!(
        "{body}.{}",
        B64.encode(key.sign(body.as_bytes()).to_bytes())
    )
}
pub(super) fn request(
    request: openidconnect::HttpRequest,
) -> std::result::Result<openidconnect::HttpResponse, std::io::Error> {
    SERVER.with(|state| {
        let mut server = state.borrow_mut();
        let path = request.uri().path().to_owned();
        server.calls.push(path.clone());
        assert!(!path.contains("introspect"));
        assert!(request.headers().get("authorization").is_none());
        let body = String::from_utf8(request.body().clone()).unwrap();
        assert!(!body.contains("client_secret"));
        let params = reqwest::Url::parse(&format!("http://localhost/?{body}")).unwrap().query_pairs().into_owned().collect::<std::collections::HashMap<_,_>>();
        Ok(match path.as_str() {
            "/.well-known/openid-configuration" => reply(200, json!({
                "issuer": if server.tamper == "discovery" { "https://evil.example" } else { ISSUER },
                "authorization_endpoint": format!("{ISSUER}/oauth2/authorize"), "token_endpoint": format!("{ISSUER}/oauth2/token"),
                "jwks_uri": format!("{ISSUER}/jwks"), "response_types_supported": ["code"], "subject_types_supported": ["public"],
                "id_token_signing_alg_values_supported": ["EdDSA"], "token_endpoint_auth_methods_supported": ["none"],
                "code_challenge_methods_supported": ["S256"]
            })),
            "/api/auth/jwks" => reply(200, json!({"keys": [{"kty": "OKP", "crv": "Ed25519", "alg":"EdDSA", "use":"sig", "kid": "test-key", "x": B64.encode(SigningKey::from_bytes(&[7;32]).verifying_key().to_bytes())}]})),
            "/api/auth/oauth2/token" => {
                assert_eq!(params.get("client_id").unwrap(), CLIENT_ID);
                if params["grant_type"] == "authorization_code" {
                    assert_eq!(params["redirect_uri"], server.redirect);
                    if server.code_used || server.tamper == "pkce" || B64.encode(Sha256::digest(params["code_verifier"].as_bytes())) != server.challenge {
                        return Ok(reply(400, json!({"error": "invalid_grant"})));
                    }
                    server.code_used = true;
                } else {
                    assert_eq!(params["grant_type"], "refresh_token");
                    if server.family_dead || params["refresh_token"] != format!("refresh-{}", server.refresh) {
                        server.family_dead = true;
                        return Ok(reply(400, json!({"error":"invalid_grant"})));
                    }
                    server.refresh += 1;
                }
                if server.tamper == "network" { return Err(std::io::Error::other("mock network failure")); }
                let mut response = json!({"access_token": "mock-access", "refresh_token": format!("refresh-{}", server.refresh), "token_type": "Bearer", "expires_in": 3600, "id_token": jwt(&server)});
                if server.tamper == "missing-refresh" { response.as_object_mut().unwrap().remove("refresh_token"); }
                if server.tamper == "missing-id" { response.as_object_mut().unwrap().remove("id_token"); }
                reply(200, response)
            }
            "/api/auth/oauth2/revoke" => {
                assert_eq!(params["client_id"], CLIENT_ID);
                assert_eq!(params["token_type_hint"], "refresh_token");
                if server.tamper == "revoke" { reply(503, json!({})) } else { server.family_dead = true; reply(200, json!({})) }
            }
            _ => panic!("unexpected endpoint {path}"),
        })
    })
}
fn browser(url: &str, tamper: &str, ipv6: bool) -> Result<()> {
    let url = reqwest::Url::parse(url).unwrap();
    assert_eq!(
        url.as_str().split('?').next().unwrap(),
        format!("{ISSUER}/oauth2/authorize")
    );
    let params = url
        .query_pairs()
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(params["client_id"], CLIENT_ID);
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(params["scope"], SCOPES);
    assert_eq!(params["response_type"], "code");
    assert!(!params.contains_key("client_secret"));
    SERVER.with(|s| {
        let mut s = s.borrow_mut();
        s.nonce = params["nonce"].clone();
        s.challenge = params["code_challenge"].clone();
        s.redirect = params["redirect_uri"].clone();
    });
    let redirect = reqwest::Url::parse(&params["redirect_uri"]).unwrap();
    assert_eq!(redirect.host_str(), Some("localhost"));
    let state = if tamper == "state" {
        "wrong".into()
    } else {
        params["state"].clone()
    };
    let port = redirect.port().unwrap();
    let path = if tamper == "path" {
        "/oauth/callback/"
    } else {
        "/oauth/callback"
    };
    let query = if tamper == "denied" {
        format!("error=access_denied&state={state}")
    } else {
        format!("code=code&state={state}")
    };
    std::thread::spawn(move || {
        let mut stream = std::net::TcpStream::connect(if ipv6 {
            format!("[::1]:{port}")
        } else {
            format!("127.0.0.1:{port}")
        })
        .unwrap();
        stream
            .write_all(
                format!("GET {path}?{query} HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n").as_bytes(),
            )
            .unwrap();
        let mut body = String::new();
        let _ = stream.read_to_string(&mut body);
    });
    Ok(())
}
fn account() -> (tempfile::TempDir, Account) {
    SERVER.with(|s| *s.borrow_mut() = Server::default());
    let home = tempfile::tempdir().unwrap();
    let account = Account {
        directory: home.path().join(".appliance"),
    };
    (home, account)
}
fn login(account: &Account, port: Port, tamper: &str) -> Result<Status> {
    SERVER.with(|s| {
        let mut s = s.borrow_mut();
        s.tamper = tamper.into();
        s.code_used = false;
    });
    account.login(port, false, Duration::from_millis(250), |url| {
        browser(url, tamper, matches!(port, Port::Desktop))
    })
}
fn expire(account: &Account) {
    let _lock = account.lock().unwrap();
    let mut v = account.read().unwrap();
    v["able"]["expires_at"] = json!(now());
    account.write(&v).unwrap();
}
#[test]
fn both_ports_pkce_signed_jwt_and_private_storage() {
    let _ports = PORTS.lock().unwrap();
    for port in [Port::Cli, Port::Desktop] {
        let (_home, account) = account();
        let status = login(&account, port, "").unwrap();
        assert!(status.signed_in);
        assert_eq!(status.email.as_deref(), Some("user@example.com"));
        secure(&account.directory, true).unwrap();
        secure(&account.directory.join("credentials.json"), false).unwrap();
        let encoded = serde_json::to_string(&status).unwrap();
        assert!(!encoded.contains("token"));
        assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, port.number())).is_ok());
        assert!(TcpListener::bind((Ipv6Addr::LOCALHOST, port.number())).is_ok());
    }
}
#[test]
fn tampering_denial_missing_tokens_and_timeout_fail_closed() {
    let _ports = PORTS.lock().unwrap();
    for tamper in [
        "state",
        "pkce",
        "nonce",
        "issuer",
        "aud",
        "signature",
        "expired",
        "email",
        "missing-refresh",
        "missing-id",
        "denied",
        "discovery",
        "path",
    ] {
        let (_home, account) = account();
        assert!(login(&account, Port::Cli, tamper).is_err(), "{tamper}");
        assert!(!account.status().unwrap().signed_in, "{tamper}");
    }
    let (_home, account) = account();
    assert_eq!(
        account
            .login(Port::Cli, false, Duration::from_millis(20), |_| Ok(()))
            .err(),
        Some("Sign-in timed out; retry")
    );
}
#[test]
fn busy_ipv4_or_ipv6_rolls_back_and_can_retry() {
    let _ports = PORTS.lock().unwrap();
    for ipv6 in [false, true] {
        let (_home, account) = account();
        let busy = TcpListener::bind(if ipv6 {
            "[::1]:43103"
        } else {
            "127.0.0.1:43103"
        })
        .unwrap();
        assert!(account
            .login(Port::Cli, false, Duration::from_millis(20), |_| panic!(
                "browser must not open"
            ))
            .is_err());
        drop(busy);
        assert!(login(&account, Port::Cli, "").unwrap().signed_in);
    }
}
#[test]
fn rotation_reuse_invalidates_family_and_invalid_grant_erases() {
    let _ports = PORTS.lock().unwrap();
    let (_home, account) = account();
    login(&account, Port::Cli, "").unwrap();
    expire(&account);
    assert!(account.refresh().unwrap().signed_in);
    assert_eq!(
        account.read().unwrap()["able"]["refresh_token"],
        "refresh-1"
    );
    // A reused old token invalidates the family at the mocked provider.
    {
        let _lock = account.lock().unwrap();
        let mut v = account.read().unwrap();
        v["able"]["refresh_token"] = json!("refresh-0");
        account.write(&v).unwrap();
    }
    expire(&account);
    assert!(!account.refresh().unwrap().signed_in);
    assert!(account.read().unwrap().get("able").is_none());
    SERVER.with(|s| assert!(s.borrow().family_dead));
    let calls = SERVER.with(|s| s.borrow().calls.len());
    account.refresh().unwrap();
    assert_eq!(calls, SERVER.with(|s| s.borrow().calls.len()));
}
#[test]
fn revoke_failure_erases_and_preserves_cloud_credentials() {
    let _ports = PORTS.lock().unwrap();
    let (_home, account) = account();
    {
        let _lock = account.lock().unwrap();
        account.write(&json!({"apiUrl":"https://cluster.example", "keyId":"key", "secret":"cloud-secret"})).unwrap();
    }
    login(&account, Port::Cli, "").unwrap();
    SERVER.with(|s| s.borrow_mut().tamper = "revoke".into());
    let status = account.sign_out().unwrap();
    assert!(!status.signed_in);
    assert!(status.revocation_failed);
    let v = account.read().unwrap();
    assert!(v.get("able").is_none());
    assert_eq!(v["secret"], "cloud-secret");
}
#[test]
fn signout_cancels_pending_login_before_callback_commit() {
    let _ports = PORTS.lock().unwrap();
    let (_home, account) = account();
    let result = account.login(Port::Cli, false, Duration::from_secs(1), |url| {
        account.sign_out().unwrap();
        browser(url, "", false)
    });
    assert_eq!(result.err(), Some("Sign-in cancelled"));
    assert!(!account.status().unwrap().signed_in);
}
#[cfg(unix)]
#[test]
fn refuses_symlinks_and_unsafe_permissions() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let (home, account) = account();
    account.status().unwrap();
    let target = home.path().join("target");
    fs::write(&target, b"{}").unwrap();
    symlink(&target, account.directory.join("credentials.json")).unwrap();
    assert!(account.status().is_err());
    fs::remove_file(account.directory.join("credentials.json")).unwrap();
    fs::set_permissions(&account.directory, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(account.status().is_err());
}
