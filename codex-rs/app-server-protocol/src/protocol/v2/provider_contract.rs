//! Canonical contract for durable execution through an external provider.

use super::ArtifactRef;
use super::PlatformErrorCode;
use super::ProviderCapabilityKind;
use super::ResourceRef;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;
use ts_rs::TS;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(untagged)]
#[ts(export_to = "v2/")]
pub enum RequiredNullableString {
    Value(String),
    Null,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderContractDescriptor {
    pub provider_id: String,
    pub capabilities: Vec<ProviderCapabilityKind>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderCredentialAuthorization {
    pub credential_id: String,
    pub owner_subject: String,
    pub revision: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderDelegationAuthorization {
    pub audience: String,
    pub jti: String,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderAuthorization {
    pub service_audience: String,
    pub tenant_id: String,
    pub space_id: String,
    pub task_id: String,
    pub subject: String,
    pub scopes: Vec<String>,
    pub purpose: String,
    pub credential: ProviderCredentialAuthorization,
    pub delegation: ProviderDelegationAuthorization,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderRunInput {
    pub prompt: String,
    pub context_refs: Vec<ArtifactRef>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderStartCommand {
    pub command_id: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub resource: ResourceRef,
    pub input: ProviderRunInput,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderReadCommand {
    pub command_id: String,
    pub provider_run_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderListEventsCommand {
    pub command_id: String,
    pub provider_run_id: String,
    pub after_cursor: RequiredNullableString,
    pub limit: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderCancelCommand {
    pub command_id: String,
    pub provider_run_id: String,
    pub reason: String,
    pub expected_revision: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum ProviderApprovalDecision {
    Approve,
    Deny,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderDecideApprovalCommand {
    pub command_id: String,
    pub provider_run_id: String,
    pub approval_id: String,
    pub decision: ProviderApprovalDecision,
    pub action_digest: String,
    pub idempotency_key: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderSubmitToolResultCommand {
    pub command_id: String,
    pub provider_run_id: String,
    pub tool_call_id: String,
    pub intent_digest: String,
    pub result_digest: String,
    pub artifact: ArtifactRef,
    pub idempotency_key: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type")]
#[ts(export_to = "v2/")]
pub enum ProviderCommand {
    Start(ProviderStartCommand),
    Read(ProviderReadCommand),
    ListEvents(ProviderListEventsCommand),
    Cancel(ProviderCancelCommand),
    DecideApproval(ProviderDecideApprovalCommand),
    SubmitToolResult(ProviderSubmitToolResultCommand),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderApprovalRequest {
    pub approval_id: String,
    pub action_digest: String,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderContractError {
    pub code: PlatformErrorCode,
    pub retryable: bool,
    pub provider_run_id: RequiredNullableString,
    pub trace_id: String,
}

macro_rules! provider_event {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[ts(export_to = "v2/")]
        pub struct $name {
            pub event_id: String,
            pub provider_run_id: String,
            pub attempt_id: String,
            pub sequence: u64,
            pub cursor: String,
            pub created_at: i64,
            $(pub $field: $ty,)*
        }
    };
}

provider_event!(ProviderRunStartedEvent { revision: u64 });
provider_event!(ProviderProgressEvent { summary: String });
provider_event!(ProviderApprovalRequiredEvent {
    approval: ProviderApprovalRequest,
});
provider_event!(ProviderToolResultRequiredEvent {
    tool_call_id: String,
    tool_schema_revision: String,
    arguments_digest: String,
    intent_digest: String,
    nonce: String,
    expires_at: i64,
});
provider_event!(ProviderToolResultAcceptedEvent {
    tool_call_id: String,
    intent_digest: String,
    result_digest: String,
});
provider_event!(ProviderCompletedEvent {
    output_artifacts: Vec<ArtifactRef>,
});
provider_event!(ProviderFailedEvent {
    error: ProviderContractError,
});
provider_event!(ProviderCancelledEvent { reason: String });

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(tag = "type")]
#[ts(export_to = "v2/")]
pub enum ProviderRunEvent {
    RunStarted(ProviderRunStartedEvent),
    Progress(ProviderProgressEvent),
    ApprovalRequired(ProviderApprovalRequiredEvent),
    ToolResultRequired(ProviderToolResultRequiredEvent),
    ToolResultAccepted(ProviderToolResultAcceptedEvent),
    Completed(ProviderCompletedEvent),
    Failed(ProviderFailedEvent),
    Cancelled(ProviderCancelledEvent),
}

impl ProviderRunEvent {
    fn metadata(&self) -> (&str, &str, u64, &str, i64) {
        match self {
            Self::RunStarted(event) => (
                &event.provider_run_id,
                &event.attempt_id,
                event.sequence,
                &event.cursor,
                event.created_at,
            ),
            Self::Progress(event) => (
                &event.provider_run_id,
                &event.attempt_id,
                event.sequence,
                &event.cursor,
                event.created_at,
            ),
            Self::ApprovalRequired(event) => (
                &event.provider_run_id,
                &event.attempt_id,
                event.sequence,
                &event.cursor,
                event.created_at,
            ),
            Self::ToolResultRequired(event) => (
                &event.provider_run_id,
                &event.attempt_id,
                event.sequence,
                &event.cursor,
                event.created_at,
            ),
            Self::ToolResultAccepted(event) => (
                &event.provider_run_id,
                &event.attempt_id,
                event.sequence,
                &event.cursor,
                event.created_at,
            ),
            Self::Completed(event) => (
                &event.provider_run_id,
                &event.attempt_id,
                event.sequence,
                &event.cursor,
                event.created_at,
            ),
            Self::Failed(event) => (
                &event.provider_run_id,
                &event.attempt_id,
                event.sequence,
                &event.cursor,
                event.created_at,
            ),
            Self::Cancelled(event) => (
                &event.provider_run_id,
                &event.attempt_id,
                event.sequence,
                &event.cursor,
                event.created_at,
            ),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export_to = "v2/")]
pub struct ProviderContract {
    pub schema_version: String,
    pub provider: ProviderContractDescriptor,
    pub authorization: ProviderAuthorization,
    pub commands: Vec<ProviderCommand>,
    pub events: Vec<ProviderRunEvent>,
    pub error: ProviderContractError,
}

impl ProviderContract {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != "3.0.0" {
            return Err("unsupported provider contract schemaVersion".to_string());
        }

        let expected_capabilities = BTreeSet::from([
            ProviderCapabilityKind::Approval,
            ProviderCapabilityKind::DurableRun,
            ProviderCapabilityKind::PersistentConversation,
            ProviderCapabilityKind::RemoteAgent,
            ProviderCapabilityKind::ResumableEvents,
            ProviderCapabilityKind::ToolResult,
        ]);
        let capabilities = self
            .provider
            .capabilities
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        if capabilities != expected_capabilities
            || capabilities.len() != self.provider.capabilities.len()
        {
            return Err("provider capabilities do not match v3 contract".to_string());
        }

        let expected_scopes = BTreeSet::from([
            "providerRun:approval",
            "providerRun:cancel",
            "providerRun:events",
            "providerRun:read",
            "providerRun:start",
            "providerRun:toolResult",
        ]);
        let scopes = self
            .authorization
            .scopes
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if scopes != expected_scopes || scopes.len() != self.authorization.scopes.len() {
            return Err("authorization scopes do not match v3 contract".to_string());
        }
        if self.authorization.subject != self.authorization.credential.owner_subject {
            return Err("credential owner must match the delegated subject".to_string());
        }
        if self.authorization.credential.revision == 0 {
            return Err("credential revision must be positive".to_string());
        }

        let command_kinds = self
            .commands
            .iter()
            .map(|command| match command {
                ProviderCommand::Start(_) => "start",
                ProviderCommand::Read(_) => "read",
                ProviderCommand::ListEvents(_) => "listEvents",
                ProviderCommand::Cancel(_) => "cancel",
                ProviderCommand::DecideApproval(_) => "decideApproval",
                ProviderCommand::SubmitToolResult(_) => "submitToolResult",
            })
            .collect::<BTreeSet<_>>();
        let expected_commands = BTreeSet::from([
            "cancel",
            "decideApproval",
            "listEvents",
            "read",
            "start",
            "submitToolResult",
        ]);
        if command_kinds != expected_commands || command_kinds.len() != self.commands.len() {
            return Err("provider commands do not match v2 contract".to_string());
        }

        let Some(first_event) = self.events.first() else {
            return Err("provider event stream must not be empty".to_string());
        };
        if !matches!(first_event, ProviderRunEvent::RunStarted(_)) {
            return Err("provider event stream must begin with runStarted".to_string());
        }

        let (provider_run_id, attempt_id, _, _, _) = first_event.metadata();
        let mut previous_created_at = i64::MIN;
        for (index, event) in self.events.iter().enumerate() {
            let expected_sequence = index as u64 + 1;
            let (event_run_id, event_attempt_id, sequence, cursor, created_at) = event.metadata();
            if event_run_id != provider_run_id || event_attempt_id != attempt_id {
                return Err("provider events must belong to one run attempt".to_string());
            }
            if sequence != expected_sequence || cursor != format!("event-{expected_sequence:04}") {
                return Err("provider event sequence or cursor is not contiguous".to_string());
            }
            if created_at < previous_created_at {
                return Err("provider event timestamps must be monotonic".to_string());
            }
            previous_created_at = created_at;

            let terminal = matches!(
                event,
                ProviderRunEvent::Completed(_)
                    | ProviderRunEvent::Failed(_)
                    | ProviderRunEvent::Cancelled(_)
            );
            if terminal != (index + 1 == self.events.len()) {
                return Err(
                    "provider event stream must have exactly one final terminal event".to_string(),
                );
            }
        }

        if self.authorization.delegation.expires_at <= previous_created_at {
            return Err(
                "delegation must remain valid through the fixture event stream".to_string(),
            );
        }

        for command in &self.commands {
            match command {
                ProviderCommand::Start(command) => {
                    if command.resource.provider_id != self.provider.provider_id {
                        return Err("start resource provider does not match descriptor".to_string());
                    }
                    if command
                        .input
                        .context_refs
                        .iter()
                        .any(|artifact| artifact.task_id != self.authorization.task_id)
                    {
                        return Err("context artifact must match the authorized task".to_string());
                    }
                }
                ProviderCommand::Read(command) => {
                    if command.provider_run_id != provider_run_id {
                        return Err("read command targets another provider run".to_string());
                    }
                }
                ProviderCommand::ListEvents(command) => {
                    if command.provider_run_id != provider_run_id {
                        return Err("listEvents command targets another provider run".to_string());
                    }
                }
                ProviderCommand::Cancel(command) => {
                    if command.provider_run_id != provider_run_id {
                        return Err("cancel command targets another provider run".to_string());
                    }
                }
                ProviderCommand::DecideApproval(command) => {
                    let matches_event = self.events.iter().any(|event| {
                        matches!(
                            event,
                            ProviderRunEvent::ApprovalRequired(event)
                                if event.provider_run_id == command.provider_run_id
                                    && event.approval.approval_id == command.approval_id
                                    && event.approval.action_digest == command.action_digest
                        )
                    });
                    if !matches_event {
                        return Err(
                            "approval decision is not bound to the required action".to_string()
                        );
                    }
                }
                ProviderCommand::SubmitToolResult(command) => {
                    if command.artifact.task_id != self.authorization.task_id {
                        return Err(
                            "tool result artifact must match the authorized task".to_string()
                        );
                    }
                    let matches_requirement = self.events.iter().any(|event| {
                        matches!(
                            event,
                            ProviderRunEvent::ToolResultRequired(event)
                                if event.provider_run_id == command.provider_run_id
                                    && event.tool_call_id == command.tool_call_id
                                    && event.intent_digest == command.intent_digest
                        )
                    });
                    if !matches_requirement {
                        return Err(
                            "tool result is not bound to a required tool intent".to_string()
                        );
                    }
                    let matches_acceptance = self.events.iter().any(|event| {
                        matches!(
                            event,
                            ProviderRunEvent::ToolResultAccepted(event)
                                if event.provider_run_id == command.provider_run_id
                                    && event.tool_call_id == command.tool_call_id
                                    && event.intent_digest == command.intent_digest
                                    && event.result_digest == command.result_digest
                        )
                    });
                    if !matches_acceptance {
                        return Err("tool result is not bound to its accepted event".to_string());
                    }
                }
            }
        }

        if self.events.iter().any(|event| {
            matches!(
                event,
                ProviderRunEvent::Completed(event)
                    if event
                        .output_artifacts
                        .iter()
                        .any(|artifact| artifact.task_id != self.authorization.task_id)
            )
        }) {
            return Err("output artifact must match the authorized task".to_string());
        }

        Ok(())
    }
}

#[cfg(test)]
#[path = "provider_contract_tests.rs"]
mod tests;
