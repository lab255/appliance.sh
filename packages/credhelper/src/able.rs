//! Optional host identity. Never supplies grants or runtime authorization.
//! Both native ports execute this code and share the same OS lock and generation.
use fs2::FileExt;
use openidconnect::core::{
    CoreAuthenticationFlow, CoreClient, CoreJwsSigningAlgorithm, CoreProviderMetadata,
};
use openidconnect::reqwest;
use openidconnect::SyncHttpClient;
use openidconnect::{
    AuthType, AuthorizationCode, ClientId, CsrfToken, Nonce, OAuth2TokenResponse,
    PkceCodeChallenge, RedirectUrl, RefreshToken, Scope, TokenResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const ISSUER: &str = "https://account.able.online/api/auth";
pub const CLIENT_ID: &str = "appliance-desktop";
const DISCOVERY: &str = "https://account.able.online/.well-known/openid-configuration";
const SCOPES: &str = "openid profile email offline_access";
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Copy)]
pub enum Port {
    Cli,
    Desktop,
}
impl Port {
    fn number(self) -> u16 {
        match self {
            Self::Cli => 43103,
            Self::Desktop => 43104,
        }
    }
    fn busy_message(self) -> &'static str {
        match self {
            Self::Cli => "Sign-in port 43103 is in use. Close the process using it and retry.",
            Self::Desktop => "Sign-in port 43104 is in use. Close the process using it and retry.",
        }
    }
    fn redirect(self) -> String {
        format!("http://localhost:{}/oauth/callback", self.number())
    }
}

/// Only this redacted shape crosses IPC. No token getter is exported.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub signed_in: bool,
    pub email: Option<String>,
    pub subject: Option<String>,
    pub revocation_failed: bool,
}
#[derive(Serialize, Deserialize)]
struct Credential {
    version: u8,
    issuer: String,
    client_id: String,
    subject: String,
    email: String,
    // Identity-only until the separate account backend admission contract is available.
    account_id: Option<String>,
    scopes: String,
    audience: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    refresh_expires_at: u64,
}
impl Drop for Credential {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}
impl Credential {
    fn status(&self) -> Status {
        Status {
            signed_in: true,
            email: Some(self.email.clone()),
            subject: Some(self.subject.clone()),
            revocation_failed: false,
        }
    }
}

pub struct Account {
    directory: PathBuf,
}
struct AccountLock {
    _os: File,
    profile_path: PathBuf,
}
impl Drop for AccountLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.profile_path);
    }
}

impl Account {
    pub fn host() -> Result<Self> {
        Ok(Self {
            directory: dirs::home_dir()
                .ok_or("Home directory unavailable")?
                .join(".appliance"),
        })
    }
    fn lock(&self) -> Result<AccountLock> {
        if !self.directory.exists() {
            #[allow(unused_mut)] // Only Unix adds a creation mode.
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&self.directory) {
                Ok(()) => initialize_created_path(&self.directory)?,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err("Cannot create account directory"),
            }
        }
        secure(&self.directory, true)?;
        let path = self.directory.join("able.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = match options.open(&path) {
            Ok(file) => {
                initialize_created_path(&path)?;
                file
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                secure(&path, false)?;
                options
                    .create_new(false)
                    .open(&path)
                    .map_err(|_| "Cannot open account lock")?
            }
            Err(_) => return Err("Cannot open account lock"),
        };
        secure(&path, false)?;
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if file.try_lock_exclusive().is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                return Err("Account is busy; retry");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let profile_path = self.directory.join("profiles.json.lock");
        loop {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&profile_path) {
                Ok(profile_file) => {
                    if let Err(error) = initialize_created_path(&profile_path) {
                        drop(profile_file);
                        let _ = fs::remove_file(&profile_path);
                        return Err(error);
                    }
                    return Ok(AccountLock {
                        _os: file,
                        profile_path,
                    })
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::AlreadyExists
                        && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(25))
                }
                Err(_) => return Err("Profile credentials are busy; retry. If no Appliance process is running, remove ~/.appliance/profiles.json.lock."),
            }
        }
    }
    fn read(&self) -> Result<Value> {
        let path = self.directory.join("credentials.json");
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
            Err(_) => Err("Cannot read account credentials"),
            Ok(_) => {
                secure(&path, false)?;
                let value: Value = serde_json::from_slice(
                    &fs::read(&path).map_err(|_| "Cannot read account credentials")?,
                )
                .map_err(|_| "Invalid account credentials")?;
                if !value.is_object() {
                    return Err("Invalid account credentials");
                }
                Ok(value)
            }
        }
    }
    fn write(&self, value: &Value) -> Result<()> {
        let mut temp = tempfile::NamedTempFile::new_in(&self.directory)
            .map_err(|_| "Cannot create account replacement")?;
        initialize_created_path(temp.path())?;
        secure(temp.path(), false)?;
        serde_json::to_writer(&mut temp, value).map_err(|_| "Cannot write account credentials")?;
        temp.as_file()
            .sync_all()
            .map_err(|_| "Cannot sync account credentials")?;
        temp.persist(self.directory.join("credentials.json"))
            .map_err(|_| "Cannot replace account credentials")?;
        #[cfg(unix)]
        File::open(&self.directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| "Cannot sync account directory")?;
        Ok(())
    }
    fn current(&self, value: &Value) -> Result<Option<Credential>> {
        value
            .get("able")
            .map(|v| {
                serde_json::from_value::<Credential>(v.clone())
                    .map_err(|_| "Invalid able credential entry")
                    .and_then(|c| {
                        if c.version != 1
                            || c.issuer != ISSUER
                            || c.client_id != CLIENT_ID
                            || c.audience != CLIENT_ID
                        {
                            Err("Invalid able credential entry")
                        } else {
                            Ok(c)
                        }
                    })
            })
            .transpose()
    }
    pub fn status(&self) -> Result<Status> {
        let _lock = self.lock()?;
        Ok(self
            .current(&self.read()?)?
            .filter(|c| c.refresh_expires_at > now())
            .map(|c| c.status())
            .unwrap_or_default())
    }
    fn generation(&self) -> Result<Value> {
        let _lock = self.lock()?;
        Ok(self.read()?["able_generation"].clone())
    }
    pub fn sign_in(&self, port: Port, switch_account: bool) -> Result<Status> {
        self.login(port, switch_account, Duration::from_secs(300), |url| {
            webbrowser::open(url).map_err(|_| "Cannot open system browser; retry on this host")
        })
    }
    fn login(
        &self,
        port: Port,
        switch_account: bool,
        timeout: Duration,
        open: impl FnOnce(&str) -> Result<()>,
    ) -> Result<Status> {
        let generation = self.generation()?;
        // RAII drops the first listener if the second bind fails. Never bind a hostname.
        let listeners = [
            TcpListener::bind((Ipv4Addr::LOCALHOST, port.number()))
                .map_err(|_| port.busy_message())?,
            TcpListener::bind((Ipv6Addr::LOCALHOST, port.number()))
                .map_err(|_| port.busy_message())?,
        ];
        for l in &listeners {
            l.set_nonblocking(true)
                .map_err(|_| "Cannot prepare sign-in listener")?;
        }
        let deadline = Instant::now() + timeout;
        let http = http()?;
        let metadata = metadata(&http)?;
        let client =
            CoreClient::from_provider_metadata(metadata, ClientId::new(CLIENT_ID.into()), None)
                .set_auth_type(AuthType::RequestBody)
                .set_redirect_uri(
                    RedirectUrl::new(port.redirect()).map_err(|_| "Invalid callback")?,
                );
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let (url, state, nonce) = client
            .authorize_url(
                CoreAuthenticationFlow::AuthorizationCode,
                CsrfToken::new_random,
                Nonce::new_random,
            )
            .add_scope(Scope::new("profile".into()))
            .add_scope(Scope::new("email".into()))
            .add_scope(Scope::new("offline_access".into()))
            .set_pkce_challenge(challenge)
            .url();
        if Instant::now() >= deadline {
            return Err("Sign-in timed out; retry");
        }
        open(url.as_str())?;
        let code = 'receive: loop {
            if Instant::now() >= deadline {
                return Err("Sign-in timed out; retry");
            }
            if self.generation()? != generation {
                return Err("Sign-in cancelled");
            }
            for listener in &listeners {
                if let Ok((mut stream, _)) = listener.accept() {
                    stream
                        .set_read_timeout(Some(Duration::from_millis(250)))
                        .map_err(|_| "Callback failed")?;
                    stream
                        .set_write_timeout(Some(Duration::from_millis(250)))
                        .map_err(|_| "Callback failed")?;
                    let mut bytes = [0; 8192];
                    let count = stream.read(&mut bytes).unwrap_or(0);
                    let line = std::str::from_utf8(&bytes[..count])
                        .unwrap_or("")
                        .lines()
                        .next()
                        .unwrap_or("");
                    let mut parts = line.split_whitespace();
                    let method = parts.next().unwrap_or("");
                    let target = parts.next().unwrap_or("");
                    if method != "GET" || target.split('?').next() != Some("/oauth/callback") {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        continue;
                    }
                    let callback = reqwest::Url::parse(&format!(
                        "{}{}",
                        port.redirect().trim_end_matches("/oauth/callback"),
                        target
                    ))
                    .map_err(|_| "Invalid callback")?;
                    let params: Vec<_> = callback.query_pairs().collect();
                    let unique = |name: &str| {
                        let values: Vec<_> = params.iter().filter(|(k, _)| k == name).collect();
                        if values.len() == 1 {
                            Some(values[0].1.to_string())
                        } else {
                            None
                        }
                    };
                    let valid = unique("state").as_deref() == Some(state.secret().as_str());
                    let code = unique("code").filter(|v| !v.is_empty());
                    let denied = unique("error").is_some() || code.is_none();
                    let message = if valid && !denied {
                        "Return to Appliance to finish sign-in."
                    } else {
                        "Sign-in was not completed. Return to Appliance to try again."
                    };
                    let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{message}").as_bytes());
                    if !valid {
                        return Err("Sign-in state did not match; retry");
                    }
                    if denied {
                        return Err("Sign-in was denied; retry");
                    }
                    break 'receive code.unwrap();
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        drop(listeners); // single use, including while exchanging the code
        let response = client
            .exchange_code(AuthorizationCode::new(code))
            .map_err(|_| "Invalid token endpoint")?
            .set_pkce_verifier(verifier)
            .request(&http)
            .map_err(|_| "Sign-in exchange failed; retry")?;
        let id = response.id_token().ok_or("Missing ID token")?;
        let verify = client
            .id_token_verifier()
            .set_allowed_algs([CoreJwsSigningAlgorithm::EdDsa]);
        let claims = id
            .claims(&verify, &nonce)
            .map_err(|_| "Invalid able ID token")?;
        if claims.subject().as_str().is_empty() || claims.email_verified() != Some(true) {
            return Err("A verified able email is required");
        }
        let userinfo_request = openidconnect::http::Request::builder()
            .uri(format!("{ISSUER}/oauth2/userinfo"))
            .header(
                "authorization",
                format!("Bearer {}", response.access_token().secret()),
            )
            .body(Vec::new())
            .map_err(|_| "Invalid userinfo request")?;
        let userinfo_response = http
            .call(userinfo_request)
            .map_err(|_| "Cannot verify able profile")?;
        if !userinfo_response.status().is_success() {
            return Err("Cannot verify able profile");
        }
        let userinfo: Value =
            serde_json::from_slice(userinfo_response.body()).map_err(|_| "Invalid able profile")?;
        if userinfo["sub"].as_str() != Some(claims.subject().as_str())
            || userinfo["email_verified"] != true
        {
            return Err("able profile did not match verified identity");
        }
        let email = userinfo["email"]
            .as_str()
            .ok_or("A verified able email is required")?
            .trim()
            .to_lowercase();
        if email.is_empty() {
            return Err("A verified able email is required");
        }
        if response.scopes().is_some_and(|scopes| {
            SCOPES
                .split(' ')
                .any(|required| !scopes.iter().any(|scope| scope.as_str() == required))
        }) {
            return Err("able did not grant the required identity scopes");
        }
        if let Some(expected) = claims.access_token_hash() {
            let actual = openidconnect::AccessTokenHash::from_token(
                response.access_token(),
                id.signing_alg()
                    .map_err(|_| "Invalid signature algorithm")?,
                id.signing_key(&verify)
                    .map_err(|_| "Invalid signature key")?,
            )
            .map_err(|_| "Invalid access token hash")?;
            if &actual != expected {
                return Err("Invalid access token hash");
            }
        }
        let refresh = response
            .refresh_token()
            .filter(|t| !t.secret().is_empty())
            .ok_or("able did not grant offline access; retry sign-in")?;
        let ttl = response
            .expires_in()
            .ok_or("Missing access token expiry")?
            .as_secs();
        if ttl == 0 || ttl > 3600 {
            return Err("Invalid access token expiry");
        }
        let credential = Credential {
            version: 1,
            issuer: ISSUER.into(),
            client_id: CLIENT_ID.into(),
            subject: claims.subject().as_str().into(),
            email,
            account_id: None,
            scopes: SCOPES.into(),
            audience: CLIENT_ID.into(),
            access_token: response.access_token().secret().clone(),
            refresh_token: refresh.secret().clone(),
            expires_at: now() + ttl,
            refresh_expires_at: now() + 30 * 86400,
        };
        let _lock = self.lock()?;
        let mut value = self.read()?;
        if value["able_generation"] != generation {
            return Err("Sign-in cancelled");
        }
        if self
            .current(&value)?
            .is_some_and(|old| old.subject != credential.subject)
            && !switch_account
        {
            return Err("Account switch requires confirmation; sign out first or confirm switch");
        }
        let status = credential.status();
        value["able"] = serde_json::to_value(credential).map_err(|_| "Cannot encode account")?;
        value["able_generation"] = json!(CsrfToken::new_random().secret());
        self.write(&value)?;
        Ok(status)
    }
    pub fn refresh(&self) -> Result<Status> {
        let _lock = self.lock()?; // re-read only after locking; no tokens cached across calls
        let mut value = self.read()?;
        let Some(mut credential) = self.current(&value)? else {
            return Ok(Status::default());
        };
        if credential.refresh_expires_at <= now() {
            clear(&mut value);
            self.write(&value)?;
            return Ok(Status::default());
        }
        if credential.expires_at > now() + 60 {
            return Ok(credential.status());
        }
        let http = http()?;
        let client = CoreClient::from_provider_metadata(
            metadata(&http)?,
            ClientId::new(CLIENT_ID.into()),
            None,
        )
        .set_auth_type(AuthType::RequestBody);
        let refresh = RefreshToken::new(credential.refresh_token.clone());
        let response = match client
            .exchange_refresh_token(&refresh)
            .map_err(|_| "Invalid token endpoint")?
            .request(&http)
        {
            Ok(response) => response,
            Err(openidconnect::RequestTokenError::ServerResponse(e))
                if e.error() == &openidconnect::core::CoreErrorResponseType::InvalidGrant =>
            {
                clear(&mut value);
                self.write(&value)?;
                return Ok(Status::default());
            }
            Err(_) => return Err("Account refresh failed; credentials retained for a later retry"),
        };
        if let Some(id) = response.id_token() {
            let verify = client
                .id_token_verifier()
                .set_allowed_algs([CoreJwsSigningAlgorithm::EdDsa]);
            let claims = id
                .claims(&verify, |_: Option<&Nonce>| Ok(()))
                .map_err(|_| "Invalid refreshed ID token")?;
            if claims.subject().as_str() != credential.subject {
                return Err("Refreshed account did not match");
            }
        }
        credential.access_token = response.access_token().secret().clone();
        if let Some(refresh) = response.refresh_token().filter(|t| !t.secret().is_empty()) {
            credential.refresh_token = refresh.secret().clone();
        }
        let ttl = response
            .expires_in()
            .ok_or("Missing access token expiry")?
            .as_secs();
        if ttl == 0 || ttl > 3600 {
            return Err("Invalid access token expiry");
        }
        credential.expires_at = now() + ttl;
        let status = credential.status();
        value["able"] = serde_json::to_value(credential).map_err(|_| "Cannot encode account")?;
        self.write(&value)?;
        Ok(status)
    }
    pub fn sign_out(&self) -> Result<Status> {
        let _lock = self.lock()?;
        let mut value = self.read()?;
        let credential = self.current(&value)?;
        // Persist cancellation even with no current account, so pending logins cannot commit.
        clear(&mut value);
        self.write(&value)?;
        let mut status = Status::default();
        if let Some(credential) = credential {
            status.revocation_failed = http()
                .and_then(|http| {
                    let body: String = reqwest::Url::parse_with_params(
                        "http://localhost",
                        &[
                            ("client_id", CLIENT_ID),
                            ("token", credential.refresh_token.as_str()),
                            ("token_type_hint", "refresh_token"),
                        ],
                    )
                    .map_err(|_| "Revocation failed")?
                    .query()
                    .unwrap_or_default()
                    .into();
                    let request = openidconnect::http::Request::builder()
                        .method("POST")
                        .uri(format!("{ISSUER}/oauth2/revoke"))
                        .header("content-type", "application/x-www-form-urlencoded")
                        .body(body.into_bytes())
                        .map_err(|_| "Revocation failed")?;
                    let response = http.call(request).map_err(|_| "Revocation failed")?;
                    if response.status().is_success() {
                        Ok(())
                    } else {
                        Err("Revocation failed")
                    }
                })
                .is_err();
        }
        Ok(status)
    }
}
fn clear(value: &mut Value) {
    value.as_object_mut().unwrap().remove("able");
    value["able_generation"] = json!(CsrfToken::new_random().secret());
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
// Windows may assign an elevated token's default owner (Administrators) to new
// objects. Set the private owner/DACL only after exclusive creation; never adopt
// existing paths, which must pass the ownership check below.
fn initialize_created_path(_path: &Path) -> Result<()> {
    #[cfg(windows)]
    appliance_credential_store::restrict_to_current_user(_path)
        .map_err(|_| "Cannot secure new account storage")?;
    Ok(())
}
fn secure(path: &Path, directory: bool) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|_| "Cannot inspect account storage")?;
    if meta.file_type().is_symlink()
        || (directory && !meta.is_dir())
        || (!directory && !meta.is_file())
    {
        return Err("Unsafe account storage path");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o777 != if directory { 0o700 } else { 0o600 }
        {
            return Err("Account storage must be owned by you with directory 0700 and files 0600");
        }
    }
    #[cfg(windows)]
    appliance_credential_store::secure_owned_account_path(path)
        .map_err(|_| "Unsafe account storage ownership or permissions")?;
    Ok(())
}
#[cfg_attr(test, allow(dead_code))]
struct AbleHttp(reqwest::blocking::Client);
impl SyncHttpClient for AbleHttp {
    type Error = std::io::Error;
    fn call(
        &self,
        request: openidconnect::HttpRequest,
    ) -> std::result::Result<openidconnect::HttpResponse, Self::Error> {
        #[cfg(test)]
        {
            tests::request(request)
        }
        #[cfg(not(test))]
        self.0.call(request).map_err(std::io::Error::other)
    }
}
fn http() -> Result<AbleHttp> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map(AbleHttp)
        .map_err(|_| "Cannot initialize able connection")
}
fn get(http: &AbleHttp, url: &str) -> Result<Vec<u8>> {
    let request = openidconnect::http::Request::builder()
        .uri(url)
        .body(Vec::new())
        .map_err(|_| "Invalid able request")?;
    let response = http.call(request).map_err(|_| "Cannot connect to able")?;
    if !response.status().is_success() || response.body().len() > 1024 * 1024 {
        return Err("Invalid able response");
    }
    Ok(response.into_body())
}
fn metadata(http: &AbleHttp) -> Result<CoreProviderMetadata> {
    let metadata: CoreProviderMetadata =
        serde_json::from_slice(&get(http, DISCOVERY)?).map_err(|_| "Invalid able discovery")?;
    if metadata.issuer().as_str() != ISSUER
        || metadata.authorization_endpoint().as_str() != format!("{ISSUER}/oauth2/authorize")
        || metadata.token_endpoint().map(|u| u.as_str())
            != Some(format!("{ISSUER}/oauth2/token").as_str())
        || metadata.jwks_uri().as_str() != format!("{ISSUER}/jwks")
    {
        return Err("able discovery did not match the pinned contract");
    }
    Ok(metadata.set_jwks(
        serde_json::from_slice(&get(http, &format!("{ISSUER}/jwks"))?)
            .map_err(|_| "Invalid able signing keys")?,
    ))
}

#[cfg(test)]
mod tests;
