use crewon_resource_federation::ContentDigest;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceKind;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;

use crate::AgentPlatformDynamicResourceManifest;
use crate::AgentPlatformProviderError;
use crate::ProviderDynamicOperation;
use crate::ProviderDynamicSideEffect;
use crate::wire::ResourceRefWire;

const MANIFEST_SCHEMA_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ReadDynamicResourceCommandType {
    ReadDynamicResource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadDynamicResourceCommand {
    #[serde(rename = "type")]
    command_type: ReadDynamicResourceCommandType,
    command_id: String,
    resource: ResourceRefWire,
}

impl ReadDynamicResourceCommand {
    pub(crate) fn new(command_id: String, resource: ResourceRefWire) -> Self {
        Self {
            command_type: ReadDynamicResourceCommandType::ReadDynamicResource,
            command_id,
            resource,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum DynamicOperationWire {
    Call,
    Search,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum DynamicSideEffectWire {
    ReadOnly,
    LocalMutation,
    ExternalWrite,
    Send,
    Publish,
    Delete,
    Destructive,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DynamicResourceManifestWire {
    resource: ResourceRefWire,
    manifest_schema_version: String,
    content_digest: String,
    operation: DynamicOperationWire,
    side_effect: DynamicSideEffectWire,
    schema_digest: String,
    description: String,
    input_schema: JsonValue,
}

impl DynamicResourceManifestWire {
    pub(crate) fn into_domain(
        self,
        provider: &ProviderRef,
    ) -> Result<AgentPlatformDynamicResourceManifest, AgentPlatformProviderError> {
        if self.manifest_schema_version != MANIFEST_SCHEMA_VERSION {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        let resource = self.resource.into_domain(provider)?;
        let operation = match self.operation {
            DynamicOperationWire::Call => ProviderDynamicOperation::Call,
            DynamicOperationWire::Search => ProviderDynamicOperation::Search,
        };
        if matches!(resource.kind, ResourceKind::McpTool)
            != matches!(operation, ProviderDynamicOperation::Call)
        {
            return Err(AgentPlatformProviderError::InvalidResponse);
        }
        AgentPlatformDynamicResourceManifest::new(
            resource,
            ContentDigest::new(self.content_digest)
                .map_err(|_| AgentPlatformProviderError::InvalidResponse)?,
            operation,
            match self.side_effect {
                DynamicSideEffectWire::ReadOnly => ProviderDynamicSideEffect::ReadOnly,
                DynamicSideEffectWire::LocalMutation => ProviderDynamicSideEffect::LocalMutation,
                DynamicSideEffectWire::ExternalWrite => ProviderDynamicSideEffect::ExternalWrite,
                DynamicSideEffectWire::Send => ProviderDynamicSideEffect::Send,
                DynamicSideEffectWire::Publish => ProviderDynamicSideEffect::Publish,
                DynamicSideEffectWire::Delete => ProviderDynamicSideEffect::Delete,
                DynamicSideEffectWire::Destructive => ProviderDynamicSideEffect::Destructive,
            },
            ContentDigest::new(self.schema_digest)
                .map_err(|_| AgentPlatformProviderError::InvalidResponse)?,
            self.description,
            self.input_schema,
        )
    }
}

#[cfg(test)]
#[path = "dynamic_manifest_wire_tests.rs"]
mod tests;
