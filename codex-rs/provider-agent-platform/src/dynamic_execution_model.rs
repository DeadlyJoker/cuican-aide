use std::fmt;

use crewon_resource_federation::ContentDigest;
use crewon_resource_federation::ResourceKind;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use sha2::Digest;
use sha2::Sha256;

use crate::AgentPlatformProviderError;
use crate::ProviderDynamicAuthorizationBinding;

const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_INLINE_ITEMS: usize = 16;
const MAX_INLINE_ITEM_BYTES: usize = 16 * 1024;
const MAX_INLINE_RESULT_BYTES: usize = 32 * 1024;

/// Fully validated one-shot Provider Tool or Knowledge execution request.
#[derive(Clone, PartialEq)]
pub struct ProviderDynamicExecutionRequest {
    authorization: ProviderDynamicAuthorizationBinding,
    command_id: String,
    arguments: JsonValue,
}

impl ProviderDynamicExecutionRequest {
    pub fn new(
        authorization: ProviderDynamicAuthorizationBinding,
        command_id: impl Into<String>,
        arguments: JsonValue,
    ) -> Result<Self, AgentPlatformProviderError> {
        let command_id = bounded_identifier(command_id.into())?;
        if !arguments.is_object()
            || serde_json::to_vec(&arguments)
                .map_err(|_| AgentPlatformProviderError::InvalidRequest)?
                .len()
                > MAX_ARGUMENT_BYTES
        {
            return Err(AgentPlatformProviderError::InvalidRequest);
        }
        Ok(Self {
            authorization,
            command_id,
            arguments,
        })
    }

    pub fn authorization(&self) -> &ProviderDynamicAuthorizationBinding {
        &self.authorization
    }

    pub fn command_id(&self) -> &str {
        &self.command_id
    }

    pub fn arguments(&self) -> &JsonValue {
        &self.arguments
    }
}

impl fmt::Debug for ProviderDynamicExecutionRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderDynamicExecutionRequest")
            .field("authorization", &self.authorization)
            .field("command_id", &self.command_id)
            .field("arguments", &"[REDACTED]")
            .finish()
    }
}

/// Exact Provider-owned Artifact result reference. Artifact bytes never cross this model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderDynamicArtifactRef {
    artifact_id: String,
    revision: u64,
    content_digest: ContentDigest,
}

impl ProviderDynamicArtifactRef {
    /// Constructs a bounded exact Provider Artifact reference.
    pub fn new(
        artifact_id: String,
        revision: u64,
        content_digest: ContentDigest,
    ) -> Result<Self, AgentPlatformProviderError> {
        if revision == 0 {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(Self {
            artifact_id: bounded_response_identifier(artifact_id)?,
            revision,
            content_digest,
        })
    }

    pub fn artifact_id(&self) -> &str {
        &self.artifact_id
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn content_digest(&self) -> &ContentDigest {
        &self.content_digest
    }
}

/// Bounded success payload. Images and larger bodies must be returned as an Artifact reference.
#[derive(Clone, PartialEq, Eq)]
pub enum ProviderDynamicResult {
    InlineText(Vec<String>),
    Artifact(ProviderDynamicArtifactRef),
}

impl ProviderDynamicResult {
    /// Constructs a bounded inline text result for adapters and Harness fakes.
    pub fn inline_text(items: Vec<String>) -> Result<Self, AgentPlatformProviderError> {
        if items.len() > MAX_INLINE_ITEMS
            || items
                .iter()
                .any(|item| item.len() > MAX_INLINE_ITEM_BYTES || item.contains('\0'))
            || serde_json::to_vec(&items)
                .map_err(|_| AgentPlatformProviderError::InvalidResponse)?
                .len()
                > MAX_INLINE_RESULT_BYTES
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(Self::InlineText(items))
    }

    pub fn inline_items(&self) -> Option<&[String]> {
        match self {
            Self::InlineText(items) => Some(items),
            Self::Artifact(_) => None,
        }
    }

    pub fn artifact(&self) -> Option<&ProviderDynamicArtifactRef> {
        match self {
            Self::Artifact(artifact) => Some(artifact),
            Self::InlineText(_) => None,
        }
    }
}

impl fmt::Debug for ProviderDynamicResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InlineText(items) => formatter
                .debug_struct("InlineText")
                .field("item_count", &items.len())
                .field("items", &"[REDACTED]")
                .finish(),
            Self::Artifact(artifact) => formatter.debug_tuple("Artifact").field(artifact).finish(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum DynamicResultWire {
    InlineText {
        items: Vec<String>,
    },
    Artifact {
        artifact_id: String,
        revision: u64,
        content_digest: String,
    },
}

impl DynamicResultWire {
    pub(crate) fn digest(&self) -> Result<ContentDigest, AgentPlatformProviderError> {
        ContentDigest::new(format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::to_vec(self)
                    .map_err(|_| AgentPlatformProviderError::InvalidResponse)?
            )
        ))
        .map_err(|_| AgentPlatformProviderError::InvalidResponse)
    }

    pub(crate) fn into_domain(self) -> Result<ProviderDynamicResult, AgentPlatformProviderError> {
        match self {
            Self::InlineText { items } => ProviderDynamicResult::inline_text(items),
            Self::Artifact {
                artifact_id,
                revision,
                content_digest,
            } => Ok(ProviderDynamicResult::Artifact(
                ProviderDynamicArtifactRef::new(
                    artifact_id,
                    revision,
                    ContentDigest::new(content_digest)
                        .map_err(|_| AgentPlatformProviderError::InvalidResponse)?,
                )?,
            )),
        }
    }
}

impl From<&ProviderDynamicResult> for DynamicResultWire {
    fn from(result: &ProviderDynamicResult) -> Self {
        match result {
            ProviderDynamicResult::InlineText(items) => Self::InlineText {
                items: items.clone(),
            },
            ProviderDynamicResult::Artifact(artifact) => Self::Artifact {
                artifact_id: artifact.artifact_id().to_string(),
                revision: artifact.revision(),
                content_digest: artifact.content_digest().as_str().to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderDynamicExecutionSuccess {
    result_digest: ContentDigest,
    result: ProviderDynamicResult,
}

impl ProviderDynamicExecutionSuccess {
    /// Constructs a bounded success and derives its digest from the exact wire representation.
    pub fn new(result: ProviderDynamicResult) -> Result<Self, AgentPlatformProviderError> {
        let result_digest = DynamicResultWire::from(&result).digest()?;
        Ok(Self {
            result_digest,
            result,
        })
    }

    pub fn result_digest(&self) -> &ContentDigest {
        &self.result_digest
    }

    pub fn result(&self) -> &ProviderDynamicResult {
        &self.result
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderDynamicExecutionFailure {
    Rejected,
    ExecutionFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderDynamicExecutionUnknown {
    Timeout,
    ProviderUnavailable,
    UnknownOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderDynamicExecutionOutcome {
    Succeeded(ProviderDynamicExecutionSuccess),
    Failed(ProviderDynamicExecutionFailure),
    Unknown(ProviderDynamicExecutionUnknown),
}

pub(crate) fn operation_for_resource(
    kind: ResourceKind,
) -> Result<crate::DynamicAuthorizationOperation, AgentPlatformProviderError> {
    match kind {
        ResourceKind::McpTool => Ok(crate::DynamicAuthorizationOperation::Call),
        ResourceKind::KnowledgeBase => Ok(crate::DynamicAuthorizationOperation::Search),
        ResourceKind::Agent
        | ResourceKind::Skill
        | ResourceKind::McpServer
        | ResourceKind::Workflow => Err(AgentPlatformProviderError::Incompatible),
    }
}

fn bounded_identifier(value: String) -> Result<String, AgentPlatformProviderError> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES || value.chars().any(char::is_control)
    {
        return Err(AgentPlatformProviderError::InvalidRequest);
    }
    Ok(value)
}

fn bounded_response_identifier(value: String) -> Result<String, AgentPlatformProviderError> {
    bounded_identifier(value).map_err(|_| AgentPlatformProviderError::InvalidResponse)
}

#[cfg(test)]
#[path = "dynamic_execution_model_tests.rs"]
mod tests;
