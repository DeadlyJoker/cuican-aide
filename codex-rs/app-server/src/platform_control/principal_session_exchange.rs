use std::future::Future;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crewon_app_server_transport::PrincipalSessionExchangeError;
use crewon_app_server_transport::PrincipalSessionExchangeResult;
use crewon_app_server_transport::PrincipalSessionExchangeService;
use crewon_provider_agent_platform::AgentPlatformIdentitySourceConnector;
use crewon_provider_agent_platform::AgentPlatformProviderError;
use crewon_provider_agent_platform::IdentitySourceAuthorizationError;
use crewon_provider_agent_platform::IdentitySourceBootstrapRs256Verifier;
use crewon_provider_agent_platform::IdentitySourceRs256SigningKey;
use crewon_provider_agent_platform::ProviderIdentitySourceOwner;
use crewon_provider_agent_platform::ProviderIdentitySourceSnapshot;
use crewon_provider_agent_platform::ProviderIdentitySourceStatus;
use crewon_provider_agent_platform::Rs256IdentitySourceAuthorizer;
use crewon_state::ProviderIdentityBindingLookup;
use crewon_state::StateRuntime;

use super::provider_access_grant_provisioner::ProviderAccessGrantProvisionError;
use super::provider_access_grant_provisioner::provision_agent_platform_access_grant;
use super::provider_identity_refresh::ProviderIdentityRefreshError;
use super::provider_identity_refresh::apply_provider_identity_source_snapshot;

const AGENT_PLATFORM_PROVIDER_ID: &str = "agent-platform";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BootstrapSessionIssuerError {
    Unauthorized,
    Conflict,
    Unavailable,
}

pub(crate) struct IssuedBootstrapSession {
    token: String,
    expires_at: i64,
}

impl IssuedBootstrapSession {
    pub(crate) fn new(token: String, expires_at: i64) -> Result<Self, BootstrapSessionIssuerError> {
        if token.is_empty() || expires_at < 0 {
            return Err(BootstrapSessionIssuerError::Unavailable);
        }
        Ok(Self { token, expires_at })
    }
}

pub(crate) trait BootstrapSessionIssuer: Send + Sync + 'static {
    fn issue(
        &self,
        bootstrap_token: String,
    ) -> impl Future<Output = Result<IssuedBootstrapSession, BootstrapSessionIssuerError>> + Send;
}

pub(crate) struct AgentPlatformBootstrapSessionIssuer {
    connector: AgentPlatformIdentitySourceConnector,
    signing_key: Arc<IdentitySourceRs256SigningKey>,
    bootstrap_verifier: IdentitySourceBootstrapRs256Verifier,
    state: Arc<StateRuntime>,
}

impl AgentPlatformBootstrapSessionIssuer {
    pub(crate) fn new(
        connector: AgentPlatformIdentitySourceConnector,
        signing_key: Arc<IdentitySourceRs256SigningKey>,
        bootstrap_verifier: IdentitySourceBootstrapRs256Verifier,
        state: Arc<StateRuntime>,
    ) -> Self {
        Self {
            connector,
            signing_key,
            bootstrap_verifier,
            state,
        }
    }
}

impl BootstrapSessionIssuer for AgentPlatformBootstrapSessionIssuer {
    async fn issue(
        &self,
        bootstrap_token: String,
    ) -> Result<IssuedBootstrapSession, BootstrapSessionIssuerError> {
        let now = unix_now()?;
        let bootstrap = self
            .bootstrap_verifier
            .verify(bootstrap_token, now)
            .map_err(map_authorization_error)?;
        let owner = bootstrap.owner();
        let authorizer =
            Rs256IdentitySourceAuthorizer::with_bootstrap(self.signing_key.clone(), bootstrap);
        let client = self
            .connector
            .client(authorizer)
            .map_err(map_provider_error)?;
        let binding = client
            .resolve(owner.clone(), now)
            .await
            .map_err(map_provider_error)?;
        if binding.binding().status() != ProviderIdentitySourceStatus::Active {
            return Err(BootstrapSessionIssuerError::Conflict);
        }
        persist_resolved_provider_identity(self.state.as_ref(), &owner, &binding).await?;
        let issued = client
            .issue_principal_session(binding.binding().source_binding_id(), owner.clone())
            .await
            .map_err(map_provider_error)?;
        provision_agent_platform_access_grant(
            self.state.as_ref(),
            &owner,
            &binding,
            issued.expires_at,
            now,
        )
        .await
        .map_err(map_grant_provision_error)?;
        IssuedBootstrapSession::new(
            issued.token.reveal_for_transport().to_string(),
            issued.expires_at,
        )
    }
}

async fn persist_resolved_provider_identity(
    state: &StateRuntime,
    owner: &ProviderIdentitySourceOwner,
    snapshot: &ProviderIdentitySourceSnapshot,
) -> Result<(), BootstrapSessionIssuerError> {
    apply_provider_identity_source_snapshot(
        state,
        &ProviderIdentityBindingLookup {
            local_actor_id: owner.actor_id().to_string(),
            local_tenant_id: owner.tenant_id().to_string(),
            local_space_id: owner.space_id().to_string(),
            provider_id: AGENT_PLATFORM_PROVIDER_ID.to_string(),
        },
        snapshot,
    )
    .await
    .map(|_| ())
    .map_err(|error| match error {
        ProviderIdentityRefreshError::OwnerMismatch | ProviderIdentityRefreshError::Conflict => {
            BootstrapSessionIssuerError::Conflict
        }
        ProviderIdentityRefreshError::StateUnavailable => BootstrapSessionIssuerError::Unavailable,
    })
}

pub(crate) fn principal_session_exchange_service<Issuer>(
    issuer: Arc<Issuer>,
) -> PrincipalSessionExchangeService
where
    Issuer: BootstrapSessionIssuer,
{
    PrincipalSessionExchangeService::new(move |bootstrap_token| {
        let issuer = issuer.clone();
        async move {
            let issued = issuer
                .issue(bootstrap_token)
                .await
                .map_err(map_exchange_error)?;
            PrincipalSessionExchangeResult::new(issued.token, issued.expires_at)
        }
    })
}

fn unix_now() -> Result<i64, BootstrapSessionIssuerError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| BootstrapSessionIssuerError::Unavailable)?
        .as_secs();
    i64::try_from(now).map_err(|_| BootstrapSessionIssuerError::Unavailable)
}

fn map_authorization_error(error: IdentitySourceAuthorizationError) -> BootstrapSessionIssuerError {
    match error {
        IdentitySourceAuthorizationError::Unauthorized => BootstrapSessionIssuerError::Unauthorized,
        IdentitySourceAuthorizationError::Unavailable => BootstrapSessionIssuerError::Unavailable,
        _ => BootstrapSessionIssuerError::Unavailable,
    }
}

fn map_provider_error(error: AgentPlatformProviderError) -> BootstrapSessionIssuerError {
    match error {
        AgentPlatformProviderError::Unauthorized | AgentPlatformProviderError::NotFound => {
            BootstrapSessionIssuerError::Unauthorized
        }
        AgentPlatformProviderError::Conflict => BootstrapSessionIssuerError::Conflict,
        AgentPlatformProviderError::InvalidRequest
        | AgentPlatformProviderError::Incompatible
        | AgentPlatformProviderError::InvalidResponse
        | AgentPlatformProviderError::Unavailable
        | AgentPlatformProviderError::Timeout
        | AgentPlatformProviderError::UnknownOutcome
        | AgentPlatformProviderError::RateLimited { .. } => {
            BootstrapSessionIssuerError::Unavailable
        }
        _ => BootstrapSessionIssuerError::Unavailable,
    }
}

fn map_grant_provision_error(
    error: ProviderAccessGrantProvisionError,
) -> BootstrapSessionIssuerError {
    match error {
        ProviderAccessGrantProvisionError::Conflict => BootstrapSessionIssuerError::Conflict,
        ProviderAccessGrantProvisionError::CapacityExceeded
        | ProviderAccessGrantProvisionError::StateUnavailable => {
            BootstrapSessionIssuerError::Unavailable
        }
    }
}

fn map_exchange_error(error: BootstrapSessionIssuerError) -> PrincipalSessionExchangeError {
    match error {
        BootstrapSessionIssuerError::Unauthorized => PrincipalSessionExchangeError::Unauthorized,
        BootstrapSessionIssuerError::Conflict => PrincipalSessionExchangeError::Conflict,
        BootstrapSessionIssuerError::Unavailable => PrincipalSessionExchangeError::Unavailable,
    }
}

#[cfg(test)]
#[path = "principal_session_exchange_tests.rs"]
mod tests;
