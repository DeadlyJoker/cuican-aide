use std::fmt;
use std::future::Future;

use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use reqwest::RequestBuilder;
use reqwest::header::AUTHORIZATION;
use reqwest::header::HeaderValue;
use zeroize::Zeroizing;

const DELEGATION_HEADER: &str = "x-crewon-delegation";
const MAX_TOKEN_BYTES: usize = 8 * 1024;
const MAX_AUTHORIZATION_REFERENCE_BYTES: usize = 255;
const PROVIDER_ID: &str = "agent-platform";
const PROTOCOL_VERSION: &str = "3.0.0";

/// Discovery operation for which a short-lived Provider delegation is requested.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryAuthorizationOperation {
    ReadDescriptor,
    ReadDynamicResource,
    ListResources,
    ReadResource,
}

/// Durable Run operation for which an exact delegated authority is requested.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunAuthorizationOperation {
    Start,
    Read,
    ListEvents,
    Cancel,
    DecideApproval,
    SubmitToolResult,
}

/// Dynamic Provider operation for which one exact short-lived delegation is requested.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DynamicAuthorizationOperation {
    Call,
    Search,
}

/// Exact non-secret binding covered by a Provider Tool or Knowledge delegation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderDynamicAuthorizationBinding {
    resource: ResourceRef,
    call_id: String,
    action_digest: String,
    credential_id: String,
    credential_revision: u64,
}

impl ProviderDynamicAuthorizationBinding {
    pub fn new(
        resource: ResourceRef,
        call_id: impl Into<String>,
        action_digest: impl Into<String>,
        credential_id: impl Into<String>,
        credential_revision: u64,
    ) -> Result<Self, ProviderAuthorizationError> {
        if resource.provider.provider_id.as_str() != PROVIDER_ID
            || resource.provider.protocol_version.as_str() != PROTOCOL_VERSION
            || !matches!(
                resource.kind,
                ResourceKind::McpTool | ResourceKind::KnowledgeBase
            )
            || credential_revision == 0
        {
            return Err(ProviderAuthorizationError::Unauthorized);
        }
        let action_digest = action_digest.into();
        if !is_sha256_digest(&action_digest) {
            return Err(ProviderAuthorizationError::Unauthorized);
        }
        Ok(Self {
            resource,
            call_id: bounded_reference(call_id.into())?,
            action_digest,
            credential_id: bounded_reference(credential_id.into())?,
            credential_revision,
        })
    }

    pub fn resource(&self) -> &ResourceRef {
        &self.resource
    }

    pub fn call_id(&self) -> &str {
        &self.call_id
    }

    pub fn action_digest(&self) -> &str {
        &self.action_digest
    }

    pub fn credential_id(&self) -> &str {
        &self.credential_id
    }

    pub fn credential_revision(&self) -> u64 {
        self.credential_revision
    }
}

/// Exact non-secret binding that every durable Run delegation must cover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunAuthorizationBinding {
    resource: ResourceRef,
    task_id: String,
    credential_id: String,
    credential_revision: u64,
}

impl ProviderRunAuthorizationBinding {
    /// Constructs an exact Agent Platform resource/task/credential binding.
    pub fn new(
        resource: ResourceRef,
        task_id: impl Into<String>,
        credential_id: impl Into<String>,
        credential_revision: u64,
    ) -> Result<Self, ProviderAuthorizationError> {
        if resource.provider.provider_id.as_str() != PROVIDER_ID
            || resource.provider.protocol_version.as_str() != PROTOCOL_VERSION
            || resource.kind != ResourceKind::Agent
        {
            return Err(ProviderAuthorizationError::Unauthorized);
        }
        if credential_revision == 0 {
            return Err(ProviderAuthorizationError::Unauthorized);
        }
        let task_id = bounded_reference(task_id.into())?;
        let credential_id = bounded_reference(credential_id.into())?;
        Ok(Self {
            resource,
            task_id,
            credential_id,
            credential_revision,
        })
    }

    /// Returns the exact immutable Provider resource revision.
    pub fn resource(&self) -> &ResourceRef {
        &self.resource
    }

    /// Returns the task identifier that must be present in the signed delegation.
    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    /// Returns the opaque Credential reference, never credential material.
    pub fn credential_id(&self) -> &str {
        &self.credential_id
    }

    /// Returns the exact Credential revision that the delegation must bind.
    pub fn credential_revision(&self) -> u64 {
        self.credential_revision
    }
}

/// Exact semantic request that an injected authorizer must sign.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProviderAuthorizationRequest {
    Dynamic {
        operation: DynamicAuthorizationOperation,
        binding: ProviderDynamicAuthorizationBinding,
    },
    Discovery(DiscoveryAuthorizationOperation),
    Run {
        operation: RunAuthorizationOperation,
        binding: ProviderRunAuthorizationBinding,
    },
}

/// Closed authorizer failure categories that do not expose token or signing details.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum ProviderAuthorizationError {
    #[error("provider authorization is unavailable")]
    Unavailable,
    #[error("provider authorization was rejected")]
    Unauthorized,
}

/// Supplies short-lived service and delegation credentials for one exact Provider operation.
///
/// Implementations are expected to bind tokens to the server-resolved actor, tenant, space, and
/// requested operation. They must not return a wildcard resource authority or a long-lived user
/// access token.
pub trait ProviderAuthorizer: Send + Sync {
    fn authorize(
        &self,
        request: ProviderAuthorizationRequest,
    ) -> impl Future<Output = Result<ProviderAuthorizationHeaders, ProviderAuthorizationError>> + Send;
}

macro_rules! sensitive_token {
    ($name:ident, $max:expr) => {
        pub struct $name(Zeroizing<String>);

        impl $name {
            /// Constructs a bounded token without exposing its value through Debug or Display.
            pub fn new(value: impl Into<String>) -> Result<Self, ProviderAuthorizationError> {
                let value = Zeroizing::new(value.into());
                if value.is_empty()
                    || value.len() > $max
                    || HeaderValue::from_str(value.as_str()).is_err()
                {
                    return Err(ProviderAuthorizationError::Unauthorized);
                }
                Ok(Self(value))
            }

            fn as_str(&self) -> &str {
                self.0.as_str()
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(concat!(stringify!($name), "([REDACTED])"))
            }
        }
    };
}

sensitive_token!(ServiceBearerToken, MAX_TOKEN_BYTES - 7);
sensitive_token!(DelegationToken, MAX_TOKEN_BYTES);

/// Opaque sensitive headers returned by a Provider authorizer.
pub struct ProviderAuthorizationHeaders {
    authorization: HeaderValue,
    delegation: HeaderValue,
}

impl ProviderAuthorizationHeaders {
    /// Builds sensitive headers from separately typed service and delegation tokens.
    pub fn new(
        service_token: ServiceBearerToken,
        delegation_token: DelegationToken,
    ) -> Result<Self, ProviderAuthorizationError> {
        let authorization_value = Zeroizing::new(format!("Bearer {}", service_token.as_str()));
        let mut authorization = HeaderValue::from_str(authorization_value.as_str())
            .map_err(|_| ProviderAuthorizationError::Unauthorized)?;
        let mut delegation = HeaderValue::from_str(delegation_token.as_str())
            .map_err(|_| ProviderAuthorizationError::Unauthorized)?;
        authorization.set_sensitive(true);
        delegation.set_sensitive(true);
        Ok(Self {
            authorization,
            delegation,
        })
    }

    pub(crate) fn apply(self, request: RequestBuilder) -> RequestBuilder {
        request
            .header(AUTHORIZATION, self.authorization)
            .header(DELEGATION_HEADER, self.delegation)
    }
}

impl fmt::Debug for ProviderAuthorizationHeaders {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderAuthorizationHeaders")
            .field("authorization", &"[REDACTED]")
            .field("delegation", &"[REDACTED]")
            .finish()
    }
}

fn bounded_reference(value: String) -> Result<String, ProviderAuthorizationError> {
    if value.is_empty()
        || value.len() > MAX_AUTHORIZATION_REFERENCE_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(ProviderAuthorizationError::Unauthorized);
    }
    Ok(value)
}

fn is_sha256_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

#[cfg(test)]
#[path = "authorization_tests.rs"]
mod tests;
