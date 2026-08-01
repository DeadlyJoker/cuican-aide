use std::fmt;

use sha2::Digest;
use sha2::Sha256;
use uuid::Uuid;

const GRANT_ID_PREFIX: &str = "provider-grant:";
const MAX_ID_BYTES: usize = 255;
const MAX_SCOPE_BYTES: usize = 128;
const MAX_SCOPES: usize = 32;
pub(crate) const MAX_SCOPES_JSON_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderAccessGrantRecordErrorKind {
    Empty,
    TooLong,
    InvalidGrantId,
    InvalidPrincipal,
    InvalidSourceBinding,
    InvalidScope,
    OutOfRange,
    InconsistentFields,
    InvalidDigest,
    DigestMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderAccessGrantRecordError {
    field: &'static str,
    kind: ProviderAccessGrantRecordErrorKind,
}

impl ProviderAccessGrantRecordError {
    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn kind(&self) -> ProviderAccessGrantRecordErrorKind {
        self.kind
    }
}

impl fmt::Display for ProviderAccessGrantRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid Provider access grant field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for ProviderAccessGrantRecordError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderAccessGrantStatus {
    Active,
    Revoked,
}

impl ProviderAccessGrantStatus {
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
            _ => anyhow::bail!("invalid Provider access grant status"),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderAccessGrantRecord {
    pub grant_id: String,
    pub local_actor_id: String,
    pub local_tenant_id: String,
    pub local_space_id: String,
    pub provider_id: String,
    pub source_binding_id: String,
    pub source_revision: u64,
    pub granted_scopes: Vec<String>,
    pub status: ProviderAccessGrantStatus,
    pub expires_at: i64,
    pub revision: u64,
    pub record_hash: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub revoked_at: Option<i64>,
}

impl ProviderAccessGrantRecord {
    pub fn validate(&self) -> Result<(), ProviderAccessGrantRecordError> {
        validate_grant_id(&self.grant_id)?;
        validate_principal(&self.local_actor_id)?;
        validate_text(&self.local_tenant_id, "localTenantId", MAX_ID_BYTES)?;
        validate_text(&self.local_space_id, "localSpaceId", MAX_ID_BYTES)?;
        validate_text(&self.provider_id, "providerId", MAX_ID_BYTES)?;
        validate_source_binding_id(&self.source_binding_id)?;
        validate_revision(self.source_revision, "sourceRevision")?;
        validate_scopes(&self.granted_scopes)?;
        validate_revision(self.revision, "revision")?;
        if self.created_at < 0
            || self.updated_at < self.created_at
            || self.expires_at <= self.created_at
        {
            return Err(error(
                "expiresAt",
                ProviderAccessGrantRecordErrorKind::OutOfRange,
            ));
        }
        match self.status {
            ProviderAccessGrantStatus::Active
                if self.revision == 1
                    && self.updated_at == self.created_at
                    && self.revoked_at.is_none() => {}
            ProviderAccessGrantStatus::Revoked
                if self.revision >= 2 && self.revoked_at == Some(self.updated_at) => {}
            ProviderAccessGrantStatus::Active | ProviderAccessGrantStatus::Revoked => {
                return Err(error(
                    "status",
                    ProviderAccessGrantRecordErrorKind::InconsistentFields,
                ));
            }
        }
        validate_digest(&self.record_hash)?;
        if self.record_hash != self.canonical_hash() {
            return Err(error(
                "recordHash",
                ProviderAccessGrantRecordErrorKind::DigestMismatch,
            ));
        }
        Ok(())
    }

    pub fn canonical_hash(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(b"crewon.provider-access-grant.v1\0");
        hash_part(&mut digest, self.grant_id.as_bytes());
        hash_part(&mut digest, self.local_actor_id.as_bytes());
        hash_part(&mut digest, self.local_tenant_id.as_bytes());
        hash_part(&mut digest, self.local_space_id.as_bytes());
        hash_part(&mut digest, self.provider_id.as_bytes());
        hash_part(&mut digest, self.source_binding_id.as_bytes());
        hash_part(&mut digest, self.source_revision.to_string().as_bytes());
        hash_part(
            &mut digest,
            self.granted_scopes.len().to_string().as_bytes(),
        );
        for scope in &self.granted_scopes {
            hash_part(&mut digest, scope.as_bytes());
        }
        hash_part(&mut digest, self.status.as_str().as_bytes());
        hash_part(&mut digest, self.expires_at.to_string().as_bytes());
        hash_part(&mut digest, self.revision.to_string().as_bytes());
        hash_part(&mut digest, self.created_at.to_string().as_bytes());
        hash_part(&mut digest, self.updated_at.to_string().as_bytes());
        let revoked_at = self.revoked_at.map(|value| value.to_string());
        hash_part(
            &mut digest,
            revoked_at.as_deref().unwrap_or_default().as_bytes(),
        );
        format!("sha256:{:x}", digest.finalize())
    }
}

impl fmt::Debug for ProviderAccessGrantRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderAccessGrantRecord")
            .field("grant_id", &self.grant_id)
            .field("owner", &"[REDACTED]")
            .field("provider_id", &self.provider_id)
            .field("source_binding", &"[REDACTED]")
            .field("granted_scope_count", &self.granted_scopes.len())
            .field("status", &self.status)
            .field("expires_at", &self.expires_at)
            .field("revision", &self.revision)
            .field("record_hash", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .field("revoked_at", &self.revoked_at)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderAccessGrantLookup {
    pub local_actor_id: String,
    pub local_tenant_id: String,
    pub local_space_id: String,
    pub provider_id: String,
    pub source_binding_id: String,
    pub source_revision: u64,
}

impl ProviderAccessGrantLookup {
    pub(crate) fn validate(&self) -> Result<(), ProviderAccessGrantRecordError> {
        validate_principal(&self.local_actor_id)?;
        validate_text(&self.local_tenant_id, "localTenantId", MAX_ID_BYTES)?;
        validate_text(&self.local_space_id, "localSpaceId", MAX_ID_BYTES)?;
        validate_text(&self.provider_id, "providerId", MAX_ID_BYTES)?;
        validate_source_binding_id(&self.source_binding_id)?;
        validate_revision(self.source_revision, "sourceRevision")
    }
}

impl fmt::Debug for ProviderAccessGrantLookup {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderAccessGrantLookup([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderAccessGrantOwnerLookup {
    pub local_actor_id: String,
    pub local_tenant_id: String,
    pub local_space_id: String,
    pub provider_id: String,
}

impl ProviderAccessGrantOwnerLookup {
    pub(crate) fn validate(&self) -> Result<(), ProviderAccessGrantRecordError> {
        validate_principal(&self.local_actor_id)?;
        validate_text(&self.local_tenant_id, "localTenantId", MAX_ID_BYTES)?;
        validate_text(&self.local_space_id, "localSpaceId", MAX_ID_BYTES)?;
        validate_text(&self.provider_id, "providerId", MAX_ID_BYTES)
    }
}

impl fmt::Debug for ProviderAccessGrantOwnerLookup {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderAccessGrantOwnerLookup([REDACTED])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderAccessGrantResolveOutcome {
    Created(ProviderAccessGrantRecord),
    Existing(ProviderAccessGrantRecord),
    CapacityExceeded,
    Conflict,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderAccessGrantRefreshRequest {
    pub grant_id: String,
    pub expected_revision: u64,
    pub expected_expires_at: i64,
    pub refreshed_expires_at: i64,
    pub refreshed_at: i64,
}

impl ProviderAccessGrantRefreshRequest {
    pub(crate) fn validate(&self) -> Result<(), ProviderAccessGrantRecordError> {
        validate_grant_id(&self.grant_id)?;
        validate_revision(self.expected_revision, "expectedRevision")?;
        if self.refreshed_at < 0
            || self.refreshed_expires_at <= self.expected_expires_at
            || self.refreshed_expires_at <= self.refreshed_at
        {
            return Err(error(
                "refreshedExpiresAt",
                ProviderAccessGrantRecordErrorKind::InconsistentFields,
            ));
        }
        Ok(())
    }
}

impl fmt::Debug for ProviderAccessGrantRefreshRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderAccessGrantRefreshRequest")
            .field("grant_id", &self.grant_id)
            .field("expected_revision", &self.expected_revision)
            .field("expected_expires_at", &self.expected_expires_at)
            .field("refreshed_expires_at", &self.refreshed_expires_at)
            .field("refreshed_at", &self.refreshed_at)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderAccessGrantRefreshOutcome {
    Refreshed(ProviderAccessGrantRecord),
    Existing(ProviderAccessGrantRecord),
    Conflict,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderAccessGrantReplaceRequest {
    pub current_grant_id: String,
    pub expected_revision: u64,
    pub replacement: ProviderAccessGrantRecord,
    pub replaced_at: i64,
}

impl ProviderAccessGrantReplaceRequest {
    pub(crate) fn validate(&self) -> Result<(), ProviderAccessGrantRecordError> {
        validate_grant_id(&self.current_grant_id)?;
        validate_revision(self.expected_revision, "expectedRevision")?;
        self.replacement.validate()?;
        if self.replacement.status != ProviderAccessGrantStatus::Active
            || self.replacement.revision != 1
            || self.replacement.grant_id == self.current_grant_id
            || self.replaced_at < 0
            || self.replacement.created_at != self.replaced_at
        {
            return Err(error(
                "replacement",
                ProviderAccessGrantRecordErrorKind::InconsistentFields,
            ));
        }
        Ok(())
    }
}

impl fmt::Debug for ProviderAccessGrantReplaceRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderAccessGrantReplaceRequest")
            .field("current_grant_id", &self.current_grant_id)
            .field("expected_revision", &self.expected_revision)
            .field("replacement", &self.replacement)
            .field("replaced_at", &self.replaced_at)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderAccessGrantReplaceOutcome {
    Replaced(ProviderAccessGrantRecord),
    Existing(ProviderAccessGrantRecord),
    CapacityExceeded,
    Conflict,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderAccessGrantRevokeRequest {
    pub grant_id: String,
    pub expected_revision: u64,
    pub revoked_at: i64,
}

impl ProviderAccessGrantRevokeRequest {
    pub(crate) fn validate(&self) -> Result<(), ProviderAccessGrantRecordError> {
        validate_grant_id(&self.grant_id)?;
        validate_revision(self.expected_revision, "expectedRevision")?;
        if self.revoked_at < 0 {
            return Err(error(
                "revokedAt",
                ProviderAccessGrantRecordErrorKind::OutOfRange,
            ));
        }
        Ok(())
    }
}

impl fmt::Debug for ProviderAccessGrantRevokeRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderAccessGrantRevokeRequest")
            .field("grant_id", &self.grant_id)
            .field("expected_revision", &self.expected_revision)
            .field("revoked_at", &self.revoked_at)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderAccessGrantRevokeOutcome {
    Revoked,
    ExistingRevoked,
    NotFound,
    Conflict,
}

pub(crate) fn validate_grant_id(value: &str) -> Result<(), ProviderAccessGrantRecordError> {
    let Some(raw_uuid) = value.strip_prefix(GRANT_ID_PREFIX) else {
        return Err(error(
            "grantId",
            ProviderAccessGrantRecordErrorKind::InvalidGrantId,
        ));
    };
    validate_canonical_uuid(
        raw_uuid,
        "grantId",
        ProviderAccessGrantRecordErrorKind::InvalidGrantId,
    )
}

fn validate_source_binding_id(value: &str) -> Result<(), ProviderAccessGrantRecordError> {
    validate_canonical_uuid(
        value,
        "sourceBindingId",
        ProviderAccessGrantRecordErrorKind::InvalidSourceBinding,
    )
}

fn validate_canonical_uuid(
    value: &str,
    field: &'static str,
    kind: ProviderAccessGrantRecordErrorKind,
) -> Result<(), ProviderAccessGrantRecordError> {
    let parsed = Uuid::parse_str(value).map_err(|_| error(field, kind))?;
    if parsed.to_string() != value {
        return Err(error(field, kind));
    }
    Ok(())
}

fn validate_principal(value: &str) -> Result<(), ProviderAccessGrantRecordError> {
    let Some(digest) = value.strip_prefix("principal:") else {
        return Err(error(
            "localActorId",
            ProviderAccessGrantRecordErrorKind::InvalidPrincipal,
        ));
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(error(
            "localActorId",
            ProviderAccessGrantRecordErrorKind::InvalidPrincipal,
        ));
    }
    Ok(())
}

fn validate_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), ProviderAccessGrantRecordError> {
    if value.is_empty() || value.trim() != value {
        return Err(error(field, ProviderAccessGrantRecordErrorKind::Empty));
    }
    if value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(error(field, ProviderAccessGrantRecordErrorKind::TooLong));
    }
    Ok(())
}

fn validate_revision(
    value: u64,
    field: &'static str,
) -> Result<(), ProviderAccessGrantRecordError> {
    if value == 0 || value > i64::MAX as u64 {
        return Err(error(field, ProviderAccessGrantRecordErrorKind::OutOfRange));
    }
    Ok(())
}

fn validate_scopes(scopes: &[String]) -> Result<(), ProviderAccessGrantRecordError> {
    if scopes.is_empty() || scopes.len() > MAX_SCOPES {
        return Err(error(
            "grantedScopes",
            ProviderAccessGrantRecordErrorKind::InconsistentFields,
        ));
    }
    for scope in scopes {
        if scope.is_empty()
            || scope.len() > MAX_SCOPE_BYTES
            || !scope.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'_' | b'-')
            })
        {
            return Err(error(
                "grantedScopes",
                ProviderAccessGrantRecordErrorKind::InvalidScope,
            ));
        }
    }
    if !scopes.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(error(
            "grantedScopes",
            ProviderAccessGrantRecordErrorKind::InconsistentFields,
        ));
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<(), ProviderAccessGrantRecordError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(error(
            "recordHash",
            ProviderAccessGrantRecordErrorKind::InvalidDigest,
        ));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(error(
            "recordHash",
            ProviderAccessGrantRecordErrorKind::InvalidDigest,
        ));
    }
    Ok(())
}

fn hash_part(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
}

fn error(
    field: &'static str,
    kind: ProviderAccessGrantRecordErrorKind,
) -> ProviderAccessGrantRecordError {
    ProviderAccessGrantRecordError { field, kind }
}
