use std::fmt;
use std::future::Future;

use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;

use crate::AgentPlatformProviderClient;
use crate::AgentPlatformProviderError;
use crate::ProviderArtifactKind;
use crate::ProviderArtifactRef;
use crate::ProviderArtifactRetention;
use crate::ProviderAuthorizer;
use crate::ProviderRunAuthorizationBinding;
use crate::RunAuthorizationOperation;
use crate::run_artifact_wire::ImportArtifactResponseWire;
use crate::run_artifact_wire::import_headers;
use crate::run_artifact_wire::import_path;
use crate::run_artifact_wire::validate_read_response;
use crate::run_model::bounded_identifier;
use crate::run_wire::ArtifactRefWire;

pub(crate) const MAX_ARTIFACT_BYTES: usize = 64 * 1024;
const MAX_ARTIFACT_LIFETIME_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS: i64 = 30;

/// Text media types accepted by the durable Provider Artifact boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum ProviderArtifactMediaType {
    #[serde(rename = "application/json")]
    ApplicationJson,
    #[serde(rename = "text/markdown")]
    TextMarkdown,
    #[serde(rename = "text/plain")]
    TextPlain,
}

impl ProviderArtifactMediaType {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::ApplicationJson => "application/json",
            Self::TextMarkdown => "text/markdown",
            Self::TextPlain => "text/plain",
        }
    }
}

/// Sensitivity metadata returned by the durable Provider Artifact boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderArtifactSensitivity {
    Public,
    Internal,
    WorkspaceSensitive,
}

impl ProviderArtifactSensitivity {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Internal => "internal",
            Self::WorkspaceSensitive => "workspaceSensitive",
        }
    }
}

/// Exact bounded context Artifact upload prepared before one durable Run start.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderRunArtifactImportInput {
    pub media_type: ProviderArtifactMediaType,
    pub sensitivity: ProviderArtifactSensitivity,
    pub content: Vec<u8>,
    pub idempotency_key: String,
    pub now: i64,
    pub expires_at: i64,
}

impl fmt::Debug for ProviderRunArtifactImportInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRunArtifactImportInput")
            .field("media_type", &self.media_type)
            .field("sensitivity", &self.sensitivity)
            .field("byte_length", &self.content.len())
            .field("idempotency_key", &self.idempotency_key)
            .field("now", &self.now)
            .field("expires_at", &self.expires_at)
            .field("content", &"[REDACTED]")
            .finish()
    }
}

/// Validated request that binds one import input to exact Run authority and Artifact identity.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderRunArtifactImportRequest {
    authorization: ProviderRunAuthorizationBinding,
    artifact: ProviderArtifactRef,
    media_type: ProviderArtifactMediaType,
    sensitivity: ProviderArtifactSensitivity,
    content: Vec<u8>,
    content_digest: String,
    idempotency_key: String,
    expires_at: i64,
}

impl ProviderRunArtifactImportRequest {
    pub fn new(
        authorization: ProviderRunAuthorizationBinding,
        artifact: ProviderArtifactRef,
        input: ProviderRunArtifactImportInput,
    ) -> Result<Self, AgentPlatformProviderError> {
        let ProviderRunArtifactImportInput {
            media_type,
            sensitivity,
            content,
            idempotency_key,
            now,
            expires_at,
        } = input;
        let valid_created_at = now
            .checked_add(MAX_CLOCK_SKEW_SECONDS)
            .is_some_and(|latest| artifact.created_at() <= latest);
        let valid_expires_at = now
            .checked_add(MAX_ARTIFACT_LIFETIME_SECONDS)
            .is_some_and(|latest| expires_at <= latest);
        if artifact.task_id() != authorization.task_id()
            || !matches!(
                artifact.kind(),
                ProviderArtifactKind::File
                    | ProviderArtifactKind::Report
                    | ProviderArtifactKind::Evidence
                    | ProviderArtifactKind::ToolResult
            )
            || !matches!(
                artifact.retention(),
                ProviderArtifactRetention::Session | ProviderArtifactRetention::Task
            )
            || !matches!(
                media_type,
                ProviderArtifactMediaType::TextMarkdown | ProviderArtifactMediaType::TextPlain
            )
            || content.len() > MAX_ARTIFACT_BYTES
            || std::str::from_utf8(&content).is_err()
            || now < 0
            || !valid_created_at
            || expires_at <= now
            || expires_at <= artifact.created_at()
            || !valid_expires_at
        {
            return Err(AgentPlatformProviderError::InvalidRequest);
        }
        Ok(Self {
            authorization,
            artifact,
            media_type,
            sensitivity,
            content_digest: digest(&content),
            content,
            idempotency_key: bounded_identifier(idempotency_key)?,
            expires_at,
        })
    }

    pub fn authorization(&self) -> &ProviderRunAuthorizationBinding {
        &self.authorization
    }

    pub fn artifact(&self) -> &ProviderArtifactRef {
        &self.artifact
    }

    pub fn media_type(&self) -> ProviderArtifactMediaType {
        self.media_type
    }

    pub fn sensitivity(&self) -> ProviderArtifactSensitivity {
        self.sensitivity
    }

    pub fn content(&self) -> &[u8] {
        &self.content
    }

    pub fn content_digest(&self) -> &str {
        &self.content_digest
    }

    pub fn idempotency_key(&self) -> &str {
        &self.idempotency_key
    }

    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

impl fmt::Debug for ProviderRunArtifactImportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRunArtifactImportRequest")
            .field("authorization", &self.authorization)
            .field("artifact", &self.artifact)
            .field("media_type", &self.media_type)
            .field("sensitivity", &self.sensitivity)
            .field("content_digest", &self.content_digest)
            .field("byte_length", &self.content.len())
            .field("idempotency_key", &self.idempotency_key)
            .field("expires_at", &self.expires_at)
            .field("content", &"[REDACTED]")
            .finish()
    }
}

/// Exact result of one idempotent Provider context Artifact import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunArtifactImportResult {
    artifact: ProviderArtifactRef,
    media_type: ProviderArtifactMediaType,
    sensitivity: ProviderArtifactSensitivity,
    content_digest: String,
    byte_length: usize,
    created: bool,
}

impl ProviderRunArtifactImportResult {
    pub(crate) fn from_response(
        artifact: ProviderArtifactRef,
        media_type: ProviderArtifactMediaType,
        sensitivity: ProviderArtifactSensitivity,
        content_digest: String,
        byte_length: usize,
        created: bool,
    ) -> Self {
        Self {
            artifact,
            media_type,
            sensitivity,
            content_digest,
            byte_length,
            created,
        }
    }

    pub fn artifact(&self) -> &ProviderArtifactRef {
        &self.artifact
    }

    pub fn media_type(&self) -> ProviderArtifactMediaType {
        self.media_type
    }

    pub fn sensitivity(&self) -> ProviderArtifactSensitivity {
        self.sensitivity
    }

    pub fn content_digest(&self) -> &str {
        &self.content_digest
    }

    pub fn byte_length(&self) -> usize {
        self.byte_length
    }

    pub fn created(&self) -> bool {
        self.created
    }
}

/// Exact output Artifact reference requested from the Provider task scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunArtifactReadRequest {
    authorization: ProviderRunAuthorizationBinding,
    artifact: ProviderArtifactRef,
}

impl ProviderRunArtifactReadRequest {
    pub fn new(
        authorization: ProviderRunAuthorizationBinding,
        artifact: ProviderArtifactRef,
    ) -> Result<Self, AgentPlatformProviderError> {
        if artifact.task_id() != authorization.task_id() {
            return Err(AgentPlatformProviderError::InvalidRequest);
        }
        Ok(Self {
            authorization,
            artifact,
        })
    }

    pub fn authorization(&self) -> &ProviderRunAuthorizationBinding {
        &self.authorization
    }

    pub fn artifact(&self) -> &ProviderArtifactRef {
        &self.artifact
    }
}

/// Verified bounded Provider Artifact bytes. Debug never exposes the body.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderRunArtifactContent {
    authorization: ProviderRunAuthorizationBinding,
    artifact: ProviderArtifactRef,
    media_type: ProviderArtifactMediaType,
    sensitivity: ProviderArtifactSensitivity,
    content_digest: String,
    bytes: Vec<u8>,
}

impl ProviderRunArtifactContent {
    /// Constructs bounded Artifact bytes after revalidating the exact digest and text encoding.
    pub fn new(
        authorization: ProviderRunAuthorizationBinding,
        artifact: ProviderArtifactRef,
        media_type: ProviderArtifactMediaType,
        sensitivity: ProviderArtifactSensitivity,
        content_digest: impl Into<String>,
        bytes: Vec<u8>,
    ) -> Result<Self, AgentPlatformProviderError> {
        let content_digest = content_digest.into();
        if artifact.task_id() != authorization.task_id()
            || bytes.len() > MAX_ARTIFACT_BYTES
            || std::str::from_utf8(&bytes).is_err()
            || content_digest != digest(&bytes)
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(Self {
            authorization,
            artifact,
            media_type,
            sensitivity,
            content_digest,
            bytes,
        })
    }

    pub fn authorization(&self) -> &ProviderRunAuthorizationBinding {
        &self.authorization
    }

    pub fn artifact(&self) -> &ProviderArtifactRef {
        &self.artifact
    }

    pub fn media_type(&self) -> ProviderArtifactMediaType {
        self.media_type
    }

    pub fn sensitivity(&self) -> ProviderArtifactSensitivity {
        self.sensitivity
    }

    pub fn content_digest(&self) -> &str {
        &self.content_digest
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl fmt::Debug for ProviderRunArtifactContent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRunArtifactContent")
            .field("resource", self.authorization.resource())
            .field("task_id", &self.authorization.task_id())
            .field("artifact", &self.artifact)
            .field("media_type", &self.media_type)
            .field("sensitivity", &self.sensitivity)
            .field("content_digest", &self.content_digest)
            .field("byte_length", &self.bytes.len())
            .field("bytes", &"[REDACTED]")
            .finish()
    }
}

/// Transfers exact durable Run Artifacts without semantic retries.
pub trait ProviderRunArtifactClient {
    fn import_context_artifact(
        &self,
        request: ProviderRunArtifactImportRequest,
    ) -> impl Future<Output = Result<ProviderRunArtifactImportResult, AgentPlatformProviderError>> + Send;

    fn read_artifact(
        &self,
        request: ProviderRunArtifactReadRequest,
    ) -> impl Future<Output = Result<ProviderRunArtifactContent, AgentPlatformProviderError>> + Send;
}

impl<Authorizer> ProviderRunArtifactClient for AgentPlatformProviderClient<Authorizer>
where
    Authorizer: ProviderAuthorizer,
{
    async fn import_context_artifact(
        &self,
        request: ProviderRunArtifactImportRequest,
    ) -> Result<ProviderRunArtifactImportResult, AgentPlatformProviderError> {
        self.require_run_capabilities()?;
        let authorization = self
            .authorize_run(RunAuthorizationOperation::Start, request.authorization())
            .await?;
        let path = import_path(request.artifact());
        let response = self
            .http
            .put_bytes_json::<ImportArtifactResponseWire>(
                &path,
                authorization,
                import_headers(&request)?,
                request.content().to_vec(),
            )
            .await?;
        response.into_domain(&request)
    }

    async fn read_artifact(
        &self,
        request: ProviderRunArtifactReadRequest,
    ) -> Result<ProviderRunArtifactContent, AgentPlatformProviderError> {
        self.require_run_capabilities()?;
        let authorization = self
            .authorize_run(RunAuthorizationOperation::Read, request.authorization())
            .await?;
        let response = self
            .http
            .post_raw(
                "./artifacts:read",
                authorization,
                &ArtifactRefWire::from_domain(request.artifact()),
            )
            .await?;
        validate_read_response(&response.headers, response.body, &request)
    }
}

pub(crate) fn digest(value: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(value))
}
