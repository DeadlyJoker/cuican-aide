use std::fmt;
use std::future::Future;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use crewon_app_server_protocol::DynamicToolCallOutputContentItem;
use crewon_app_server_protocol::DynamicToolCallResponse;
use crewon_artifact::ArtifactRef;
use serde_json::Value as JsonValue;
use sha2::Digest;
use sha2::Sha256;

use super::execution::DynamicToolAuthorizedCall;
use super::execution::DynamicToolDispatchParts;
use super::ports::*;
use super::registration::DynamicToolExecutionTarget;
use super::registration::DynamicToolOperation;

const MAX_INLINE_RESULT_ITEMS: usize = 16;
const MAX_INLINE_RESULT_BYTES: usize = 32 * 1024;
const MAX_INLINE_ITEM_BYTES: usize = 16 * 1024;
const MAX_DISPATCH_TIMEOUT: Duration = Duration::from_secs(60);
const SAFE_IMAGE_PREFIXES: [&str; 4] = [
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
    "data:image/webp;base64,",
    "data:image/gif;base64,",
];

enum DynamicToolResultPayload {
    Inline(DynamicToolCallResponse),
    Artifact(ArtifactRef),
}

pub(crate) struct BoundedDynamicToolResult {
    payload: DynamicToolResultPayload,
    metadata: DynamicToolExecutionResultMetadata,
}

impl BoundedDynamicToolResult {
    pub(crate) fn inline(
        content_items: Vec<DynamicToolCallOutputContentItem>,
    ) -> Result<Self, DynamicToolResultValidationError> {
        if content_items.len() > MAX_INLINE_RESULT_ITEMS {
            return Err(DynamicToolResultValidationError::TooManyItems);
        }
        for item in &content_items {
            match item {
                DynamicToolCallOutputContentItem::InputText { text } => {
                    if text.len() > MAX_INLINE_ITEM_BYTES {
                        return Err(DynamicToolResultValidationError::ItemTooLarge);
                    }
                }
                DynamicToolCallOutputContentItem::InputImage { image_url } => {
                    validate_inline_image(image_url)?;
                }
            }
        }
        let response = DynamicToolCallResponse {
            content_items,
            success: true,
        };
        let encoded = serde_json::to_vec(&response)
            .map_err(|_| DynamicToolResultValidationError::Serialization)?;
        if encoded.len() > MAX_INLINE_RESULT_BYTES {
            return Err(DynamicToolResultValidationError::ResponseTooLarge);
        }
        let metadata = DynamicToolExecutionResultMetadata::Inline {
            item_count: response.content_items.len() as u16,
            byte_len: encoded.len() as u32,
            sha256: format!("sha256:{:x}", Sha256::digest(&encoded)),
        };
        Ok(Self {
            payload: DynamicToolResultPayload::Inline(response),
            metadata,
        })
    }

    pub(crate) fn artifact(artifact: ArtifactRef) -> Self {
        let metadata = DynamicToolExecutionResultMetadata::Artifact {
            artifact_id: artifact.artifact_id().as_str().to_string(),
            revision: artifact.revision().get(),
        };
        Self {
            payload: DynamicToolResultPayload::Artifact(artifact),
            metadata,
        }
    }

    pub(crate) fn inline_response(&self) -> Option<&DynamicToolCallResponse> {
        match &self.payload {
            DynamicToolResultPayload::Inline(response) => Some(response),
            DynamicToolResultPayload::Artifact(_) => None,
        }
    }

    pub(crate) fn artifact_ref(&self) -> Option<&ArtifactRef> {
        match &self.payload {
            DynamicToolResultPayload::Artifact(artifact) => Some(artifact),
            DynamicToolResultPayload::Inline(_) => None,
        }
    }

    fn metadata(&self) -> DynamicToolExecutionResultMetadata {
        self.metadata.clone()
    }
}

impl fmt::Debug for BoundedDynamicToolResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BoundedDynamicToolResult")
            .field("metadata", &self.metadata)
            .field("payload", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum DynamicToolResultValidationError {
    #[error("dynamic tool result contains too many items")]
    TooManyItems,
    #[error("dynamic tool result item requires an Artifact")]
    ItemTooLarge,
    #[error("dynamic tool result requires an Artifact")]
    ResponseTooLarge,
    #[error("dynamic tool image requires a server-owned Artifact")]
    UnsafeImageReference,
    #[error("dynamic tool inline image data is invalid")]
    InvalidImageData,
    #[error("dynamic tool result could not be serialized")]
    Serialization,
}

pub(crate) enum DynamicToolAdapterOutcome {
    Succeeded(BoundedDynamicToolResult),
    Failed(DynamicToolExecutionFailure),
    Unknown(DynamicToolExecutionUnknown),
}

impl fmt::Debug for DynamicToolAdapterOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Succeeded(result) => formatter.debug_tuple("Succeeded").field(result).finish(),
            Self::Failed(reason) => formatter.debug_tuple("Failed").field(reason).finish(),
            Self::Unknown(reason) => formatter.debug_tuple("Unknown").field(reason).finish(),
        }
    }
}

struct DynamicToolExecutionContext {
    claim: DynamicToolExecutionClaimRequest,
    credential: DynamicToolCredentialSnapshot,
    operation: DynamicToolOperation,
    arguments: JsonValue,
}

impl DynamicToolExecutionContext {
    fn claim(&self) -> &DynamicToolExecutionClaimRequest {
        &self.claim
    }

    fn credential(&self) -> &DynamicToolCredentialSnapshot {
        &self.credential
    }

    fn operation(&self) -> DynamicToolOperation {
        self.operation
    }
}

impl fmt::Debug for DynamicToolExecutionContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DynamicToolExecutionContext")
            .field("claim", &self.claim)
            .field("credential", &"[REDACTED]")
            .field("operation", &self.operation)
            .field("arguments", &"[REDACTED]")
            .finish()
    }
}

pub(crate) struct ProviderDynamicToolExecutionRequest {
    context: DynamicToolExecutionContext,
    connection_id: String,
    resource_id: String,
}

impl ProviderDynamicToolExecutionRequest {
    pub(super) fn new(
        claim: DynamicToolExecutionClaimRequest,
        credential: DynamicToolCredentialSnapshot,
        operation: DynamicToolOperation,
        arguments: JsonValue,
        connection_id: String,
        resource_id: String,
    ) -> Self {
        Self {
            context: DynamicToolExecutionContext {
                claim,
                credential,
                operation,
                arguments,
            },
            connection_id,
            resource_id,
        }
    }

    pub(crate) fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub(crate) fn resource_id(&self) -> &str {
        &self.resource_id
    }

    pub(crate) fn arguments(&self) -> &JsonValue {
        &self.context.arguments
    }

    pub(crate) fn claim(&self) -> &DynamicToolExecutionClaimRequest {
        self.context.claim()
    }

    pub(crate) fn credential(&self) -> &DynamicToolCredentialSnapshot {
        self.context.credential()
    }

    pub(crate) fn operation(&self) -> DynamicToolOperation {
        self.context.operation()
    }
}

impl fmt::Debug for ProviderDynamicToolExecutionRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderDynamicToolExecutionRequest")
            .field("context", &self.context)
            .field("target", &"[REDACTED]")
            .finish()
    }
}

/// Executes exactly one pinned Provider Tool or Knowledge target.
///
/// Implementations must use the exact claim and Credential snapshot to mint short-lived Provider
/// authority. Old catalog APIs, user tokens, latest revisions, and alternate locations are invalid.
pub(crate) trait ProviderDynamicToolExecutor: Send + Sync {
    fn execute(
        &self,
        request: ProviderDynamicToolExecutionRequest,
    ) -> impl Future<Output = DynamicToolAdapterOutcome> + Send;
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct DynamicToolDispatchConfig {
    timeout: Duration,
}

impl DynamicToolDispatchConfig {
    pub(crate) fn new(timeout: Duration) -> Result<Self, DynamicToolDispatchError> {
        if timeout.is_zero() || timeout > MAX_DISPATCH_TIMEOUT {
            return Err(DynamicToolDispatchError::InvalidTimeout);
        }
        Ok(Self { timeout })
    }
}

pub(crate) struct DynamicToolDispatcher<'a, Provider, Journal> {
    provider: &'a Provider,
    journal: &'a Journal,
    config: DynamicToolDispatchConfig,
}

impl<'a, Provider, Journal> DynamicToolDispatcher<'a, Provider, Journal>
where
    Provider: ProviderDynamicToolExecutor,
    Journal: DynamicToolExecutionJournal,
{
    pub(crate) fn new(
        provider: &'a Provider,
        journal: &'a Journal,
        config: DynamicToolDispatchConfig,
    ) -> Self {
        Self {
            provider,
            journal,
            config,
        }
    }

    pub(crate) async fn dispatch(
        &self,
        authorized: DynamicToolAuthorizedCall,
    ) -> Result<DynamicToolDispatchOutcome, DynamicToolDispatchError> {
        let DynamicToolDispatchParts {
            claim,
            target,
            operation,
            arguments,
            credential,
        } = authorized.into_dispatch_parts();
        let claim_snapshot = claim.request().clone();
        let adapter_outcome = match target {
            DynamicToolExecutionTarget::Provider {
                connection_id,
                resource_id,
            } => {
                await_adapter(
                    self.provider
                        .execute(ProviderDynamicToolExecutionRequest::new(
                            claim_snapshot,
                            credential,
                            operation,
                            arguments,
                            connection_id,
                            resource_id,
                        )),
                    self.config.timeout,
                )
                .await
            }
        };
        let (completion, outcome) = match adapter_outcome {
            DynamicToolAdapterOutcome::Succeeded(result) => (
                DynamicToolExecutionCompletion::succeeded(claim, result.metadata()),
                DynamicToolDispatchOutcome::Succeeded(result),
            ),
            DynamicToolAdapterOutcome::Failed(reason) => (
                DynamicToolExecutionCompletion::failed(claim, reason),
                DynamicToolDispatchOutcome::Failed(reason),
            ),
            DynamicToolAdapterOutcome::Unknown(reason) => (
                DynamicToolExecutionCompletion::unknown(claim, reason),
                DynamicToolDispatchOutcome::Unknown(reason),
            ),
        };
        match self.journal.complete(completion).await {
            Ok(DynamicToolExecutionCompletionOutcome::Completed) => Ok(outcome),
            Ok(DynamicToolExecutionCompletionOutcome::Conflict) | Err(_) => {
                Err(DynamicToolDispatchError::UnknownOutcome)
            }
        }
    }
}

async fn await_adapter(
    future: impl Future<Output = DynamicToolAdapterOutcome>,
    timeout: Duration,
) -> DynamicToolAdapterOutcome {
    tokio::time::timeout(timeout, future)
        .await
        .unwrap_or(DynamicToolAdapterOutcome::Unknown(
            DynamicToolExecutionUnknown::Timeout,
        ))
}

#[derive(Debug)]
pub(crate) enum DynamicToolDispatchOutcome {
    Succeeded(BoundedDynamicToolResult),
    Failed(DynamicToolExecutionFailure),
    Unknown(DynamicToolExecutionUnknown),
}

impl DynamicToolDispatchOutcome {
    pub(crate) fn terminal_status(&self) -> DynamicToolExecutionTerminal {
        match self {
            Self::Succeeded(result) => DynamicToolExecutionTerminal::Succeeded(result.metadata()),
            Self::Failed(reason) => DynamicToolExecutionTerminal::Failed(*reason),
            Self::Unknown(reason) => DynamicToolExecutionTerminal::Unknown(*reason),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum DynamicToolDispatchError {
    #[error("dynamic tool timeout is outside the server limit")]
    InvalidTimeout,
    #[error("dynamic tool outcome is unknown because completion is not durable")]
    UnknownOutcome,
}

fn validate_inline_image(image_url: &str) -> Result<(), DynamicToolResultValidationError> {
    if image_url.len() > MAX_INLINE_ITEM_BYTES {
        return Err(DynamicToolResultValidationError::ItemTooLarge);
    }
    let Some(prefix) = SAFE_IMAGE_PREFIXES
        .iter()
        .find(|prefix| image_url.starts_with(*prefix))
    else {
        return Err(DynamicToolResultValidationError::UnsafeImageReference);
    };
    let encoded = &image_url[prefix.len()..];
    let Ok(decoded) = STANDARD.decode(encoded) else {
        return Err(DynamicToolResultValidationError::InvalidImageData);
    };
    let valid_signature = match *prefix {
        "data:image/png;base64," => decoded.starts_with(b"\x89PNG\r\n\x1a\n"),
        "data:image/jpeg;base64," => decoded.starts_with(&[0xff, 0xd8, 0xff]),
        "data:image/gif;base64," => {
            decoded.starts_with(b"GIF87a") || decoded.starts_with(b"GIF89a")
        }
        "data:image/webp;base64," => {
            decoded.starts_with(b"RIFF") && decoded.get(8..12) == Some(b"WEBP")
        }
        _ => false,
    };
    if !valid_signature {
        return Err(DynamicToolResultValidationError::InvalidImageData);
    }
    Ok(())
}
