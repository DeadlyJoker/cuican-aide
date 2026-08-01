use serde::Deserialize;
use serde_json::value::RawValue;

use crate::AgentPlatformCapability;
use crate::AgentPlatformProviderDescriptor;
use crate::AgentPlatformProviderError;
use crate::ProviderRunEvent;
use crate::ProviderRunEventMetadata;
use crate::ProviderRunEventPage;
use crate::ProviderRunEventPayload;
use crate::ProviderRunEventsRequest;
use crate::ProviderRunFailure;
use crate::ProviderRunFailureCode;
use crate::run_wire::ArtifactRefWire;
use crate::wire::ProviderErrorCodeWire;
use crate::wire::ProviderErrorWire;

const MAX_EVENT_PAYLOAD_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum EventTypeWire {
    RunStarted,
    Progress,
    ApprovalRequired,
    ToolResultRequired,
    ToolResultAccepted,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EventHttpWire {
    event_id: String,
    provider_run_id: String,
    attempt_id: String,
    sequence: u64,
    cursor: String,
    schema_version: String,
    #[serde(rename = "type")]
    event_type: EventTypeWire,
    payload: Box<RawValue>,
    created_at: i64,
}

impl EventHttpWire {
    pub(crate) fn into_domain(
        self,
        task_id: &str,
    ) -> Result<ProviderRunEvent, AgentPlatformProviderError> {
        if self.payload.get().len() > MAX_EVENT_PAYLOAD_BYTES {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        let payload = parse_payload(self.event_type, self.payload)?;
        ProviderRunEvent::new(
            ProviderRunEventMetadata::new(
                self.event_id,
                self.provider_run_id,
                self.attempt_id,
                self.sequence,
                self.cursor,
                self.schema_version,
                self.created_at,
            )?,
            payload,
            task_id,
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EventsResponseWire {
    events: Vec<EventHttpWire>,
    last_cursor: Option<String>,
}

impl EventsResponseWire {
    pub(crate) fn into_domain(
        self,
        request: &ProviderRunEventsRequest,
        descriptor: &AgentPlatformProviderDescriptor,
    ) -> Result<ProviderRunEventPage, AgentPlatformProviderError> {
        let mut events = Vec::with_capacity(self.events.len());
        for event in self.events {
            let event = event.into_domain(request.authorization().task_id())?;
            if event.payload().requires_approval_capability()
                && !descriptor.supports(AgentPlatformCapability::Approval)
            {
                return Err(AgentPlatformProviderError::Incompatible);
            }
            if event.payload().requires_tool_result_capability()
                && !descriptor.supports(AgentPlatformCapability::ToolResult)
            {
                return Err(AgentPlatformProviderError::Incompatible);
            }
            events.push(event);
        }
        ProviderRunEventPage::validated(
            events,
            self.last_cursor,
            request.provider_run_id(),
            request.after_cursor(),
        )
    }
}

macro_rules! payload_wire {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct $name { $($field: $ty,)* }
    };
}

payload_wire!(RunStartedPayloadWire { revision: u64 });
payload_wire!(ProgressPayloadWire { summary: String });
payload_wire!(ApprovalWire {
    approval_id: String,
    action_digest: String,
    expires_at: i64
});
payload_wire!(ApprovalPayloadWire {
    approval: ApprovalWire
});
payload_wire!(ToolRequiredPayloadWire {
    tool_call_id: String,
    tool_schema_revision: String,
    arguments_digest: String,
    intent_digest: String,
    nonce: String,
    expires_at: i64,
});
payload_wire!(ToolAcceptedPayloadWire {
    tool_call_id: String,
    intent_digest: String,
    result_digest: String
});
payload_wire!(CompletedPayloadWire { output_artifacts: Vec<ArtifactRefWire> });
payload_wire!(FailedPayloadWire {
    error: ProviderErrorWire
});
payload_wire!(CancelledPayloadWire { reason: String });

fn parse_payload(
    event_type: EventTypeWire,
    value: Box<RawValue>,
) -> Result<ProviderRunEventPayload, AgentPlatformProviderError> {
    fn decode<T: for<'de> Deserialize<'de>>(
        value: &RawValue,
    ) -> Result<T, AgentPlatformProviderError> {
        serde_json::from_str(value.get()).map_err(|_| AgentPlatformProviderError::InvalidResponse)
    }
    Ok(match event_type {
        EventTypeWire::RunStarted => {
            let value: RunStartedPayloadWire = decode(&value)?;
            ProviderRunEventPayload::RunStarted {
                revision: value.revision,
            }
        }
        EventTypeWire::Progress => {
            let value: ProgressPayloadWire = decode(&value)?;
            ProviderRunEventPayload::Progress {
                summary: value.summary,
            }
        }
        EventTypeWire::ApprovalRequired => {
            let value: ApprovalPayloadWire = decode(&value)?;
            ProviderRunEventPayload::ApprovalRequired {
                approval_id: value.approval.approval_id,
                action_digest: value.approval.action_digest,
                expires_at: value.approval.expires_at,
            }
        }
        EventTypeWire::ToolResultRequired => {
            let value: ToolRequiredPayloadWire = decode(&value)?;
            ProviderRunEventPayload::ToolResultRequired {
                tool_call_id: value.tool_call_id,
                tool_schema_revision: value.tool_schema_revision,
                arguments_digest: value.arguments_digest,
                intent_digest: value.intent_digest,
                nonce: value.nonce,
                expires_at: value.expires_at,
            }
        }
        EventTypeWire::ToolResultAccepted => {
            let value: ToolAcceptedPayloadWire = decode(&value)?;
            ProviderRunEventPayload::ToolResultAccepted {
                tool_call_id: value.tool_call_id,
                intent_digest: value.intent_digest,
                result_digest: value.result_digest,
            }
        }
        EventTypeWire::Completed => {
            let value: CompletedPayloadWire = decode(&value)?;
            ProviderRunEventPayload::Completed {
                output_artifacts: value
                    .output_artifacts
                    .into_iter()
                    .map(ArtifactRefWire::into_domain)
                    .collect::<Result<_, _>>()?,
            }
        }
        EventTypeWire::Failed => {
            let value: FailedPayloadWire = decode(&value)?;
            ProviderRunEventPayload::Failed {
                error: ProviderRunFailure::new(
                    map_failure_code(value.error.code),
                    value.error.retryable,
                    value
                        .error
                        .provider_run_id
                        .ok_or(AgentPlatformProviderError::InvalidResponse)?,
                    value.error.trace_id,
                )?,
            }
        }
        EventTypeWire::Cancelled => {
            let value: CancelledPayloadWire = decode(&value)?;
            ProviderRunEventPayload::Cancelled {
                reason: value.reason,
            }
        }
    })
}

fn map_failure_code(code: ProviderErrorCodeWire) -> ProviderRunFailureCode {
    match code {
        ProviderErrorCodeWire::InvalidRequest => ProviderRunFailureCode::InvalidRequest,
        ProviderErrorCodeWire::Unauthorized => ProviderRunFailureCode::Unauthorized,
        ProviderErrorCodeWire::Forbidden => ProviderRunFailureCode::Forbidden,
        ProviderErrorCodeWire::NotFound => ProviderRunFailureCode::NotFound,
        ProviderErrorCodeWire::Conflict => ProviderRunFailureCode::Conflict,
        ProviderErrorCodeWire::CapabilityUnsupported => {
            ProviderRunFailureCode::CapabilityUnsupported
        }
        ProviderErrorCodeWire::ProviderUnavailable => ProviderRunFailureCode::ProviderUnavailable,
        ProviderErrorCodeWire::Timeout => ProviderRunFailureCode::Timeout,
        ProviderErrorCodeWire::UnknownOutcome => ProviderRunFailureCode::UnknownOutcome,
        ProviderErrorCodeWire::Internal => ProviderRunFailureCode::Internal,
    }
}
