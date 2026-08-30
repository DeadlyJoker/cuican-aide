use std::fmt;

use sha2::Digest;
use sha2::Sha256;
use uuid::Uuid;

use crate::durable_workspace_records::validate_workspace_key;
use crate::provider_connection_records::validate_connection_id;

const BINDING_ID_PREFIX: &str = "resource-binding:";
const MAX_ID_BYTES: usize = 255;
const MAX_RESOURCE_ID_BYTES: usize = 512;
const MAX_REVISION_BYTES: usize = 256;
const MAX_PROTOCOL_VERSION_BYTES: usize = 64;
const MAX_SCHEMA_VERSION_BYTES: usize = 64;
const DIGEST_PREFIX: &str = "sha256:";

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub(crate) const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire),+
                }
            }

            pub(crate) fn from_str(value: &str) -> anyhow::Result<Self> {
                match value {
                    $($wire => Ok(Self::$variant)),+,
                    _ => anyhow::bail!(concat!("invalid stored ", stringify!($name), " value")),
                }
            }
        }
    };
}

string_enum!(ProviderResourceWorkspaceScope {
    Conversation => "conversation",
    Office => "office",
    Workflow => "workflow",
    Automation => "automation",
});

string_enum!(ProviderResourceKind {
    Agent => "agent",
    Skill => "skill",
    McpServer => "mcpServer",
    McpTool => "mcpTool",
    KnowledgeBase => "knowledgeBase",
    Workflow => "workflow",
});

string_enum!(ProviderResourceBindingMode {
    RemoteReference => "remoteReference",
    LocalSnapshot => "localSnapshot",
    LocalFork => "localFork",
    ProviderManaged => "providerManaged",
});

string_enum!(ProviderResourceExecutionLocation {
    LocalNode => "localNode",
    Provider => "provider",
});

string_enum!(ProviderResourceBindingStatus {
    Active => "active",
    Unbound => "unbound",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderResourceBindingRecordErrorKind {
    Empty,
    TooLong,
    InvalidBindingId,
    InvalidConnectionId,
    InvalidWorkspaceKey,
    InvalidDigest,
    OutOfRange,
    InconsistentFields,
    DigestMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderResourceBindingRecordError {
    field: &'static str,
    kind: ProviderResourceBindingRecordErrorKind,
}

impl ProviderResourceBindingRecordError {
    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn kind(&self) -> ProviderResourceBindingRecordErrorKind {
        self.kind
    }
}

impl fmt::Display for ProviderResourceBindingRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid Provider resource binding field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for ProviderResourceBindingRecordError {}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderResourceBindingRecord {
    pub binding_id: String,
    pub local_actor_id: String,
    pub local_tenant_id: String,
    pub local_space_id: String,
    pub connection_id: String,
    pub workspace_key: String,
    pub workspace_scope: ProviderResourceWorkspaceScope,
    pub workspace_scope_id: String,
    pub provider_id: String,
    pub protocol_version: String,
    pub resource_kind: ProviderResourceKind,
    pub resource_id: String,
    pub resource_revision: String,
    pub binding_mode: ProviderResourceBindingMode,
    pub execution_location: ProviderResourceExecutionLocation,
    pub manifest_schema_version: String,
    pub content_digest: Option<String>,
    pub source_revision: Option<String>,
    pub source_digest: Option<String>,
    pub local_revision: Option<String>,
    pub local_content_digest: Option<String>,
    pub status: ProviderResourceBindingStatus,
    pub revision: u64,
    pub record_hash: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub unbound_at: Option<i64>,
}

impl ProviderResourceBindingRecord {
    pub fn validate(&self) -> Result<(), ProviderResourceBindingRecordError> {
        validate_binding_id(&self.binding_id)?;
        validate_resource_binding_owner(
            &self.local_actor_id,
            &self.local_tenant_id,
            &self.local_space_id,
        )?;
        validate_connection_id(&self.connection_id).map_err(|_| {
            error(
                "connectionId",
                ProviderResourceBindingRecordErrorKind::InvalidConnectionId,
            )
        })?;
        validate_workspace_key(&self.workspace_key).map_err(|_| {
            error(
                "workspaceKey",
                ProviderResourceBindingRecordErrorKind::InvalidWorkspaceKey,
            )
        })?;
        validate_text(&self.workspace_scope_id, "workspaceScopeId", MAX_ID_BYTES)?;
        validate_text(&self.provider_id, "providerId", MAX_ID_BYTES)?;
        validate_text(
            &self.protocol_version,
            "protocolVersion",
            MAX_PROTOCOL_VERSION_BYTES,
        )?;
        validate_text(&self.resource_id, "resourceId", MAX_RESOURCE_ID_BYTES)?;
        validate_text(
            &self.resource_revision,
            "resourceRevision",
            MAX_REVISION_BYTES,
        )?;
        validate_text(
            &self.manifest_schema_version,
            "manifestSchemaVersion",
            MAX_SCHEMA_VERSION_BYTES,
        )?;
        if let Some(content_digest) = &self.content_digest {
            validate_digest(content_digest, "contentDigest")?;
        }
        validate_materialization(self)?;
        validate_lifecycle(self)?;
        validate_digest(&self.record_hash, "recordHash")?;
        if self.record_hash != self.canonical_hash() {
            return Err(error(
                "recordHash",
                ProviderResourceBindingRecordErrorKind::DigestMismatch,
            ));
        }
        Ok(())
    }

    pub fn canonical_hash(&self) -> String {
        let revision = self.revision.to_string();
        let created_at = self.created_at.to_string();
        let updated_at = self.updated_at.to_string();
        let unbound_at = self.unbound_at.map(|value| value.to_string());
        digest_parts(&[
            self.binding_id.as_bytes(),
            self.local_actor_id.as_bytes(),
            self.local_tenant_id.as_bytes(),
            self.local_space_id.as_bytes(),
            self.connection_id.as_bytes(),
            self.workspace_key.as_bytes(),
            self.workspace_scope.as_str().as_bytes(),
            self.workspace_scope_id.as_bytes(),
            self.provider_id.as_bytes(),
            self.protocol_version.as_bytes(),
            self.resource_kind.as_str().as_bytes(),
            self.resource_id.as_bytes(),
            self.resource_revision.as_bytes(),
            self.binding_mode.as_str().as_bytes(),
            self.execution_location.as_str().as_bytes(),
            self.manifest_schema_version.as_bytes(),
            optional_bytes(self.content_digest.as_deref()),
            optional_bytes(self.source_revision.as_deref()),
            optional_bytes(self.source_digest.as_deref()),
            optional_bytes(self.local_revision.as_deref()),
            optional_bytes(self.local_content_digest.as_deref()),
            self.status.as_str().as_bytes(),
            revision.as_bytes(),
            created_at.as_bytes(),
            updated_at.as_bytes(),
            optional_bytes(unbound_at.as_deref()),
        ])
    }
}

impl fmt::Debug for ProviderResourceBindingRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderResourceBindingRecord")
            .field("binding_id", &self.binding_id)
            .field("owner", &"[REDACTED]")
            .field("connection_id", &"[REDACTED]")
            .field("workspace", &"[REDACTED]")
            .field("provider_id", &self.provider_id)
            .field("protocol_version", &self.protocol_version)
            .field("resource_kind", &self.resource_kind)
            .field("resource", &"[REDACTED]")
            .field("binding_mode", &self.binding_mode)
            .field("execution_location", &self.execution_location)
            .field("manifest", &"[REDACTED]")
            .field("status", &self.status)
            .field("revision", &self.revision)
            .field("record_hash", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .field("unbound_at", &self.unbound_at)
            .finish()
    }
}

pub(crate) fn validate_binding_id(value: &str) -> Result<(), ProviderResourceBindingRecordError> {
    let Some(raw_uuid) = value.strip_prefix(BINDING_ID_PREFIX) else {
        return Err(error(
            "bindingId",
            ProviderResourceBindingRecordErrorKind::InvalidBindingId,
        ));
    };
    let parsed = Uuid::parse_str(raw_uuid).map_err(|_| {
        error(
            "bindingId",
            ProviderResourceBindingRecordErrorKind::InvalidBindingId,
        )
    })?;
    if parsed.to_string() != raw_uuid {
        return Err(error(
            "bindingId",
            ProviderResourceBindingRecordErrorKind::InvalidBindingId,
        ));
    }
    Ok(())
}

pub(crate) fn validate_resource_binding_owner(
    local_actor_id: &str,
    local_tenant_id: &str,
    local_space_id: &str,
) -> Result<(), ProviderResourceBindingRecordError> {
    validate_text(local_actor_id, "localActorId", MAX_ID_BYTES)?;
    validate_text(local_tenant_id, "localTenantId", MAX_ID_BYTES)?;
    validate_text(local_space_id, "localSpaceId", MAX_ID_BYTES)
}

pub(crate) fn validate_resource_binding_revision(
    value: u64,
    field: &'static str,
) -> Result<(), ProviderResourceBindingRecordError> {
    if value == 0 || value > i64::MAX as u64 {
        return Err(error(
            field,
            ProviderResourceBindingRecordErrorKind::OutOfRange,
        ));
    }
    Ok(())
}

pub(crate) fn validate_resource_binding_timestamp(
    value: i64,
    field: &'static str,
) -> Result<(), ProviderResourceBindingRecordError> {
    if value < 0 {
        return Err(error(
            field,
            ProviderResourceBindingRecordErrorKind::OutOfRange,
        ));
    }
    Ok(())
}

fn validate_materialization(
    record: &ProviderResourceBindingRecord,
) -> Result<(), ProviderResourceBindingRecordError> {
    let fields = [
        record.source_revision.as_deref(),
        record.source_digest.as_deref(),
        record.local_revision.as_deref(),
        record.local_content_digest.as_deref(),
    ];
    match record.binding_mode {
        ProviderResourceBindingMode::RemoteReference
        | ProviderResourceBindingMode::ProviderManaged => {
            if record.execution_location != ProviderResourceExecutionLocation::Provider
                || fields.iter().any(Option::is_some)
            {
                return Err(error(
                    "materialization",
                    ProviderResourceBindingRecordErrorKind::InconsistentFields,
                ));
            }
        }
        ProviderResourceBindingMode::LocalSnapshot | ProviderResourceBindingMode::LocalFork => {
            if record.execution_location != ProviderResourceExecutionLocation::LocalNode {
                return Err(error(
                    "materialization",
                    ProviderResourceBindingRecordErrorKind::InconsistentFields,
                ));
            }
            let (
                Some(source_revision),
                Some(source_digest),
                Some(local_revision),
                Some(local_content_digest),
                Some(content_digest),
            ) = (
                record.source_revision.as_deref(),
                record.source_digest.as_deref(),
                record.local_revision.as_deref(),
                record.local_content_digest.as_deref(),
                record.content_digest.as_deref(),
            )
            else {
                return Err(error(
                    "materialization",
                    ProviderResourceBindingRecordErrorKind::InconsistentFields,
                ));
            };
            validate_text(source_revision, "sourceRevision", MAX_REVISION_BYTES)?;
            validate_digest(source_digest, "sourceDigest")?;
            validate_text(local_revision, "localRevision", MAX_REVISION_BYTES)?;
            validate_digest(local_content_digest, "localContentDigest")?;
            if source_revision != record.resource_revision
                || source_digest != content_digest
                || (record.binding_mode == ProviderResourceBindingMode::LocalSnapshot
                    && (local_revision != record.resource_revision
                        || local_content_digest != content_digest))
            {
                return Err(error(
                    "materialization",
                    ProviderResourceBindingRecordErrorKind::InconsistentFields,
                ));
            }
        }
    }
    Ok(())
}

fn validate_lifecycle(
    record: &ProviderResourceBindingRecord,
) -> Result<(), ProviderResourceBindingRecordError> {
    if record.revision == 0
        || record.revision > i64::MAX as u64
        || record.created_at < 0
        || record.updated_at < record.created_at
    {
        return Err(error(
            "revision",
            ProviderResourceBindingRecordErrorKind::OutOfRange,
        ));
    }
    match record.status {
        ProviderResourceBindingStatus::Active
            if record.revision % 2 == 1 && record.unbound_at.is_none() =>
        {
            Ok(())
        }
        ProviderResourceBindingStatus::Unbound
            if record.revision >= 2
                && record.revision.is_multiple_of(2)
                && record.unbound_at == Some(record.updated_at) =>
        {
            Ok(())
        }
        ProviderResourceBindingStatus::Active | ProviderResourceBindingStatus::Unbound => {
            Err(error(
                "status",
                ProviderResourceBindingRecordErrorKind::InconsistentFields,
            ))
        }
    }
}

fn validate_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), ProviderResourceBindingRecordError> {
    if value.is_empty() || value.trim() != value {
        return Err(error(field, ProviderResourceBindingRecordErrorKind::Empty));
    }
    if value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(error(
            field,
            ProviderResourceBindingRecordErrorKind::TooLong,
        ));
    }
    Ok(())
}

fn validate_digest(
    value: &str,
    field: &'static str,
) -> Result<(), ProviderResourceBindingRecordError> {
    let Some(hex) = value.strip_prefix(DIGEST_PREFIX) else {
        return Err(error(
            field,
            ProviderResourceBindingRecordErrorKind::InvalidDigest,
        ));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(error(
            field,
            ProviderResourceBindingRecordErrorKind::InvalidDigest,
        ));
    }
    Ok(())
}

fn digest_parts(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"crewon.provider-resource-binding.v1\0");
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn optional_bytes(value: Option<&str>) -> &[u8] {
    value.unwrap_or_default().as_bytes()
}

fn error(
    field: &'static str,
    kind: ProviderResourceBindingRecordErrorKind,
) -> ProviderResourceBindingRecordError {
    ProviderResourceBindingRecordError { field, kind }
}
