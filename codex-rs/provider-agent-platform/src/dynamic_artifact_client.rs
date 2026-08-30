use std::future::Future;

use crewon_resource_federation::ResourceKind;

use crate::AgentPlatformCapability;
use crate::AgentPlatformProviderClient;
use crate::AgentPlatformProviderError;
use crate::DynamicAuthorizationOperation;
use crate::ProviderAuthorizationError;
use crate::ProviderAuthorizationRequest;
use crate::ProviderAuthorizer;
use crate::ProviderDynamicArtifactContent;
use crate::ProviderDynamicArtifactReadRequest;
use crate::dynamic_artifact_wire::ReadDynamicArtifactCommandWire;
use crate::dynamic_artifact_wire::validate_dynamic_artifact_response;

/// Reads one exact Provider-owned dynamic Artifact without semantic execution retries.
pub trait ProviderDynamicArtifactClient {
    fn read_dynamic_artifact(
        &self,
        request: ProviderDynamicArtifactReadRequest,
    ) -> impl Future<Output = Result<ProviderDynamicArtifactContent, AgentPlatformProviderError>> + Send;
}

impl<Authorizer> ProviderDynamicArtifactClient for AgentPlatformProviderClient<Authorizer>
where
    Authorizer: ProviderAuthorizer,
{
    async fn read_dynamic_artifact(
        &self,
        request: ProviderDynamicArtifactReadRequest,
    ) -> Result<ProviderDynamicArtifactContent, AgentPlatformProviderError> {
        let kind = request.authorization().resource().kind;
        let (capability, operation) = match kind {
            ResourceKind::McpTool => (
                AgentPlatformCapability::RemoteTool,
                DynamicAuthorizationOperation::Call,
            ),
            ResourceKind::KnowledgeBase => (
                AgentPlatformCapability::RemoteKnowledge,
                DynamicAuthorizationOperation::Search,
            ),
            ResourceKind::Agent
            | ResourceKind::Skill
            | ResourceKind::McpServer
            | ResourceKind::Workflow => return Err(AgentPlatformProviderError::Incompatible),
        };
        if !self.descriptor.supports(capability) {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        let authorization = self
            .authorizer
            .authorize(ProviderAuthorizationRequest::Dynamic {
                operation,
                binding: request.authorization().clone(),
            })
            .await
            .map_err(map_authorization)?;
        let response = self
            .http
            .post_raw(
                "./dynamicArtifacts:read",
                authorization,
                &ReadDynamicArtifactCommandWire::from_domain(&request),
            )
            .await?;
        validate_dynamic_artifact_response(&response.headers, response.body, request.artifact())
    }
}

fn map_authorization(error: ProviderAuthorizationError) -> AgentPlatformProviderError {
    match error {
        ProviderAuthorizationError::Unavailable => AgentPlatformProviderError::Unavailable,
        ProviderAuthorizationError::Unauthorized => AgentPlatformProviderError::Unauthorized,
    }
}

#[cfg(test)]
#[path = "dynamic_artifact_client_tests.rs"]
mod tests;
