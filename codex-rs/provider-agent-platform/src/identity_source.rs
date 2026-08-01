use std::fmt;

use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use uuid::Uuid;

const SCHEMA_VERSION: &str = "1.0.0";
const AUTHORITY_ID: &str = "agent-platform-identity";
const PROVIDER_ID: &str = "agent-platform";
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_ID_BYTES: usize = 255;
const MAX_SCOPE_ID_BYTES: usize = 128;
const MAX_FRESHNESS_SECONDS: i64 = 60;
const MAX_CLOCK_SKEW_SECONDS: i64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProviderIdentitySourceError {
    #[error("provider identity source response is invalid")]
    InvalidResponse,
    #[error("provider identity source response is not fresh")]
    NotFresh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderIdentitySourceStatus {
    Active,
    Revoked,
}

impl ProviderIdentitySourceStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Revoked => "revoked",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderIdentitySourceBinding {
    source_binding_id: String,
    source_revision: u64,
    status: ProviderIdentitySourceStatus,
    local_actor_id: String,
    local_tenant_id: String,
    local_space_id: String,
    provider_subject: String,
    provider_tenant_id: String,
    provider_space_id: String,
    binding_digest: String,
    created_at: i64,
    updated_at: i64,
}

impl ProviderIdentitySourceBinding {
    pub fn source_binding_id(&self) -> &str {
        &self.source_binding_id
    }

    pub fn source_revision(&self) -> u64 {
        self.source_revision
    }

    pub fn status(&self) -> ProviderIdentitySourceStatus {
        self.status
    }

    pub fn local_actor_id(&self) -> &str {
        &self.local_actor_id
    }

    pub fn local_tenant_id(&self) -> &str {
        &self.local_tenant_id
    }

    pub fn local_space_id(&self) -> &str {
        &self.local_space_id
    }

    pub fn provider_subject(&self) -> &str {
        &self.provider_subject
    }

    pub fn provider_tenant_id(&self) -> &str {
        &self.provider_tenant_id
    }

    pub fn provider_space_id(&self) -> &str {
        &self.provider_space_id
    }

    pub fn binding_digest(&self) -> &str {
        &self.binding_digest
    }

    pub fn created_at(&self) -> i64 {
        self.created_at
    }

    pub fn updated_at(&self) -> i64 {
        self.updated_at
    }

    fn canonical_digest(&self) -> String {
        let source_revision = self.source_revision.to_string();
        let created_at = self.created_at.to_string();
        let updated_at = self.updated_at.to_string();
        digest_parts(&[
            AUTHORITY_ID.as_bytes(),
            self.source_binding_id.as_bytes(),
            source_revision.as_bytes(),
            self.status.as_str().as_bytes(),
            self.local_actor_id.as_bytes(),
            self.local_tenant_id.as_bytes(),
            self.local_space_id.as_bytes(),
            PROVIDER_ID.as_bytes(),
            self.provider_subject.as_bytes(),
            self.provider_tenant_id.as_bytes(),
            self.provider_space_id.as_bytes(),
            created_at.as_bytes(),
            updated_at.as_bytes(),
        ])
    }
}

impl fmt::Debug for ProviderIdentitySourceBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderIdentitySourceBinding")
            .field("source_binding_id", &self.source_binding_id)
            .field("source_revision", &self.source_revision)
            .field("status", &self.status)
            .field("identity", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderIdentitySourceSnapshot {
    binding: ProviderIdentitySourceBinding,
    issued_at: i64,
    fresh_until: i64,
}

impl ProviderIdentitySourceSnapshot {
    pub fn parse(json: &[u8], now: i64) -> Result<Self, ProviderIdentitySourceError> {
        if json.len() > MAX_RESPONSE_BYTES || now < 0 {
            return Err(ProviderIdentitySourceError::InvalidResponse);
        }
        let wire: IdentitySourceContractWire = serde_json::from_slice(json)
            .map_err(|_| ProviderIdentitySourceError::InvalidResponse)?;
        wire.validate(now)
    }

    pub fn binding(&self) -> &ProviderIdentitySourceBinding {
        &self.binding
    }

    pub fn issued_at(&self) -> i64 {
        self.issued_at
    }

    pub fn fresh_until(&self) -> i64 {
        self.fresh_until
    }
}

impl fmt::Debug for ProviderIdentitySourceSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderIdentitySourceSnapshot")
            .field("binding", &self.binding)
            .field("issued_at", &self.issued_at)
            .field("fresh_until", &self.fresh_until)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentitySourceContractWire {
    schema_version: String,
    authority_id: String,
    binding: IdentityBindingWire,
    freshness: BindingFreshnessWire,
}

impl IdentitySourceContractWire {
    fn validate(
        self,
        now: i64,
    ) -> Result<ProviderIdentitySourceSnapshot, ProviderIdentitySourceError> {
        if self.schema_version != SCHEMA_VERSION || self.authority_id != AUTHORITY_ID {
            return Err(ProviderIdentitySourceError::InvalidResponse);
        }
        let binding = self.binding.validate()?;
        self.freshness.validate(now, binding.updated_at)?;
        Ok(ProviderIdentitySourceSnapshot {
            binding,
            issued_at: self.freshness.issued_at,
            fresh_until: self.freshness.fresh_until,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityBindingWire {
    source_binding_id: String,
    source_revision: u64,
    status: ProviderIdentitySourceStatus,
    local_owner: LocalOwnerWire,
    provider_identity: ProviderIdentityWire,
    created_at: i64,
    updated_at: i64,
    binding_digest: String,
}

impl IdentityBindingWire {
    fn validate(self) -> Result<ProviderIdentitySourceBinding, ProviderIdentitySourceError> {
        validate_uuid(&self.source_binding_id)?;
        validate_principal(&self.local_owner.actor_id)?;
        validate_positive_integer(&self.local_owner.tenant_id, MAX_SCOPE_ID_BYTES)?;
        validate_positive_integer(&self.local_owner.space_id, MAX_SCOPE_ID_BYTES)?;
        if self.provider_identity.provider_id != PROVIDER_ID
            || !is_canonical_user_subject(&self.provider_identity.subject)
        {
            return Err(ProviderIdentitySourceError::InvalidResponse);
        }
        validate_positive_integer(&self.provider_identity.tenant_id, MAX_SCOPE_ID_BYTES)?;
        validate_positive_integer(&self.provider_identity.space_id, MAX_SCOPE_ID_BYTES)?;
        if self.local_owner.tenant_id != self.provider_identity.tenant_id
            || self.local_owner.space_id != self.provider_identity.space_id
            || self.created_at < 0
            || self.updated_at < self.created_at
            || self.source_revision == 0
            || i64::try_from(self.source_revision).is_err()
        {
            return Err(ProviderIdentitySourceError::InvalidResponse);
        }
        match self.status {
            ProviderIdentitySourceStatus::Active
                if self.source_revision == 1 && self.created_at == self.updated_at => {}
            ProviderIdentitySourceStatus::Revoked if self.source_revision >= 2 => {}
            ProviderIdentitySourceStatus::Active | ProviderIdentitySourceStatus::Revoked => {
                return Err(ProviderIdentitySourceError::InvalidResponse);
            }
        }
        validate_digest(&self.binding_digest)?;
        let binding = ProviderIdentitySourceBinding {
            source_binding_id: self.source_binding_id,
            source_revision: self.source_revision,
            status: self.status,
            local_actor_id: self.local_owner.actor_id,
            local_tenant_id: self.local_owner.tenant_id,
            local_space_id: self.local_owner.space_id,
            provider_subject: self.provider_identity.subject,
            provider_tenant_id: self.provider_identity.tenant_id,
            provider_space_id: self.provider_identity.space_id,
            binding_digest: self.binding_digest,
            created_at: self.created_at,
            updated_at: self.updated_at,
        };
        if binding.binding_digest != binding.canonical_digest() {
            return Err(ProviderIdentitySourceError::InvalidResponse);
        }
        Ok(binding)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalOwnerWire {
    actor_id: String,
    tenant_id: String,
    space_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderIdentityWire {
    provider_id: String,
    subject: String,
    tenant_id: String,
    space_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BindingFreshnessWire {
    issued_at: i64,
    fresh_until: i64,
}

impl BindingFreshnessWire {
    fn validate(
        &self,
        now: i64,
        binding_updated_at: i64,
    ) -> Result<(), ProviderIdentitySourceError> {
        if self.issued_at < binding_updated_at
            || self.issued_at < 0
            || self.fresh_until <= self.issued_at
            || self.fresh_until - self.issued_at > MAX_FRESHNESS_SECONDS
            || self.issued_at > now.saturating_add(MAX_CLOCK_SKEW_SECONDS)
        {
            return Err(ProviderIdentitySourceError::InvalidResponse);
        }
        if self.fresh_until <= now {
            return Err(ProviderIdentitySourceError::NotFresh);
        }
        Ok(())
    }
}

fn validate_uuid(value: &str) -> Result<(), ProviderIdentitySourceError> {
    validate_text(value, MAX_ID_BYTES)?;
    let parsed =
        Uuid::parse_str(value).map_err(|_| ProviderIdentitySourceError::InvalidResponse)?;
    if parsed.to_string() != value {
        return Err(ProviderIdentitySourceError::InvalidResponse);
    }
    Ok(())
}

fn validate_principal(value: &str) -> Result<(), ProviderIdentitySourceError> {
    let Some(digest) = value.strip_prefix("principal:") else {
        return Err(ProviderIdentitySourceError::InvalidResponse);
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ProviderIdentitySourceError::InvalidResponse);
    }
    Ok(())
}

fn is_canonical_user_subject(value: &str) -> bool {
    value
        .strip_prefix("user:")
        .is_some_and(|user_id| validate_positive_integer(user_id, MAX_ID_BYTES).is_ok())
}

fn validate_positive_integer(
    value: &str,
    max_bytes: usize,
) -> Result<(), ProviderIdentitySourceError> {
    validate_text(value, max_bytes)?;
    if !value.bytes().all(|byte| byte.is_ascii_digit())
        || !value
            .parse::<u64>()
            .is_ok_and(|parsed| parsed > 0 && parsed.to_string() == value)
    {
        return Err(ProviderIdentitySourceError::InvalidResponse);
    }
    Ok(())
}

fn validate_text(value: &str, max_bytes: usize) -> Result<(), ProviderIdentitySourceError> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(ProviderIdentitySourceError::InvalidResponse);
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<(), ProviderIdentitySourceError> {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return Err(ProviderIdentitySourceError::InvalidResponse);
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ProviderIdentitySourceError::InvalidResponse);
    }
    Ok(())
}

fn digest_parts(parts: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"crewon.provider-identity-source-binding.v1\0");
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    format!("sha256:{:x}", digest.finalize())
}
