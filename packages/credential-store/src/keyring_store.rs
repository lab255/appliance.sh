use crate::{CredentialStore, StoreError, StoreKey};
use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine;

const DESKTOP_SERVICE: &str = "sh.appliance.desktop";
const AGENT_SERVICE: &str = "sh.appliance.agent";
const ENTITLEMENT_KEY_ACCOUNT: &str = "device:entitlements:v1";
const ENTITLEMENT_ANCHOR_ACCOUNT: &str = "device:entitlements-anchor:v1";
const BINARY_VALUE_PREFIX: &str = "\0appliance:opaque-bytes:v1:";

#[derive(Debug, Default, Clone, Copy)]
pub struct KeyringStore;

impl KeyringStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(key: &StoreKey) -> Result<keyring::Entry, StoreError> {
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            return Err(StoreError::Unsupported(format!(
                "{} (OS keyring is enabled only on Windows and macOS)",
                key.canonical_name()
            )));
        }

        #[cfg(any(windows, target_os = "macos"))]
        {
            let (service, account) = match key {
                StoreKey::Cluster(profile) => (DESKTOP_SERVICE, format!("cluster:{profile}")),
                StoreKey::Agent(provider) => (AGENT_SERVICE, provider.as_str().to_owned()),
                StoreKey::EntitlementKey => (DESKTOP_SERVICE, ENTITLEMENT_KEY_ACCOUNT.to_owned()),
                StoreKey::EntitlementAnchor => {
                    (DESKTOP_SERVICE, ENTITLEMENT_ANCHOR_ACCOUNT.to_owned())
                }
                StoreKey::VmBroker { .. } => {
                    return Err(StoreError::Unsupported(key.canonical_name()))
                }
            };
            keyring::Entry::new(service, &account).map_err(map_keyring_error)
        }
    }
}

impl CredentialStore for KeyringStore {
    fn get(&self, key: &StoreKey) -> Result<Option<Vec<u8>>, StoreError> {
        let entry = Self::entry(key)?;
        match entry.get_password() {
            Ok(password) => decode_password(password).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn put(&self, key: &StoreKey, value: &[u8]) -> Result<(), StoreError> {
        let entry = Self::entry(key)?;
        let password = encode_password(value);
        entry.set_password(&password).map_err(map_keyring_error)
    }

    fn delete(&self, key: &StoreKey) -> Result<(), StoreError> {
        let entry = Self::entry(key)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

fn encode_password(value: &[u8]) -> String {
    match std::str::from_utf8(value) {
        Ok(text) if !text.starts_with(BINARY_VALUE_PREFIX) => text.to_owned(),
        _ => format!("{BINARY_VALUE_PREFIX}{}", STANDARD_NO_PAD.encode(value)),
    }
}

fn decode_password(password: String) -> Result<Vec<u8>, StoreError> {
    if let Some(encoded) = password.strip_prefix(BINARY_VALUE_PREFIX) {
        STANDARD_NO_PAD
            .decode(encoded)
            .map_err(|_| StoreError::Malformed("invalid opaque-byte encoding".to_owned()))
    } else {
        Ok(password.into_bytes())
    }
}

fn map_keyring_error(error: keyring::Error) -> StoreError {
    match error {
        keyring::Error::NoStorageAccess(source) => StoreError::Denied(source.to_string()),
        keyring::Error::BadEncoding(_)
        | keyring::Error::Invalid(_, _)
        | keyring::Error::Ambiguous(_) => StoreError::Malformed(error.to_string()),
        keyring::Error::NoEntry => StoreError::Internal("unexpected missing credential".to_owned()),
        keyring::Error::PlatformFailure(source) => StoreError::Internal(source.to_string()),
        keyring::Error::TooLong(_, _) => StoreError::Internal(error.to_string()),
        _ => StoreError::Internal(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_encoding_preserves_utf8_binary_and_reserved_values() {
        for value in [
            b"ordinary utf-8".as_slice(),
            b"non-ascii: \xe2\x98\x83".as_slice(),
            b"binary: \xff\x00\r\n".as_slice(),
            format!("{BINARY_VALUE_PREFIX}collision").as_bytes(),
        ] {
            assert_eq!(decode_password(encode_password(value)).unwrap(), value);
        }
        assert_eq!(
            encode_password(b"existing desktop value"),
            "existing desktop value"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_keyring_round_trip() {
        round_trip_platform_keyring();
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires an unlocked interactive login Keychain; release macOS runners are headless"]
    fn macos_keyring_round_trip() {
        round_trip_platform_keyring();
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn round_trip_platform_keyring() {
        let store = KeyringStore::new();
        let key = StoreKey::cluster(format!("test-{}", std::process::id())).unwrap();
        let value = b"byte-exact \x00 \xff";
        store.delete(&key).unwrap();
        assert_eq!(store.get(&key).unwrap(), None);
        store.put(&key, value).unwrap();
        assert_eq!(store.get(&key).unwrap().as_deref(), Some(value.as_slice()));
        assert_eq!(store.probe(&key).unwrap(), crate::Presence::Present);
        store.delete(&key).unwrap();
        assert_eq!(store.probe(&key).unwrap(), crate::Presence::Missing);
    }
}
