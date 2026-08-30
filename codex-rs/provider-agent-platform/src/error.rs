use crewon_provider_transport::ProviderEndpointPolicyError;
use crewon_resource_federation::ProviderError;

/// Safe, closed errors produced by the Agent Platform adapter.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum AgentPlatformProviderError {
    #[error("provider request is invalid")]
    InvalidRequest,
    #[error("provider request is unauthorized")]
    Unauthorized,
    #[error("provider resource was not found")]
    NotFound,
    #[error("provider request conflicts with current state")]
    Conflict,
    #[error("provider capability is incompatible")]
    Incompatible,
    #[error("provider response is invalid")]
    InvalidResponse,
    #[error("provider is unavailable")]
    Unavailable,
    #[error("provider request timed out")]
    Timeout,
    #[error("provider execution outcome is unknown")]
    UnknownOutcome,
    #[error("provider rate limit was reached")]
    RateLimited { retry_after_seconds: Option<u64> },
}

impl AgentPlatformProviderError {
    pub(crate) fn catalog_error(&self) -> ProviderError {
        match self {
            Self::InvalidRequest => ProviderError::InvalidResponse,
            Self::Unauthorized => ProviderError::Unauthorized,
            Self::NotFound => ProviderError::NotFound,
            Self::Incompatible => ProviderError::Incompatible,
            Self::Conflict | Self::InvalidResponse => ProviderError::InvalidResponse,
            Self::Unavailable | Self::Timeout | Self::UnknownOutcome | Self::RateLimited { .. } => {
                ProviderError::Unavailable
            }
        }
    }
}

impl From<ProviderEndpointPolicyError> for AgentPlatformProviderError {
    fn from(error: ProviderEndpointPolicyError) -> Self {
        match error {
            ProviderEndpointPolicyError::RequestTimeout => Self::Timeout,
            ProviderEndpointPolicyError::NetworkRequest
            | ProviderEndpointPolicyError::DnsResolution
            | ProviderEndpointPolicyError::EmptyDnsResult => Self::Unavailable,
            ProviderEndpointPolicyError::InvalidUrl
            | ProviderEndpointPolicyError::EmbeddedCredentials
            | ProviderEndpointPolicyError::QueryNotAllowed
            | ProviderEndpointPolicyError::FragmentNotAllowed
            | ProviderEndpointPolicyError::MissingHost
            | ProviderEndpointPolicyError::MissingPort
            | ProviderEndpointPolicyError::MetadataHost
            | ProviderEndpointPolicyError::ForbiddenAddress
            | ProviderEndpointPolicyError::MixedAddressClasses
            | ProviderEndpointPolicyError::SchemeNotAllowed
            | ProviderEndpointPolicyError::RedirectLimitExceeded
            | ProviderEndpointPolicyError::CrossOriginRedirect
            | ProviderEndpointPolicyError::CrossOriginRequest
            | ProviderEndpointPolicyError::ClientConfiguration
            | ProviderEndpointPolicyError::ResponseTooLarge => Self::InvalidResponse,
        }
    }
}
