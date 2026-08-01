use std::fmt;

use crewon_resource_federation::ContentDigest;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use serde_json::Value as JsonValue;
use sha2::Digest;
use sha2::Sha256;

use crate::AgentPlatformProviderError;

const MAX_DESCRIPTION_CHARS: usize = 2_000;
const MAX_INPUT_SCHEMA_BYTES: usize = 16 * 1024;
const MAX_MANIFEST_BYTES: usize = 32 * 1024;

/// Closed operation exposed by a Provider-managed dynamic resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderDynamicOperation {
    Call,
    Search,
}

/// Server-owned side-effect classification frozen in a dynamic resource revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderDynamicSideEffect {
    ReadOnly,
    LocalMutation,
    ExternalWrite,
    Send,
    Publish,
    Delete,
    Destructive,
}

/// Bounded execution contract for one exact Provider Tool or Knowledge revision.
#[derive(Clone, PartialEq)]
pub struct AgentPlatformDynamicResourceManifest {
    resource: ResourceRef,
    content_digest: ContentDigest,
    operation: ProviderDynamicOperation,
    side_effect: ProviderDynamicSideEffect,
    schema_digest: ContentDigest,
    description: String,
    input_schema: JsonValue,
}

impl AgentPlatformDynamicResourceManifest {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        resource: ResourceRef,
        content_digest: ContentDigest,
        operation: ProviderDynamicOperation,
        side_effect: ProviderDynamicSideEffect,
        schema_digest: ContentDigest,
        description: String,
        input_schema: JsonValue,
    ) -> Result<Self, AgentPlatformProviderError> {
        if !matches!(
            resource.kind,
            ResourceKind::McpTool | ResourceKind::KnowledgeBase
        ) || matches!(resource.kind, ResourceKind::McpTool)
            != matches!(operation, ProviderDynamicOperation::Call)
            || resource.kind == ResourceKind::KnowledgeBase
                && side_effect != ProviderDynamicSideEffect::ReadOnly
            || description.is_empty()
            || description.chars().count() > MAX_DESCRIPTION_CHARS
            || description.chars().any(char::is_control)
            || !input_schema.is_object()
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        let schema_bytes = serde_json::to_vec(&input_schema)
            .map_err(|_| AgentPlatformProviderError::InvalidResponse)?;
        let actual_schema_digest = format!("sha256:{:x}", Sha256::digest(&schema_bytes));
        if schema_bytes.len() > MAX_INPUT_SCHEMA_BYTES
            || schema_digest.as_str() != actual_schema_digest
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        let manifest = Self {
            resource,
            content_digest,
            operation,
            side_effect,
            schema_digest,
            description,
            input_schema,
        };
        if serde_json::to_vec(&manifest.size_view())
            .map_err(|_| AgentPlatformProviderError::InvalidResponse)?
            .len()
            > MAX_MANIFEST_BYTES
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        Ok(manifest)
    }

    pub fn resource(&self) -> &ResourceRef {
        &self.resource
    }

    pub fn content_digest(&self) -> &ContentDigest {
        &self.content_digest
    }

    pub fn operation(&self) -> ProviderDynamicOperation {
        self.operation
    }

    pub fn side_effect(&self) -> ProviderDynamicSideEffect {
        self.side_effect
    }

    pub fn schema_digest(&self) -> &ContentDigest {
        &self.schema_digest
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn input_schema(&self) -> &JsonValue {
        &self.input_schema
    }

    fn size_view(
        &self,
    ) -> (
        &ResourceRef,
        &ContentDigest,
        &ContentDigest,
        &str,
        &JsonValue,
    ) {
        (
            &self.resource,
            &self.content_digest,
            &self.schema_digest,
            &self.description,
            &self.input_schema,
        )
    }
}

impl fmt::Debug for AgentPlatformDynamicResourceManifest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentPlatformDynamicResourceManifest")
            .field("resource", &self.resource)
            .field("content_digest", &self.content_digest)
            .field("operation", &self.operation)
            .field("side_effect", &self.side_effect)
            .field("schema_digest", &self.schema_digest)
            .field("description", &"[REDACTED]")
            .field("input_schema", &"[REDACTED]")
            .finish()
    }
}
