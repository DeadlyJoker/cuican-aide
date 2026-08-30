use std::fmt;
use std::sync::Arc;

use crewon_app_server_protocol::WorkspaceScope;
use crewon_state::DynamicToolExecutionClaimInput as StateClaimInput;
use crewon_state::DynamicToolExecutionClaimOutcome as StateClaimOutcome;
use crewon_state::DynamicToolExecutionCompletionOutcome as StateCompletionOutcome;
use crewon_state::DynamicToolExecutionCompletionRecord as StateCompletionRecord;
use crewon_state::DynamicToolExecutionFailureCode as StateFailureCode;
use crewon_state::DynamicToolExecutionOperation as StateOperation;
use crewon_state::DynamicToolExecutionRecord as StateExecutionRecord;
use crewon_state::DynamicToolExecutionResultRecord as StateResultRecord;
use crewon_state::DynamicToolExecutionTerminalRecord as StateTerminalRecord;
use crewon_state::DynamicToolExecutionUnknownCode as StateUnknownCode;
use crewon_state::ProviderResourceWorkspaceScope;
use crewon_state::StateRuntime;

use super::ports::DynamicToolExecutionClaim;
use super::ports::DynamicToolExecutionClaimOutcome;
use super::ports::DynamicToolExecutionClaimRequest;
use super::ports::DynamicToolExecutionCompletion;
use super::ports::DynamicToolExecutionCompletionOutcome;
use super::ports::DynamicToolExecutionFailure;
use super::ports::DynamicToolExecutionJournal;
use super::ports::DynamicToolExecutionResultMetadata;
use super::ports::DynamicToolExecutionTerminal;
use super::ports::DynamicToolExecutionUnknown;
use super::ports::DynamicToolPortError;
use super::registration::DynamicToolOperation;
use super::state_journal_audit::audit_event_id;
use super::state_journal_audit::external_action_audit;
use crate::platform_control::provider_connection_descriptor::ProviderConnectionClock;

/// State-backed implementation of the Dynamic Tool journal and metadata-only Audit contract.
pub(crate) struct StateDynamicToolExecutionJournal<Clock> {
    state: Arc<StateRuntime>,
    clock: Clock,
}

impl<Clock> StateDynamicToolExecutionJournal<Clock>
where
    Clock: ProviderConnectionClock,
{
    pub(crate) fn new(state: Arc<StateRuntime>, clock: Clock) -> Self {
        Self { state, clock }
    }
}

impl<Clock> DynamicToolExecutionJournal for StateDynamicToolExecutionJournal<Clock>
where
    Clock: ProviderConnectionClock,
{
    async fn claim(
        &self,
        request: DynamicToolExecutionClaimRequest,
    ) -> Result<DynamicToolExecutionClaimOutcome, DynamicToolPortError> {
        let proposed = state_claim(&request)?;
        let outcome = self
            .state
            .claim_dynamic_tool_execution_record(&proposed)
            .await
            .map_err(|_| DynamicToolPortError::Unavailable)?;
        Ok(match outcome {
            StateClaimOutcome::Claimed(_) => DynamicToolExecutionClaimOutcome::Acquired(Box::new(
                DynamicToolExecutionClaim::new(request),
            )),
            StateClaimOutcome::ExistingSame(_) => DynamicToolExecutionClaimOutcome::ExistingSame,
            StateClaimOutcome::AuthorityMismatch => {
                return Err(DynamicToolPortError::Unauthorized);
            }
            StateClaimOutcome::CapacityExceeded => {
                return Err(DynamicToolPortError::Unavailable);
            }
            StateClaimOutcome::Conflict => DynamicToolExecutionClaimOutcome::Conflict,
        })
    }

    async fn complete(
        &self,
        request: DynamicToolExecutionCompletion,
    ) -> Result<DynamicToolExecutionCompletionOutcome, DynamicToolPortError> {
        let snapshot = request.snapshot();
        let current = self
            .state
            .get_dynamic_tool_execution_record(&snapshot.claim().call_id)
            .await
            .map_err(|_| DynamicToolPortError::Unavailable)?
            .ok_or(DynamicToolPortError::InvalidResponse)?;
        if !request_matches_record(snapshot.claim(), &current) {
            return Ok(DynamicToolExecutionCompletionOutcome::Conflict);
        }
        let expected_terminal = state_terminal(snapshot.terminal());
        let completed = if current.terminal == StateTerminalRecord::Claimed {
            let completed_at = self.clock.now();
            if completed_at < current.updated_at {
                return Err(DynamicToolPortError::Unavailable);
            }
            current
                .complete(
                    state_completion(expected_terminal),
                    audit_event_id(&current.call_id),
                    completed_at,
                )
                .map_err(|_| DynamicToolPortError::InvalidResponse)?
        } else if current.terminal == expected_terminal {
            current
        } else {
            return Ok(DynamicToolExecutionCompletionOutcome::Conflict);
        };
        let audit_event = external_action_audit(&completed)?;
        let outcome = self
            .state
            .complete_dynamic_tool_execution_record(&completed, &audit_event)
            .await
            .map_err(|_| DynamicToolPortError::Unavailable)?;
        Ok(match outcome {
            StateCompletionOutcome::Completed(_) | StateCompletionOutcome::ExistingSame(_) => {
                DynamicToolExecutionCompletionOutcome::Completed
            }
            StateCompletionOutcome::NotFound
            | StateCompletionOutcome::AuditConflict
            | StateCompletionOutcome::Conflict => DynamicToolExecutionCompletionOutcome::Conflict,
        })
    }
}

impl<Clock> fmt::Debug for StateDynamicToolExecutionJournal<Clock> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("StateDynamicToolExecutionJournal([REDACTED])")
    }
}

fn state_claim(
    request: &DynamicToolExecutionClaimRequest,
) -> Result<StateExecutionRecord, DynamicToolPortError> {
    let tenant_id = request
        .tenant_id
        .clone()
        .ok_or(DynamicToolPortError::Unauthorized)?;
    let space_id = request
        .space_id
        .clone()
        .ok_or(DynamicToolPortError::Unauthorized)?;
    StateExecutionRecord::claimed(StateClaimInput {
        call_id: request.call_id.clone(),
        action_digest: request.action_digest.clone(),
        access_decision_id: request.access_decision_id.clone(),
        approval_id: request.approval_id.clone(),
        actor_id: request.actor_id.clone(),
        tenant_id,
        space_id,
        session_id: request.session_id.clone(),
        trace_id: request.trace_id.clone(),
        span_id: request.span_id.clone(),
        parent_span_id: request.parent_span_id.clone(),
        thread_id: request.thread_id.clone(),
        turn_id: request.turn_id.clone(),
        workspace_key: request.workspace_key.clone(),
        workspace_binding_id: request.workspace_binding_id.clone(),
        workspace_scope: state_workspace_scope(request.workspace_scope),
        workspace_scope_id: request.workspace_scope_id.clone(),
        binding_id: request.binding_id.clone(),
        binding_revision: request.binding_revision,
        connection_id: request.connection_id.clone(),
        provider_id: request.provider_id.clone(),
        protocol_version: request.protocol_version.clone(),
        resource_kind: request.resource_kind,
        resource_id: request.resource_id.clone(),
        resource_revision: request.resource_revision.clone(),
        execution_location: request.execution_location,
        credential_id: request.credential_id.clone(),
        credential_revision: request.credential_revision,
        provider_identity_binding_id: request.provider_identity_binding_id.clone(),
        provider_identity_binding_revision: request.provider_identity_binding_revision,
        provider_subject: request.provider_subject.clone(),
        provider_tenant_id: request.provider_tenant_id.clone(),
        provider_space_id: request.provider_space_id.clone(),
        operation: state_operation(request.operation),
        created_at: request.claimed_at,
    })
    .map_err(|_| DynamicToolPortError::InvalidResponse)
}

fn request_matches_record(
    request: &DynamicToolExecutionClaimRequest,
    record: &StateExecutionRecord,
) -> bool {
    request.call_id == record.call_id
        && request.action_digest == record.action_digest
        && request.access_decision_id == record.access_decision_id
        && request.approval_id == record.approval_id
        && request.actor_id == record.actor_id
        && request.tenant_id.as_deref() == Some(record.tenant_id.as_str())
        && request.space_id.as_deref() == Some(record.space_id.as_str())
        && request.session_id == record.session_id
        && request.trace_id == record.trace_id
        && request.span_id == record.span_id
        && request.parent_span_id == record.parent_span_id
        && request.thread_id == record.thread_id
        && request.turn_id == record.turn_id
        && request.workspace_key == record.workspace_key
        && request.workspace_binding_id == record.workspace_binding_id
        && state_workspace_scope(request.workspace_scope) == record.workspace_scope
        && request.workspace_scope_id == record.workspace_scope_id
        && request.binding_id == record.binding_id
        && request.binding_revision == record.binding_revision
        && request.connection_id == record.connection_id
        && request.provider_id == record.provider_id
        && request.protocol_version == record.protocol_version
        && request.resource_kind == record.resource_kind
        && request.resource_id == record.resource_id
        && request.resource_revision == record.resource_revision
        && request.execution_location == record.execution_location
        && request.credential_id == record.credential_id
        && request.credential_revision == record.credential_revision
        && request.provider_identity_binding_id == record.provider_identity_binding_id
        && request.provider_identity_binding_revision == record.provider_identity_binding_revision
        && request.provider_subject == record.provider_subject
        && request.provider_tenant_id == record.provider_tenant_id
        && request.provider_space_id == record.provider_space_id
        && state_operation(request.operation) == record.operation
        && request.claimed_at == record.created_at
}

fn state_terminal(terminal: &DynamicToolExecutionTerminal) -> StateTerminalRecord {
    match terminal {
        DynamicToolExecutionTerminal::Succeeded(result) => {
            StateTerminalRecord::Succeeded(state_result(result))
        }
        DynamicToolExecutionTerminal::Failed(reason) => StateTerminalRecord::Failed(match reason {
            DynamicToolExecutionFailure::Rejected => StateFailureCode::Rejected,
            DynamicToolExecutionFailure::ExecutionFailed => StateFailureCode::ExecutionFailed,
        }),
        DynamicToolExecutionTerminal::Unknown(reason) => {
            StateTerminalRecord::Unknown(match reason {
                DynamicToolExecutionUnknown::Timeout => StateUnknownCode::Timeout,
                DynamicToolExecutionUnknown::AdapterUnavailable => {
                    StateUnknownCode::AdapterUnavailable
                }
                DynamicToolExecutionUnknown::InvalidResponse => StateUnknownCode::InvalidResponse,
            })
        }
    }
}

fn state_completion(terminal: StateTerminalRecord) -> StateCompletionRecord {
    match terminal {
        StateTerminalRecord::Succeeded(result) => StateCompletionRecord::Succeeded(result),
        StateTerminalRecord::Failed(reason) => StateCompletionRecord::Failed(reason),
        StateTerminalRecord::Unknown(reason) => StateCompletionRecord::Unknown(reason),
        StateTerminalRecord::Claimed => unreachable!("port completion has no claimed variant"),
    }
}

fn state_result(result: &DynamicToolExecutionResultMetadata) -> StateResultRecord {
    match result {
        DynamicToolExecutionResultMetadata::Inline {
            item_count,
            byte_len,
            sha256,
        } => StateResultRecord::Inline {
            item_count: *item_count,
            byte_len: *byte_len,
            sha256: sha256.clone(),
        },
        DynamicToolExecutionResultMetadata::Artifact {
            artifact_id,
            revision,
        } => StateResultRecord::Artifact {
            artifact_id: artifact_id.clone(),
            revision: *revision,
        },
    }
}

const fn state_workspace_scope(scope: WorkspaceScope) -> ProviderResourceWorkspaceScope {
    match scope {
        WorkspaceScope::Conversation => ProviderResourceWorkspaceScope::Conversation,
        WorkspaceScope::Office => ProviderResourceWorkspaceScope::Office,
        WorkspaceScope::Workflow => ProviderResourceWorkspaceScope::Workflow,
        WorkspaceScope::Automation => ProviderResourceWorkspaceScope::Automation,
    }
}

const fn state_operation(operation: DynamicToolOperation) -> StateOperation {
    match operation {
        DynamicToolOperation::Call => StateOperation::Call,
        DynamicToolOperation::Search => StateOperation::Search,
    }
}
