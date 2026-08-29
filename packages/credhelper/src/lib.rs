use appliance_credential_store::{CredentialStore, Presence, StoreError, StoreKey};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};

pub const EXIT_OK: i32 = 0;
pub const EXIT_INTERNAL: i32 = 1;
pub const EXIT_MISSING: i32 = 3;
pub const EXIT_DENIED: i32 = 4;
pub const EXIT_MALFORMED: i32 = 5;
pub const EXIT_INVALID_IDENTIFIER: i32 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Get,
    Put,
    Delete,
    Probe,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Store { operation: Operation, key: StoreKey },
    EntitlementKeyGetOrCreate,
    EntitlementAnchorGet,
    EntitlementAnchorPut,
}

#[derive(Debug)]
pub enum CommandError {
    Missing,
    Store(StoreError),
    Io(std::io::Error),
}

impl CommandError {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Missing => EXIT_MISSING,
            Self::Store(StoreError::Denied(_)) => EXIT_DENIED,
            Self::Store(StoreError::Malformed(_)) => EXIT_MALFORMED,
            Self::Store(StoreError::InvalidIdentifier { .. }) => EXIT_INVALID_IDENTIFIER,
            Self::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => EXIT_DENIED,
            Self::Store(StoreError::Unsupported(_) | StoreError::Internal(_)) | Self::Io(_) => {
                EXIT_INTERNAL
            }
        }
    }

    pub fn diagnostic(&self) -> String {
        match self {
            Self::Missing => "credential is missing".to_owned(),
            Self::Store(error) => error.to_string(),
            Self::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                "credential I/O was denied".to_owned()
            }
            Self::Io(_) => "credential I/O failed".to_owned(),
        }
    }
}

impl From<StoreError> for CommandError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<std::io::Error> for CommandError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn execute<S: CredentialStore, R: Read, W: Write>(
    store: &S,
    request: &Request,
    input: &mut R,
    output: &mut W,
) -> Result<(), CommandError> {
    match request {
        Request::Store { operation, key } => match operation {
            Operation::Get => {
                let value = store.get(key)?.ok_or(CommandError::Missing)?;
                output.write_all(&value)?;
                output.flush()?;
                Ok(())
            }
            Operation::Put => {
                let mut value = Vec::new();
                input.read_to_end(&mut value)?;
                store.put(key, &value)?;
                Ok(())
            }
            Operation::Delete => store.delete(key).map_err(Into::into),
            Operation::Probe => match store.probe(key)? {
                Presence::Present => Ok(()),
                Presence::Missing => Err(CommandError::Missing),
            },
        },
        Request::EntitlementKeyGetOrCreate => {
            let lock = UserGlobalLock::acquire()?;
            let key = StoreKey::entitlement_key();
            let value = get_or_create_entitlement_key(store, &key)?;
            output.write_all(&value)?;
            output.flush()?;
            drop(lock);
            Ok(())
        }
        Request::EntitlementAnchorGet => {
            let value = store
                .get(&StoreKey::entitlement_anchor())?
                .ok_or(CommandError::Missing)?;
            validate_entitlement_anchor(&value)?;
            output.write_all(&value)?;
            output.flush()?;
            Ok(())
        }
        Request::EntitlementAnchorPut => {
            let mut value = Vec::new();
            input.read_to_end(&mut value)?;
            validate_entitlement_anchor(&value)?;
            store.put(&StoreKey::entitlement_anchor(), &value)?;
            Ok(())
        }
    }
}

fn get_or_create_entitlement_key<S: CredentialStore>(
    store: &S,
    key: &StoreKey,
) -> Result<Vec<u8>, CommandError> {
    if let Some(existing) = store.get(key)? {
        validate_entitlement_key(&existing)?;
        return Ok(existing);
    }

    // Re-read immediately before the write. All Appliance surfaces use the
    // same user-global lock; this second read also protects a caller that
    // completed a legacy write just before it joined that protocol.
    if let Some(existing) = store.get(key)? {
        validate_entitlement_key(&existing)?;
        return Ok(existing);
    }

    let mut seed = [0_u8; 32];
    getrandom::fill(&mut seed)
        .map_err(|error| StoreError::Internal(format!("secure randomness unavailable: {error}")))?;
    let generated = format!("ed25519:{}", URL_SAFE_NO_PAD.encode(seed));
    store.put(key, generated.as_bytes())?;

    // The OS store is canonical. Always re-read instead of returning our
    // candidate so an interleaving writer's value wins visibly.
    let canonical = store.get(key)?.ok_or_else(|| {
        StoreError::Internal("entitlement key disappeared after its write".to_owned())
    })?;
    validate_entitlement_key(&canonical)?;
    Ok(canonical)
}

fn validate_entitlement_key(value: &[u8]) -> Result<(), StoreError> {
    let wire = std::str::from_utf8(value)
        .map_err(|_| StoreError::Malformed("entitlement key is not UTF-8".to_owned()))?;
    let encoded = wire
        .strip_prefix("ed25519:")
        .ok_or_else(|| StoreError::Malformed("entitlement key has an invalid prefix".to_owned()))?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| {
        StoreError::Malformed("entitlement key is not canonical base64url".to_owned())
    })?;
    if decoded.len() != 32 || URL_SAFE_NO_PAD.encode(&decoded) != encoded {
        return Err(StoreError::Malformed(
            "entitlement key has an invalid seed".to_owned(),
        ));
    }
    Ok(())
}

fn validate_entitlement_anchor(value: &[u8]) -> Result<(), StoreError> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

    let parsed: serde_json::Value = serde_json::from_slice(value)
        .map_err(|_| StoreError::Malformed("entitlement anchor is not valid JSON".to_owned()))?;
    let sequence = parsed.get("sequence").and_then(|value| {
        value.as_u64().or_else(|| {
            value.as_f64().and_then(|number| {
                (number.fract() == 0.0 && (1.0..=MAX_SAFE_INTEGER as f64).contains(&number))
                    .then_some(number as u64)
            })
        })
    });
    let head_hash = parsed.get("headHash").and_then(serde_json::Value::as_str);
    let valid_hash = head_hash.is_some_and(|hash| {
        hash.len() == 71
            && hash.starts_with("sha256:")
            && hash[7..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    });
    if sequence.is_none() || !valid_hash {
        return Err(StoreError::Malformed(
            "entitlement anchor has an invalid structure".to_owned(),
        ));
    }
    Ok(())
}

struct UserGlobalLock {
    file: File,
}

impl UserGlobalLock {
    fn acquire() -> Result<Self, CommandError> {
        let home = dirs::home_dir().ok_or_else(|| {
            StoreError::Internal("cannot resolve the current user's home directory".to_owned())
        })?;
        let directory = home.join(".appliance");
        fs::create_dir_all(&directory)?;
        let path = directory.join("credential-store.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path)?;
        fs2::FileExt::lock_exclusive(&file)?;
        Ok(Self { file })
    }
}

impl Drop for UserGlobalLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

pub fn parse_store_key(kind: KeyKind<'_>) -> Result<StoreKey, CommandError> {
    match kind {
        KeyKind::Cluster(profile) => StoreKey::cluster(profile).map_err(Into::into),
        KeyKind::Agent(provider) => StoreKey::agent(provider).map_err(Into::into),
        KeyKind::EntitlementAnchor => Ok(StoreKey::entitlement_anchor()),
    }
}

#[derive(Debug, Clone, Copy)]
pub enum KeyKind<'a> {
    Cluster(&'a str),
    Agent(&'a str),
    EntitlementAnchor,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryStore {
        values: RefCell<HashMap<String, Vec<u8>>>,
        put_count: Cell<usize>,
        canonical_after_put: RefCell<Option<Vec<u8>>>,
        error: RefCell<Option<StoreError>>,
    }

    impl CredentialStore for MemoryStore {
        fn get(&self, key: &StoreKey) -> Result<Option<Vec<u8>>, StoreError> {
            if let Some(error) = self.error.borrow_mut().take() {
                return Err(error);
            }
            Ok(self.values.borrow().get(&key.canonical_name()).cloned())
        }

        fn put(&self, key: &StoreKey, value: &[u8]) -> Result<(), StoreError> {
            self.put_count.set(self.put_count.get() + 1);
            let canonical = self
                .canonical_after_put
                .borrow_mut()
                .take()
                .unwrap_or_else(|| value.to_vec());
            self.values
                .borrow_mut()
                .insert(key.canonical_name(), canonical);
            Ok(())
        }

        fn delete(&self, key: &StoreKey) -> Result<(), StoreError> {
            self.values.borrow_mut().remove(&key.canonical_name());
            Ok(())
        }
    }

    #[test]
    fn raw_pipe_contract_adds_no_bytes() {
        let store = MemoryStore::default();
        let key = StoreKey::cluster("pipe-test").unwrap();
        let raw = b"\x00line one\r\nline two\xff";
        execute(
            &store,
            &Request::Store {
                operation: Operation::Put,
                key: key.clone(),
            },
            &mut raw.as_slice(),
            &mut Vec::new(),
        )
        .unwrap();
        let mut output = Vec::new();
        execute(
            &store,
            &Request::Store {
                operation: Operation::Get,
                key,
            },
            &mut std::io::empty(),
            &mut output,
        )
        .unwrap();
        assert_eq!(output, raw);
    }

    #[test]
    fn existing_entitlement_key_always_wins_without_a_write() {
        let store = MemoryStore::default();
        let key = StoreKey::entitlement_key();
        let existing = format!("ed25519:{}", URL_SAFE_NO_PAD.encode([7_u8; 32]));
        store
            .values
            .borrow_mut()
            .insert(key.canonical_name(), existing.as_bytes().to_vec());
        assert_eq!(
            get_or_create_entitlement_key(&store, &key).unwrap(),
            existing.as_bytes()
        );
        assert_eq!(store.put_count.get(), 0);
    }

    #[test]
    fn entitlement_creation_returns_the_post_write_canonical_value() {
        let store = MemoryStore::default();
        let winner = format!("ed25519:{}", URL_SAFE_NO_PAD.encode([9_u8; 32]));
        *store.canonical_after_put.borrow_mut() = Some(winner.as_bytes().to_vec());
        let key = StoreKey::entitlement_key();
        assert_eq!(
            get_or_create_entitlement_key(&store, &key).unwrap(),
            winner.as_bytes()
        );
        assert_eq!(store.put_count.get(), 1);
    }

    #[test]
    fn malformed_existing_entitlement_key_fails_without_a_write() {
        let store = MemoryStore::default();
        let key = StoreKey::entitlement_key();
        store
            .values
            .borrow_mut()
            .insert(key.canonical_name(), b"ed25519:not-a-seed".to_vec());
        let error = get_or_create_entitlement_key(&store, &key).unwrap_err();
        assert_eq!(error.exit_code(), EXIT_MALFORMED);
        assert_eq!(store.put_count.get(), 0);
    }

    #[test]
    fn entitlement_anchor_is_validated_without_changing_its_bytes() {
        let store = MemoryStore::default();
        let anchor = format!(r#"{{"sequence":1,"headHash":"sha256:{}"}}"#, "a".repeat(64));
        execute(
            &store,
            &Request::EntitlementAnchorPut,
            &mut anchor.as_bytes(),
            &mut Vec::new(),
        )
        .unwrap();
        let mut output = Vec::new();
        execute(
            &store,
            &Request::EntitlementAnchorGet,
            &mut std::io::empty(),
            &mut output,
        )
        .unwrap();
        assert_eq!(output, anchor.as_bytes());
        assert!(validate_entitlement_anchor(
            format!(
                r#"{{"sequence":1.0,"headHash":"sha256:{}"}}"#,
                "f".repeat(64)
            )
            .as_bytes()
        )
        .is_ok());
    }

    #[test]
    fn malformed_entitlement_anchor_is_rejected_before_write() {
        let store = MemoryStore::default();
        let malformed = br#"{"sequence":0,"headHash":"sha256:nope"}"#;
        let error = execute(
            &store,
            &Request::EntitlementAnchorPut,
            &mut malformed.as_slice(),
            &mut Vec::new(),
        )
        .unwrap_err();
        assert_eq!(error.exit_code(), EXIT_MALFORMED);
        assert_eq!(store.put_count.get(), 0);
    }

    #[test]
    fn exit_code_matrix_is_closed_and_fail_closed() {
        let cases = [
            (CommandError::Missing, EXIT_MISSING),
            (
                CommandError::Store(StoreError::Denied("test".to_owned())),
                EXIT_DENIED,
            ),
            (
                CommandError::Store(StoreError::Malformed("test".to_owned())),
                EXIT_MALFORMED,
            ),
            (
                CommandError::Store(StoreError::InvalidIdentifier {
                    kind: "test",
                    max_len: 1,
                }),
                EXIT_INVALID_IDENTIFIER,
            ),
            (
                CommandError::Store(StoreError::Internal("test".to_owned())),
                EXIT_INTERNAL,
            ),
            (
                CommandError::Store(StoreError::Unsupported("test".to_owned())),
                EXIT_INTERNAL,
            ),
            (
                CommandError::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "test",
                )),
                EXIT_DENIED,
            ),
            (
                CommandError::Io(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "test")),
                EXIT_INTERNAL,
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(error.exit_code(), expected);
        }
    }

    #[test]
    fn rejects_cluster_and_provider_identifiers() {
        assert_eq!(
            parse_store_key(KeyKind::Cluster("../escape"))
                .unwrap_err()
                .exit_code(),
            EXIT_INVALID_IDENTIFIER
        );
        assert_eq!(
            parse_store_key(KeyKind::Agent("provider/name"))
                .unwrap_err()
                .exit_code(),
            EXIT_INVALID_IDENTIFIER
        );
    }
}
