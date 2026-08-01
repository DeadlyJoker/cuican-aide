use std::fmt;

use crate::AgentPlatformProviderError;
use crate::ProviderDynamicArtifactRef;
use crate::ProviderDynamicAuthorizationBinding;

const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_ARTIFACT_BYTES: usize = 64 * 1024;

/// Exact request used to import one Provider-owned dynamic result Artifact.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderDynamicArtifactReadRequest {
    authorization: ProviderDynamicAuthorizationBinding,
    command_id: String,
    artifact: ProviderDynamicArtifactRef,
}

impl ProviderDynamicArtifactReadRequest {
    pub fn new(
        authorization: ProviderDynamicAuthorizationBinding,
        command_id: impl Into<String>,
        artifact: ProviderDynamicArtifactRef,
    ) -> Result<Self, AgentPlatformProviderError> {
        let command_id = command_id.into();
        if command_id.is_empty()
            || command_id.len() > MAX_IDENTIFIER_BYTES
            || command_id.chars().any(char::is_control)
        {
            return Err(AgentPlatformProviderError::InvalidRequest);
        }
        Ok(Self {
            authorization,
            command_id,
            artifact,
        })
    }

    pub fn authorization(&self) -> &ProviderDynamicAuthorizationBinding {
        &self.authorization
    }

    pub fn command_id(&self) -> &str {
        &self.command_id
    }

    pub fn artifact(&self) -> &ProviderDynamicArtifactRef {
        &self.artifact
    }
}

impl fmt::Debug for ProviderDynamicArtifactReadRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderDynamicArtifactReadRequest")
            .field("authorization", &self.authorization)
            .field("command_id", &self.command_id)
            .field("artifact", &self.artifact)
            .finish()
    }
}

/// Validated Provider Artifact bytes and safe response metadata.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderDynamicArtifactContent {
    bytes: Vec<u8>,
    media_type: String,
    workspace_sensitive: bool,
}

impl ProviderDynamicArtifactContent {
    pub fn new(
        bytes: Vec<u8>,
        media_type: String,
        workspace_sensitive: bool,
    ) -> Result<Self, AgentPlatformProviderError> {
        if bytes.is_empty()
            || bytes.len() > MAX_ARTIFACT_BYTES
            || std::str::from_utf8(&bytes).is_err()
            || !matches!(
                media_type.as_str(),
                "application/json" | "text/markdown" | "text/plain"
            )
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(Self {
            bytes,
            media_type,
            workspace_sensitive,
        })
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn media_type(&self) -> &str {
        &self.media_type
    }

    pub fn workspace_sensitive(&self) -> bool {
        self.workspace_sensitive
    }
}

impl fmt::Debug for ProviderDynamicArtifactContent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderDynamicArtifactContent")
            .field("byte_len", &self.bytes.len())
            .field("media_type", &self.media_type)
            .field("workspace_sensitive", &self.workspace_sensitive)
            .field("bytes", &"[REDACTED]")
            .finish()
    }
}
