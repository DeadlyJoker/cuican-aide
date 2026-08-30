use std::fmt;

use crewon_state::ProviderAccessGrantLookup;
use crewon_state::ProviderAccessGrantRecord;
use crewon_state::ProviderIdentityBindingRecord;
use crewon_state::StateRuntime;

use super::RequestIdentity;
use super::authenticated_principal::AuthenticatedPrincipalBinding;
use super::credential_adapter::credential_owner;
use super::provider_access_grant_scope::has_exact_agent_platform_scopes;
use super::provider_identity_adapter::ProviderIdentityAdapterError;
use super::provider_identity_adapter::ResolvedProviderIdentity;
use super::provider_identity_adapter::resolve_provider_identity;
use super::provider_identity_refresh_supervisor::ReadyProviderIdentityMappings;

const AGENT_PLATFORM_PROVIDER_ID: &str = "agent-platform";

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ProviderAccessGrantAuthority {
    provider_identity: ResolvedProviderIdentity,
    grant: ProviderAccessGrantRecord,
}

impl ProviderAccessGrantAuthority {
    pub(crate) fn provider_identity(
        &self,
    ) -> &crewon_provider_agent_platform::ProviderAuthorizationIdentity {
        self.provider_identity.authorization()
    }

    pub(crate) fn provider_identity_binding(&self) -> &ProviderIdentityBindingRecord {
        self.provider_identity.binding()
    }

    pub(crate) fn grant(&self) -> &ProviderAccessGrantRecord {
        &self.grant
    }
}

impl fmt::Debug for ProviderAccessGrantAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderAccessGrantAuthority([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderAccessGrantAuthorityError {
    #[error("Provider identity is not authorized")]
    Identity(#[source] ProviderIdentityAdapterError),
    #[error("Provider access grant was not found")]
    GrantNotFound,
    #[error("Provider access grant is invalid")]
    InvalidGrant,
    #[error("Provider access grant state is unavailable")]
    StateUnavailable,
}

pub(crate) async fn resolve_agent_platform_access_grant_authority(
    state: &StateRuntime,
    identity: &RequestIdentity,
    ready_mappings: &ReadyProviderIdentityMappings,
    now: i64,
) -> Result<ProviderAccessGrantAuthority, ProviderAccessGrantAuthorityError> {
    let owner = credential_owner(identity).map_err(|_| {
        ProviderAccessGrantAuthorityError::Identity(ProviderIdentityAdapterError::IdentityScope)
    })?;
    let provider_identity = resolve_provider_identity(state, identity, &owner, ready_mappings, now)
        .await
        .map_err(ProviderAccessGrantAuthorityError::Identity)?;
    let principal =
        identity
            .authenticated_principal()
            .ok_or(ProviderAccessGrantAuthorityError::Identity(
                ProviderIdentityAdapterError::Unauthenticated,
            ))?;
    let AuthenticatedPrincipalBinding::AgentPlatform {
        source_binding_id,
        source_revision,
    } = principal.binding()
    else {
        return Err(ProviderAccessGrantAuthorityError::Identity(
            ProviderIdentityAdapterError::SessionBindingMismatch,
        ));
    };
    let reference = identity.reference();
    let tenant_id =
        reference
            .tenant_id
            .as_deref()
            .ok_or(ProviderAccessGrantAuthorityError::Identity(
                ProviderIdentityAdapterError::IdentityScope,
            ))?;
    let space_id =
        reference
            .space_id
            .as_deref()
            .ok_or(ProviderAccessGrantAuthorityError::Identity(
                ProviderIdentityAdapterError::IdentityScope,
            ))?;
    let grant = state
        .get_active_provider_access_grant_record(
            &ProviderAccessGrantLookup {
                local_actor_id: reference.actor_id.clone(),
                local_tenant_id: tenant_id.to_string(),
                local_space_id: space_id.to_string(),
                provider_id: AGENT_PLATFORM_PROVIDER_ID.to_string(),
                source_binding_id: source_binding_id.clone(),
                source_revision: *source_revision,
            },
            now,
        )
        .await
        .map_err(|_| ProviderAccessGrantAuthorityError::StateUnavailable)?
        .ok_or(ProviderAccessGrantAuthorityError::GrantNotFound)?;
    if !has_exact_agent_platform_scopes(&grant.granted_scopes) {
        return Err(ProviderAccessGrantAuthorityError::InvalidGrant);
    }
    Ok(ProviderAccessGrantAuthority {
        provider_identity,
        grant,
    })
}
