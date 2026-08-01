use std::fmt;

use crewon_provider_agent_platform::ProviderAuthorizationIdentity;
use crewon_provider_agent_platform::ProviderAuthorizationIdentitySpec;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ResolvedResourceBinding;
use crewon_resource_federation::ResourceKind;
use crewon_secrets::CredentialOwner;
use crewon_state::ProviderAccessGrantStatus;
use crewon_state::ProviderIdentityBindingLookup;
use crewon_state::ProviderResourceBindingStatus;
use crewon_state::StateRuntime;

use crate::platform_control::provider_access_grant_scope::has_exact_agent_platform_scopes;

const AGENT_PLATFORM_PROVIDER_ID: &str = "agent-platform";

pub(super) struct ProviderRunAuthorityRequest<'a> {
    pub state: &'a StateRuntime,
    pub binding: &'a ResolvedResourceBinding,
    pub expected_binding_revision: Option<u64>,
    pub credential_id: &'a str,
    pub credential_revision: u64,
    pub now: i64,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct ResolvedProviderRunAuthority {
    credential_owner: CredentialOwner,
    credential_id: String,
    credential_revision: u64,
    authorization_identity: ProviderAuthorizationIdentity,
    identity_binding_id: String,
    identity_binding_revision: u64,
}

impl ResolvedProviderRunAuthority {
    pub(super) fn credential_owner(&self) -> &CredentialOwner {
        &self.credential_owner
    }

    pub(super) fn credential_id(&self) -> &str {
        &self.credential_id
    }

    pub(super) fn credential_revision(&self) -> u64 {
        self.credential_revision
    }

    pub(super) fn authorization_identity(&self) -> &ProviderAuthorizationIdentity {
        &self.authorization_identity
    }

    pub(super) fn identity_binding_id(&self) -> &str {
        &self.identity_binding_id
    }

    pub(super) fn identity_binding_revision(&self) -> u64 {
        self.identity_binding_revision
    }
}

impl fmt::Debug for ResolvedProviderRunAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ResolvedProviderRunAuthority([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(super) enum ProviderRunAuthorityError {
    #[error("Provider Run authority request is invalid")]
    InvalidRequest,
    #[error("Provider Run authority state is unavailable")]
    StateUnavailable,
    #[error("Provider Run resource binding is unavailable or changed")]
    BindingMismatch,
    #[error("Provider Run connection is unavailable or changed")]
    ConnectionMismatch,
    #[error("Provider Run access grant is unavailable or changed")]
    GrantMismatch,
    #[error("Provider Run identity mapping is unavailable or changed")]
    IdentityMismatch,
}

pub(super) async fn resolve_provider_run_authority(
    request: ProviderRunAuthorityRequest<'_>,
) -> Result<ResolvedProviderRunAuthority, ProviderRunAuthorityError> {
    if request.now < 0
        || request.credential_revision == 0
        || request.expected_binding_revision == Some(0)
    {
        return Err(ProviderRunAuthorityError::InvalidRequest);
    }
    let resource = request.binding.resource();
    if request.binding.mode() != BindingMode::ProviderManaged
        || request.binding.execution_location() != ExecutionLocation::Provider
        || resource.kind != ResourceKind::Agent
        || resource.provider.provider_id.as_str() != AGENT_PLATFORM_PROVIDER_ID
    {
        return Err(ProviderRunAuthorityError::BindingMismatch);
    }

    let binding = request
        .state
        .get_provider_resource_binding_record(request.binding.binding_id().as_str())
        .await
        .map_err(|_| ProviderRunAuthorityError::StateUnavailable)?
        .ok_or(ProviderRunAuthorityError::BindingMismatch)?;
    binding
        .validate()
        .map_err(|_| ProviderRunAuthorityError::BindingMismatch)?;
    if binding.status != ProviderResourceBindingStatus::Active
        || binding.workspace_key != request.binding.workspace_key().as_str()
        || binding.provider_id != resource.provider.provider_id.as_str()
        || binding.protocol_version != resource.provider.protocol_version.as_str()
        || binding.resource_kind != crewon_state::ProviderResourceKind::Agent
        || binding.resource_id != resource.resource_id.as_str()
        || binding.resource_revision != resource.revision.as_str()
        || binding.binding_mode != crewon_state::ProviderResourceBindingMode::ProviderManaged
        || binding.execution_location != crewon_state::ProviderResourceExecutionLocation::Provider
        || binding.revision == 0
        || request
            .expected_binding_revision
            .is_some_and(|revision| binding.revision != revision)
    {
        return Err(ProviderRunAuthorityError::BindingMismatch);
    }

    let connection = request
        .state
        .get_provider_connection_record(&binding.connection_id)
        .await
        .map_err(|_| ProviderRunAuthorityError::StateUnavailable)?
        .ok_or(ProviderRunAuthorityError::ConnectionMismatch)?;
    connection
        .validate()
        .map_err(|_| ProviderRunAuthorityError::ConnectionMismatch)?;
    if connection.local_actor_id != binding.local_actor_id
        || connection.local_tenant_id != binding.local_tenant_id
        || connection.local_space_id != binding.local_space_id
        || connection.provider_id != binding.provider_id
        || connection.protocol_version != binding.protocol_version
        || connection.credential_id != request.credential_id
        || connection.credential_revision != request.credential_revision
        || connection.created_at > request.now
    {
        return Err(ProviderRunAuthorityError::ConnectionMismatch);
    }

    let grant = request
        .state
        .get_provider_access_grant_record(request.credential_id)
        .await
        .map_err(|_| ProviderRunAuthorityError::StateUnavailable)?
        .ok_or(ProviderRunAuthorityError::GrantMismatch)?;
    grant
        .validate()
        .map_err(|_| ProviderRunAuthorityError::GrantMismatch)?;
    if grant.status != ProviderAccessGrantStatus::Active
        || grant.local_actor_id != binding.local_actor_id
        || grant.local_tenant_id != binding.local_tenant_id
        || grant.local_space_id != binding.local_space_id
        || grant.provider_id != binding.provider_id
        || grant.revision != request.credential_revision
        || grant.expires_at <= request.now
        || !has_exact_agent_platform_scopes(&grant.granted_scopes)
    {
        return Err(ProviderRunAuthorityError::GrantMismatch);
    }

    let identity = request
        .state
        .get_active_provider_identity_binding_record(
            &ProviderIdentityBindingLookup {
                local_actor_id: binding.local_actor_id.clone(),
                local_tenant_id: binding.local_tenant_id.clone(),
                local_space_id: binding.local_space_id.clone(),
                provider_id: binding.provider_id.clone(),
            },
            request.now,
        )
        .await
        .map_err(|_| ProviderRunAuthorityError::StateUnavailable)?
        .ok_or(ProviderRunAuthorityError::IdentityMismatch)?;
    if identity.source_binding_id != grant.source_binding_id
        || identity.source_revision != grant.source_revision
    {
        return Err(ProviderRunAuthorityError::IdentityMismatch);
    }
    let credential_owner = CredentialOwner::space_user(
        &binding.local_actor_id,
        &binding.local_tenant_id,
        &binding.local_space_id,
    )
    .map_err(|_| ProviderRunAuthorityError::IdentityMismatch)?;
    let authorization_identity =
        ProviderAuthorizationIdentity::new(ProviderAuthorizationIdentitySpec {
            subject: identity.provider_subject.clone(),
            tenant_id: identity.provider_tenant_id.clone(),
            space_id: identity.provider_space_id.clone(),
        })
        .map_err(|_| ProviderRunAuthorityError::IdentityMismatch)?;
    Ok(ResolvedProviderRunAuthority {
        credential_owner,
        credential_id: grant.grant_id,
        credential_revision: grant.revision,
        authorization_identity,
        identity_binding_id: identity.binding_id,
        identity_binding_revision: identity.revision,
    })
}

#[cfg(test)]
#[path = "provider_run_authority_tests.rs"]
pub(in crate::task_control) mod tests;
