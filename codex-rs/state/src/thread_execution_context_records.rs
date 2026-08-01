use std::fmt;

use sha2::Digest;
use sha2::Sha256;

use crate::ProviderResourceWorkspaceScope;
use crate::durable_workspace_records::validate_workspace_key;
use crate::provider_resource_binding_records::validate_binding_id;

pub const MAX_THREAD_EXECUTION_CONTEXT_BINDINGS: usize = 32;
const MAX_ID_BYTES: usize = 255;
const DIGEST_PREFIX: &str = "sha256:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadExecutionContextRecordErrorKind {
    Empty,
    TooLong,
    InvalidWorkspaceKey,
    InvalidBindingId,
    OutOfRange,
    TooManyItems,
    Duplicate,
    InconsistentFields,
    DigestMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadExecutionContextRecordError {
    field: &'static str,
    kind: ThreadExecutionContextRecordErrorKind,
}

impl ThreadExecutionContextRecordError {
    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn kind(&self) -> ThreadExecutionContextRecordErrorKind {
        self.kind
    }
}

impl fmt::Display for ThreadExecutionContextRecordError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid Thread execution context field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for ThreadExecutionContextRecordError {}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ThreadExecutionContextBindingRef {
    pub binding_id: String,
    pub revision: u64,
}

impl ThreadExecutionContextBindingRef {
    fn validate(&self) -> Result<(), ThreadExecutionContextRecordError> {
        validate_binding_id(&self.binding_id).map_err(|_| {
            error(
                "resourceBindingId",
                ThreadExecutionContextRecordErrorKind::InvalidBindingId,
            )
        })?;
        if self.revision == 0 {
            return Err(error(
                "resourceBindingRevision",
                ThreadExecutionContextRecordErrorKind::OutOfRange,
            ));
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ThreadExecutionContextRecord {
    pub thread_id: String,
    pub local_actor_id: String,
    pub local_tenant_id: String,
    pub local_space_id: String,
    pub workspace_key: String,
    pub workspace_scope: ProviderResourceWorkspaceScope,
    pub workspace_scope_id: String,
    pub resource_bindings: Vec<ThreadExecutionContextBindingRef>,
    pub execution_binding: Option<ThreadExecutionContextBindingRef>,
    pub revision: u64,
    pub record_hash: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl ThreadExecutionContextRecord {
    pub fn validate(&self) -> Result<(), ThreadExecutionContextRecordError> {
        validate_text(&self.thread_id, "threadId")?;
        validate_owner(
            &self.local_actor_id,
            &self.local_tenant_id,
            &self.local_space_id,
        )?;
        validate_workspace_key(&self.workspace_key).map_err(|_| {
            error(
                "workspaceKey",
                ThreadExecutionContextRecordErrorKind::InvalidWorkspaceKey,
            )
        })?;
        validate_text(&self.workspace_scope_id, "workspaceScopeId")?;
        match self.workspace_scope {
            ProviderResourceWorkspaceScope::Conversation => {
                if self.workspace_scope_id != self.thread_id {
                    return Err(error(
                        "workspaceScope",
                        ThreadExecutionContextRecordErrorKind::InconsistentFields,
                    ));
                }
            }
            ProviderResourceWorkspaceScope::Office => {}
            ProviderResourceWorkspaceScope::Workflow
            | ProviderResourceWorkspaceScope::Automation => {
                return Err(error(
                    "workspaceScope",
                    ThreadExecutionContextRecordErrorKind::InconsistentFields,
                ));
            }
        }
        validate_bindings(&self.resource_bindings)?;
        validate_execution_binding(self.execution_binding.as_ref(), &self.resource_bindings)?;
        if self.revision == 0
            || self.created_at < 0
            || self.updated_at < self.created_at
            || !valid_hash(&self.record_hash)
        {
            return Err(error(
                "lifecycle",
                ThreadExecutionContextRecordErrorKind::OutOfRange,
            ));
        }
        if self.record_hash != self.canonical_hash() {
            return Err(error(
                "recordHash",
                ThreadExecutionContextRecordErrorKind::DigestMismatch,
            ));
        }
        Ok(())
    }

    pub fn canonical_hash(&self) -> String {
        let revision = self.revision.to_string();
        let created_at = self.created_at.to_string();
        let updated_at = self.updated_at.to_string();
        let mut hasher = Sha256::new();
        hasher.update(if self.execution_binding.is_some() {
            b"crewon.thread-execution-context.v2\0".as_slice()
        } else {
            b"crewon.thread-execution-context.v1\0".as_slice()
        });
        for part in [
            self.thread_id.as_bytes(),
            self.local_actor_id.as_bytes(),
            self.local_tenant_id.as_bytes(),
            self.local_space_id.as_bytes(),
            self.workspace_key.as_bytes(),
            self.workspace_scope.as_str().as_bytes(),
            self.workspace_scope_id.as_bytes(),
            revision.as_bytes(),
            created_at.as_bytes(),
            updated_at.as_bytes(),
        ] {
            update_part(&mut hasher, part);
        }
        for binding in &self.resource_bindings {
            let binding_revision = binding.revision.to_string();
            update_part(&mut hasher, binding.binding_id.as_bytes());
            update_part(&mut hasher, binding_revision.as_bytes());
        }
        if let Some(binding) = &self.execution_binding {
            let binding_revision = binding.revision.to_string();
            update_part(&mut hasher, binding.binding_id.as_bytes());
            update_part(&mut hasher, binding_revision.as_bytes());
        }
        format!("{DIGEST_PREFIX}{:x}", hasher.finalize())
    }
}

impl fmt::Debug for ThreadExecutionContextRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ThreadExecutionContextRecord")
            .field("thread_id", &self.thread_id)
            .field("owner", &"[REDACTED]")
            .field("workspace", &"[REDACTED]")
            .field("resource_binding_count", &self.resource_bindings.len())
            .field("has_execution_binding", &self.execution_binding.is_some())
            .field("revision", &self.revision)
            .field("record_hash", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadExecutionContextBindingUpdate {
    pub thread_id: String,
    pub local_actor_id: String,
    pub local_tenant_id: String,
    pub local_space_id: String,
    pub expected_revision: u64,
    pub resource_bindings: Vec<ThreadExecutionContextBindingRef>,
    pub execution_binding: Option<ThreadExecutionContextBindingRef>,
    pub updated_at: i64,
}

impl ThreadExecutionContextBindingUpdate {
    pub(crate) fn validate(&self) -> Result<(), ThreadExecutionContextRecordError> {
        validate_text(&self.thread_id, "threadId")?;
        validate_owner(
            &self.local_actor_id,
            &self.local_tenant_id,
            &self.local_space_id,
        )?;
        if self.expected_revision == 0 || self.updated_at < 0 {
            return Err(error(
                "updateLifecycle",
                ThreadExecutionContextRecordErrorKind::OutOfRange,
            ));
        }
        validate_bindings(&self.resource_bindings)?;
        validate_execution_binding(self.execution_binding.as_ref(), &self.resource_bindings)
    }
}

fn validate_owner(
    actor_id: &str,
    tenant_id: &str,
    space_id: &str,
) -> Result<(), ThreadExecutionContextRecordError> {
    validate_text(actor_id, "localActorId")?;
    validate_text(tenant_id, "localTenantId")?;
    validate_text(space_id, "localSpaceId")
}

fn validate_bindings(
    bindings: &[ThreadExecutionContextBindingRef],
) -> Result<(), ThreadExecutionContextRecordError> {
    if bindings.len() > MAX_THREAD_EXECUTION_CONTEXT_BINDINGS {
        return Err(error(
            "resourceBindings",
            ThreadExecutionContextRecordErrorKind::TooManyItems,
        ));
    }
    let mut previous: Option<&ThreadExecutionContextBindingRef> = None;
    for binding in bindings {
        binding.validate()?;
        if previous.is_some_and(|previous| previous >= binding) {
            return Err(error(
                "resourceBindings",
                if previous == Some(binding) {
                    ThreadExecutionContextRecordErrorKind::Duplicate
                } else {
                    ThreadExecutionContextRecordErrorKind::InconsistentFields
                },
            ));
        }
        previous = Some(binding);
    }
    Ok(())
}

fn validate_execution_binding(
    execution_binding: Option<&ThreadExecutionContextBindingRef>,
    resource_bindings: &[ThreadExecutionContextBindingRef],
) -> Result<(), ThreadExecutionContextRecordError> {
    let Some(execution_binding) = execution_binding else {
        return Ok(());
    };
    execution_binding.validate()?;
    if resource_bindings.binary_search(execution_binding).is_err() {
        return Err(error(
            "executionBinding",
            ThreadExecutionContextRecordErrorKind::InconsistentFields,
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadExecutionContextCreateOutcome {
    Created,
    ExistingSame,
    Conflict,
    DependencyMissing,
    CapacityExceeded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadExecutionContextUpdateOutcome {
    Updated,
    ExistingSame,
    NotFound,
    Conflict,
    DependencyMissing,
}

fn validate_text(
    value: &str,
    field: &'static str,
) -> Result<(), ThreadExecutionContextRecordError> {
    if value.is_empty() || value.trim() != value {
        return Err(error(field, ThreadExecutionContextRecordErrorKind::Empty));
    }
    if value.len() > MAX_ID_BYTES || value.chars().any(char::is_control) {
        return Err(error(field, ThreadExecutionContextRecordErrorKind::TooLong));
    }
    Ok(())
}

pub(crate) fn validate_thread_execution_context_id(value: &str) -> anyhow::Result<()> {
    validate_text(value, "threadId").map_err(Into::into)
}

fn valid_hash(value: &str) -> bool {
    value.len() == DIGEST_PREFIX.len() + 64
        && value.starts_with(DIGEST_PREFIX)
        && value[DIGEST_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
}

fn update_part(hasher: &mut Sha256, part: &[u8]) {
    hasher.update((part.len() as u64).to_be_bytes());
    hasher.update(part);
}

fn error(
    field: &'static str,
    kind: ThreadExecutionContextRecordErrorKind,
) -> ThreadExecutionContextRecordError {
    ThreadExecutionContextRecordError { field, kind }
}
