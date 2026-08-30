use crewon_provider_transport::ProviderEndpointPolicy;
use crewon_provider_transport::SystemEndpointResolver;
use crewon_provider_transport::ValidatedProviderEndpoint;
use reqwest::Method;
use reqwest::StatusCode;
use serde::Deserialize;
use serde::Serialize;
use uuid::Uuid;

use crate::AgentPlatformProviderError;
use crate::IdentitySourceAuthorizationError;
use crate::IdentitySourceAuthorizationRequest;
use crate::IdentitySourceAuthorizer;
use crate::ProviderIdentitySourceError;
use crate::ProviderIdentitySourceOwner;
use crate::ProviderIdentitySourceSnapshot;
use crate::http_client::validate_json_content_type;

pub struct AgentPlatformIdentitySourceClient<Authorizer> {
    pub(crate) transport: crewon_provider_transport::PinnedProviderClient,
    pub(crate) authorizer: Authorizer,
}

#[derive(Clone)]
pub struct AgentPlatformIdentitySourceConnector {
    policy: ProviderEndpointPolicy,
    endpoint: ValidatedProviderEndpoint,
}

impl AgentPlatformIdentitySourceConnector {
    pub async fn production(raw_url: &str) -> Result<Self, AgentPlatformProviderError> {
        Self::validate(ProviderEndpointPolicy::production(), raw_url).await
    }

    pub async fn development_loopback(raw_url: &str) -> Result<Self, AgentPlatformProviderError> {
        Self::validate(ProviderEndpointPolicy::development_loopback(), raw_url).await
    }

    async fn validate(
        policy: ProviderEndpointPolicy,
        raw_url: &str,
    ) -> Result<Self, AgentPlatformProviderError> {
        let endpoint = policy.validate(raw_url, &SystemEndpointResolver).await?;
        if !endpoint.url().path().ends_with("/identity/v1/") {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        Ok(Self { policy, endpoint })
    }

    pub fn client<Authorizer>(
        &self,
        authorizer: Authorizer,
    ) -> Result<AgentPlatformIdentitySourceClient<Authorizer>, AgentPlatformProviderError>
    where
        Authorizer: IdentitySourceAuthorizer,
    {
        AgentPlatformIdentitySourceClient::connect(self.policy, self.endpoint.clone(), authorizer)
    }
}

impl std::fmt::Debug for AgentPlatformIdentitySourceConnector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AgentPlatformIdentitySourceConnector([REDACTED])")
    }
}

impl<Authorizer> AgentPlatformIdentitySourceClient<Authorizer>
where
    Authorizer: IdentitySourceAuthorizer,
{
    pub fn connect(
        policy: ProviderEndpointPolicy,
        endpoint: ValidatedProviderEndpoint,
        authorizer: Authorizer,
    ) -> Result<Self, AgentPlatformProviderError> {
        if !endpoint.url().path().ends_with("/identity/v1/") {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        Ok(Self {
            transport: policy.pinned_client(endpoint)?,
            authorizer,
        })
    }

    pub async fn resolve(
        &self,
        owner: ProviderIdentitySourceOwner,
        now: i64,
    ) -> Result<ProviderIdentitySourceSnapshot, AgentPlatformProviderError> {
        let authorization = self
            .authorizer
            .authorize(IdentitySourceAuthorizationRequest::Resolve {
                owner: owner.clone(),
            })
            .await
            .map_err(map_authorization)?;
        let builder = self
            .transport
            .request(Method::POST, "./identity-bindings:resolve")?;
        let response = authorization
            .apply(builder)
            .send()
            .await
            .map_err(crewon_provider_transport::classify_request_error)?;
        self.parse_response(response, None, &owner, now).await
    }

    pub async fn read(
        &self,
        source_binding_id: impl Into<String>,
        owner: ProviderIdentitySourceOwner,
        now: i64,
    ) -> Result<ProviderIdentitySourceSnapshot, AgentPlatformProviderError> {
        let source_binding_id = canonical_binding_id(source_binding_id.into())?;
        let authorization = self
            .authorizer
            .authorize(IdentitySourceAuthorizationRequest::Read {
                source_binding_id: source_binding_id.clone(),
                owner: owner.clone(),
            })
            .await
            .map_err(map_authorization)?;
        let request = IdentityBindingReadWire {
            source_binding_id: &source_binding_id,
            expected_local_owner: LocalOwnerWire::from(&owner),
        };
        let builder = self
            .transport
            .request(Method::POST, "./identity-bindings:read")?;
        let response = authorization
            .apply(builder.json(&request))
            .send()
            .await
            .map_err(crewon_provider_transport::classify_request_error)?;
        self.parse_response(response, Some(&source_binding_id), &owner, now)
            .await
    }

    async fn parse_response(
        &self,
        response: reqwest::Response,
        expected_source_binding_id: Option<&str>,
        expected_owner: &ProviderIdentitySourceOwner,
        now: i64,
    ) -> Result<ProviderIdentitySourceSnapshot, AgentPlatformProviderError> {
        let status = response.status();
        validate_json_content_type(response.headers())?;
        let body = self.transport.read_bounded_body(response).await?;
        if status == StatusCode::OK {
            let snapshot =
                ProviderIdentitySourceSnapshot::parse(&body, now).map_err(|error| match error {
                    ProviderIdentitySourceError::InvalidResponse => {
                        AgentPlatformProviderError::InvalidResponse
                    }
                    ProviderIdentitySourceError::NotFresh => {
                        AgentPlatformProviderError::Unavailable
                    }
                })?;
            let binding = snapshot.binding();
            if expected_source_binding_id
                .is_some_and(|expected| binding.source_binding_id() != expected)
                || binding.local_actor_id() != expected_owner.actor_id()
                || binding.local_tenant_id() != expected_owner.tenant_id()
                || binding.local_space_id() != expected_owner.space_id()
            {
                return Err(AgentPlatformProviderError::InvalidResponse);
            }
            return Ok(snapshot);
        }
        let error = serde_json::from_slice::<IdentitySourceErrorWire>(&body)
            .map_err(|_| AgentPlatformProviderError::InvalidResponse)?;
        map_identity_source_error(status, error)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityBindingReadWire<'a> {
    source_binding_id: &'a str,
    expected_local_owner: LocalOwnerWire<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalOwnerWire<'a> {
    actor_id: &'a str,
    tenant_id: &'a str,
    space_id: &'a str,
}

impl<'a> From<&'a ProviderIdentitySourceOwner> for LocalOwnerWire<'a> {
    fn from(owner: &'a ProviderIdentitySourceOwner) -> Self {
        Self {
            actor_id: owner.actor_id(),
            tenant_id: owner.tenant_id(),
            space_id: owner.space_id(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IdentitySourceErrorWire {
    code: IdentitySourceErrorCodeWire,
    retryable: bool,
    trace_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum IdentitySourceErrorCodeWire {
    Invalid,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Unavailable,
    Internal,
}

pub(crate) fn map_identity_source_error<T>(
    status: StatusCode,
    error: IdentitySourceErrorWire,
) -> Result<T, AgentPlatformProviderError> {
    if error.trace_id.is_empty()
        || error.trace_id.len() > 128
        || error.trace_id.chars().any(char::is_control)
    {
        return Err(AgentPlatformProviderError::InvalidResponse);
    }
    match (status, error.code, error.retryable) {
        (StatusCode::BAD_REQUEST, IdentitySourceErrorCodeWire::Invalid, false) => {
            Err(AgentPlatformProviderError::InvalidRequest)
        }
        (StatusCode::UNAUTHORIZED, IdentitySourceErrorCodeWire::Unauthorized, false)
        | (StatusCode::FORBIDDEN, IdentitySourceErrorCodeWire::Forbidden, false) => {
            Err(AgentPlatformProviderError::Unauthorized)
        }
        (StatusCode::NOT_FOUND, IdentitySourceErrorCodeWire::NotFound, false) => {
            Err(AgentPlatformProviderError::NotFound)
        }
        (StatusCode::CONFLICT, IdentitySourceErrorCodeWire::Conflict, false) => {
            Err(AgentPlatformProviderError::Conflict)
        }
        (StatusCode::SERVICE_UNAVAILABLE, IdentitySourceErrorCodeWire::Unavailable, true)
        | (StatusCode::INTERNAL_SERVER_ERROR, IdentitySourceErrorCodeWire::Internal, false) => {
            Err(AgentPlatformProviderError::Unavailable)
        }
        _ => Err(AgentPlatformProviderError::InvalidResponse),
    }
}

pub(crate) fn map_authorization(
    error: IdentitySourceAuthorizationError,
) -> AgentPlatformProviderError {
    match error {
        IdentitySourceAuthorizationError::Unavailable => AgentPlatformProviderError::Unavailable,
        IdentitySourceAuthorizationError::Unauthorized => AgentPlatformProviderError::Unauthorized,
    }
}

fn canonical_binding_id(value: String) -> Result<String, AgentPlatformProviderError> {
    let parsed = Uuid::parse_str(&value).map_err(|_| AgentPlatformProviderError::InvalidRequest)?;
    if parsed.to_string() != value {
        return Err(AgentPlatformProviderError::InvalidRequest);
    }
    Ok(value)
}
