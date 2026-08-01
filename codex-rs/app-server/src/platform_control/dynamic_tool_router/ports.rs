use std::fmt;
use std::future::Future;

use crewon_app_server_protocol::WorkspaceScope;
use crewon_policy::ActionCredentialRef;
use crewon_policy::CredentialBinding;
use crewon_policy::CredentialExpiry;
use crewon_policy::CredentialState;
use crewon_policy::PolicyModelError;
use crewon_resource_federation::ProviderId;
use crewon_state::ProviderResourceBindingRecord;

use super::registration::DynamicToolOperation;
use crate::platform_control::RequestIdentity;

/// Reads the current durable binding immediately before a Tool side effect.
pub(crate) trait DynamicToolBindingReader: Send + Sync {
    fn read_binding(
        &self,
        binding_id: String,
    ) -> impl Future<Output = Result<Option<ProviderResourceBindingRecord>, DynamicToolPortError>> + Send;
}

#[derive(Clone)]
pub(crate) struct DynamicToolCredentialRequest {
    pub identity: RequestIdentity,
    pub binding: ProviderResourceBindingRecord,
}

impl fmt::Debug for DynamicToolCredentialRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DynamicToolCredentialRequest([REDACTED])")
    }
}

#[derive(Clone)]
pub(crate) struct DynamicToolCredentialSnapshot {
    binding: CredentialBinding,
    credential_id: Option<String>,
    revision: Option<u64>,
    provider_identity: Option<DynamicToolProviderIdentitySnapshot>,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct DynamicToolProviderIdentitySnapshot {
    pub binding_id: String,
    pub binding_revision: u64,
    pub subject: String,
    pub tenant_id: String,
    pub space_id: String,
}

impl fmt::Debug for DynamicToolProviderIdentitySnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DynamicToolProviderIdentitySnapshot([REDACTED])")
    }
}

impl DynamicToolCredentialSnapshot {
    pub(crate) fn none() -> Self {
        Self {
            binding: CredentialBinding::None,
            credential_id: None,
            revision: None,
            provider_identity: None,
        }
    }

    pub(crate) fn provider_reference(
        credential_id: impl Into<String>,
        provider_id: ProviderId,
        status: CredentialState,
        revision: u64,
        expiry: CredentialExpiry,
        provider_identity: DynamicToolProviderIdentitySnapshot,
    ) -> Result<Self, PolicyModelError> {
        let credential_id = credential_id.into();
        let binding = CredentialBinding::Reference(ActionCredentialRef::new(
            credential_id.clone(),
            provider_id,
            status,
            revision,
            expiry,
        )?);
        Ok(Self {
            binding,
            credential_id: Some(credential_id),
            revision: Some(revision),
            provider_identity: Some(provider_identity),
        })
    }

    pub(crate) fn policy_binding(&self) -> CredentialBinding {
        self.binding.clone()
    }

    pub(crate) fn credential_id(&self) -> Option<&str> {
        self.credential_id.as_deref()
    }

    pub(crate) fn revision(&self) -> Option<u64> {
        self.revision
    }

    pub(crate) fn is_reference(&self) -> bool {
        self.credential_id.is_some()
    }

    pub(crate) fn provider_identity(&self) -> Option<&DynamicToolProviderIdentitySnapshot> {
        self.provider_identity.as_ref()
    }
}

impl fmt::Debug for DynamicToolCredentialSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DynamicToolCredentialSnapshot([REDACTED])")
    }
}

/// Resolves live Credential status and revision from server-owned authority.
pub(crate) trait DynamicToolCredentialResolver: Send + Sync {
    fn resolve_credential(
        &self,
        request: DynamicToolCredentialRequest,
    ) -> impl Future<Output = Result<DynamicToolCredentialSnapshot, DynamicToolPortError>> + Send;
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct DynamicToolExecutionClaimRequest {
    pub call_id: String,
    pub action_digest: String,
    pub access_decision_id: String,
    pub approval_id: Option<String>,
    pub actor_id: String,
    pub tenant_id: Option<String>,
    pub space_id: Option<String>,
    pub session_id: String,
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
    pub thread_id: String,
    pub turn_id: String,
    pub workspace_key: String,
    pub workspace_binding_id: String,
    pub workspace_scope: WorkspaceScope,
    pub workspace_scope_id: String,
    pub binding_id: String,
    pub binding_revision: u64,
    pub connection_id: String,
    pub provider_id: String,
    pub protocol_version: String,
    pub resource_kind: crewon_state::ProviderResourceKind,
    pub resource_id: String,
    pub resource_revision: String,
    pub execution_location: crewon_state::ProviderResourceExecutionLocation,
    pub credential_id: Option<String>,
    pub credential_revision: Option<u64>,
    pub provider_identity_binding_id: Option<String>,
    pub provider_identity_binding_revision: Option<u64>,
    pub provider_subject: Option<String>,
    pub provider_tenant_id: Option<String>,
    pub provider_space_id: Option<String>,
    pub operation: DynamicToolOperation,
    pub claimed_at: i64,
}

impl DynamicToolExecutionClaimRequest {
    pub(crate) fn same_execution(&self, other: &Self) -> bool {
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
}

impl fmt::Debug for DynamicToolExecutionClaimRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DynamicToolExecutionClaimRequest")
            .field("call_id", &self.call_id)
            .field("binding_id", &self.binding_id)
            .field("binding_revision", &self.binding_revision)
            .field("operation", &self.operation)
            .field("claimed_at", &self.claimed_at)
            .field("authority", &"[REDACTED]")
            .finish()
    }
}

pub(crate) struct DynamicToolExecutionClaim {
    request: DynamicToolExecutionClaimRequest,
}

impl DynamicToolExecutionClaim {
    pub(crate) fn new(request: DynamicToolExecutionClaimRequest) -> Self {
        Self { request }
    }

    pub(crate) fn request(&self) -> &DynamicToolExecutionClaimRequest {
        &self.request
    }
}

impl fmt::Debug for DynamicToolExecutionClaim {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DynamicToolExecutionClaim([REDACTED])")
    }
}

#[derive(Debug)]
pub(crate) enum DynamicToolExecutionClaimOutcome {
    Acquired(Box<DynamicToolExecutionClaim>),
    ExistingSame,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DynamicToolExecutionFailure {
    Rejected,
    ExecutionFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DynamicToolExecutionUnknown {
    Timeout,
    AdapterUnavailable,
    InvalidResponse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DynamicToolExecutionResultMetadata {
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
pub(crate) enum DynamicToolExecutionTerminal {
    Succeeded(DynamicToolExecutionResultMetadata),
    Failed(DynamicToolExecutionFailure),
    Unknown(DynamicToolExecutionUnknown),
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct DynamicToolExecutionCompletionSnapshot {
    claim: DynamicToolExecutionClaimRequest,
    terminal: DynamicToolExecutionTerminal,
}

impl DynamicToolExecutionCompletionSnapshot {
    pub(crate) fn claim(&self) -> &DynamicToolExecutionClaimRequest {
        &self.claim
    }

    pub(crate) fn terminal(&self) -> &DynamicToolExecutionTerminal {
        &self.terminal
    }
}

impl fmt::Debug for DynamicToolExecutionCompletionSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DynamicToolExecutionCompletionSnapshot")
            .field("claim", &self.claim)
            .field("terminal", &self.terminal)
            .finish()
    }
}

pub(crate) struct DynamicToolExecutionCompletion {
    claim: DynamicToolExecutionClaim,
    terminal: DynamicToolExecutionTerminal,
}

impl DynamicToolExecutionCompletion {
    pub(crate) fn succeeded(
        claim: DynamicToolExecutionClaim,
        result: DynamicToolExecutionResultMetadata,
    ) -> Self {
        Self {
            claim,
            terminal: DynamicToolExecutionTerminal::Succeeded(result),
        }
    }

    pub(crate) fn failed(
        claim: DynamicToolExecutionClaim,
        reason: DynamicToolExecutionFailure,
    ) -> Self {
        Self {
            claim,
            terminal: DynamicToolExecutionTerminal::Failed(reason),
        }
    }

    pub(crate) fn unknown(
        claim: DynamicToolExecutionClaim,
        reason: DynamicToolExecutionUnknown,
    ) -> Self {
        Self {
            claim,
            terminal: DynamicToolExecutionTerminal::Unknown(reason),
        }
    }

    pub(crate) fn snapshot(&self) -> DynamicToolExecutionCompletionSnapshot {
        DynamicToolExecutionCompletionSnapshot {
            claim: self.claim.request().clone(),
            terminal: self.terminal.clone(),
        }
    }
}

impl fmt::Debug for DynamicToolExecutionCompletion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DynamicToolExecutionCompletion")
            .field("claim", &self.claim)
            .field("terminal", &self.terminal)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DynamicToolExecutionCompletionOutcome {
    Completed,
    Conflict,
}

/// Atomically claims Tool call IDs and completes them with one metadata-only Audit fact.
///
/// Production implementations must commit the terminal journal transition and matching
/// `ExternalAction` Audit record in one durable transaction. Neither operation may store raw
/// arguments, result bodies, credentials, headers, or provider error text.
pub(crate) trait DynamicToolExecutionJournal: Send + Sync {
    fn claim(
        &self,
        request: DynamicToolExecutionClaimRequest,
    ) -> impl Future<Output = Result<DynamicToolExecutionClaimOutcome, DynamicToolPortError>> + Send;

    fn complete(
        &self,
        request: DynamicToolExecutionCompletion,
    ) -> impl Future<Output = Result<DynamicToolExecutionCompletionOutcome, DynamicToolPortError>> + Send;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum DynamicToolPortError {
    #[error("dynamic tool authority is unavailable")]
    Unavailable,
    #[error("dynamic tool authority rejected the request")]
    Unauthorized,
    #[error("dynamic tool authority returned an invalid response")]
    InvalidResponse,
}
