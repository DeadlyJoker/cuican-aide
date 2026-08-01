use std::fmt;

use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_artifact::ArtifactError;
use crewon_artifact::ThreadId;
use crewon_artifact::TurnId;
use crewon_policy::AccessDecisionId;
use crewon_policy::ActionNonce;
use crewon_policy::ActionPurpose;
use crewon_policy::ActionTarget;
use crewon_policy::ActionTargetId;
use crewon_policy::ActionType;
use crewon_policy::ApprovalRequirement;
use crewon_policy::AuthorizationError;
use crewon_policy::ExecutionAuthorization;
use crewon_policy::PolicyDecision;
use crewon_policy::PolicyDenial;
use crewon_policy::PolicyModelError;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ModelError as ResourceModelError;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceRevision;
use crewon_state::ProviderResourceBindingRecord;
use crewon_state::ProviderResourceExecutionLocation;
use crewon_state::ProviderResourceWorkspaceScope;
use serde_json::Value as JsonValue;
use sha2::Digest;
use sha2::Sha256;

use super::ports::*;
use super::registration::*;
use crate::platform_control::RequestIdentity;
use crate::platform_control::policy_adapter::PolicyAdapterError;
use crate::platform_control::policy_adapter::ResolvedPolicyActionInput;
use crate::platform_control::policy_adapter::build_action_intent;

pub(crate) struct DynamicToolPolicyContext {
    pub purpose: ActionPurpose,
    pub expires_at: i64,
    pub nonce: ActionNonce,
    pub execution: DynamicToolConversationExecution,
}

pub(crate) struct DynamicToolConversationExecution {
    thread_id: ThreadId,
    turn_id: TurnId,
}

impl DynamicToolConversationExecution {
    pub(crate) fn new(
        thread_id: impl Into<String>,
        turn_id: impl Into<String>,
    ) -> Result<Self, ArtifactError> {
        Ok(Self {
            thread_id: ThreadId::new(thread_id)?,
            turn_id: TurnId::new(turn_id)?,
        })
    }

    fn thread_id(&self) -> &str {
        self.thread_id.as_str()
    }

    fn turn_id(&self) -> &str {
        self.turn_id.as_str()
    }
}

pub(crate) enum DynamicToolAuthorization {
    Evaluate(AccessDecisionId),
    Presented(ExecutionAuthorization),
}

pub(crate) struct DynamicToolAuthorizedCall {
    claim: DynamicToolExecutionClaim,
    target: DynamicToolExecutionTarget,
    operation: DynamicToolOperation,
    arguments: JsonValue,
    credential: DynamicToolCredentialSnapshot,
}

impl DynamicToolAuthorizedCall {
    pub(crate) fn claim(&self) -> &DynamicToolExecutionClaim {
        &self.claim
    }

    pub(crate) fn target(&self) -> &DynamicToolExecutionTarget {
        &self.target
    }

    pub(crate) fn arguments(&self) -> &JsonValue {
        &self.arguments
    }

    pub(crate) fn into_dispatch_parts(self) -> DynamicToolDispatchParts {
        DynamicToolDispatchParts {
            claim: self.claim,
            target: self.target,
            operation: self.operation,
            arguments: self.arguments,
            credential: self.credential,
        }
    }
}

pub(crate) struct DynamicToolDispatchParts {
    pub claim: DynamicToolExecutionClaim,
    pub target: DynamicToolExecutionTarget,
    pub operation: DynamicToolOperation,
    pub arguments: JsonValue,
    pub credential: DynamicToolCredentialSnapshot,
}

impl fmt::Debug for DynamicToolAuthorizedCall {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DynamicToolAuthorizedCall")
            .field("claim", &self.claim)
            .field("target", &self.target)
            .field("operation", &self.operation)
            .field("arguments", &"[REDACTED]")
            .field("credential", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug)]
pub(crate) enum DynamicToolAdmissionOutcome {
    Authorized(Box<DynamicToolAuthorizedCall>),
    ApprovalRequired {
        action: Box<crewon_policy::ActionIntent>,
        requirement: ApprovalRequirement,
    },
    Denied(PolicyDenial),
    Duplicate,
}

pub(crate) struct DynamicToolAdmissionRouter<'a, Binding, Credential, Journal> {
    registry: &'a DynamicToolRegistry,
    bindings: &'a Binding,
    credentials: &'a Credential,
    journal: &'a Journal,
}

impl<'a, Binding, Credential, Journal> DynamicToolAdmissionRouter<'a, Binding, Credential, Journal>
where
    Binding: DynamicToolBindingReader,
    Credential: DynamicToolCredentialResolver,
    Journal: DynamicToolExecutionJournal,
{
    pub(crate) fn new(
        registry: &'a DynamicToolRegistry,
        bindings: &'a Binding,
        credentials: &'a Credential,
        journal: &'a Journal,
    ) -> Self {
        Self {
            registry,
            bindings,
            credentials,
            journal,
        }
    }

    pub(crate) async fn admit(
        &self,
        identity: &RequestIdentity,
        workspace: &WorkspaceRef,
        invocation: DynamicToolInvocation,
        policy: DynamicToolPolicyContext,
        authorization: DynamicToolAuthorization,
        now: i64,
    ) -> Result<DynamicToolAdmissionOutcome, DynamicToolAdmissionError> {
        let DynamicToolPolicyContext {
            purpose,
            expires_at,
            nonce,
            execution,
        } = policy;
        let registered = self.registry.registration(&invocation)?;
        let binding = self
            .bindings
            .read_binding(registered.binding().binding_id.clone())
            .await?
            .ok_or(DynamicToolAdmissionError::BindingNotFound)?;
        let registration = self.registry.resolve(&invocation, &binding)?;
        validate_authority(identity, workspace, &binding)?;
        let credential = self
            .credentials
            .resolve_credential(DynamicToolCredentialRequest {
                identity: identity.clone(),
                binding: binding.clone(),
            })
            .await?;
        if matches!(
            registration.target(),
            DynamicToolExecutionTarget::Provider { .. }
        ) && (!credential.is_reference() || credential.provider_identity().is_none())
        {
            return Err(DynamicToolAdmissionError::CredentialRequired);
        }
        let action = build_action_intent(
            identity,
            workspace,
            ResolvedPolicyActionInput {
                action_type: ActionType::ToolCall,
                purpose,
                target: action_target(&binding, registration.tool_name())?,
                arguments: invocation.arguments().clone(),
                credential: credential.policy_binding(),
                execution_location: execution_location(binding.execution_location),
                side_effect: registration.side_effect(),
                expires_at,
                nonce,
            },
        )?;
        let execution_authorization = match authorization {
            DynamicToolAuthorization::Evaluate(access_decision_id) => {
                match crewon_policy::BaselinePolicy::evaluate(access_decision_id, &action, now)? {
                    PolicyDecision::Allow(authorization) => authorization,
                    PolicyDecision::ApprovalRequired(requirement) => {
                        return Ok(DynamicToolAdmissionOutcome::ApprovalRequired {
                            action: Box::new(action),
                            requirement,
                        });
                    }
                    PolicyDecision::Deny(denial) => {
                        return Ok(DynamicToolAdmissionOutcome::Denied(denial));
                    }
                }
            }
            DynamicToolAuthorization::Presented(authorization) => authorization,
        }
        .verify(&action, now)?;
        let claim = match self
            .journal
            .claim(claim_request(
                identity,
                workspace,
                &invocation,
                &binding,
                registration.operation(),
                &action,
                &execution_authorization,
                &credential,
                &execution,
                now,
            )?)
            .await?
        {
            DynamicToolExecutionClaimOutcome::Acquired(claim) => *claim,
            DynamicToolExecutionClaimOutcome::ExistingSame => {
                return Ok(DynamicToolAdmissionOutcome::Duplicate);
            }
            DynamicToolExecutionClaimOutcome::Conflict => {
                return Err(DynamicToolAdmissionError::CallConflict);
            }
        };
        Ok(DynamicToolAdmissionOutcome::Authorized(Box::new(
            DynamicToolAuthorizedCall {
                claim,
                target: registration.target().clone(),
                operation: registration.operation(),
                arguments: invocation.arguments().clone(),
                credential,
            },
        )))
    }
}

fn validate_authority(
    identity: &RequestIdentity,
    workspace: &WorkspaceRef,
    binding: &ProviderResourceBindingRecord,
) -> Result<(), DynamicToolAdmissionError> {
    let reference = identity.reference();
    let scope = match workspace.scope {
        WorkspaceScope::Conversation => ProviderResourceWorkspaceScope::Conversation,
        WorkspaceScope::Office => ProviderResourceWorkspaceScope::Office,
        WorkspaceScope::Workflow => ProviderResourceWorkspaceScope::Workflow,
        WorkspaceScope::Automation => ProviderResourceWorkspaceScope::Automation,
    };
    if reference.tenant_id.as_deref() != Some(&binding.local_tenant_id)
        || reference.space_id.as_deref() != Some(&binding.local_space_id)
        || reference.actor_id != binding.local_actor_id
        || workspace.workspace_key != binding.workspace_key
        || workspace.scope_id != binding.workspace_scope_id
        || scope != binding.workspace_scope
    {
        return Err(DynamicToolAdmissionError::AuthorityMismatch);
    }
    Ok(())
}

fn action_target(
    binding: &ProviderResourceBindingRecord,
    operation: &str,
) -> Result<ActionTarget, DynamicToolAdmissionError> {
    Ok(ActionTarget::tool(
        ProviderRef {
            provider_id: ProviderId::new(&binding.provider_id)?,
            protocol_version: ProviderProtocolVersion::new(&binding.protocol_version)?,
        },
        ActionTargetId::new(format!("{operation}:{}", binding.binding_id))?,
        ResourceRevision::new(&binding.resource_revision)?,
    ))
}

fn execution_location(location: ProviderResourceExecutionLocation) -> ExecutionLocation {
    match location {
        ProviderResourceExecutionLocation::LocalNode => ExecutionLocation::LocalNode,
        ProviderResourceExecutionLocation::Provider => ExecutionLocation::Provider,
    }
}

#[allow(clippy::too_many_arguments)]
fn claim_request(
    identity: &RequestIdentity,
    workspace: &WorkspaceRef,
    invocation: &DynamicToolInvocation,
    binding: &ProviderResourceBindingRecord,
    operation: DynamicToolOperation,
    action: &crewon_policy::ActionIntent,
    authorization: &ExecutionAuthorization,
    credential: &DynamicToolCredentialSnapshot,
    execution: &DynamicToolConversationExecution,
    claimed_at: i64,
) -> Result<DynamicToolExecutionClaimRequest, DynamicToolAdmissionError> {
    let provider_identity = credential.provider_identity();
    Ok(DynamicToolExecutionClaimRequest {
        call_id: invocation.call_id().to_string(),
        action_digest: action.digest()?.as_str().to_string(),
        access_decision_id: authorization.access_decision_id().as_str().to_string(),
        approval_id: authorization
            .approval_id()
            .map(|approval_id| approval_id.as_str().to_string()),
        actor_id: identity.reference().actor_id.clone(),
        tenant_id: identity.reference().tenant_id.clone(),
        space_id: identity.reference().space_id.clone(),
        session_id: identity.reference().session_id.clone(),
        trace_id: identity.reference().trace_id.clone(),
        span_id: dynamic_tool_span_id(invocation.call_id()),
        parent_span_id: None,
        thread_id: execution.thread_id().to_string(),
        turn_id: execution.turn_id().to_string(),
        workspace_key: workspace.workspace_key.clone(),
        workspace_binding_id: workspace.binding_id.clone(),
        workspace_scope: workspace.scope,
        workspace_scope_id: workspace.scope_id.clone(),
        binding_id: binding.binding_id.clone(),
        binding_revision: binding.revision,
        connection_id: binding.connection_id.clone(),
        provider_id: binding.provider_id.clone(),
        protocol_version: binding.protocol_version.clone(),
        resource_kind: binding.resource_kind,
        resource_id: binding.resource_id.clone(),
        resource_revision: binding.resource_revision.clone(),
        execution_location: binding.execution_location,
        credential_id: credential.credential_id().map(str::to_string),
        credential_revision: credential.revision(),
        provider_identity_binding_id: provider_identity.map(|identity| identity.binding_id.clone()),
        provider_identity_binding_revision: provider_identity
            .map(|identity| identity.binding_revision),
        provider_subject: provider_identity.map(|identity| identity.subject.clone()),
        provider_tenant_id: provider_identity.map(|identity| identity.tenant_id.clone()),
        provider_space_id: provider_identity.map(|identity| identity.space_id.clone()),
        operation,
        claimed_at,
    })
}

fn dynamic_tool_span_id(call_id: &str) -> String {
    format!("dynamic-tool-{:x}", Sha256::digest(call_id.as_bytes()))
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum DynamicToolAdmissionError {
    #[error("dynamic tool route rejected the request")]
    Route(#[from] DynamicToolRouteError),
    #[error("dynamic tool policy adapter rejected the request")]
    PolicyAdapter(#[from] PolicyAdapterError),
    #[error("dynamic tool policy model rejected the request")]
    PolicyModel(#[from] PolicyModelError),
    #[error("dynamic tool resource model rejected the request")]
    ResourceModel(#[from] ResourceModelError),
    #[error("dynamic tool authorization rejected the request")]
    Authorization(AuthorizationError),
    #[error("dynamic tool authority port failed")]
    Port(#[from] DynamicToolPortError),
    #[error("dynamic tool binding was not found")]
    BindingNotFound,
    #[error("dynamic tool actor or workspace does not own the binding")]
    AuthorityMismatch,
    #[error("dynamic tool Provider execution requires a live Credential reference")]
    CredentialRequired,
    #[error("dynamic tool call ID conflicts with another action")]
    CallConflict,
}

impl From<AuthorizationError> for DynamicToolAdmissionError {
    fn from(error: AuthorizationError) -> Self {
        Self::Authorization(error)
    }
}
