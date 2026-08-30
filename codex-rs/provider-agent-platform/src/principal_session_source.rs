use std::fmt;

use uuid::Uuid;
use zeroize::Zeroizing;

use crate::AgentPlatformProviderError;

pub(crate) const PRINCIPAL_SESSION_ISSUER: &str = "agent-platform";
const MAX_PRINCIPAL_SESSION_LIFETIME_SECONDS: i64 = 60 * 60;
const MAX_SEQUENCE: u64 = i64::MAX as u64;

/// Self-documenting input for one durable revocation stream cursor.
#[derive(Clone, PartialEq, Eq)]
pub struct PrincipalRevocationCursorSpec {
    /// Opaque canonical UUID identifying one durable stream generation.
    pub stream_id: String,
    /// Last durably consumed sequence in that stream.
    pub sequence: u64,
}

/// Validated, redacted cursor for one Agent Platform revocation stream.
#[derive(Clone, PartialEq, Eq)]
pub struct PrincipalRevocationCursor {
    stream_id: String,
    sequence: u64,
}

impl PrincipalRevocationCursor {
    /// Validates an externally supplied stream cursor.
    pub fn new(spec: PrincipalRevocationCursorSpec) -> Result<Self, AgentPlatformProviderError> {
        if spec.sequence > MAX_SEQUENCE || !is_canonical_uuid(&spec.stream_id) {
            return Err(AgentPlatformProviderError::InvalidRequest);
        }
        Ok(Self {
            stream_id: spec.stream_id,
            sequence: spec.sequence,
        })
    }

    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }
}

impl fmt::Debug for PrincipalRevocationCursorSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrincipalRevocationCursorSpec")
            .field("stream_id", &"[REDACTED]")
            .field("sequence", &self.sequence)
            .finish()
    }
}

/// Self-documenting input for one exact principal-session revocation.
#[derive(Clone, PartialEq, Eq)]
pub struct PrincipalRevocationSpec {
    /// Monotonic durable stream sequence.
    pub sequence: u64,
    /// Fixed principal-session issuer.
    pub issuer: String,
    /// Canonical UUID identifying the revoked JWT session.
    pub session_jti: String,
    /// Original verified JWT expiry as Unix seconds.
    pub expires_at: i64,
    /// Durable revocation time as Unix seconds.
    pub revoked_at: i64,
}

impl fmt::Debug for PrincipalRevocationCursor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrincipalRevocationCursor")
            .field("stream_id", &"[REDACTED]")
            .field("sequence", &self.sequence)
            .finish()
    }
}

/// Validated exact revocation without the raw bearer token.
#[derive(Clone, PartialEq, Eq)]
pub struct PrincipalRevocation {
    sequence: u64,
    issuer: String,
    session_jti: String,
    expires_at: i64,
    revoked_at: i64,
}

impl PrincipalRevocation {
    /// Validates an externally supplied revocation event.
    pub fn new(spec: PrincipalRevocationSpec) -> Result<Self, AgentPlatformProviderError> {
        if spec.sequence == 0
            || spec.sequence > MAX_SEQUENCE
            || spec.issuer != PRINCIPAL_SESSION_ISSUER
            || !is_canonical_uuid(&spec.session_jti)
            || spec.revoked_at < 0
            || spec.expires_at <= spec.revoked_at
            || spec.expires_at - spec.revoked_at > MAX_PRINCIPAL_SESSION_LIFETIME_SECONDS
        {
            return Err(AgentPlatformProviderError::InvalidRequest);
        }
        Ok(Self {
            sequence: spec.sequence,
            issuer: spec.issuer,
            session_jti: spec.session_jti,
            expires_at: spec.expires_at,
            revoked_at: spec.revoked_at,
        })
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    pub fn session_jti(&self) -> &str {
        &self.session_jti
    }

    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }

    pub fn revoked_at(&self) -> i64 {
        self.revoked_at
    }
}

impl fmt::Debug for PrincipalRevocationSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrincipalRevocationSpec")
            .field("sequence", &self.sequence)
            .field("issuer", &"[REDACTED]")
            .field("session_jti", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .field("revoked_at", &self.revoked_at)
            .finish()
    }
}

impl fmt::Debug for PrincipalRevocation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrincipalRevocation")
            .field("sequence", &self.sequence)
            .field("issuer", &"[REDACTED]")
            .field("session_jti", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .field("revoked_at", &self.revoked_at)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct PrincipalRevocationSnapshotPage {
    pub stream_id: String,
    pub watermark_sequence: u64,
    pub data: Vec<PrincipalRevocation>,
    pub next_after_sequence: Option<u64>,
}

impl PrincipalRevocationSnapshotPage {
    pub fn continuation_cursor(
        &self,
    ) -> Result<Option<PrincipalRevocationCursor>, AgentPlatformProviderError> {
        if self.next_after_sequence.is_some() {
            return Ok(None);
        }
        PrincipalRevocationCursor::new(PrincipalRevocationCursorSpec {
            stream_id: self.stream_id.clone(),
            sequence: self.watermark_sequence,
        })
        .map(Some)
    }
}

impl fmt::Debug for PrincipalRevocationSnapshotPage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrincipalRevocationSnapshotPage")
            .field("stream_id", &"[REDACTED]")
            .field("watermark_sequence", &self.watermark_sequence)
            .field("data", &self.data)
            .field("next_after_sequence", &self.next_after_sequence)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrincipalRevocationReadPage {
    pub data: Vec<PrincipalRevocation>,
    pub cursor: PrincipalRevocationCursor,
}

pub struct PrincipalSessionToken(Zeroizing<String>);

impl PrincipalSessionToken {
    pub(crate) fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    pub fn reveal_for_transport(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for PrincipalSessionToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PrincipalSessionToken([REDACTED])")
    }
}

pub struct PrincipalSessionIssued {
    pub token: PrincipalSessionToken,
    pub expires_at: i64,
    pub source_binding_id: String,
    pub source_revision: u64,
}

impl fmt::Debug for PrincipalSessionIssued {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrincipalSessionIssued")
            .field("token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .field("source_binding_id", &"[REDACTED]")
            .field("source_revision", &self.source_revision)
            .finish()
    }
}

fn is_canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}
