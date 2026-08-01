use crewon_provider_agent_platform::AgentPlatformIdentitySourceClient;
use crewon_provider_agent_platform::IdentitySourceAuthorizer;
use crewon_provider_agent_platform::ProviderIdentitySourceOwner;

use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReadError;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReadRequest;
use super::provider_identity_refresh_supervisor::ProviderIdentitySourceReader;

impl<Authorizer> ProviderIdentitySourceReader for AgentPlatformIdentitySourceClient<Authorizer>
where
    Authorizer: IdentitySourceAuthorizer,
{
    async fn read(
        &self,
        request: ProviderIdentitySourceReadRequest,
        now: i64,
    ) -> Result<
        crewon_provider_agent_platform::ProviderIdentitySourceSnapshot,
        ProviderIdentitySourceReadError,
    > {
        let owner = ProviderIdentitySourceOwner::new(
            request.expected_owner.local_actor_id,
            request.expected_owner.local_tenant_id,
            request.expected_owner.local_space_id,
        )
        .map_err(|_| ProviderIdentitySourceReadError)?;
        self.read(request.source_binding_id, owner, now)
            .await
            .map_err(|_| ProviderIdentitySourceReadError)
    }
}
