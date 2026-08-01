use std::fmt;
use std::future;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use jsonwebtoken::Algorithm;
use jsonwebtoken::EncodingKey;
use jsonwebtoken::Header;
use jsonwebtoken::encode;
use serde::Serialize;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::DelegationToken;
use crate::DiscoveryAuthorizationOperation;
use crate::ProviderAuthorizationError;
use crate::ProviderAuthorizationHeaders;
use crate::ProviderAuthorizationRequest;
use crate::ProviderAuthorizer;
use crate::ProviderRunAuthorizationBinding;
use crate::RunAuthorizationOperation;
use crate::ServiceBearerToken;
use crate::rs256_dynamic_authorizer::issue_dynamic_delegation;
use crate::wire::ResourceRefWire;

const ISSUER: &str = "crewon";
const SERVICE_TOKEN_AUDIENCE: &str = "agent-platform-provider-api";
const SERVICE_SUBJECT: &str = "crewon-app-server";
const SERVICE_AUDIENCE: &str = "crewon-task-control";
const RUN_DELEGATION_AUDIENCE: &str = "agent-platform-provider-run";
const DISCOVERY_DELEGATION_AUDIENCE: &str = "agent-platform-provider-discovery";
const RUN_PURPOSE: &str = "executeTask";
const DISCOVERY_PURPOSE: &str = "discoverResources";
const SERVICE_TOKEN_TYPE: &str = "crewon-service+jwt";
const RUN_DELEGATION_TOKEN_TYPE: &str = "crewon-delegation+jwt";
const DISCOVERY_DELEGATION_TOKEN_TYPE: &str = "crewon-discovery+jwt";
const TOKEN_LIFETIME_SECONDS: u64 = 5 * 60;
const MAX_IDENTIFIER_BYTES: usize = 255;
const MAX_AUDIENCE_BYTES: usize = 128;

/// Safe configuration failures for the RS256 Provider authorization issuer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum ProviderAuthorizationConfigurationError {
    #[error("provider authorization signing key is invalid")]
    InvalidSigningKey,
    #[error("provider authorization key id is invalid")]
    InvalidKeyId,
    #[error("provider authorization identity is invalid")]
    InvalidIdentity,
}

/// Server-owned identity fields required by the Agent Platform Provider verifier.
pub struct ProviderAuthorizationIdentitySpec {
    /// Canonical Agent Platform user subject in `user:<positive integer>` form.
    pub subject: String,
    /// Canonical positive Agent Platform tenant identifier.
    pub tenant_id: String,
    /// Canonical positive Agent Platform space identifier.
    pub space_id: String,
}

/// Validated Agent Platform user/tenant/space authority.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderAuthorizationIdentity {
    subject: String,
    tenant_id: String,
    space_id: String,
}

impl ProviderAuthorizationIdentity {
    /// Validates the exact identity produced by the future durable principal-owner mapping.
    pub fn new(
        spec: ProviderAuthorizationIdentitySpec,
    ) -> Result<Self, ProviderAuthorizationConfigurationError> {
        if !is_canonical_user_subject(&spec.subject)
            || !is_canonical_positive_integer(&spec.tenant_id, MAX_AUDIENCE_BYTES)
            || !is_canonical_positive_integer(&spec.space_id, MAX_AUDIENCE_BYTES)
        {
            return Err(ProviderAuthorizationConfigurationError::InvalidIdentity);
        }
        Ok(Self {
            subject: spec.subject,
            tenant_id: spec.tenant_id,
            space_id: spec.space_id,
        })
    }
}

impl fmt::Debug for ProviderAuthorizationIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderAuthorizationIdentity([REDACTED])")
    }
}

/// Parsed server-owned RSA private key used only for Provider JWT signing.
pub struct ProviderRs256SigningKey {
    key_id: String,
    encoding_key: EncodingKey,
}

impl ProviderRs256SigningKey {
    /// Parses owned RSA PEM bytes and clears the source buffer after configuration.
    pub fn from_owned_rsa_pem(
        key_id: impl Into<String>,
        private_key_pem: Vec<u8>,
    ) -> Result<Self, ProviderAuthorizationConfigurationError> {
        let private_key_pem = Zeroizing::new(private_key_pem);
        Self::from_rsa_pem(key_id, private_key_pem.as_slice())
    }

    /// Parses an RSA PEM private key and performs a signing probe during configuration.
    pub fn from_rsa_pem(
        key_id: impl Into<String>,
        private_key_pem: &[u8],
    ) -> Result<Self, ProviderAuthorizationConfigurationError> {
        let key_id = key_id.into();
        if !is_bounded_text(&key_id, MAX_IDENTIFIER_BYTES) || key_id.trim() != key_id {
            return Err(ProviderAuthorizationConfigurationError::InvalidKeyId);
        }
        let encoding_key = EncodingKey::from_rsa_pem(private_key_pem)
            .map_err(|_| ProviderAuthorizationConfigurationError::InvalidSigningKey)?;
        let signing_key = Self {
            key_id,
            encoding_key,
        };
        signing_key.sign(
            SERVICE_TOKEN_TYPE,
            &SigningProbe {
                purpose: "configurationProbe",
            },
        )?;
        Ok(signing_key)
    }

    fn sign<Claims>(
        &self,
        token_type: &str,
        claims: &Claims,
    ) -> Result<String, ProviderAuthorizationConfigurationError>
    where
        Claims: Serialize,
    {
        encode(
            &jose_header(token_type, &self.key_id),
            claims,
            &self.encoding_key,
        )
        .map_err(|_| ProviderAuthorizationConfigurationError::InvalidSigningKey)
    }

    pub(crate) fn issue<Claims>(
        &self,
        token_type: &str,
        claims: &Claims,
    ) -> Result<String, ProviderAuthorizationError>
    where
        Claims: Serialize,
    {
        encode(
            &jose_header(token_type, &self.key_id),
            claims,
            &self.encoding_key,
        )
        .map_err(|_| ProviderAuthorizationError::Unavailable)
    }
}

impl fmt::Debug for ProviderRs256SigningKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ProviderRs256SigningKey([REDACTED])")
    }
}

/// RS256 implementation of the strict Agent Platform Provider authorizer.
pub struct Rs256ProviderAuthorizer {
    signing_key: Arc<ProviderRs256SigningKey>,
    identity: ProviderAuthorizationIdentity,
}

impl Rs256ProviderAuthorizer {
    /// Creates an unregistered authorizer from server-owned key and mapped identity inputs.
    pub fn new(
        signing_key: ProviderRs256SigningKey,
        identity: ProviderAuthorizationIdentity,
    ) -> Self {
        Self::from_shared(Arc::new(signing_key), identity)
    }

    /// Creates an authorizer from one process-owned signing key and an exact mapped identity.
    pub fn from_shared(
        signing_key: Arc<ProviderRs256SigningKey>,
        identity: ProviderAuthorizationIdentity,
    ) -> Self {
        Self {
            signing_key,
            identity,
        }
    }

    fn authorize_request(
        &self,
        request: ProviderAuthorizationRequest,
    ) -> Result<ProviderAuthorizationHeaders, ProviderAuthorizationError> {
        let issued_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ProviderAuthorizationError::Unavailable)?
            .as_secs();
        let expires_at = issued_at
            .checked_add(TOKEN_LIFETIME_SECONDS)
            .ok_or(ProviderAuthorizationError::Unavailable)?;
        let service = self.service_token(issued_at, expires_at)?;
        let delegation = match request {
            ProviderAuthorizationRequest::Dynamic { operation, binding } => {
                issue_dynamic_delegation(
                    &self.signing_key,
                    &self.identity,
                    operation,
                    &binding,
                    issued_at,
                    expires_at,
                )?
            }
            ProviderAuthorizationRequest::Discovery(operation) => {
                self.discovery_token(operation, issued_at, expires_at)?
            }
            ProviderAuthorizationRequest::Run { operation, binding } => {
                self.run_token(operation, &binding, issued_at, expires_at)?
            }
        };
        ProviderAuthorizationHeaders::new(
            ServiceBearerToken::new(service)?,
            DelegationToken::new(delegation)?,
        )
    }

    fn service_token(
        &self,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<String, ProviderAuthorizationError> {
        self.signing_key.issue(
            SERVICE_TOKEN_TYPE,
            &ServiceClaims {
                registered: RegisteredClaims::new(
                    SERVICE_TOKEN_AUDIENCE,
                    SERVICE_SUBJECT,
                    issued_at,
                    expires_at,
                ),
                service_audience: SERVICE_AUDIENCE,
            },
        )
    }

    fn discovery_token(
        &self,
        operation: DiscoveryAuthorizationOperation,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<String, ProviderAuthorizationError> {
        self.signing_key.issue(
            DISCOVERY_DELEGATION_TOKEN_TYPE,
            &DiscoveryClaims {
                registered: RegisteredClaims::new(
                    DISCOVERY_DELEGATION_AUDIENCE,
                    &self.identity.subject,
                    issued_at,
                    expires_at,
                ),
                authorized_party: SERVICE_SUBJECT,
                tenant_id: &self.identity.tenant_id,
                space_id: &self.identity.space_id,
                scopes: [discovery_scope(operation)],
                purpose: DISCOVERY_PURPOSE,
            },
        )
    }

    fn run_token(
        &self,
        operation: RunAuthorizationOperation,
        binding: &ProviderRunAuthorizationBinding,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<String, ProviderAuthorizationError> {
        if !is_bounded_text(
            binding.resource().resource_id.as_str(),
            MAX_IDENTIFIER_BYTES,
        ) || !is_bounded_text(binding.resource().revision.as_str(), MAX_IDENTIFIER_BYTES)
        {
            return Err(ProviderAuthorizationError::Unauthorized);
        }
        let resource = ResourceRefWire::from_domain(binding.resource())
            .map_err(|_| ProviderAuthorizationError::Unauthorized)?;
        self.signing_key.issue(
            RUN_DELEGATION_TOKEN_TYPE,
            &RunClaims {
                registered: RegisteredClaims::new(
                    RUN_DELEGATION_AUDIENCE,
                    &self.identity.subject,
                    issued_at,
                    expires_at,
                ),
                authorized_party: SERVICE_SUBJECT,
                tenant_id: &self.identity.tenant_id,
                space_id: &self.identity.space_id,
                task_id: binding.task_id(),
                scopes: [run_scope(operation)],
                purpose: RUN_PURPOSE,
                credential: CredentialClaims {
                    credential_id: binding.credential_id(),
                    owner_subject: &self.identity.subject,
                    revision: binding.credential_revision(),
                },
                resource,
            },
        )
    }
}

impl ProviderAuthorizationIdentity {
    pub(crate) fn subject(&self) -> &str {
        &self.subject
    }

    pub(crate) fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    pub(crate) fn space_id(&self) -> &str {
        &self.space_id
    }
}

impl ProviderAuthorizer for Rs256ProviderAuthorizer {
    fn authorize(
        &self,
        request: ProviderAuthorizationRequest,
    ) -> impl Future<Output = Result<ProviderAuthorizationHeaders, ProviderAuthorizationError>> + Send
    {
        future::ready(self.authorize_request(request))
    }
}

impl fmt::Debug for Rs256ProviderAuthorizer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Rs256ProviderAuthorizer([REDACTED])")
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredClaims<'a> {
    iss: &'static str,
    aud: &'a str,
    sub: &'a str,
    jti: String,
    iat: u64,
    exp: u64,
}

impl<'a> RegisteredClaims<'a> {
    fn new(audience: &'a str, subject: &'a str, issued_at: u64, expires_at: u64) -> Self {
        Self {
            iss: ISSUER,
            aud: audience,
            sub: subject,
            jti: Uuid::now_v7().to_string(),
            iat: issued_at,
            exp: expires_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceClaims<'a> {
    #[serde(flatten)]
    registered: RegisteredClaims<'a>,
    service_audience: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryClaims<'a> {
    #[serde(flatten)]
    registered: RegisteredClaims<'a>,
    #[serde(rename = "azp")]
    authorized_party: &'static str,
    tenant_id: &'a str,
    space_id: &'a str,
    scopes: [&'static str; 1],
    purpose: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialClaims<'a> {
    credential_id: &'a str,
    owner_subject: &'a str,
    revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunClaims<'a> {
    #[serde(flatten)]
    registered: RegisteredClaims<'a>,
    #[serde(rename = "azp")]
    authorized_party: &'static str,
    tenant_id: &'a str,
    space_id: &'a str,
    task_id: &'a str,
    scopes: [&'static str; 1],
    purpose: &'static str,
    credential: CredentialClaims<'a>,
    resource: ResourceRefWire,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SigningProbe {
    purpose: &'static str,
}

fn jose_header(token_type: &str, key_id: &str) -> Header {
    let mut header = Header::new(Algorithm::RS256);
    header.typ = Some(token_type.to_string());
    header.kid = Some(key_id.to_string());
    header
}

fn discovery_scope(operation: DiscoveryAuthorizationOperation) -> &'static str {
    match operation {
        DiscoveryAuthorizationOperation::ReadDescriptor => "provider:describe",
        DiscoveryAuthorizationOperation::ReadDynamicResource => "dynamicResource:read",
        DiscoveryAuthorizationOperation::ListResources => "resource:list",
        DiscoveryAuthorizationOperation::ReadResource => "resource:read",
    }
}

fn run_scope(operation: RunAuthorizationOperation) -> &'static str {
    match operation {
        RunAuthorizationOperation::Start => "providerRun:start",
        RunAuthorizationOperation::Read => "providerRun:read",
        RunAuthorizationOperation::ListEvents => "providerRun:events",
        RunAuthorizationOperation::Cancel => "providerRun:cancel",
        RunAuthorizationOperation::DecideApproval => "providerRun:approval",
        RunAuthorizationOperation::SubmitToolResult => "providerRun:toolResult",
    }
}

fn is_canonical_user_subject(subject: &str) -> bool {
    subject
        .strip_prefix("user:")
        .is_some_and(|user_id| is_canonical_positive_integer(user_id, MAX_IDENTIFIER_BYTES - 5))
        && subject.len() <= MAX_IDENTIFIER_BYTES
}

fn is_canonical_positive_integer(value: &str, max_bytes: usize) -> bool {
    if value.is_empty()
        || value.len() > max_bytes
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    value
        .parse::<u64>()
        .is_ok_and(|parsed| parsed > 0 && parsed.to_string() == value)
}

fn is_bounded_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}
