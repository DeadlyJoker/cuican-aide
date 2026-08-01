use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;
use sha2::Digest;
use sha2::Sha256;
use std::fmt;

/// Maximum number of bytes held by one first-version local payload.
pub const MAX_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;

const MAX_ID_BYTES: usize = 256;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 512;
const MAX_MEDIA_TYPE_BYTES: usize = 256;
const MAX_LOCATOR_BYTES: usize = 1_024;
const MAX_ERROR_CODE_BYTES: usize = 128;
const MAX_CURRENCY_CODE_BYTES: usize = 16;

/// Stable classification for validation failures without rejected input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactErrorKind {
    Empty,
    TooLong,
    ControlCharacter,
    InvalidDigest,
    OutOfRange,
    TooManyItems,
    Duplicate,
    Mismatch,
    SecretPayloadUnsupported,
}

/// Bounded domain validation error that never echoes payload or external text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactError {
    field: &'static str,
    kind: ArtifactErrorKind,
}

impl ArtifactError {
    pub(crate) const fn new(field: &'static str, kind: ArtifactErrorKind) -> Self {
        Self { field, kind }
    }

    pub(crate) const fn too_many(field: &'static str) -> Self {
        Self::new(field, ArtifactErrorKind::TooManyItems)
    }

    /// Returns the stable field name that failed validation.
    pub fn field(&self) -> &'static str {
        self.field
    }

    /// Returns the stable failure classification.
    pub fn kind(&self) -> ArtifactErrorKind {
        self.kind
    }
}

impl fmt::Display for ArtifactError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid artifact field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for ArtifactError {}

macro_rules! bounded_text {
    ($(#[$meta:meta])* $name:ident, $field:literal, $max:expr) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Constructs a validated opaque value.
            pub fn new(value: impl Into<String>) -> Result<Self, ArtifactError> {
                let value = value.into();
                validate_bounded_text(&value, $field, $max)?;
                Ok(Self(value))
            }

            /// Returns the validated opaque value.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(de::Error::custom)
            }
        }
    };
}

bounded_text!(
    /// Stable identifier of one logical Artifact.
    ArtifactId,
    "artifactId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Stable identifier of one payload body and tombstone.
    PayloadId,
    "payloadId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Stable identifier of one Audit Event.
    AuditEventId,
    "eventId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Stable identifier of one Evidence record.
    EvidenceId,
    "evidenceId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Stable identifier of one Citation record.
    CitationId,
    "citationId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Stable Artifact commit idempotency key.
    ArtifactIdempotencyKey,
    "artifactIdempotencyKey",
    MAX_IDEMPOTENCY_KEY_BYTES
);
bounded_text!(
    /// Stable standalone Audit append idempotency key.
    AuditIdempotencyKey,
    "auditIdempotencyKey",
    MAX_IDEMPOTENCY_KEY_BYTES
);
bounded_text!(
    /// Stable Task execution run reference.
    RunId,
    "runId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Stable conversation thread reference.
    ThreadId,
    "threadId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Stable conversation turn reference.
    TurnId,
    "turnId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Stable trace identifier.
    TraceId,
    "traceId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Stable trace span identifier.
    SpanId,
    "spanId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Stable workspace scope identifier.
    WorkspaceScopeId,
    "workspaceScopeId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Bounded MIME media type.
    MediaType,
    "mediaType",
    MAX_MEDIA_TYPE_BYTES
);
bounded_text!(
    /// Bounded locator into evidence without copying evidence body.
    CitationLocator,
    "citationLocator",
    MAX_LOCATOR_BYTES
);
bounded_text!(
    /// Stable bounded failure code without raw error text.
    AuditErrorCode,
    "errorCode",
    MAX_ERROR_CODE_BYTES
);
bounded_text!(
    /// Bounded ISO-like currency code used with integer micros.
    CurrencyCode,
    "currencyCode",
    MAX_CURRENCY_CODE_BYTES
);

/// Positive immutable revision of an Artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ArtifactRevision(u64);

impl ArtifactRevision {
    /// Constructs a positive immutable revision.
    pub fn new(value: u64) -> Result<Self, ArtifactError> {
        if value == 0 {
            return Err(ArtifactError::new(
                "artifactRevision",
                ArtifactErrorKind::OutOfRange,
            ));
        }
        Ok(Self(value))
    }

    /// Returns the numeric revision.
    pub fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for ArtifactRevision {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(u64::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

/// Canonical SHA-256 digest of payload bytes.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct PayloadDigest(String);

impl PayloadDigest {
    /// Parses a canonical `sha256:<64 lowercase hex>` digest.
    pub fn new(value: impl Into<String>) -> Result<Self, ArtifactError> {
        let value = value.into();
        let Some(hex) = value.strip_prefix("sha256:") else {
            return Err(ArtifactError::new(
                "payloadDigest",
                ArtifactErrorKind::InvalidDigest,
            ));
        };
        if hex.len() != 64
            || !hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ArtifactError::new(
                "payloadDigest",
                ArtifactErrorKind::InvalidDigest,
            ));
        }
        Ok(Self(value))
    }

    /// Computes a canonical digest without retaining body bytes.
    pub fn compute(bytes: &[u8]) -> Self {
        let digest = Sha256::digest(bytes);
        Self(format!("sha256:{digest:x}"))
    }

    /// Returns the canonical digest text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PayloadDigest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

/// Storage sensitivity used to select an admissible payload store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PayloadSensitivity {
    Public,
    Internal,
    WorkspaceSensitive,
    Secret,
}

/// Bounded payload bytes that cannot be serialized and are redacted in Debug.
#[derive(Clone, PartialEq, Eq)]
pub struct PayloadBody {
    bytes: Vec<u8>,
    sensitivity: PayloadSensitivity,
}

impl PayloadBody {
    /// Builds a local plaintext payload, rejecting unsupported Secret content.
    pub fn new(
        bytes: impl Into<Vec<u8>>,
        sensitivity: PayloadSensitivity,
    ) -> Result<Self, ArtifactError> {
        if sensitivity == PayloadSensitivity::Secret {
            return Err(ArtifactError::new(
                "payloadSensitivity",
                ArtifactErrorKind::SecretPayloadUnsupported,
            ));
        }
        let bytes = bytes.into();
        if bytes.len() > MAX_PAYLOAD_BYTES {
            return Err(ArtifactError::new(
                "payloadBody",
                ArtifactErrorKind::TooLong,
            ));
        }
        Ok(Self { bytes, sensitivity })
    }

    /// Borrows the body only at an explicit persistence or delivery boundary.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Returns the bounded byte length.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Returns whether this payload has no bytes.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Computes the immutable payload identity.
    pub fn digest(&self) -> PayloadDigest {
        PayloadDigest::compute(&self.bytes)
    }

    /// Returns the classification selected before persistence.
    pub fn sensitivity(&self) -> PayloadSensitivity {
        self.sensitivity
    }
}

impl fmt::Debug for PayloadBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "PayloadBody(<redacted {} bytes>)",
            self.bytes.len()
        )
    }
}

fn validate_bounded_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), ArtifactError> {
    let kind = if value.trim().is_empty() {
        Some(ArtifactErrorKind::Empty)
    } else if value.len() > max_bytes {
        Some(ArtifactErrorKind::TooLong)
    } else if value.chars().any(char::is_control) {
        Some(ArtifactErrorKind::ControlCharacter)
    } else {
        None
    };
    if let Some(kind) = kind {
        return Err(ArtifactError::new(field, kind));
    }
    Ok(())
}
