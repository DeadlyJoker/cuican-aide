use std::fmt;

use sha2::Digest;
use sha2::Sha256;
use uuid::Uuid;

const CONNECTION_ID_PREFIX: &str = "provider-connection:";
const MAX_ID_BYTES: usize = 255;
const MAX_PROTOCOL_VERSION_BYTES: usize = 64;
const DIGEST_PREFIX: &str = "sha256:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderConnectionRecordErrorKind {
    Empty,
    TooLong,
    InvalidConnectionId,
    InvalidDigest,
    OutOfRange,
    DigestMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderConnectionRecordError {
    field: &'static str,
    kind: ProviderConnectionRecordErrorKind,
}

impl ProviderConnectionRecordError {
    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn kind(&self) -> ProviderConnectionRecordErrorKind {
        self.kind
    }
}

impl fmt::Display for ProviderConnectionRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid provider connection field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for ProviderConnectionRecordError {}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderConnectionRecord {
    pub connection_id: String,
    pub local_actor_id: String,
    pub local_tenant_id: String,
    pub local_space_id: String,
    pub provider_id: String,
    pub protocol_version: String,
    pub credential_id: String,
    pub credential_revision: u64,
    pub record_hash: String,
    pub created_at: i64,
}

impl ProviderConnectionRecord {
    pub fn validate(&self) -> Result<(), ProviderConnectionRecordError> {
        validate_connection_id(&self.connection_id)?;
        validate_text(&self.local_actor_id, "localActorId", MAX_ID_BYTES)?;
        validate_text(&self.local_tenant_id, "localTenantId", MAX_ID_BYTES)?;
        validate_text(&self.local_space_id, "localSpaceId", MAX_ID_BYTES)?;
        validate_text(&self.provider_id, "providerId", MAX_ID_BYTES)?;
        validate_text(
            &self.protocol_version,
            "protocolVersion",
            MAX_PROTOCOL_VERSION_BYTES,
        )?;
        validate_text(&self.credential_id, "credentialId", MAX_ID_BYTES)?;
        if self.credential_revision == 0 || self.credential_revision > i64::MAX as u64 {
            return Err(error(
                "credentialRevision",
                ProviderConnectionRecordErrorKind::OutOfRange,
            ));
        }
        validate_digest(&self.record_hash, "recordHash")?;
        if self.created_at < 0 {
            return Err(error(
                "createdAt",
                ProviderConnectionRecordErrorKind::OutOfRange,
            ));
        }
        if self.record_hash != self.canonical_hash() {
            return Err(error(
                "recordHash",
                ProviderConnectionRecordErrorKind::DigestMismatch,
            ));
        }
        Ok(())
    }

    pub fn canonical_hash(&self) -> String {
        let credential_revision = self.credential_revision.to_string();
        let created_at = self.created_at.to_string();
        digest_parts(&[
            self.connection_id.as_bytes(),
            self.local_actor_id.as_bytes(),
            self.local_tenant_id.as_bytes(),
            self.local_space_id.as_bytes(),
            self.provider_id.as_bytes(),
            self.protocol_version.as_bytes(),
            self.credential_id.as_bytes(),
            credential_revision.as_bytes(),
            created_at.as_bytes(),
        ])
    }
}

impl fmt::Debug for ProviderConnectionRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderConnectionRecord")
            .field("connection_id", &self.connection_id)
            .field("local_actor_id", &"[REDACTED]")
            .field("local_tenant_id", &"[REDACTED]")
            .field("local_space_id", &"[REDACTED]")
            .field("provider_id", &self.provider_id)
            .field("protocol_version", &self.protocol_version)
            .field("credential_id", &"[REDACTED]")
            .field("credential_revision", &self.credential_revision)
            .field("record_hash", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderConnectionResolveOutcome {
    Created(ProviderConnectionRecord),
    Existing(ProviderConnectionRecord),
    CapacityExceeded,
    Conflict,
}

pub(crate) fn validate_connection_id(
    connection_id: &str,
) -> Result<(), ProviderConnectionRecordError> {
    let Some(raw_uuid) = connection_id.strip_prefix(CONNECTION_ID_PREFIX) else {
        return Err(error(
            "connectionId",
            ProviderConnectionRecordErrorKind::InvalidConnectionId,
        ));
    };
    let parsed = Uuid::parse_str(raw_uuid).map_err(|_| {
        error(
            "connectionId",
            ProviderConnectionRecordErrorKind::InvalidConnectionId,
        )
    })?;
    if parsed.to_string() != raw_uuid {
        return Err(error(
            "connectionId",
            ProviderConnectionRecordErrorKind::InvalidConnectionId,
        ));
    }
    Ok(())
}

fn validate_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), ProviderConnectionRecordError> {
    if value.is_empty() || value.trim() != value {
        return Err(error(field, ProviderConnectionRecordErrorKind::Empty));
    }
    if value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(error(field, ProviderConnectionRecordErrorKind::TooLong));
    }
    Ok(())
}

fn validate_digest(value: &str, field: &'static str) -> Result<(), ProviderConnectionRecordError> {
    let Some(hex) = value.strip_prefix(DIGEST_PREFIX) else {
        return Err(error(
            field,
            ProviderConnectionRecordErrorKind::InvalidDigest,
        ));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(error(
            field,
            ProviderConnectionRecordErrorKind::InvalidDigest,
        ));
    }
    Ok(())
}

fn digest_parts(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"crewon.provider-connection.v1\0");
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn error(
    field: &'static str,
    kind: ProviderConnectionRecordErrorKind,
) -> ProviderConnectionRecordError {
    ProviderConnectionRecordError { field, kind }
}
