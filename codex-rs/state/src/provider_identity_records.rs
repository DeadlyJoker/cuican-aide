use std::fmt;

use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

use crate::provider_identity_validation::error;
use crate::provider_identity_validation::validate_revision;
use crate::provider_identity_validation::validate_text;

const PROVIDER_ID: &str = "agent-platform";
const MAX_ID_BYTES: usize = 255;
const MAX_SCOPE_ID_BYTES: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderIdentityBindingRecordErrorKind {
    Empty,
    TooLong,
    OutOfRange,
    InvalidPrincipal,
    InvalidProviderIdentity,
    InconsistentFields,
    DigestMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderIdentityBindingRecordError {
    pub(crate) field: &'static str,
    pub(crate) kind: ProviderIdentityBindingRecordErrorKind,
}

impl ProviderIdentityBindingRecordError {
    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn kind(&self) -> ProviderIdentityBindingRecordErrorKind {
        self.kind
    }
}

impl fmt::Display for ProviderIdentityBindingRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid Provider identity binding field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for ProviderIdentityBindingRecordError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderIdentityBindingStatus {
    Active,
    Revoked,
}

impl ProviderIdentityBindingStatus {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Revoked => "revoked",
        }
    }

    pub(crate) fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "active" => Ok(Self::Active),
            "revoked" => Ok(Self::Revoked),
            _ => anyhow::bail!("invalid Provider identity binding status"),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderIdentityBindingRecord {
    pub binding_id: String,
    pub local_actor_id: String,
    pub local_tenant_id: String,
    pub local_space_id: String,
    pub provider_id: String,
    pub provider_subject: String,
    pub provider_tenant_id: String,
    pub provider_space_id: String,
    pub authority_id: String,
    pub source_binding_id: String,
    pub source_revision: u64,
    pub source_fresh_until: i64,
    pub revision: u64,
    pub status: ProviderIdentityBindingStatus,
    pub record_hash: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl ProviderIdentityBindingRecord {
    pub fn validate(&self) -> Result<(), ProviderIdentityBindingRecordError> {
        validate_text(&self.binding_id, "bindingId", MAX_ID_BYTES)?;
        validate_principal(&self.local_actor_id)?;
        validate_text(&self.local_tenant_id, "localTenantId", MAX_SCOPE_ID_BYTES)?;
        validate_text(&self.local_space_id, "localSpaceId", MAX_SCOPE_ID_BYTES)?;
        if self.provider_id != PROVIDER_ID {
            return Err(error(
                "providerId",
                ProviderIdentityBindingRecordErrorKind::InconsistentFields,
            ));
        }
        validate_provider_subject(&self.provider_subject)?;
        validate_positive_integer(&self.provider_tenant_id, "providerTenantId")?;
        validate_positive_integer(&self.provider_space_id, "providerSpaceId")?;
        validate_text(&self.authority_id, "authorityId", MAX_ID_BYTES)?;
        validate_text(&self.source_binding_id, "sourceBindingId", MAX_ID_BYTES)?;
        validate_revision(self.source_revision, "sourceRevision")?;
        if self.source_fresh_until < 0
            || (self.source_fresh_until != 0 && self.source_fresh_until <= self.updated_at)
        {
            return Err(error(
                "sourceFreshUntil",
                ProviderIdentityBindingRecordErrorKind::OutOfRange,
            ));
        }
        validate_revision(self.revision, "revision")?;
        if self.created_at < 0 || self.updated_at < self.created_at {
            return Err(error(
                "updatedAt",
                ProviderIdentityBindingRecordErrorKind::OutOfRange,
            ));
        }
        if self.status == ProviderIdentityBindingStatus::Active
            && (self.source_revision != 1 || self.created_at != self.updated_at)
        {
            return Err(error(
                "status",
                ProviderIdentityBindingRecordErrorKind::InconsistentFields,
            ));
        }
        if self.status == ProviderIdentityBindingStatus::Revoked
            && (self.source_revision < 2 || self.revision < 2)
        {
            return Err(error(
                "revision",
                ProviderIdentityBindingRecordErrorKind::InconsistentFields,
            ));
        }
        validate_hash(&self.record_hash)?;
        if self.record_hash != self.canonical_hash() {
            return Err(error(
                "recordHash",
                ProviderIdentityBindingRecordErrorKind::DigestMismatch,
            ));
        }
        Ok(())
    }

    pub fn canonical_hash(&self) -> String {
        if self.source_fresh_until == 0 {
            return self.legacy_canonical_hash();
        }
        let source_revision = self.source_revision.to_string();
        let source_fresh_until = self.source_fresh_until.to_string();
        let revision = self.revision.to_string();
        let created_at = self.created_at.to_string();
        let updated_at = self.updated_at.to_string();
        digest_parts_v2(&[
            self.binding_id.as_bytes(),
            self.local_actor_id.as_bytes(),
            self.local_tenant_id.as_bytes(),
            self.local_space_id.as_bytes(),
            self.provider_id.as_bytes(),
            self.provider_subject.as_bytes(),
            self.provider_tenant_id.as_bytes(),
            self.provider_space_id.as_bytes(),
            self.authority_id.as_bytes(),
            self.source_binding_id.as_bytes(),
            source_revision.as_bytes(),
            source_fresh_until.as_bytes(),
            revision.as_bytes(),
            self.status.as_str().as_bytes(),
            created_at.as_bytes(),
            updated_at.as_bytes(),
        ])
    }

    fn legacy_canonical_hash(&self) -> String {
        let source_revision = self.source_revision.to_string();
        let revision = self.revision.to_string();
        let created_at = self.created_at.to_string();
        let updated_at = self.updated_at.to_string();
        digest_parts_v1(&[
            self.binding_id.as_bytes(),
            self.local_actor_id.as_bytes(),
            self.local_tenant_id.as_bytes(),
            self.local_space_id.as_bytes(),
            self.provider_id.as_bytes(),
            self.provider_subject.as_bytes(),
            self.provider_tenant_id.as_bytes(),
            self.provider_space_id.as_bytes(),
            self.authority_id.as_bytes(),
            self.source_binding_id.as_bytes(),
            source_revision.as_bytes(),
            revision.as_bytes(),
            self.status.as_str().as_bytes(),
            created_at.as_bytes(),
            updated_at.as_bytes(),
        ])
    }
}

impl fmt::Debug for ProviderIdentityBindingRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderIdentityBindingRecord")
            .field("binding_id", &self.binding_id)
            .field("owner", &"[REDACTED]")
            .field("provider_identity", &"[REDACTED]")
            .field("authority", &"[REDACTED]")
            .field("revision", &self.revision)
            .field("status", &self.status)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderIdentityBindingLookup {
    pub local_actor_id: String,
    pub local_tenant_id: String,
    pub local_space_id: String,
    pub provider_id: String,
}

impl ProviderIdentityBindingLookup {
    pub(crate) fn validate(&self) -> Result<(), ProviderIdentityBindingRecordError> {
        validate_principal(&self.local_actor_id)?;
        validate_text(&self.local_tenant_id, "localTenantId", MAX_SCOPE_ID_BYTES)?;
        validate_text(&self.local_space_id, "localSpaceId", MAX_SCOPE_ID_BYTES)?;
        if self.provider_id != PROVIDER_ID {
            return Err(error(
                "providerId",
                ProviderIdentityBindingRecordErrorKind::InconsistentFields,
            ));
        }
        Ok(())
    }
}

impl fmt::Debug for ProviderIdentityBindingLookup {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderIdentityBindingLookup([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderIdentityBindingRevokeRequest {
    pub binding_id: String,
    pub expected_revision: u64,
    pub authority_id: String,
    pub source_revision: u64,
    pub source_fresh_until: i64,
    pub updated_at: i64,
}

impl fmt::Debug for ProviderIdentityBindingRevokeRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderIdentityBindingRevokeRequest")
            .field("binding_id", &self.binding_id)
            .field("expected_revision", &self.expected_revision)
            .field("authority_id", &"[REDACTED]")
            .field("source_revision", &self.source_revision)
            .field("source_fresh_until", &self.source_fresh_until)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

impl ProviderIdentityBindingRevokeRequest {
    pub(crate) fn validate(&self) -> Result<(), ProviderIdentityBindingRecordError> {
        validate_text(&self.binding_id, "bindingId", MAX_ID_BYTES)?;
        validate_text(&self.authority_id, "authorityId", MAX_ID_BYTES)?;
        validate_revision(self.expected_revision, "expectedRevision")?;
        validate_revision(self.source_revision, "sourceRevision")?;
        if self.updated_at < 0 {
            return Err(error(
                "updatedAt",
                ProviderIdentityBindingRecordErrorKind::OutOfRange,
            ));
        }
        if self.source_fresh_until <= self.updated_at {
            return Err(error(
                "sourceFreshUntil",
                ProviderIdentityBindingRecordErrorKind::OutOfRange,
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderIdentityBindingCreateOutcome {
    Created,
    ExistingSame,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderIdentityBindingRevokeOutcome {
    Revoked,
    ExistingRevoked,
    NotFound,
    Conflict,
}

fn validate_principal(value: &str) -> Result<(), ProviderIdentityBindingRecordError> {
    let Some(digest) = value.strip_prefix("principal:") else {
        return Err(error(
            "localActorId",
            ProviderIdentityBindingRecordErrorKind::InvalidPrincipal,
        ));
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(error(
            "localActorId",
            ProviderIdentityBindingRecordErrorKind::InvalidPrincipal,
        ));
    }
    Ok(())
}

pub(crate) fn validate_binding_id(value: &str) -> Result<(), ProviderIdentityBindingRecordError> {
    validate_text(value, "bindingId", MAX_ID_BYTES)
}

fn validate_provider_subject(value: &str) -> Result<(), ProviderIdentityBindingRecordError> {
    let Some(user_id) = value.strip_prefix("user:") else {
        return Err(error(
            "providerSubject",
            ProviderIdentityBindingRecordErrorKind::InvalidProviderIdentity,
        ));
    };
    validate_positive_integer(user_id, "providerSubject").map_err(|_| {
        error(
            "providerSubject",
            ProviderIdentityBindingRecordErrorKind::InvalidProviderIdentity,
        )
    })
}

fn validate_positive_integer(
    value: &str,
    field: &'static str,
) -> Result<(), ProviderIdentityBindingRecordError> {
    if value.is_empty()
        || value.len() > MAX_SCOPE_ID_BYTES
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || !value
            .parse::<u64>()
            .is_ok_and(|parsed| parsed > 0 && parsed.to_string() == value)
    {
        return Err(error(
            field,
            ProviderIdentityBindingRecordErrorKind::InvalidProviderIdentity,
        ));
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<(), ProviderIdentityBindingRecordError> {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return Err(error(
            "recordHash",
            ProviderIdentityBindingRecordErrorKind::DigestMismatch,
        ));
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(error(
            "recordHash",
            ProviderIdentityBindingRecordErrorKind::DigestMismatch,
        ));
    }
    Ok(())
}

fn digest_parts_v1(parts: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"crewon.provider-identity-binding.v1\0");
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    format!("sha256:{:x}", digest.finalize())
}

fn digest_parts_v2(parts: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"crewon.provider-identity-binding.v2\0");
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    format!("sha256:{:x}", digest.finalize())
}
