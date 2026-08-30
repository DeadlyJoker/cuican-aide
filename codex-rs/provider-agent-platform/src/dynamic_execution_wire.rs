use serde::Deserialize;
use serde::Serialize;

use crate::AgentPlatformProviderError;
use crate::DynamicAuthorizationOperation;
use crate::ProviderDynamicExecutionFailure;
use crate::ProviderDynamicExecutionOutcome;
use crate::ProviderDynamicExecutionRequest;
use crate::ProviderDynamicExecutionSuccess;
use crate::ProviderDynamicExecutionUnknown;
use crate::dynamic_execution_model::DynamicResultWire;
use crate::dynamic_execution_model::operation_for_resource;
use crate::wire::ResourceRefWire;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ExecuteDynamicCommandType {
    ExecuteDynamicResource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum DynamicOperationWire {
    Call,
    Search,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecuteDynamicCommandWire {
    #[serde(rename = "type")]
    command_type: ExecuteDynamicCommandType,
    command_id: String,
    call_id: String,
    action_digest: String,
    resource: ResourceRefWire,
    operation: DynamicOperationWire,
    arguments: serde_json::Value,
}

impl ExecuteDynamicCommandWire {
    pub(crate) fn from_domain(
        request: &ProviderDynamicExecutionRequest,
    ) -> Result<Self, AgentPlatformProviderError> {
        let operation = operation_for_resource(request.authorization().resource().kind)?;
        Ok(Self {
            command_type: ExecuteDynamicCommandType::ExecuteDynamicResource,
            command_id: request.command_id().to_string(),
            call_id: request.authorization().call_id().to_string(),
            action_digest: request.authorization().action_digest().to_string(),
            resource: ResourceRefWire::from_domain(request.authorization().resource())?,
            operation: match operation {
                DynamicAuthorizationOperation::Call => DynamicOperationWire::Call,
                DynamicAuthorizationOperation::Search => DynamicOperationWire::Search,
            },
            arguments: request.arguments().clone(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DynamicFailureCodeWire {
    Rejected,
    ExecutionFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DynamicUnknownCodeWire {
    Timeout,
    ProviderUnavailable,
    UnknownOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ExecuteDynamicResponseWire {
    Succeeded {
        call_id: String,
        action_digest: String,
        result_digest: String,
        result: DynamicResultWire,
    },
    Failed {
        call_id: String,
        action_digest: String,
        code: DynamicFailureCodeWire,
    },
    Unknown {
        call_id: String,
        action_digest: String,
        code: DynamicUnknownCodeWire,
    },
}

impl ExecuteDynamicResponseWire {
    pub(crate) fn into_domain(
        self,
        request: &ProviderDynamicExecutionRequest,
    ) -> Result<ProviderDynamicExecutionOutcome, AgentPlatformProviderError> {
        let (call_id, action_digest) = match &self {
            Self::Succeeded {
                call_id,
                action_digest,
                ..
            }
            | Self::Failed {
                call_id,
                action_digest,
                ..
            }
            | Self::Unknown {
                call_id,
                action_digest,
                ..
            } => (call_id, action_digest),
        };
        if call_id != request.authorization().call_id()
            || action_digest != request.authorization().action_digest()
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        match self {
            Self::Succeeded {
                result_digest,
                result,
                ..
            } => {
                let actual_digest = result.digest()?;
                if result_digest != actual_digest.as_str() {
                    return Err(AgentPlatformProviderError::InvalidResponse);
                }
                Ok(ProviderDynamicExecutionOutcome::Succeeded(
                    ProviderDynamicExecutionSuccess::new(result.into_domain()?)?,
                ))
            }
            Self::Failed { code, .. } => Ok(ProviderDynamicExecutionOutcome::Failed(match code {
                DynamicFailureCodeWire::Rejected => ProviderDynamicExecutionFailure::Rejected,
                DynamicFailureCodeWire::ExecutionFailed => {
                    ProviderDynamicExecutionFailure::ExecutionFailed
                }
            })),
            Self::Unknown { code, .. } => {
                Ok(ProviderDynamicExecutionOutcome::Unknown(match code {
                    DynamicUnknownCodeWire::Timeout => ProviderDynamicExecutionUnknown::Timeout,
                    DynamicUnknownCodeWire::ProviderUnavailable => {
                        ProviderDynamicExecutionUnknown::ProviderUnavailable
                    }
                    DynamicUnknownCodeWire::UnknownOutcome => {
                        ProviderDynamicExecutionUnknown::UnknownOutcome
                    }
                }))
            }
        }
    }
}

#[cfg(test)]
#[path = "dynamic_execution_wire_tests.rs"]
mod tests;
