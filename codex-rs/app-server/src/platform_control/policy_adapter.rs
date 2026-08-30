use super::RequestIdentity;
use super::request_identity::RequestIdentityActorError;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_policy::AccessDecisionId;
use crewon_policy::ActionIntent;
use crewon_policy::ActionIntentSpec;
use crewon_policy::ActionNonce;
use crewon_policy::ActionPurpose;
use crewon_policy::ActionTarget;
use crewon_policy::ActionType;
use crewon_policy::ActionWorkspace;
use crewon_policy::BaselinePolicy;
use crewon_policy::CredentialBinding;
use crewon_policy::PolicyDecision;
use crewon_policy::PolicyModelError;
use crewon_policy::SideEffect;
use crewon_policy::WorkspaceScopeKind;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::WorkspaceKey;
use serde_json::Value as JsonValue;
use std::fmt;

/// Fully resolved action data supplied by server-owned resource and credential adapters.
pub(crate) struct ResolvedPolicyActionInput {
    pub action_type: ActionType,
    pub purpose: ActionPurpose,
    pub target: ActionTarget,
    pub arguments: JsonValue,
    pub credential: CredentialBinding,
    pub execution_location: ExecutionLocation,
    pub side_effect: SideEffect,
    pub expires_at: i64,
    pub nonce: ActionNonce,
}

pub(crate) fn build_action_intent(
    identity: &RequestIdentity,
    workspace: &WorkspaceRef,
    input: ResolvedPolicyActionInput,
) -> Result<ActionIntent, PolicyAdapterError> {
    let actor = identity.policy_actor().map_err(|error| match error {
        RequestIdentityActorError::IdentityScope => PolicyAdapterError::IdentityScope,
        RequestIdentityActorError::Model(error) => PolicyAdapterError::PolicyModel(error),
    })?;
    let scope = match workspace.scope {
        WorkspaceScope::Conversation => WorkspaceScopeKind::Conversation,
        WorkspaceScope::Office => WorkspaceScopeKind::Office,
        WorkspaceScope::Workflow => WorkspaceScopeKind::Workflow,
        WorkspaceScope::Automation => WorkspaceScopeKind::Automation,
    };
    let workspace = ActionWorkspace::new(
        WorkspaceKey::new(&workspace.workspace_key).map_err(|_| PolicyAdapterError::Workspace)?,
        &workspace.binding_id,
        scope,
        &workspace.scope_id,
        &workspace.node_id,
        &workspace.environment_id,
    )?;

    Ok(ActionIntent::new(ActionIntentSpec {
        action_type: input.action_type,
        actor,
        purpose: input.purpose,
        workspace,
        target: input.target,
        arguments: input.arguments,
        credential: input.credential,
        execution_location: input.execution_location,
        side_effect: input.side_effect,
        expires_at: input.expires_at,
        nonce: input.nonce,
    })?)
}

pub(crate) fn evaluate_action(
    identity: &RequestIdentity,
    workspace: &WorkspaceRef,
    access_decision_id: AccessDecisionId,
    input: ResolvedPolicyActionInput,
    now: i64,
) -> Result<PolicyDecision, PolicyAdapterError> {
    let action = build_action_intent(identity, workspace, input)?;
    Ok(BaselinePolicy::evaluate(access_decision_id, &action, now)?)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PolicyAdapterError {
    IdentityScope,
    Workspace,
    PolicyModel(PolicyModelError),
}

impl From<PolicyModelError> for PolicyAdapterError {
    fn from(error: PolicyModelError) -> Self {
        Self::PolicyModel(error)
    }
}

impl fmt::Display for PolicyAdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "policy adapter rejected input: {self:?}")
    }
}

impl std::error::Error for PolicyAdapterError {}

#[cfg(test)]
#[path = "policy_adapter_tests.rs"]
mod tests;
