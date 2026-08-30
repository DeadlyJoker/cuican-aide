use super::RequestIdentity;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_core::context::ContextAudience;
use crewon_core::context::ContextBudget;
use crewon_core::context::ContextFreshness;
use crewon_core::context::ContextProvenance;
use crewon_core::context::ContextPurpose;
use crewon_core::context::ContextSensitivity;
use crewon_core::context::ContextSourceKind;
use crewon_core::context::ContextTrust;
use crewon_core::context::GovernedContextError;
use crewon_core::context::GovernedContextFragment;
use crewon_core::context::GovernedContextSpec;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ContextConsumer {
    Single,
    Experts,
    OfficeShared,
    OfficeMemberPrivate { member_id: String },
}

pub(crate) struct ContextFragmentInput {
    pub fragment_id: String,
    pub source_kind: ContextSourceKind,
    pub source_id: String,
    pub trust: ContextTrust,
    pub sensitivity: ContextSensitivity,
    pub purpose: ContextPurpose,
    pub budget: ContextBudget,
    pub freshness: ContextFreshness,
    pub content: String,
}

pub(crate) fn build_context_fragment(
    identity: &RequestIdentity,
    workspace: &WorkspaceRef,
    consumer: ContextConsumer,
    input: ContextFragmentInput,
    now: i64,
) -> Result<GovernedContextFragment, ContextAdapterError> {
    let audience = match (workspace.scope, consumer) {
        (WorkspaceScope::Conversation, ContextConsumer::Single) => {
            ContextAudience::single(&workspace.binding_id, &workspace.scope_id)?
        }
        (WorkspaceScope::Conversation, ContextConsumer::Experts) => {
            ContextAudience::experts(&workspace.binding_id, &workspace.scope_id)?
        }
        (WorkspaceScope::Office, ContextConsumer::OfficeShared) => {
            ContextAudience::office_shared(&workspace.binding_id, &workspace.scope_id)?
        }
        (WorkspaceScope::Office, ContextConsumer::OfficeMemberPrivate { member_id }) => {
            ContextAudience::office_member_private(
                &workspace.binding_id,
                &workspace.scope_id,
                member_id,
            )?
        }
        (
            WorkspaceScope::Conversation,
            ContextConsumer::OfficeShared | ContextConsumer::OfficeMemberPrivate { .. },
        )
        | (WorkspaceScope::Office, ContextConsumer::Single | ContextConsumer::Experts)
        | (WorkspaceScope::Workflow | WorkspaceScope::Automation, _) => {
            return Err(ContextAdapterError::WorkspaceScopeMismatch);
        }
    };
    Ok(GovernedContextFragment::build(
        GovernedContextSpec {
            fragment_id: input.fragment_id,
            audience,
            provenance: ContextProvenance::new(
                input.source_kind,
                input.source_id,
                identity.reference().actor_id.clone(),
            )?,
            trust: input.trust,
            sensitivity: input.sensitivity,
            purpose: input.purpose,
            budget: input.budget,
            freshness: input.freshness,
            content: input.content,
        },
        now,
    )?)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ContextAdapterError {
    WorkspaceScopeMismatch,
    InvalidContext(GovernedContextError),
}

impl From<GovernedContextError> for ContextAdapterError {
    fn from(error: GovernedContextError) -> Self {
        Self::InvalidContext(error)
    }
}

impl fmt::Display for ContextAdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "context adapter rejected input: {self:?}")
    }
}

impl std::error::Error for ContextAdapterError {}

#[cfg(test)]
#[path = "context_adapter_tests.rs"]
mod tests;
