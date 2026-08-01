use std::collections::BTreeSet;
use std::fmt;

use age::secrecy::ExposeSecret;
use age::secrecy::SecretString;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;

mod engine;
mod fake;
mod local;

pub use fake::FakeCredentialStore;
pub use local::LocalCredentialStore;

const CREDENTIAL_ID_HEX_BYTES: usize = 16;
const MAX_ID_BYTES: usize = 128;
const MAX_GRANTED_SCOPES: usize = 32;
const MAX_SCOPE_BYTES: usize = 128;
const MAX_SECRET_BYTES: usize = 64 * 1024;
const MAX_CREATE_ATTEMPTS: usize = 4;

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct CredentialId(String);

impl CredentialId {
    pub fn parse(raw: &str) -> Result<Self, CredentialStoreError> {
        let Some(hex) = raw.strip_prefix("cred_") else {
            return Err(CredentialStoreError::InvalidInput("invalid credential id"));
        };
        if hex.len() != CREDENTIAL_ID_HEX_BYTES * 2
            || !hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(CredentialStoreError::InvalidInput("invalid credential id"));
        }
        Ok(Self(raw.to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for CredentialId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("CredentialId")
            .field(&self.0)
            .finish()
    }
}

impl fmt::Display for CredentialId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for CredentialId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialOwner {
    actor_id: String,
    tenant_id: Option<String>,
    space_id: Option<String>,
}

impl<'de> Deserialize<'de> for CredentialOwner {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct StoredOwner {
            actor_id: String,
            tenant_id: Option<String>,
            space_id: Option<String>,
        }

        let owner = StoredOwner::deserialize(deserializer)?;
        Self::new(owner.actor_id, owner.tenant_id, owner.space_id).map_err(serde::de::Error::custom)
    }
}

impl CredentialOwner {
    pub fn user(actor_id: impl Into<String>) -> Result<Self, CredentialStoreError> {
        Self::new(
            actor_id.into(),
            /*tenant_id*/ None,
            /*space_id*/ None,
        )
    }

    pub fn tenant_user(
        actor_id: impl Into<String>,
        tenant_id: impl Into<String>,
    ) -> Result<Self, CredentialStoreError> {
        Self::new(
            actor_id.into(),
            Some(tenant_id.into()),
            /*space_id*/ None,
        )
    }

    pub fn space_user(
        actor_id: impl Into<String>,
        tenant_id: impl Into<String>,
        space_id: impl Into<String>,
    ) -> Result<Self, CredentialStoreError> {
        Self::new(
            actor_id.into(),
            Some(tenant_id.into()),
            Some(space_id.into()),
        )
    }

    fn new(
        actor_id: String,
        tenant_id: Option<String>,
        space_id: Option<String>,
    ) -> Result<Self, CredentialStoreError> {
        validate_identifier(&actor_id, "invalid credential actor")?;
        if let Some(tenant_id) = tenant_id.as_deref() {
            validate_identifier(tenant_id, "invalid credential tenant")?;
        }
        if let Some(space_id) = space_id.as_deref() {
            validate_identifier(space_id, "invalid credential space")?;
            if tenant_id.is_none() {
                return Err(CredentialStoreError::InvalidInput(
                    "credential space requires tenant",
                ));
            }
        }
        Ok(Self {
            actor_id,
            tenant_id,
            space_id,
        })
    }

    pub fn actor_id(&self) -> &str {
        self.actor_id.as_str()
    }

    pub fn tenant_id(&self) -> Option<&str> {
        self.tenant_id.as_deref()
    }

    pub fn space_id(&self) -> Option<&str> {
        self.space_id.as_deref()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialScopeKind {
    User,
    Space,
    Service,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct GrantedCredentialScope(String);

impl GrantedCredentialScope {
    pub fn new(raw: impl Into<String>) -> Result<Self, CredentialStoreError> {
        let value = raw.into();
        if value.is_empty()
            || value.len() > MAX_SCOPE_BYTES
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-')
            })
        {
            return Err(CredentialStoreError::InvalidInput(
                "invalid credential granted scope",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl<'de> Deserialize<'de> for GrantedCredentialScope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::new(raw).map_err(serde::de::Error::custom)
    }
}

pub struct CredentialSecret(SecretString);

impl CredentialSecret {
    pub fn new(value: impl Into<String>) -> Result<Self, CredentialStoreError> {
        let value = value.into();
        if value.is_empty() || value.len() > MAX_SECRET_BYTES {
            return Err(CredentialStoreError::InvalidInput(
                "invalid credential secret",
            ));
        }
        Ok(Self(SecretString::from(value)))
    }

    pub fn expose_secret(&self) -> &str {
        self.0.expose_secret()
    }

    pub(super) fn into_inner(self) -> SecretString {
        self.0
    }

    pub(super) fn from_inner(value: SecretString) -> Self {
        Self(value)
    }
}

impl fmt::Debug for CredentialSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CredentialSecret([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialStatus {
    Available,
    Expired,
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialMetadata {
    pub credential_id: CredentialId,
    pub provider_id: String,
    pub owner: CredentialOwner,
    pub scope: CredentialScopeKind,
    pub granted_scopes: BTreeSet<GrantedCredentialScope>,
    pub status: CredentialStatus,
    pub expires_at: Option<i64>,
    pub revision: u64,
    pub created_at: i64,
    pub rotated_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

pub struct CredentialAccess {
    pub metadata: CredentialMetadata,
    pub secret: CredentialSecret,
}

impl fmt::Debug for CredentialAccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialAccess")
            .field("metadata", &self.metadata)
            .field("secret", &self.secret)
            .finish()
    }
}

pub struct CredentialCreateRequest {
    pub provider_id: String,
    pub owner: CredentialOwner,
    pub scope: CredentialScopeKind,
    pub granted_scopes: Vec<GrantedCredentialScope>,
    pub secret: CredentialSecret,
    pub expires_at: Option<i64>,
    pub now: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialAccessRequest {
    pub credential_id: CredentialId,
    pub owner: CredentialOwner,
    pub now: i64,
}

pub struct CredentialRotateRequest {
    pub credential_id: CredentialId,
    pub owner: CredentialOwner,
    pub secret: CredentialSecret,
    pub expires_at: Option<i64>,
    pub now: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialStoreError {
    InvalidInput(&'static str),
    NotFound,
    Expired,
    Revoked,
    RevisionExhausted,
    Unavailable(&'static str),
}

impl fmt::Display for CredentialStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(message) => formatter.write_str(message),
            Self::NotFound => formatter.write_str("credential not found"),
            Self::Expired => formatter.write_str("credential expired"),
            Self::Revoked => formatter.write_str("credential revoked"),
            Self::RevisionExhausted => formatter.write_str("credential revision exhausted"),
            Self::Unavailable(message) => {
                write!(formatter, "credential store unavailable: {message}")
            }
        }
    }
}

impl std::error::Error for CredentialStoreError {}

/// Stores provider credentials while enforcing server-derived ownership and lifecycle rules.
///
/// Implementations must never expose Secret values through Debug, errors, logs, or serialized
/// metadata. A web implementation belongs in a server-side Cloud Vault adapter, not in a browser.
pub trait CredentialStore: Send + Sync {
    fn create(
        &self,
        request: CredentialCreateRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError>;

    fn inspect(
        &self,
        request: CredentialAccessRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError>;

    fn read(
        &self,
        request: CredentialAccessRequest,
    ) -> Result<CredentialAccess, CredentialStoreError>;

    fn rotate(
        &self,
        request: CredentialRotateRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError>;

    fn revoke(
        &self,
        request: CredentialAccessRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError>;
}

fn validate_provider_id(provider_id: &str) -> Result<(), CredentialStoreError> {
    validate_identifier(provider_id, "invalid credential provider")
}

fn validate_identifier(value: &str, message: &'static str) -> Result<(), CredentialStoreError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-'))
    {
        return Err(CredentialStoreError::InvalidInput(message));
    }
    Ok(())
}

fn validate_owner_scope(
    owner: &CredentialOwner,
    scope: CredentialScopeKind,
) -> Result<(), CredentialStoreError> {
    if matches!(scope, CredentialScopeKind::Space) && owner.space_id().is_none() {
        return Err(CredentialStoreError::InvalidInput(
            "space credential requires space owner",
        ));
    }
    Ok(())
}

fn validate_expiry(expires_at: Option<i64>, now: i64) -> Result<(), CredentialStoreError> {
    if expires_at.is_some_and(|expires_at| expires_at <= now) {
        return Err(CredentialStoreError::InvalidInput(
            "credential expiry must be in the future",
        ));
    }
    Ok(())
}

fn normalize_scopes(
    granted_scopes: Vec<GrantedCredentialScope>,
) -> Result<BTreeSet<GrantedCredentialScope>, CredentialStoreError> {
    let granted_scopes = granted_scopes.into_iter().collect::<BTreeSet<_>>();
    if granted_scopes.is_empty() || granted_scopes.len() > MAX_GRANTED_SCOPES {
        return Err(CredentialStoreError::InvalidInput(
            "invalid credential granted scope count",
        ));
    }
    Ok(granted_scopes)
}

#[cfg(test)]
#[path = "credential_tests.rs"]
mod tests;
