//! Typed storage for Appliance credentials.
//!
//! Store values are opaque bytes. [`StoreKey`] deliberately exposes only the
//! credential classes Appliance owns, and every caller-supplied identifier is
//! validated before it can become an OS-store account or filesystem component.

use std::fmt;

#[cfg(feature = "file")]
mod file;
#[cfg(feature = "keyring")]
mod keyring_store;

#[cfg(feature = "file")]
pub use file::AclFileStore;
#[cfg(feature = "keyring")]
pub use keyring_store::KeyringStore;

pub const MAX_IDENTIFIER_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct StoreIdentifier(String);

impl StoreIdentifier {
    fn new(kind: &'static str, value: impl Into<String>) -> Result<Self, StoreError> {
        let value = value.into();
        let valid = value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
            && value.len() <= MAX_IDENTIFIER_LEN
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
        if !valid {
            return Err(StoreError::InvalidIdentifier {
                kind,
                max_len: MAX_IDENTIFIER_LEN,
            });
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for StoreIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VmBrokerFile {
    Credentials,
    Secrets,
}

impl VmBrokerFile {
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Credentials => "egress-credentials.json",
            Self::Secrets => "egress-secrets.json",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum StoreKey {
    Cluster(StoreIdentifier),
    Agent(StoreIdentifier),
    EntitlementKey,
    EntitlementAnchor,
    VmBroker {
        name: StoreIdentifier,
        file: VmBrokerFile,
    },
}

impl StoreKey {
    pub fn cluster(profile: impl Into<String>) -> Result<Self, StoreError> {
        Ok(Self::Cluster(StoreIdentifier::new("profile", profile)?))
    }

    pub fn agent(provider: impl Into<String>) -> Result<Self, StoreError> {
        Ok(Self::Agent(StoreIdentifier::new("provider", provider)?))
    }

    pub fn entitlement_key() -> Self {
        Self::EntitlementKey
    }

    pub fn entitlement_anchor() -> Self {
        Self::EntitlementAnchor
    }

    pub fn vm_broker(name: impl Into<String>, file: VmBrokerFile) -> Result<Self, StoreError> {
        Ok(Self::VmBroker {
            name: StoreIdentifier::new("vm name", name)?,
            file,
        })
    }

    pub fn canonical_name(&self) -> String {
        match self {
            Self::Cluster(profile) => format!("cluster:{profile}"),
            Self::Agent(provider) => format!("agent:{provider}"),
            Self::EntitlementKey => "entitlement-key".to_owned(),
            Self::EntitlementAnchor => "entitlement-anchor".to_owned(),
            Self::VmBroker { name, file } => {
                format!("vm-broker:{name}:{}", file.file_name())
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Missing,
    Present,
}

pub trait CredentialStore {
    fn get(&self, key: &StoreKey) -> Result<Option<Vec<u8>>, StoreError>;
    fn put(&self, key: &StoreKey, value: &[u8]) -> Result<(), StoreError>;
    fn delete(&self, key: &StoreKey) -> Result<(), StoreError>;

    fn probe(&self, key: &StoreKey) -> Result<Presence, StoreError> {
        self.get(key).map(|value| {
            if value.is_some() {
                Presence::Present
            } else {
                Presence::Missing
            }
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("invalid {kind}; expected 1..={max_len} characters, starting with an ASCII letter or digit and containing only letters, digits, '.', '_' or '-'")]
    InvalidIdentifier { kind: &'static str, max_len: usize },
    #[error("credential store access denied: {0}")]
    Denied(String),
    #[error("credential store value is malformed: {0}")]
    Malformed(String),
    #[error("credential class is unsupported by this backend: {0}")]
    Unsupported(String),
    #[error("credential store failure: {0}")]
    Internal(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[test]
    fn validates_identifiers_and_canonical_names() {
        for valid in [
            "default",
            "local-runtime",
            "github_copilot",
            "prod.us-1",
            "A9",
        ] {
            assert!(StoreKey::cluster(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "",
            ".",
            "..",
            "-leading",
            "two words",
            "slash/name",
            "colon:name",
            "é",
            "line\nbreak",
        ] {
            assert!(matches!(
                StoreKey::cluster(invalid),
                Err(StoreError::InvalidIdentifier { .. })
            ));
        }
        assert!(StoreKey::agent("x".repeat(MAX_IDENTIFIER_LEN)).is_ok());
        assert!(StoreKey::agent("x".repeat(MAX_IDENTIFIER_LEN + 1)).is_err());

        assert_eq!(
            StoreKey::cluster("prod").unwrap().canonical_name(),
            "cluster:prod"
        );
        assert_eq!(
            StoreKey::agent("openai").unwrap().canonical_name(),
            "agent:openai"
        );
        assert_eq!(
            StoreKey::entitlement_key().canonical_name(),
            "entitlement-key"
        );
        assert_eq!(
            StoreKey::entitlement_anchor().canonical_name(),
            "entitlement-anchor"
        );
        assert_eq!(
            StoreKey::vm_broker("main", VmBrokerFile::Secrets)
                .unwrap()
                .canonical_name(),
            "vm-broker:main:egress-secrets.json"
        );
    }

    #[derive(Debug, Deserialize)]
    struct EnvelopeVector {
        kind: String,
        value: String,
        encoded: String,
    }

    #[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
    struct AgentEnvelope {
        kind: String,
        value: String,
    }

    #[test]
    fn agent_envelope_vectors_are_byte_exact_round_trips() {
        let vectors: Vec<EnvelopeVector> =
            serde_json::from_str(include_str!("../testdata/envelope-vectors.json")).unwrap();
        assert!(!vectors.is_empty());
        for vector in vectors {
            let envelope = AgentEnvelope {
                kind: vector.kind,
                value: vector.value,
            };
            assert_eq!(
                serde_json::to_string(&envelope).unwrap().as_bytes(),
                vector.encoded.as_bytes()
            );
            assert_eq!(
                serde_json::from_str::<AgentEnvelope>(&vector.encoded).unwrap(),
                envelope
            );
        }
    }
}
