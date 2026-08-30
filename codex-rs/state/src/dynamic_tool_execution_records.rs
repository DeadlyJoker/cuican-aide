use std::fmt;

use sha2::Digest;
use sha2::Sha256;

use crate::ProviderResourceExecutionLocation;
use crate::ProviderResourceKind;
use crate::ProviderResourceWorkspaceScope;
use crate::dynamic_tool_execution_validation::validate_dynamic_tool_execution_call_id;
use crate::dynamic_tool_execution_validation::validate_dynamic_tool_execution_record;

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

string_enum!(DynamicToolExecutionOperation {
    Call => "call",
    Search => "search",
});

string_enum!(DynamicToolExecutionFailureCode {
    Rejected => "rejected",
    ExecutionFailed => "executionFailed",
});

string_enum!(DynamicToolExecutionUnknownCode {
    Timeout => "timeout",
    AdapterUnavailable => "adapterUnavailable",
    InvalidResponse => "invalidResponse",
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DynamicToolExecutionResultRecord {
    Inline {
        item_count: u16,
        byte_len: u32,
        sha256: String,
    },
    Artifact {
        artifact_id: String,
        revision: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DynamicToolExecutionTerminalRecord {
    Claimed,
    Succeeded(DynamicToolExecutionResultRecord),
    Failed(DynamicToolExecutionFailureCode),
    Unknown(DynamicToolExecutionUnknownCode),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DynamicToolExecutionCompletionRecord {
    Succeeded(DynamicToolExecutionResultRecord),
    Failed(DynamicToolExecutionFailureCode),
    Unknown(DynamicToolExecutionUnknownCode),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DynamicToolExecutionClaimOutcome {
    Claimed(DynamicToolExecutionRecord),
    ExistingSame(DynamicToolExecutionRecord),
    AuthorityMismatch,
    CapacityExceeded,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DynamicToolExecutionCompletionOutcome {
    Completed(DynamicToolExecutionRecord),
    ExistingSame(DynamicToolExecutionRecord),
    NotFound,
    AuditConflict,
    Conflict,
}

#[derive(Clone, PartialEq, Eq)]
pub struct DynamicToolExecutionRecoveryQuery {
    pub stale_before_or_at: i64,
    pub after_call_id: Option<String>,
    pub limit: u32,
}

impl DynamicToolExecutionRecoveryQuery {
    pub(crate) fn validate(&self) -> Result<(), DynamicToolExecutionRecordError> {
        if self.stale_before_or_at < 0 || !(1..=100).contains(&self.limit) {
            return Err(dynamic_tool_execution_record_error(
                "recoveryQuery",
                DynamicToolExecutionRecordErrorKind::OutOfRange,
            ));
        }
        if let Some(call_id) = self.after_call_id.as_deref() {
            validate_dynamic_tool_execution_call_id(call_id)?;
        }
        Ok(())
    }
}

impl fmt::Debug for DynamicToolExecutionRecoveryQuery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DynamicToolExecutionRecoveryQuery")
            .field("stale_before_or_at", &self.stale_before_or_at)
            .field(
                "after_call_id",
                &self.after_call_id.as_ref().map(|_| "[REDACTED]"),
            )
            .field("limit", &self.limit)
            .finish()
    }
}

#[derive(Clone)]
pub struct DynamicToolExecutionClaimInput {
    pub call_id: String,
    pub action_digest: String,
    pub access_decision_id: String,
    pub approval_id: Option<String>,
    pub actor_id: String,
    pub tenant_id: String,
    pub space_id: String,
    pub session_id: String,
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub thread_id: String,
    pub turn_id: String,
    pub workspace_key: String,
    pub workspace_binding_id: String,
    pub workspace_scope: ProviderResourceWorkspaceScope,
    pub workspace_scope_id: String,
    pub binding_id: String,
    pub binding_revision: u64,
    pub connection_id: String,
    pub provider_id: String,
    pub protocol_version: String,
    pub resource_kind: ProviderResourceKind,
    pub resource_id: String,
    pub resource_revision: String,
    pub execution_location: ProviderResourceExecutionLocation,
    pub credential_id: Option<String>,
    pub credential_revision: Option<u64>,
    pub provider_identity_binding_id: Option<String>,
    pub provider_identity_binding_revision: Option<u64>,
    pub provider_subject: Option<String>,
    pub provider_tenant_id: Option<String>,
    pub provider_space_id: Option<String>,
    pub operation: DynamicToolExecutionOperation,
    pub created_at: i64,
}

#[derive(Clone, PartialEq, Eq)]
pub struct DynamicToolExecutionRecord {
    pub call_id: String,
    pub action_digest: String,
    pub access_decision_id: String,
    pub approval_id: Option<String>,
    pub actor_id: String,
    pub tenant_id: String,
    pub space_id: String,
    pub session_id: String,
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub thread_id: String,
    pub turn_id: String,
    pub workspace_key: String,
    pub workspace_binding_id: String,
    pub workspace_scope: ProviderResourceWorkspaceScope,
    pub workspace_scope_id: String,
    pub binding_id: String,
    pub binding_revision: u64,
    pub connection_id: String,
    pub provider_id: String,
    pub protocol_version: String,
    pub resource_kind: ProviderResourceKind,
    pub resource_id: String,
    pub resource_revision: String,
    pub execution_location: ProviderResourceExecutionLocation,
    pub credential_id: Option<String>,
    pub credential_revision: Option<u64>,
    pub provider_identity_binding_id: Option<String>,
    pub provider_identity_binding_revision: Option<u64>,
    pub provider_subject: Option<String>,
    pub provider_tenant_id: Option<String>,
    pub provider_space_id: Option<String>,
    pub operation: DynamicToolExecutionOperation,
    pub terminal: DynamicToolExecutionTerminalRecord,
    pub audit_event_id: Option<String>,
    pub claim_hash: String,
    pub record_hash: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl DynamicToolExecutionRecord {
    pub fn claimed(
        input: DynamicToolExecutionClaimInput,
    ) -> Result<Self, DynamicToolExecutionRecordError> {
        let mut record = Self {
            call_id: input.call_id,
            action_digest: input.action_digest,
            access_decision_id: input.access_decision_id,
            approval_id: input.approval_id,
            actor_id: input.actor_id,
            tenant_id: input.tenant_id,
            space_id: input.space_id,
            session_id: input.session_id,
            trace_id: input.trace_id,
            span_id: input.span_id,
            parent_span_id: input.parent_span_id,
            thread_id: input.thread_id,
            turn_id: input.turn_id,
            workspace_key: input.workspace_key,
            workspace_binding_id: input.workspace_binding_id,
            workspace_scope: input.workspace_scope,
            workspace_scope_id: input.workspace_scope_id,
            binding_id: input.binding_id,
            binding_revision: input.binding_revision,
            connection_id: input.connection_id,
            provider_id: input.provider_id,
            protocol_version: input.protocol_version,
            resource_kind: input.resource_kind,
            resource_id: input.resource_id,
            resource_revision: input.resource_revision,
            execution_location: input.execution_location,
            credential_id: input.credential_id,
            credential_revision: input.credential_revision,
            provider_identity_binding_id: input.provider_identity_binding_id,
            provider_identity_binding_revision: input.provider_identity_binding_revision,
            provider_subject: input.provider_subject,
            provider_tenant_id: input.provider_tenant_id,
            provider_space_id: input.provider_space_id,
            operation: input.operation,
            terminal: DynamicToolExecutionTerminalRecord::Claimed,
            audit_event_id: None,
            claim_hash: String::new(),
            record_hash: String::new(),
            created_at: input.created_at,
            updated_at: input.created_at,
        };
        record.claim_hash = record.canonical_claim_hash();
        record.record_hash = record.canonical_hash();
        record.validate()?;
        Ok(record)
    }

    pub fn complete(
        &self,
        completion: DynamicToolExecutionCompletionRecord,
        audit_event_id: impl Into<String>,
        completed_at: i64,
    ) -> Result<Self, DynamicToolExecutionRecordError> {
        if self.terminal != DynamicToolExecutionTerminalRecord::Claimed {
            return Err(dynamic_tool_execution_record_error(
                "terminal",
                DynamicToolExecutionRecordErrorKind::InvalidTransition,
            ));
        }
        let mut completed = self.clone();
        completed.terminal = match completion {
            DynamicToolExecutionCompletionRecord::Succeeded(result) => {
                DynamicToolExecutionTerminalRecord::Succeeded(result)
            }
            DynamicToolExecutionCompletionRecord::Failed(code) => {
                DynamicToolExecutionTerminalRecord::Failed(code)
            }
            DynamicToolExecutionCompletionRecord::Unknown(code) => {
                DynamicToolExecutionTerminalRecord::Unknown(code)
            }
        };
        completed.audit_event_id = Some(audit_event_id.into());
        completed.updated_at = completed_at;
        completed.record_hash = completed.canonical_hash();
        completed.validate()?;
        Ok(completed)
    }

    pub fn validate(&self) -> Result<(), DynamicToolExecutionRecordError> {
        validate_dynamic_tool_execution_record(self)
    }

    pub fn same_claim(&self, other: &Self) -> bool {
        self.call_id == other.call_id && self.claim_hash == other.claim_hash
    }

    pub fn same_execution(&self, other: &Self) -> bool {
        self.call_id == other.call_id
            && self.action_digest == other.action_digest
            && self.binding_id == other.binding_id
            && self.binding_revision == other.binding_revision
            && self.credential_id == other.credential_id
            && self.credential_revision == other.credential_revision
            && self.provider_identity_binding_id == other.provider_identity_binding_id
            && self.provider_identity_binding_revision == other.provider_identity_binding_revision
            && self.provider_subject == other.provider_subject
            && self.provider_tenant_id == other.provider_tenant_id
            && self.provider_space_id == other.provider_space_id
    }

    pub fn canonical_claim_hash(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(b"crewon.dynamic-tool-claim.v1\0");
        for value in [
            self.call_id.as_str(),
            self.action_digest.as_str(),
            self.access_decision_id.as_str(),
            self.actor_id.as_str(),
            self.tenant_id.as_str(),
            self.space_id.as_str(),
            self.session_id.as_str(),
            self.trace_id.as_str(),
            self.span_id.as_str(),
            self.thread_id.as_str(),
            self.turn_id.as_str(),
            self.workspace_key.as_str(),
            self.workspace_binding_id.as_str(),
            self.workspace_scope.as_str(),
            self.workspace_scope_id.as_str(),
            self.binding_id.as_str(),
            self.connection_id.as_str(),
            self.provider_id.as_str(),
            self.protocol_version.as_str(),
            self.resource_kind.as_str(),
            self.resource_id.as_str(),
            self.resource_revision.as_str(),
            self.execution_location.as_str(),
            self.operation.as_str(),
        ] {
            update_digest(&mut digest, value.as_bytes());
        }
        update_optional_digest(&mut digest, self.approval_id.as_deref());
        update_optional_digest(&mut digest, self.parent_span_id.as_deref());
        update_digest(&mut digest, &self.binding_revision.to_be_bytes());
        update_optional_digest(&mut digest, self.credential_id.as_deref());
        update_optional_revision_digest(&mut digest, self.credential_revision);
        update_optional_digest(&mut digest, self.provider_identity_binding_id.as_deref());
        update_optional_revision_digest(&mut digest, self.provider_identity_binding_revision);
        update_optional_digest(&mut digest, self.provider_subject.as_deref());
        update_optional_digest(&mut digest, self.provider_tenant_id.as_deref());
        update_optional_digest(&mut digest, self.provider_space_id.as_deref());
        update_digest(&mut digest, &self.created_at.to_be_bytes());
        format!("sha256:{:x}", digest.finalize())
    }

    pub fn canonical_hash(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(b"crewon.dynamic-tool-record.v1\0");
        update_digest(&mut digest, self.claim_hash.as_bytes());
        update_digest(&mut digest, terminal_tag(&self.terminal).as_bytes());
        match &self.terminal {
            DynamicToolExecutionTerminalRecord::Claimed => {}
            DynamicToolExecutionTerminalRecord::Succeeded(result) => match result {
                DynamicToolExecutionResultRecord::Inline {
                    item_count,
                    byte_len,
                    sha256,
                } => {
                    update_digest(&mut digest, &item_count.to_be_bytes());
                    update_digest(&mut digest, &byte_len.to_be_bytes());
                    update_digest(&mut digest, sha256.as_bytes());
                }
                DynamicToolExecutionResultRecord::Artifact {
                    artifact_id,
                    revision,
                } => {
                    update_digest(&mut digest, artifact_id.as_bytes());
                    update_digest(&mut digest, &revision.to_be_bytes());
                }
            },
            DynamicToolExecutionTerminalRecord::Failed(code) => {
                update_digest(&mut digest, code.as_str().as_bytes());
            }
            DynamicToolExecutionTerminalRecord::Unknown(code) => {
                update_digest(&mut digest, code.as_str().as_bytes());
            }
        }
        update_optional_digest(&mut digest, self.audit_event_id.as_deref());
        update_digest(&mut digest, &self.updated_at.to_be_bytes());
        format!("sha256:{:x}", digest.finalize())
    }
}

impl fmt::Debug for DynamicToolExecutionClaimInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DynamicToolExecutionClaimInput")
            .field("call_id", &self.call_id)
            .field("authority", &"[REDACTED]")
            .field("workspace", &"[REDACTED]")
            .field("resource", &"[REDACTED]")
            .field("credential", &"[REDACTED]")
            .field("operation", &self.operation)
            .field("created_at", &self.created_at)
            .finish()
    }
}

impl fmt::Debug for DynamicToolExecutionRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DynamicToolExecutionRecord")
            .field("call_id", &self.call_id)
            .field("authority", &"[REDACTED]")
            .field("workspace", &"[REDACTED]")
            .field("resource", &"[REDACTED]")
            .field("credential", &"[REDACTED]")
            .field("operation", &self.operation)
            .field("terminal", &self.terminal)
            .field("audit_event_id", &self.audit_event_id)
            .field("hashes", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DynamicToolExecutionRecordErrorKind {
    Empty,
    TooLong,
    InvalidHash,
    InvalidReference,
    OutOfRange,
    InconsistentFields,
    DigestMismatch,
    InvalidTransition,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DynamicToolExecutionRecordError {
    field: &'static str,
    kind: DynamicToolExecutionRecordErrorKind,
}

impl DynamicToolExecutionRecordError {
    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn kind(&self) -> DynamicToolExecutionRecordErrorKind {
        self.kind
    }
}

impl fmt::Display for DynamicToolExecutionRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid dynamic Tool execution field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for DynamicToolExecutionRecordError {}

fn terminal_tag(terminal: &DynamicToolExecutionTerminalRecord) -> &'static str {
    match terminal {
        DynamicToolExecutionTerminalRecord::Claimed => "claimed",
        DynamicToolExecutionTerminalRecord::Succeeded(
            DynamicToolExecutionResultRecord::Inline { .. },
        ) => "succeeded:inline",
        DynamicToolExecutionTerminalRecord::Succeeded(
            DynamicToolExecutionResultRecord::Artifact { .. },
        ) => "succeeded:artifact",
        DynamicToolExecutionTerminalRecord::Failed(_) => "failed",
        DynamicToolExecutionTerminalRecord::Unknown(_) => "unknown",
    }
}

fn update_digest(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
}

fn update_optional_digest(digest: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            digest.update([1]);
            update_digest(digest, value.as_bytes());
        }
        None => digest.update([0]),
    }
}

fn update_optional_revision_digest(digest: &mut Sha256, value: Option<u64>) {
    match value {
        Some(value) => {
            digest.update([1]);
            update_digest(digest, &value.to_be_bytes());
        }
        None => digest.update([0]),
    }
}

pub(crate) fn dynamic_tool_execution_record_error(
    field: &'static str,
    kind: DynamicToolExecutionRecordErrorKind,
) -> DynamicToolExecutionRecordError {
    DynamicToolExecutionRecordError { field, kind }
}
