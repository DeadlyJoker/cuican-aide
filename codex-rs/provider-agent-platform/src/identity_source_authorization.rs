use std::fmt;
use std::future::Future;

use reqwest::RequestBuilder;
use reqwest::header::AUTHORIZATION;
use reqwest::header::HeaderValue;
use zeroize::Zeroizing;

const PRINCIPAL_ASSERTION_HEADER: &str = "x-crewon-principal-assertion";
const MAX_TOKEN_BYTES: usize = 8 * 1024;
const MAX_SCOPE_BYTES: usize = 128;

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderIdentitySourceOwner {
    actor_id: String,
    tenant_id: String,
    space_id: String,
}

impl ProviderIdentitySourceOwner {
    pub fn new(
        actor_id: impl Into<String>,
        tenant_id: impl Into<String>,
        space_id: impl Into<String>,
    ) -> Result<Self, IdentitySourceAuthorizationError> {
        let actor_id = actor_id.into();
        let tenant_id = tenant_id.into();
        let space_id = space_id.into();
        validate_principal(&actor_id)?;
        validate_positive_integer(&tenant_id)?;
        validate_positive_integer(&space_id)?;
        Ok(Self {
            actor_id,
            tenant_id,
            space_id,
        })
    }

    pub fn actor_id(&self) -> &str {
        &self.actor_id
    }

    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    pub fn space_id(&self) -> &str {
        &self.space_id
    }
}

impl fmt::Debug for ProviderIdentitySourceOwner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderIdentitySourceOwner([REDACTED])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum IdentitySourceAuthorizationRequest {
    Resolve {
        owner: ProviderIdentitySourceOwner,
    },
    Read {
        source_binding_id: String,
        owner: ProviderIdentitySourceOwner,
    },
    SessionIssue {
        source_binding_id: String,
        owner: ProviderIdentitySourceOwner,
    },
    RevocationRead,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum IdentitySourceAuthorizationError {
    #[error("identity source authorization is unavailable")]
    Unavailable,
    #[error("identity source authorization was rejected")]
    Unauthorized,
}

/// Supplies operation-specific service authority and bootstrap principal assertions.
pub trait IdentitySourceAuthorizer: Send + Sync {
    fn authorize(
        &self,
        request: IdentitySourceAuthorizationRequest,
    ) -> impl Future<
        Output = Result<IdentitySourceAuthorizationHeaders, IdentitySourceAuthorizationError>,
    > + Send;
}

macro_rules! sensitive_token {
    ($name:ident) => {
        pub struct $name(Zeroizing<String>);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IdentitySourceAuthorizationError> {
                let value = Zeroizing::new(value.into());
                if value.is_empty()
                    || value.len() > MAX_TOKEN_BYTES
                    || HeaderValue::from_str(value.as_str()).is_err()
                {
                    return Err(IdentitySourceAuthorizationError::Unauthorized);
                }
                Ok(Self(value))
            }

            pub(crate) fn as_str(&self) -> &str {
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

sensitive_token!(IdentitySourceServiceToken);
sensitive_token!(IdentitySourcePrincipalAssertion);

pub struct IdentitySourceAuthorizationHeaders {
    authorization: HeaderValue,
    principal_assertion: Option<HeaderValue>,
}

impl IdentitySourceAuthorizationHeaders {
    pub fn resolve(
        service_token: IdentitySourceServiceToken,
        principal_assertion: IdentitySourcePrincipalAssertion,
    ) -> Result<Self, IdentitySourceAuthorizationError> {
        Ok(Self {
            authorization: bearer_header(service_token.as_str())?,
            principal_assertion: Some(sensitive_header(principal_assertion.as_str())?),
        })
    }

    pub fn read(
        service_token: IdentitySourceServiceToken,
    ) -> Result<Self, IdentitySourceAuthorizationError> {
        Ok(Self {
            authorization: bearer_header(service_token.as_str())?,
            principal_assertion: None,
        })
    }

    pub fn session_issue(
        service_token: IdentitySourceServiceToken,
        principal_assertion: IdentitySourcePrincipalAssertion,
    ) -> Result<Self, IdentitySourceAuthorizationError> {
        Self::resolve(service_token, principal_assertion)
    }

    pub fn revocation_read(
        service_token: IdentitySourceServiceToken,
    ) -> Result<Self, IdentitySourceAuthorizationError> {
        Self::read(service_token)
    }

    pub(crate) fn apply(self, request: RequestBuilder) -> RequestBuilder {
        let request = request.header(AUTHORIZATION, self.authorization);
        match self.principal_assertion {
            Some(principal_assertion) => {
                request.header(PRINCIPAL_ASSERTION_HEADER, principal_assertion)
            }
            None => request,
        }
    }
}

impl fmt::Debug for IdentitySourceAuthorizationHeaders {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IdentitySourceAuthorizationHeaders")
            .field("authorization", &"[REDACTED]")
            .field("principal_assertion", &"[REDACTED]")
            .finish()
    }
}

fn bearer_header(token: &str) -> Result<HeaderValue, IdentitySourceAuthorizationError> {
    let value = Zeroizing::new(format!("Bearer {token}"));
    sensitive_header(value.as_str())
}

fn sensitive_header(value: &str) -> Result<HeaderValue, IdentitySourceAuthorizationError> {
    let mut header =
        HeaderValue::from_str(value).map_err(|_| IdentitySourceAuthorizationError::Unauthorized)?;
    header.set_sensitive(true);
    Ok(header)
}

fn validate_principal(value: &str) -> Result<(), IdentitySourceAuthorizationError> {
    let Some(digest) = value.strip_prefix("principal:") else {
        return Err(IdentitySourceAuthorizationError::Unauthorized);
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(IdentitySourceAuthorizationError::Unauthorized);
    }
    Ok(())
}

fn validate_positive_integer(value: &str) -> Result<(), IdentitySourceAuthorizationError> {
    if value.is_empty()
        || value.len() > MAX_SCOPE_BYTES
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || !value
            .parse::<u64>()
            .is_ok_and(|parsed| parsed > 0 && parsed.to_string() == value)
    {
        return Err(IdentitySourceAuthorizationError::Unauthorized);
    }
    Ok(())
}
