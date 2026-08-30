use std::collections::HashMap;
use std::fmt;
use std::future;
use std::future::Future;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use jsonwebtoken::Algorithm;
use jsonwebtoken::DecodingKey;
use jsonwebtoken::EncodingKey;
use jsonwebtoken::Header;
use jsonwebtoken::Validation;
use jsonwebtoken::decode;
use jsonwebtoken::decode_header;
use jsonwebtoken::encode;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::IdentitySourceAuthorizationError;
use crate::IdentitySourceAuthorizationHeaders;
use crate::IdentitySourceAuthorizationRequest;
use crate::IdentitySourceAuthorizer;
use crate::IdentitySourcePrincipalAssertion;
use crate::IdentitySourceServiceToken;
use crate::ProviderIdentitySourceOwner;

const SERVICE_ISSUER: &str = "crewon";
const SERVICE_AUDIENCE: &str = "agent-platform-identity-source-api";
const SERVICE_SUBJECT: &str = "crewon-app-server";
const SERVICE_TARGET: &str = "crewon-identity-source";
const SERVICE_TOKEN_TYPE: &str = "crewon-service+jwt";
const BOOTSTRAP_ISSUER: &str = "agent-platform";
const BOOTSTRAP_TOKEN_TYPE: &str = "crewon-principal+jwt";
const RESOLVE_SCOPE: &str = "identityBinding:resolve";
const READ_SCOPE: &str = "identityBinding:read";
const SESSION_ISSUE_SCOPE: &str = "principalSession:issue";
const REVOCATION_READ_SCOPE: &str = "principalRevocation:read";
const TOKEN_LIFETIME_SECONDS: u64 = 5 * 60;
const MAX_KEYS: usize = 16;
const MAX_KEY_BYTES: usize = 64 * 1024;
const MAX_TOKEN_BYTES: usize = 16 * 1024;
const MAX_CLOCK_SKEW_SECONDS: u64 = 30;
const MAX_IDENTIFIER_BYTES: usize = 255;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum IdentitySourceRs256ConfigurationError {
    #[error("identity source signing key is invalid")]
    InvalidSigningKey,
    #[error("identity source key id is invalid")]
    InvalidKeyId,
    #[error("identity source bootstrap trust is invalid")]
    InvalidBootstrapTrust,
}

/// Dedicated server-owned key for least-privilege identity-source service JWTs.
pub struct IdentitySourceRs256SigningKey {
    key_id: String,
    encoding_key: EncodingKey,
}

impl IdentitySourceRs256SigningKey {
    pub fn from_owned_rsa_pem(
        key_id: impl Into<String>,
        private_key_pem: Vec<u8>,
    ) -> Result<Self, IdentitySourceRs256ConfigurationError> {
        let private_key_pem = Zeroizing::new(private_key_pem);
        Self::from_rsa_pem(key_id, private_key_pem.as_slice())
    }

    pub fn from_rsa_pem(
        key_id: impl Into<String>,
        private_key_pem: &[u8],
    ) -> Result<Self, IdentitySourceRs256ConfigurationError> {
        let key_id = key_id.into();
        if !is_bounded_text(&key_id, MAX_IDENTIFIER_BYTES) || key_id.trim() != key_id {
            return Err(IdentitySourceRs256ConfigurationError::InvalidKeyId);
        }
        if private_key_pem.is_empty() || private_key_pem.len() > MAX_KEY_BYTES {
            return Err(IdentitySourceRs256ConfigurationError::InvalidSigningKey);
        }
        let encoding_key = EncodingKey::from_rsa_pem(private_key_pem)
            .map_err(|_| IdentitySourceRs256ConfigurationError::InvalidSigningKey)?;
        let signing_key = Self {
            key_id,
            encoding_key,
        };
        signing_key
            .sign(
                SERVICE_TOKEN_TYPE,
                &SigningProbe {
                    purpose: "configurationProbe",
                },
            )
            .map_err(|_| IdentitySourceRs256ConfigurationError::InvalidSigningKey)?;
        Ok(signing_key)
    }

    fn issue_service_token(
        &self,
        scope: &'static str,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<IdentitySourceServiceToken, IdentitySourceAuthorizationError> {
        let token = self
            .sign(
                SERVICE_TOKEN_TYPE,
                &IdentitySourceServiceClaims {
                    registered: RegisteredClaims::new(issued_at, expires_at),
                    service_audience: SERVICE_TARGET,
                    scopes: [scope],
                },
            )
            .map_err(|_| IdentitySourceAuthorizationError::Unavailable)?;
        IdentitySourceServiceToken::new(token)
    }

    fn sign<Claims>(&self, token_type: &str, claims: &Claims) -> Result<String, ()>
    where
        Claims: Serialize,
    {
        encode(
            &jose_header(token_type, &self.key_id),
            claims,
            &self.encoding_key,
        )
        .map_err(|_| ())
    }
}

impl fmt::Debug for IdentitySourceRs256SigningKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("IdentitySourceRs256SigningKey([REDACTED])")
    }
}

#[derive(Clone)]
pub struct IdentitySourceBootstrapRs256Verifier {
    keys: HashMap<String, DecodingKey>,
    max_clock_skew_seconds: i64,
}

impl IdentitySourceBootstrapRs256Verifier {
    pub fn new(
        trusted_public_keys: HashMap<String, String>,
        max_clock_skew_seconds: u64,
    ) -> Result<Self, IdentitySourceRs256ConfigurationError> {
        if trusted_public_keys.is_empty()
            || trusted_public_keys.len() > MAX_KEYS
            || max_clock_skew_seconds > MAX_CLOCK_SKEW_SECONDS
        {
            return Err(IdentitySourceRs256ConfigurationError::InvalidBootstrapTrust);
        }
        let mut keys = HashMap::with_capacity(trusted_public_keys.len());
        for (key_id, public_key) in trusted_public_keys {
            if !is_bounded_text(&key_id, MAX_IDENTIFIER_BYTES)
                || public_key.is_empty()
                || public_key.len() > MAX_KEY_BYTES
            {
                return Err(IdentitySourceRs256ConfigurationError::InvalidBootstrapTrust);
            }
            let decoding_key = DecodingKey::from_rsa_pem(public_key.as_bytes())
                .map_err(|_| IdentitySourceRs256ConfigurationError::InvalidBootstrapTrust)?;
            keys.insert(key_id, decoding_key);
        }
        Ok(Self {
            keys,
            max_clock_skew_seconds: max_clock_skew_seconds as i64,
        })
    }

    pub fn verify(
        &self,
        token: impl Into<String>,
        now: i64,
    ) -> Result<VerifiedBootstrapPrincipal, IdentitySourceAuthorizationError> {
        let token = Zeroizing::new(token.into());
        if token.is_empty() || token.len() > MAX_TOKEN_BYTES || now < 0 {
            return Err(IdentitySourceAuthorizationError::Unauthorized);
        }
        let header = decode_header(token.as_str())
            .map_err(|_| IdentitySourceAuthorizationError::Unauthorized)?;
        if header.alg != Algorithm::RS256
            || header.typ.as_deref() != Some(BOOTSTRAP_TOKEN_TYPE)
            || header.jku.is_some()
            || header.jwk.is_some()
            || header.x5u.is_some()
            || header.x5c.is_some()
        {
            return Err(IdentitySourceAuthorizationError::Unauthorized);
        }
        let key_id = header
            .kid
            .ok_or(IdentitySourceAuthorizationError::Unauthorized)?;
        let key = self
            .keys
            .get(&key_id)
            .ok_or(IdentitySourceAuthorizationError::Unauthorized)?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.required_spec_claims.clear();
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.validate_aud = false;
        let claims = decode::<BootstrapPrincipalClaims>(token.as_str(), key, &validation)
            .map_err(|_| IdentitySourceAuthorizationError::Unauthorized)?
            .claims;
        let owner = claims.into_owner(now, self.max_clock_skew_seconds)?;
        let assertion = IdentitySourcePrincipalAssertion::new(token.to_string())?;
        Ok(VerifiedBootstrapPrincipal { owner, assertion })
    }
}

impl fmt::Debug for IdentitySourceBootstrapRs256Verifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IdentitySourceBootstrapRs256Verifier")
            .field("keys", &"[REDACTED]")
            .field("max_clock_skew_seconds", &self.max_clock_skew_seconds)
            .finish()
    }
}

pub struct VerifiedBootstrapPrincipal {
    owner: ProviderIdentitySourceOwner,
    assertion: IdentitySourcePrincipalAssertion,
}

impl VerifiedBootstrapPrincipal {
    pub fn owner(&self) -> ProviderIdentitySourceOwner {
        self.owner.clone()
    }
}

impl fmt::Debug for VerifiedBootstrapPrincipal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("VerifiedBootstrapPrincipal([REDACTED])")
    }
}

/// Issues operation-specific service JWTs and attaches one verified bootstrap when required.
pub struct Rs256IdentitySourceAuthorizer {
    signing_key: Arc<IdentitySourceRs256SigningKey>,
    bootstrap: Option<VerifiedBootstrapPrincipal>,
}

impl Rs256IdentitySourceAuthorizer {
    pub fn service_only(signing_key: Arc<IdentitySourceRs256SigningKey>) -> Self {
        Self {
            signing_key,
            bootstrap: None,
        }
    }

    pub fn with_bootstrap(
        signing_key: Arc<IdentitySourceRs256SigningKey>,
        bootstrap: VerifiedBootstrapPrincipal,
    ) -> Self {
        Self {
            signing_key,
            bootstrap: Some(bootstrap),
        }
    }

    fn authorize_request(
        &self,
        request: IdentitySourceAuthorizationRequest,
    ) -> Result<IdentitySourceAuthorizationHeaders, IdentitySourceAuthorizationError> {
        let issued_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| IdentitySourceAuthorizationError::Unavailable)?
            .as_secs();
        let expires_at = issued_at
            .checked_add(TOKEN_LIFETIME_SECONDS)
            .ok_or(IdentitySourceAuthorizationError::Unavailable)?;
        match request {
            IdentitySourceAuthorizationRequest::Resolve { owner } => {
                self.principal_headers(owner, RESOLVE_SCOPE, issued_at, expires_at)
            }
            IdentitySourceAuthorizationRequest::SessionIssue { owner, .. } => {
                self.principal_headers(owner, SESSION_ISSUE_SCOPE, issued_at, expires_at)
            }
            IdentitySourceAuthorizationRequest::Read { .. } => {
                IdentitySourceAuthorizationHeaders::read(
                    self.signing_key
                        .issue_service_token(READ_SCOPE, issued_at, expires_at)?,
                )
            }
            IdentitySourceAuthorizationRequest::RevocationRead => {
                IdentitySourceAuthorizationHeaders::revocation_read(
                    self.signing_key.issue_service_token(
                        REVOCATION_READ_SCOPE,
                        issued_at,
                        expires_at,
                    )?,
                )
            }
        }
    }

    fn principal_headers(
        &self,
        owner: ProviderIdentitySourceOwner,
        scope: &'static str,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<IdentitySourceAuthorizationHeaders, IdentitySourceAuthorizationError> {
        let bootstrap = self
            .bootstrap
            .as_ref()
            .ok_or(IdentitySourceAuthorizationError::Unauthorized)?;
        if bootstrap.owner != owner {
            return Err(IdentitySourceAuthorizationError::Unauthorized);
        }
        let service = self
            .signing_key
            .issue_service_token(scope, issued_at, expires_at)?;
        let assertion = IdentitySourcePrincipalAssertion::new(bootstrap.assertion.as_str())?;
        match scope {
            RESOLVE_SCOPE => IdentitySourceAuthorizationHeaders::resolve(service, assertion),
            SESSION_ISSUE_SCOPE => {
                IdentitySourceAuthorizationHeaders::session_issue(service, assertion)
            }
            _ => Err(IdentitySourceAuthorizationError::Unauthorized),
        }
    }
}

impl IdentitySourceAuthorizer for Rs256IdentitySourceAuthorizer {
    fn authorize(
        &self,
        request: IdentitySourceAuthorizationRequest,
    ) -> impl Future<
        Output = Result<IdentitySourceAuthorizationHeaders, IdentitySourceAuthorizationError>,
    > + Send {
        future::ready(self.authorize_request(request))
    }
}

impl fmt::Debug for Rs256IdentitySourceAuthorizer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Rs256IdentitySourceAuthorizer([REDACTED])")
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredClaims {
    iss: &'static str,
    aud: &'static str,
    sub: &'static str,
    jti: String,
    iat: u64,
    exp: u64,
}

impl RegisteredClaims {
    fn new(issued_at: u64, expires_at: u64) -> Self {
        Self {
            iss: SERVICE_ISSUER,
            aud: SERVICE_AUDIENCE,
            sub: SERVICE_SUBJECT,
            jti: Uuid::now_v7().to_string(),
            iat: issued_at,
            exp: expires_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentitySourceServiceClaims {
    #[serde(flatten)]
    registered: RegisteredClaims,
    service_audience: &'static str,
    scopes: [&'static str; 1],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SigningProbe {
    purpose: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BootstrapPrincipalClaims {
    iss: String,
    aud: String,
    sub: String,
    jti: String,
    iat: i64,
    exp: i64,
    azp: String,
    actor_id: String,
    auth_session_id: String,
    auth_epoch: i64,
    tenant_id: String,
    space_id: String,
    scopes: Vec<String>,
}

impl BootstrapPrincipalClaims {
    fn into_owner(
        self,
        now: i64,
        max_clock_skew_seconds: i64,
    ) -> Result<ProviderIdentitySourceOwner, IdentitySourceAuthorizationError> {
        if self.iss != BOOTSTRAP_ISSUER
            || self.aud != SERVICE_AUDIENCE
            || self.azp != SERVICE_SUBJECT
            || self.iat < 0
            || self.iat > now.saturating_add(max_clock_skew_seconds)
            || self.exp <= now
            || self.exp <= self.iat
            || self.exp - self.iat > TOKEN_LIFETIME_SECONDS as i64
            || self.scopes != [RESOLVE_SCOPE]
            || !canonical_uuid(&self.jti)
            || !canonical_uuid(&self.auth_session_id)
            || self.auth_epoch <= 0
            || !canonical_positive_subject(&self.sub)
            || self.actor_id != stable_actor_id(&self.iss, &self.sub)
        {
            return Err(IdentitySourceAuthorizationError::Unauthorized);
        }
        ProviderIdentitySourceOwner::new(self.actor_id, self.tenant_id, self.space_id)
    }
}

fn jose_header(token_type: &str, key_id: &str) -> Header {
    let mut header = Header::new(Algorithm::RS256);
    header.typ = Some(token_type.to_string());
    header.kid = Some(key_id.to_string());
    header
}

fn stable_actor_id(issuer: &str, subject: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"crewon.authenticated-principal.v1\0");
    digest.update((issuer.len() as u64).to_be_bytes());
    digest.update(issuer.as_bytes());
    digest.update((subject.len() as u64).to_be_bytes());
    digest.update(subject.as_bytes());
    format!("principal:{:x}", digest.finalize())
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

fn canonical_positive_subject(value: &str) -> bool {
    value
        .strip_prefix("user:")
        .is_some_and(canonical_positive_integer)
}

fn canonical_positive_integer(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value
            .parse::<u64>()
            .is_ok_and(|parsed| parsed > 0 && parsed.to_string() == value)
}

fn is_bounded_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
