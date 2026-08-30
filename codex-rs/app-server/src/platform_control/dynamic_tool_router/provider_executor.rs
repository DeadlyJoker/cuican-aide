use std::future::Future;

use crewon_app_server_protocol::DynamicToolCallOutputContentItem;
use crewon_artifact::ArtifactRef;
use crewon_provider_agent_platform::AgentPlatformProviderClient;
use crewon_provider_agent_platform::AgentPlatformProviderError;
use crewon_provider_agent_platform::ProviderAuthorizationIdentity;
use crewon_provider_agent_platform::ProviderAuthorizationIdentitySpec;
use crewon_provider_agent_platform::ProviderDynamicArtifactClient;
use crewon_provider_agent_platform::ProviderDynamicArtifactContent;
use crewon_provider_agent_platform::ProviderDynamicArtifactReadRequest;
use crewon_provider_agent_platform::ProviderDynamicArtifactRef;
use crewon_provider_agent_platform::ProviderDynamicAuthorizationBinding;
use crewon_provider_agent_platform::ProviderDynamicExecutionClient;
use crewon_provider_agent_platform::ProviderDynamicExecutionFailure;
use crewon_provider_agent_platform::ProviderDynamicExecutionOutcome;
use crewon_provider_agent_platform::ProviderDynamicExecutionRequest;
use crewon_provider_agent_platform::ProviderDynamicExecutionUnknown;
use crewon_provider_agent_platform::Rs256ProviderAuthorizer;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use sha2::Digest;
use sha2::Sha256;

use super::dispatch::BoundedDynamicToolResult;
use super::dispatch::DynamicToolAdapterOutcome;
use super::dispatch::ProviderDynamicToolExecutionRequest;
use super::dispatch::ProviderDynamicToolExecutor;
use super::ports::DynamicToolExecutionClaimRequest;
use super::ports::DynamicToolExecutionFailure;
use super::ports::DynamicToolExecutionUnknown;
use super::registration::DynamicToolOperation;
use crate::platform_control::provider_connection_production::AgentPlatformProviderDescriptorFactory;

pub(crate) trait ProviderDynamicClientFactory: Send + Sync {
    type Client: ProviderDynamicExecutionClient + ProviderDynamicArtifactClient + Send + Sync;

    fn connect(
        &self,
        provider_id: &str,
        identity: ProviderAuthorizationIdentity,
    ) -> impl Future<Output = Result<Self::Client, AgentPlatformProviderError>> + Send;
}

impl ProviderDynamicClientFactory for AgentPlatformProviderDescriptorFactory {
    type Client = AgentPlatformProviderClient<Rs256ProviderAuthorizer>;

    async fn connect(
        &self,
        provider_id: &str,
        identity: ProviderAuthorizationIdentity,
    ) -> Result<Self::Client, AgentPlatformProviderError> {
        self.connect_provider_client(provider_id, identity).await
    }
}

pub(crate) struct ProviderDynamicArtifactImportRequest {
    pub claim: DynamicToolExecutionClaimRequest,
    pub artifact: ProviderDynamicArtifactRef,
    pub content: ProviderDynamicArtifactContent,
}

impl std::fmt::Debug for ProviderDynamicArtifactImportRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProviderDynamicArtifactImportRequest")
            .field("claim", &self.claim)
            .field("artifact", &self.artifact)
            .finish()
    }
}

pub(crate) trait ProviderDynamicArtifactImporter: Send + Sync {
    fn import(
        &self,
        request: ProviderDynamicArtifactImportRequest,
    ) -> impl Future<Output = Result<ArtifactRef, ProviderArtifactImportError>> + Send;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderArtifactImportError {
    Unauthorized,
    Unavailable,
    InvalidResponse,
}

pub(crate) struct AgentPlatformDynamicToolExecutor<'a, Factory, Importer> {
    factory: &'a Factory,
    artifact_importer: &'a Importer,
}

impl<'a, Factory, Importer> AgentPlatformDynamicToolExecutor<'a, Factory, Importer> {
    pub(crate) fn new(factory: &'a Factory, artifact_importer: &'a Importer) -> Self {
        Self {
            factory,
            artifact_importer,
        }
    }
}

impl<Factory, Importer> ProviderDynamicToolExecutor
    for AgentPlatformDynamicToolExecutor<'_, Factory, Importer>
where
    Factory: ProviderDynamicClientFactory,
    Importer: ProviderDynamicArtifactImporter,
{
    async fn execute(
        &self,
        request: ProviderDynamicToolExecutionRequest,
    ) -> DynamicToolAdapterOutcome {
        match self.execute_inner(request).await {
            Ok(outcome) => outcome,
            Err(outcome) => outcome,
        }
    }
}

impl<Factory, Importer> AgentPlatformDynamicToolExecutor<'_, Factory, Importer>
where
    Factory: ProviderDynamicClientFactory,
    Importer: ProviderDynamicArtifactImporter,
{
    async fn execute_inner(
        &self,
        request: ProviderDynamicToolExecutionRequest,
    ) -> Result<DynamicToolAdapterOutcome, DynamicToolAdapterOutcome> {
        let claim = request.claim().clone();
        validate_target(&request, &claim)?;
        let identity = provider_identity(&claim)?;
        let client = self
            .factory
            .connect(&claim.provider_id, identity)
            .await
            .map_err(map_provider_error)?;
        let provider_request = provider_request(&request, &claim)?;
        let artifact_authorization = provider_request.authorization().clone();
        let outcome = client
            .execute_dynamic(provider_request)
            .await
            .map_err(map_provider_error)?;
        match outcome {
            ProviderDynamicExecutionOutcome::Succeeded(success) => match success.result() {
                crewon_provider_agent_platform::ProviderDynamicResult::InlineText(items) => {
                    BoundedDynamicToolResult::inline(
                        items
                            .iter()
                            .cloned()
                            .map(|text| DynamicToolCallOutputContentItem::InputText { text })
                            .collect(),
                    )
                    .map(DynamicToolAdapterOutcome::Succeeded)
                    .map_err(|_| unknown(DynamicToolExecutionUnknown::InvalidResponse))
                }
                crewon_provider_agent_platform::ProviderDynamicResult::Artifact(artifact) => {
                    let content = client
                        .read_dynamic_artifact(
                            ProviderDynamicArtifactReadRequest::new(
                                artifact_authorization,
                                format!(
                                    "dynamic-artifact-command:{:x}",
                                    Sha256::digest(claim.call_id.as_bytes())
                                ),
                                artifact.clone(),
                            )
                            .map_err(map_provider_error)?,
                        )
                        .await
                        .map_err(map_provider_error)?;
                    self.artifact_importer
                        .import(ProviderDynamicArtifactImportRequest {
                            claim,
                            artifact: artifact.clone(),
                            content,
                        })
                        .await
                        .map(BoundedDynamicToolResult::artifact)
                        .map(DynamicToolAdapterOutcome::Succeeded)
                        .map_err(map_artifact_error)
                }
            },
            ProviderDynamicExecutionOutcome::Failed(reason) => {
                Ok(DynamicToolAdapterOutcome::Failed(match reason {
                    ProviderDynamicExecutionFailure::Rejected => {
                        DynamicToolExecutionFailure::Rejected
                    }
                    ProviderDynamicExecutionFailure::ExecutionFailed => {
                        DynamicToolExecutionFailure::ExecutionFailed
                    }
                }))
            }
            ProviderDynamicExecutionOutcome::Unknown(reason) => Ok(unknown(match reason {
                ProviderDynamicExecutionUnknown::Timeout => DynamicToolExecutionUnknown::Timeout,
                ProviderDynamicExecutionUnknown::ProviderUnavailable => {
                    DynamicToolExecutionUnknown::AdapterUnavailable
                }
                ProviderDynamicExecutionUnknown::UnknownOutcome => {
                    DynamicToolExecutionUnknown::AdapterUnavailable
                }
            })),
        }
    }
}

fn validate_target(
    request: &ProviderDynamicToolExecutionRequest,
    claim: &DynamicToolExecutionClaimRequest,
) -> Result<(), DynamicToolAdapterOutcome> {
    if request.connection_id() != claim.connection_id
        || request.resource_id() != claim.resource_id
        || request.credential().credential_id() != claim.credential_id.as_deref()
        || request.credential().revision() != claim.credential_revision
        || request.operation() != claim.operation
    {
        return Err(unknown(DynamicToolExecutionUnknown::InvalidResponse));
    }
    Ok(())
}

fn provider_identity(
    claim: &DynamicToolExecutionClaimRequest,
) -> Result<ProviderAuthorizationIdentity, DynamicToolAdapterOutcome> {
    ProviderAuthorizationIdentity::new(ProviderAuthorizationIdentitySpec {
        subject: claim
            .provider_subject
            .clone()
            .ok_or_else(|| unknown(DynamicToolExecutionUnknown::InvalidResponse))?,
        tenant_id: claim
            .provider_tenant_id
            .clone()
            .ok_or_else(|| unknown(DynamicToolExecutionUnknown::InvalidResponse))?,
        space_id: claim
            .provider_space_id
            .clone()
            .ok_or_else(|| unknown(DynamicToolExecutionUnknown::InvalidResponse))?,
    })
    .map_err(|_| unknown(DynamicToolExecutionUnknown::InvalidResponse))
}

fn provider_request(
    request: &ProviderDynamicToolExecutionRequest,
    claim: &DynamicToolExecutionClaimRequest,
) -> Result<ProviderDynamicExecutionRequest, DynamicToolAdapterOutcome> {
    let resource = ResourceRef {
        provider: ProviderRef {
            provider_id: ProviderId::new(claim.provider_id.clone())
                .map_err(|_| unknown(DynamicToolExecutionUnknown::InvalidResponse))?,
            protocol_version: ProviderProtocolVersion::new(claim.protocol_version.clone())
                .map_err(|_| unknown(DynamicToolExecutionUnknown::InvalidResponse))?,
        },
        kind: match (claim.resource_kind, claim.operation) {
            (crewon_state::ProviderResourceKind::McpTool, DynamicToolOperation::Call) => {
                ResourceKind::McpTool
            }
            (crewon_state::ProviderResourceKind::KnowledgeBase, DynamicToolOperation::Search) => {
                ResourceKind::KnowledgeBase
            }
            _ => return Err(unknown(DynamicToolExecutionUnknown::InvalidResponse)),
        },
        resource_id: ResourceId::new(claim.resource_id.clone())
            .map_err(|_| unknown(DynamicToolExecutionUnknown::InvalidResponse))?,
        revision: ResourceRevision::new(claim.resource_revision.clone())
            .map_err(|_| unknown(DynamicToolExecutionUnknown::InvalidResponse))?,
    };
    let binding = ProviderDynamicAuthorizationBinding::new(
        resource,
        claim.call_id.clone(),
        claim.action_digest.clone(),
        claim
            .credential_id
            .clone()
            .ok_or_else(|| unknown(DynamicToolExecutionUnknown::InvalidResponse))?,
        claim
            .credential_revision
            .ok_or_else(|| unknown(DynamicToolExecutionUnknown::InvalidResponse))?,
    )
    .map_err(|_| unknown(DynamicToolExecutionUnknown::InvalidResponse))?;
    ProviderDynamicExecutionRequest::new(
        binding,
        format!(
            "dynamic-command:{:x}",
            Sha256::digest(claim.call_id.as_bytes())
        ),
        request.arguments().clone(),
    )
    .map_err(map_provider_error)
}

fn map_provider_error(error: AgentPlatformProviderError) -> DynamicToolAdapterOutcome {
    match error {
        AgentPlatformProviderError::Unauthorized
        | AgentPlatformProviderError::NotFound
        | AgentPlatformProviderError::Conflict
        | AgentPlatformProviderError::InvalidRequest
        | AgentPlatformProviderError::Incompatible => {
            DynamicToolAdapterOutcome::Failed(DynamicToolExecutionFailure::Rejected)
        }
        AgentPlatformProviderError::Timeout => unknown(DynamicToolExecutionUnknown::Timeout),
        AgentPlatformProviderError::Unavailable
        | AgentPlatformProviderError::UnknownOutcome
        | AgentPlatformProviderError::RateLimited { .. } => {
            unknown(DynamicToolExecutionUnknown::AdapterUnavailable)
        }
        AgentPlatformProviderError::InvalidResponse => {
            unknown(DynamicToolExecutionUnknown::InvalidResponse)
        }
        _ => unknown(DynamicToolExecutionUnknown::InvalidResponse),
    }
}

fn map_artifact_error(error: ProviderArtifactImportError) -> DynamicToolAdapterOutcome {
    match error {
        ProviderArtifactImportError::Unauthorized => {
            DynamicToolAdapterOutcome::Failed(DynamicToolExecutionFailure::Rejected)
        }
        ProviderArtifactImportError::Unavailable => {
            unknown(DynamicToolExecutionUnknown::AdapterUnavailable)
        }
        ProviderArtifactImportError::InvalidResponse => {
            unknown(DynamicToolExecutionUnknown::InvalidResponse)
        }
    }
}

fn unknown(reason: DynamicToolExecutionUnknown) -> DynamicToolAdapterOutcome {
    DynamicToolAdapterOutcome::Unknown(reason)
}

#[cfg(test)]
#[path = "provider_executor_tests.rs"]
mod tests;
