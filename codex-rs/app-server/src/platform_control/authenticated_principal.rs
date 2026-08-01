use sha2::Digest;
use sha2::Sha256;
use std::fmt;

use crewon_app_server_transport::TransportAuthenticatedPrincipal;
use crewon_app_server_transport::TransportAuthenticatedPrincipalSource;
use crewon_app_server_transport::TransportPrincipalBinding;
use uuid::Uuid;

const MAX_AUTHORITY_ID_BYTES: usize = 255;
const MAX_SCOPE_ID_BYTES: usize = 128;
const MAX_AUTHENTICATED_LIFETIME_SECONDS: i64 = 60 * 60;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AuthenticatedPrincipalSource {
    WebSocketSignedBearer,
    WebSocketPrincipalSessionRs256,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) enum AuthenticatedPrincipalBinding {
    LegacyUnbound,
    AgentPlatform {
        source_binding_id: String,
        source_revision: u64,
    },
}

impl fmt::Debug for AuthenticatedPrincipalBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LegacyUnbound => formatter.write_str("LegacyUnbound"),
            Self::AgentPlatform {
                source_revision, ..
            } => formatter
                .debug_struct("AgentPlatform")
                .field("source_binding_id", &"[REDACTED]")
                .field("source_revision", source_revision)
                .finish(),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct AuthenticatedPrincipalSpec {
    pub(crate) source: AuthenticatedPrincipalSource,
    pub(crate) issuer: String,
    pub(crate) audience: String,
    pub(crate) subject: String,
    pub(crate) tenant_id: String,
    pub(crate) space_id: String,
    pub(crate) token_id: String,
    pub(crate) issued_at: i64,
    pub(crate) expires_at: i64,
    pub(crate) binding: AuthenticatedPrincipalBinding,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct AuthenticatedPrincipal {
    source: AuthenticatedPrincipalSource,
    issuer: String,
    audience: String,
    subject: String,
    tenant_id: String,
    space_id: String,
    token_id: String,
    issued_at: i64,
    expires_at: i64,
    stable_actor_id: String,
    binding: AuthenticatedPrincipalBinding,
}

impl AuthenticatedPrincipal {
    pub(crate) fn new(
        spec: AuthenticatedPrincipalSpec,
    ) -> Result<Self, AuthenticatedPrincipalError> {
        validate_id(&spec.issuer, MAX_AUTHORITY_ID_BYTES)?;
        validate_id(&spec.audience, MAX_AUTHORITY_ID_BYTES)?;
        validate_id(&spec.subject, MAX_AUTHORITY_ID_BYTES)?;
        validate_id(&spec.tenant_id, MAX_SCOPE_ID_BYTES)?;
        validate_id(&spec.space_id, MAX_SCOPE_ID_BYTES)?;
        validate_id(&spec.token_id, MAX_AUTHORITY_ID_BYTES)?;
        if spec.issued_at < 0
            || spec.expires_at <= spec.issued_at
            || spec.expires_at - spec.issued_at > MAX_AUTHENTICATED_LIFETIME_SECONDS
        {
            return Err(AuthenticatedPrincipalError::Invalid);
        }
        let stable_actor_id = stable_actor_id(&spec.issuer, &spec.subject);
        match (&spec.source, &spec.binding) {
            (
                AuthenticatedPrincipalSource::WebSocketSignedBearer,
                AuthenticatedPrincipalBinding::LegacyUnbound,
            ) => {}
            (
                AuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
                AuthenticatedPrincipalBinding::AgentPlatform {
                    source_binding_id,
                    source_revision,
                },
            ) if *source_revision > 0 && canonical_uuid(source_binding_id) => {}
            (
                AuthenticatedPrincipalSource::WebSocketSignedBearer,
                AuthenticatedPrincipalBinding::AgentPlatform { .. },
            )
            | (
                AuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
                AuthenticatedPrincipalBinding::LegacyUnbound,
            )
            | (
                AuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
                AuthenticatedPrincipalBinding::AgentPlatform { .. },
            ) => return Err(AuthenticatedPrincipalError::Invalid),
        }
        Ok(Self {
            source: spec.source,
            issuer: spec.issuer,
            audience: spec.audience,
            subject: spec.subject,
            tenant_id: spec.tenant_id,
            space_id: spec.space_id,
            token_id: spec.token_id,
            issued_at: spec.issued_at,
            expires_at: spec.expires_at,
            stable_actor_id,
            binding: spec.binding,
        })
    }

    pub(crate) fn stable_actor_id(&self) -> &str {
        &self.stable_actor_id
    }

    pub(crate) fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    pub(crate) fn space_id(&self) -> &str {
        &self.space_id
    }

    pub(crate) fn binding(&self) -> &AuthenticatedPrincipalBinding {
        &self.binding
    }

    pub(crate) fn from_verified_transport(
        principal: TransportAuthenticatedPrincipal,
    ) -> Result<Self, AuthenticatedPrincipalError> {
        let source = match principal.source() {
            TransportAuthenticatedPrincipalSource::WebSocketSignedBearer => {
                AuthenticatedPrincipalSource::WebSocketSignedBearer
            }
            TransportAuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256 => {
                AuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256
            }
        };
        let binding = match principal.binding() {
            TransportPrincipalBinding::LegacyUnbound => {
                AuthenticatedPrincipalBinding::LegacyUnbound
            }
            TransportPrincipalBinding::AgentPlatform {
                actor_id,
                source_binding_id,
                source_revision,
            } => {
                if actor_id != stable_actor_id(principal.issuer(), principal.subject()).as_str() {
                    return Err(AuthenticatedPrincipalError::Invalid);
                }
                AuthenticatedPrincipalBinding::AgentPlatform {
                    source_binding_id: source_binding_id.clone(),
                    source_revision: *source_revision,
                }
            }
        };
        Self::new(AuthenticatedPrincipalSpec {
            source,
            issuer: principal.issuer().to_string(),
            audience: principal.audience().to_string(),
            subject: principal.subject().to_string(),
            tenant_id: principal.tenant_id().to_string(),
            space_id: principal.space_id().to_string(),
            token_id: principal.token_id().to_string(),
            issued_at: principal.issued_at(),
            expires_at: principal.expires_at(),
            binding,
        })
    }
}

impl fmt::Debug for AuthenticatedPrincipal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthenticatedPrincipal")
            .field("source", &self.source)
            .field("issuer", &"[REDACTED]")
            .field("audience", &"[REDACTED]")
            .field("subject", &"[REDACTED]")
            .field("tenant_id", &"[REDACTED]")
            .field("space_id", &"[REDACTED]")
            .field("token_id", &"[REDACTED]")
            .field("issued_at", &self.issued_at)
            .field("expires_at", &self.expires_at)
            .field("stable_actor_id", &"[REDACTED]")
            .field("binding", &"[REDACTED]")
            .finish()
    }
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub(crate) enum AuthenticatedPrincipalError {
    #[error("authenticated principal is invalid")]
    Invalid,
}

fn validate_id(value: &str, max_bytes: usize) -> Result<(), AuthenticatedPrincipalError> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(AuthenticatedPrincipalError::Invalid);
    }
    Ok(())
}

fn stable_actor_id(issuer: &str, subject: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"crewon.authenticated-principal.v1\0");
    update_digest_part(&mut digest, issuer.as_bytes());
    update_digest_part(&mut digest, subject.as_bytes());
    let digest = digest.finalize();
    format!("principal:{digest:x}")
}

fn update_digest_part(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
}
