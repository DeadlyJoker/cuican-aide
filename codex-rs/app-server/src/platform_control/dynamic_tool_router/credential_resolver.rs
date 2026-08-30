use crewon_policy::CredentialExpiry;
use crewon_policy::CredentialState;
use crewon_resource_federation::ProviderId;
use crewon_state::ProviderResourceBindingStatus;
use crewon_state::ProviderResourceExecutionLocation;
use crewon_state::ProviderResourceKind;
use crewon_state::StateRuntime;

use super::ports::DynamicToolCredentialRequest;
use super::ports::DynamicToolCredentialResolver;
use super::ports::DynamicToolCredentialSnapshot;
use super::ports::DynamicToolPortError;
use super::ports::DynamicToolProviderIdentitySnapshot;
use crate::platform_control::provider_access_grant_authority::ProviderAccessGrantAuthorityError;
use crate::platform_control::provider_access_grant_authority::resolve_agent_platform_access_grant_authority;
use crate::platform_control::provider_connection_descriptor::ProviderConnectionClock;
use crate::platform_control::provider_identity_adapter::ProviderIdentityAdapterError;
use crate::platform_control::provider_identity_refresh_supervisor::ReadyProviderIdentityMappings;

const AGENT_PLATFORM_PROVIDER_ID: &str = "agent-platform";

/// Resolves the exact live Provider authority immediately before policy evaluation and claim.
pub(crate) struct StateDynamicToolCredentialResolver<'a, Clock> {
    state: &'a StateRuntime,
    ready_mappings: &'a ReadyProviderIdentityMappings,
    clock: &'a Clock,
}

impl<'a, Clock> StateDynamicToolCredentialResolver<'a, Clock> {
    pub(crate) fn new(
        state: &'a StateRuntime,
        ready_mappings: &'a ReadyProviderIdentityMappings,
        clock: &'a Clock,
    ) -> Self {
        Self {
            state,
            ready_mappings,
            clock,
        }
    }
}

impl<Clock> DynamicToolCredentialResolver for StateDynamicToolCredentialResolver<'_, Clock>
where
    Clock: ProviderConnectionClock,
{
    async fn resolve_credential(
        &self,
        request: DynamicToolCredentialRequest,
    ) -> Result<DynamicToolCredentialSnapshot, DynamicToolPortError> {
        request
            .binding
            .validate()
            .map_err(|_| DynamicToolPortError::InvalidResponse)?;
        if request.binding.status != ProviderResourceBindingStatus::Active {
            return Err(DynamicToolPortError::Unauthorized);
        }
        if request.binding.execution_location != ProviderResourceExecutionLocation::Provider {
            return Err(DynamicToolPortError::Unauthorized);
        }
        if request.binding.provider_id != AGENT_PLATFORM_PROVIDER_ID
            || !matches!(
                request.binding.resource_kind,
                ProviderResourceKind::McpTool | ProviderResourceKind::KnowledgeBase
            )
        {
            return Err(DynamicToolPortError::Unauthorized);
        }

        let now = self.clock.now();
        if now < 0 {
            return Err(DynamicToolPortError::Unavailable);
        }
        let authority = resolve_agent_platform_access_grant_authority(
            self.state,
            &request.identity,
            self.ready_mappings,
            now,
        )
        .await
        .map_err(map_authority_error)?;
        let connection = self
            .state
            .get_provider_connection_record(&request.binding.connection_id)
            .await
            .map_err(|_| DynamicToolPortError::Unavailable)?
            .ok_or(DynamicToolPortError::Unauthorized)?;
        let identity = request.identity.reference();
        if connection.local_actor_id != identity.actor_id
            || identity.tenant_id.as_deref() != Some(connection.local_tenant_id.as_str())
            || identity.space_id.as_deref() != Some(connection.local_space_id.as_str())
            || connection.provider_id != request.binding.provider_id
            || connection.protocol_version != request.binding.protocol_version
            || connection.credential_id != authority.grant().grant_id
            || connection.credential_revision != authority.grant().revision
            || connection.created_at > now
        {
            return Err(DynamicToolPortError::Unauthorized);
        }

        let provider_identity = authority.provider_identity_binding();
        DynamicToolCredentialSnapshot::provider_reference(
            connection.credential_id,
            ProviderId::new(connection.provider_id)
                .map_err(|_| DynamicToolPortError::InvalidResponse)?,
            CredentialState::Available,
            connection.credential_revision,
            CredentialExpiry::At(authority.grant().expires_at),
            DynamicToolProviderIdentitySnapshot {
                binding_id: provider_identity.binding_id.clone(),
                binding_revision: provider_identity.revision,
                subject: provider_identity.provider_subject.clone(),
                tenant_id: provider_identity.provider_tenant_id.clone(),
                space_id: provider_identity.provider_space_id.clone(),
            },
        )
        .map_err(|_| DynamicToolPortError::InvalidResponse)
    }
}

fn map_authority_error(error: ProviderAccessGrantAuthorityError) -> DynamicToolPortError {
    match error {
        ProviderAccessGrantAuthorityError::Identity(
            ProviderIdentityAdapterError::MappingUnavailable,
        )
        | ProviderAccessGrantAuthorityError::StateUnavailable => DynamicToolPortError::Unavailable,
        ProviderAccessGrantAuthorityError::Identity(
            ProviderIdentityAdapterError::Unauthenticated
            | ProviderIdentityAdapterError::IdentityScope
            | ProviderIdentityAdapterError::PrincipalMismatch
            | ProviderIdentityAdapterError::CredentialOwnerMismatch
            | ProviderIdentityAdapterError::MappingNotFound
            | ProviderIdentityAdapterError::InvalidMapping
            | ProviderIdentityAdapterError::SessionBindingMismatch,
        )
        | ProviderAccessGrantAuthorityError::GrantNotFound
        | ProviderAccessGrantAuthorityError::InvalidGrant => DynamicToolPortError::Unauthorized,
    }
}

impl<Clock> std::fmt::Debug for StateDynamicToolCredentialResolver<'_, Clock> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("StateDynamicToolCredentialResolver([REDACTED])")
    }
}

#[cfg(test)]
#[path = "credential_resolver_tests.rs"]
mod tests;
