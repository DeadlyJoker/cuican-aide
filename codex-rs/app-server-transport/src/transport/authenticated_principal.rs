use std::fmt;

use uuid::Uuid;

pub(super) const MAX_AUTHORITY_ID_BYTES: usize = 255;
const MAX_SCOPE_ID_BYTES: usize = 128;
pub(super) const MAX_AUTHENTICATED_LIFETIME_SECONDS: i64 = 60 * 60;

/// The trusted transport mechanism that verified a principal.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TransportAuthenticatedPrincipalSource {
    WebSocketSignedBearer,
    WebSocketPrincipalSessionRs256,
}

#[derive(Clone, Eq, PartialEq)]
pub enum TransportPrincipalBinding {
    LegacyUnbound,
    AgentPlatform {
        actor_id: String,
        source_binding_id: String,
        source_revision: u64,
    },
}

pub(super) struct TransportAuthenticatedPrincipalSpec {
    pub(super) source: TransportAuthenticatedPrincipalSource,
    pub(super) issuer: String,
    pub(super) audience: String,
    pub(super) subject: String,
    pub(super) tenant_id: String,
    pub(super) space_id: String,
    pub(super) token_id: String,
    pub(super) issued_at: i64,
    pub(super) expires_at: i64,
    pub(super) binding: TransportPrincipalBinding,
}

/// Principal claims that were verified by a trusted app-server transport.
///
/// This type has no public constructor. Callers outside the transport crate can
/// consume verified claims but cannot manufacture trusted transport identity.
#[derive(Clone, Eq, PartialEq)]
pub struct TransportAuthenticatedPrincipal {
    source: TransportAuthenticatedPrincipalSource,
    issuer: String,
    audience: String,
    subject: String,
    tenant_id: String,
    space_id: String,
    token_id: String,
    issued_at: i64,
    expires_at: i64,
    binding: TransportPrincipalBinding,
}

impl TransportAuthenticatedPrincipal {
    pub(super) fn new(
        spec: TransportAuthenticatedPrincipalSpec,
    ) -> Result<Self, TransportAuthenticatedPrincipalError> {
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
            return Err(TransportAuthenticatedPrincipalError);
        }
        match (&spec.source, &spec.binding) {
            (
                TransportAuthenticatedPrincipalSource::WebSocketSignedBearer,
                TransportPrincipalBinding::LegacyUnbound,
            ) => {}
            (
                TransportAuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
                TransportPrincipalBinding::AgentPlatform {
                    actor_id,
                    source_binding_id,
                    source_revision,
                },
            ) => {
                validate_id(actor_id, MAX_AUTHORITY_ID_BYTES)?;
                if *source_revision == 0 || !canonical_uuid(source_binding_id) {
                    return Err(TransportAuthenticatedPrincipalError);
                }
            }
            (
                TransportAuthenticatedPrincipalSource::WebSocketSignedBearer,
                TransportPrincipalBinding::AgentPlatform { .. },
            )
            | (
                TransportAuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
                TransportPrincipalBinding::LegacyUnbound,
            ) => return Err(TransportAuthenticatedPrincipalError),
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
            binding: spec.binding,
        })
    }

    pub fn source(&self) -> TransportAuthenticatedPrincipalSource {
        self.source
    }

    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    pub fn audience(&self) -> &str {
        &self.audience
    }

    pub fn subject(&self) -> &str {
        &self.subject
    }

    pub fn tenant_id(&self) -> &str {
        &self.tenant_id
    }

    pub fn space_id(&self) -> &str {
        &self.space_id
    }

    pub fn token_id(&self) -> &str {
        &self.token_id
    }

    pub fn issued_at(&self) -> i64 {
        self.issued_at
    }

    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }

    pub fn binding(&self) -> &TransportPrincipalBinding {
        &self.binding
    }
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

impl fmt::Debug for TransportAuthenticatedPrincipal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TransportAuthenticatedPrincipal")
            .field("source", &self.source)
            .field("issuer", &"[REDACTED]")
            .field("audience", &"[REDACTED]")
            .field("subject", &"[REDACTED]")
            .field("tenant_id", &"[REDACTED]")
            .field("space_id", &"[REDACTED]")
            .field("token_id", &"[REDACTED]")
            .field("issued_at", &self.issued_at)
            .field("expires_at", &self.expires_at)
            .field("binding", &"[REDACTED]")
            .finish()
    }
}

impl fmt::Debug for TransportPrincipalBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LegacyUnbound => formatter.write_str("LegacyUnbound"),
            Self::AgentPlatform { .. } => formatter.write_str("AgentPlatform([REDACTED])"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct TransportAuthenticatedPrincipalError;

/// Authentication result attached to a newly opened transport connection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransportAuthentication {
    ConnectionScoped,
    AuthenticatedPrincipal(Box<TransportAuthenticatedPrincipal>),
}

impl TransportAuthentication {
    pub(super) fn expires_at(&self) -> Option<i64> {
        match self {
            Self::ConnectionScoped => None,
            Self::AuthenticatedPrincipal(principal) => Some(principal.expires_at()),
        }
    }
}

pub(super) fn validate_id(
    value: &str,
    max_bytes: usize,
) -> Result<(), TransportAuthenticatedPrincipalError> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(TransportAuthenticatedPrincipalError);
    }
    Ok(())
}
