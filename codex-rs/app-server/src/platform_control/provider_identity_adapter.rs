use crewon_provider_agent_platform::ProviderAuthorizationIdentity;
use crewon_provider_agent_platform::ProviderAuthorizationIdentitySpec;
use crewon_secrets::CredentialOwner;
use crewon_state::ProviderIdentityBindingLookup;
use crewon_state::ProviderIdentityBindingRecord;
use crewon_state::StateRuntime;
use std::fmt;

use super::RequestIdentity;
use super::authenticated_principal::AuthenticatedPrincipalBinding;
use super::credential_adapter::credential_owner;
use super::provider_identity_refresh_supervisor::ReadyProviderIdentityMappings;

const AGENT_PLATFORM_PROVIDER_ID: &str = "agent-platform";

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ResolvedProviderIdentity {
    authorization: ProviderAuthorizationIdentity,
    binding: ProviderIdentityBindingRecord,
}

impl ResolvedProviderIdentity {
    pub(crate) fn authorization(&self) -> &ProviderAuthorizationIdentity {
        &self.authorization
    }

    pub(crate) fn binding(&self) -> &ProviderIdentityBindingRecord {
        &self.binding
    }
}

impl fmt::Debug for ResolvedProviderIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ResolvedProviderIdentity([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderIdentityAdapterError {
    #[error("provider identity requires an authenticated principal")]
    Unauthenticated,
    #[error("provider identity scope is invalid")]
    IdentityScope,
    #[error("provider identity principal is inconsistent")]
    PrincipalMismatch,
    #[error("provider identity credential owner mismatch")]
    CredentialOwnerMismatch,
    #[error("provider identity mapping was not found")]
    MappingNotFound,
    #[error("provider identity mapping is unavailable")]
    MappingUnavailable,
    #[error("provider identity mapping is invalid")]
    InvalidMapping,
    #[error("provider identity principal session binding is missing or stale")]
    SessionBindingMismatch,
}

pub(crate) async fn resolve_provider_authorization_identity(
    state: &StateRuntime,
    identity: &RequestIdentity,
    owner: &CredentialOwner,
    ready_mappings: &ReadyProviderIdentityMappings,
    now: i64,
) -> Result<ProviderAuthorizationIdentity, ProviderIdentityAdapterError> {
    resolve_provider_identity(state, identity, owner, ready_mappings, now)
        .await
        .map(|resolved| resolved.authorization)
}

pub(crate) async fn resolve_provider_identity(
    state: &StateRuntime,
    identity: &RequestIdentity,
    owner: &CredentialOwner,
    _ready_mappings: &ReadyProviderIdentityMappings,
    now: i64,
) -> Result<ResolvedProviderIdentity, ProviderIdentityAdapterError> {
    let principal = identity
        .authenticated_principal()
        .ok_or(ProviderIdentityAdapterError::Unauthenticated)?;
    let reference = identity.reference();
    let (Some(tenant_id), Some(space_id)) = (
        reference.tenant_id.as_deref(),
        reference.space_id.as_deref(),
    ) else {
        return Err(ProviderIdentityAdapterError::IdentityScope);
    };
    if principal.stable_actor_id() != reference.actor_id
        || principal.tenant_id() != tenant_id
        || principal.space_id() != space_id
    {
        return Err(ProviderIdentityAdapterError::PrincipalMismatch);
    }
    let AuthenticatedPrincipalBinding::AgentPlatform {
        source_binding_id,
        source_revision,
    } = principal.binding()
    else {
        return Err(ProviderIdentityAdapterError::SessionBindingMismatch);
    };

    let expected_owner =
        credential_owner(identity).map_err(|_| ProviderIdentityAdapterError::IdentityScope)?;
    if expected_owner != *owner {
        return Err(ProviderIdentityAdapterError::CredentialOwnerMismatch);
    }

    let mapping = state
        .get_active_provider_identity_binding_record(
            &ProviderIdentityBindingLookup {
                local_actor_id: reference.actor_id.clone(),
                local_tenant_id: tenant_id.to_string(),
                local_space_id: space_id.to_string(),
                provider_id: AGENT_PLATFORM_PROVIDER_ID.to_string(),
            },
            now,
        )
        .await
        .map_err(|_| ProviderIdentityAdapterError::MappingUnavailable)?
        .ok_or(ProviderIdentityAdapterError::MappingNotFound)?;

    if mapping.local_actor_id != owner.actor_id()
        || owner.tenant_id() != Some(mapping.local_tenant_id.as_str())
        || owner.space_id() != Some(mapping.local_space_id.as_str())
        || mapping.provider_id != AGENT_PLATFORM_PROVIDER_ID
    {
        return Err(ProviderIdentityAdapterError::CredentialOwnerMismatch);
    }
    if mapping.source_binding_id != *source_binding_id
        || mapping.source_revision != *source_revision
    {
        return Err(ProviderIdentityAdapterError::SessionBindingMismatch);
    }

    let authorization = ProviderAuthorizationIdentity::new(ProviderAuthorizationIdentitySpec {
        subject: mapping.provider_subject.clone(),
        tenant_id: mapping.provider_tenant_id.clone(),
        space_id: mapping.provider_space_id.clone(),
    })
    .map_err(|_| ProviderIdentityAdapterError::InvalidMapping)?;
    Ok(ResolvedProviderIdentity {
        authorization,
        binding: mapping,
    })
}
