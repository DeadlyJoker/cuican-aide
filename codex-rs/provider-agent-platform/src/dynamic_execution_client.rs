use std::future::Future;

use crewon_resource_federation::ResourceKind;

use crate::AgentPlatformCapability;
use crate::AgentPlatformProviderClient;
use crate::AgentPlatformProviderError;
use crate::ProviderAuthorizationError;
use crate::ProviderAuthorizationRequest;
use crate::ProviderAuthorizer;
use crate::ProviderDynamicExecutionOutcome;
use crate::ProviderDynamicExecutionRequest;
use crate::dynamic_execution_model::operation_for_resource;
use crate::dynamic_execution_wire::ExecuteDynamicCommandWire;
use crate::dynamic_execution_wire::ExecuteDynamicResponseWire;

/// One-shot Provider Tool or Knowledge execution port.
///
/// Implementations must preserve the caller-owned call identity, use exact short-lived authority,
/// and never retry a semantic action or fall back to another execution location.
pub trait ProviderDynamicExecutionClient {
    fn execute_dynamic(
        &self,
        request: ProviderDynamicExecutionRequest,
    ) -> impl Future<Output = Result<ProviderDynamicExecutionOutcome, AgentPlatformProviderError>> + Send;
}

impl<Authorizer> ProviderDynamicExecutionClient for AgentPlatformProviderClient<Authorizer>
where
    Authorizer: ProviderAuthorizer,
{
    async fn execute_dynamic(
        &self,
        request: ProviderDynamicExecutionRequest,
    ) -> Result<ProviderDynamicExecutionOutcome, AgentPlatformProviderError> {
        let kind = request.authorization().resource().kind;
        let capability = match kind {
            ResourceKind::McpTool => AgentPlatformCapability::RemoteTool,
            ResourceKind::KnowledgeBase => AgentPlatformCapability::RemoteKnowledge,
            ResourceKind::Agent
            | ResourceKind::Skill
            | ResourceKind::McpServer
            | ResourceKind::Workflow => return Err(AgentPlatformProviderError::Incompatible),
        };
        if !self.descriptor.supports(capability)
            || !self
                .descriptor
                .resource_capabilities()
                .iter()
                .any(|resource| resource.resource_kind == kind)
        {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        let operation = operation_for_resource(kind)?;
        let authorization = self
            .authorizer
            .authorize(ProviderAuthorizationRequest::Dynamic {
                operation,
                binding: request.authorization().clone(),
            })
            .await
            .map_err(map_authorization)?;
        self.http
            .post_json::<_, ExecuteDynamicResponseWire>(
                "./dynamicActions:execute",
                authorization,
                &ExecuteDynamicCommandWire::from_domain(&request)?,
            )
            .await?
            .into_domain(&request)
    }
}

fn map_authorization(error: ProviderAuthorizationError) -> AgentPlatformProviderError {
    match error {
        ProviderAuthorizationError::Unavailable => AgentPlatformProviderError::Unavailable,
        ProviderAuthorizationError::Unauthorized => AgentPlatformProviderError::Unauthorized,
    }
}

#[cfg(test)]
#[path = "dynamic_execution_client_tests.rs"]
mod tests;
