use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;
use std::fmt;

const MAX_ID_BYTES: usize = 256;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 512;
const MAX_SCHEMA_VERSION_BYTES: usize = 64;

/// Classification for bounded Task Runtime model validation failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelErrorKind {
    Empty,
    TooLong,
    ControlCharacter,
    InvalidHash,
    OutOfRange,
    TooManyItems,
    Duplicate,
    Mismatch,
}

/// Validation error that does not echo rejected external input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelError {
    field: &'static str,
    kind: ModelErrorKind,
}

impl ModelError {
    pub(crate) fn new(field: &'static str, kind: ModelErrorKind) -> Self {
        Self { field, kind }
    }

    pub(crate) fn too_many_items(field: &'static str) -> Self {
        Self::new(field, ModelErrorKind::TooManyItems)
    }

    /// Returns the field whose value failed validation.
    pub fn field(&self) -> &'static str {
        self.field
    }

    /// Returns the stable failure classification.
    pub fn kind(&self) -> ModelErrorKind {
        self.kind
    }
}

impl fmt::Display for ModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid task runtime field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for ModelError {}

macro_rules! bounded_text {
    ($(#[$meta:meta])* $name:ident, $field:literal, $max:expr) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Constructs a validated opaque value.
            pub fn new(value: impl Into<String>) -> Result<Self, ModelError> {
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
    /// Opaque stable identifier for one authoritative Task.
    TaskId,
    "taskId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Opaque stable identifier for an Authority-created Attempt.
    AttemptId,
    "attemptId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Opaque stable identifier for one Worker execution claim.
    WorkerRunId,
    "workerRunId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Opaque identifier used to deduplicate an Authority command.
    CommandId,
    "commandId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Opaque identifier used to deduplicate a committed Task event.
    EventId,
    "eventId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Stable idempotency key passed to a Worker executor.
    IdempotencyKey,
    "idempotencyKey",
    MAX_IDEMPOTENCY_KEY_BYTES
);
bounded_text!(
    /// Version of the immutable Task Contract schema.
    TaskContractSchemaVersion,
    "schemaVersion",
    MAX_SCHEMA_VERSION_BYTES
);
bounded_text!(
    /// Stable identifier for one transactional Outbox record.
    OutboxId,
    "outboxId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Opaque identifier of one immutable server-owned execution specification.
    ExecutionSpecId,
    "executionSpecId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Opaque run reference returned by a Worker executor.
    ExecutorRunRef,
    "executorRunRef",
    MAX_ID_BYTES
);

macro_rules! canonical_hash {
    ($(#[$meta:meta])* $name:ident, $field:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Parses a canonical `sha256:<64 lowercase hex>` hash.
            pub fn new(value: impl Into<String>) -> Result<Self, ModelError> {
                let value = value.into();
                validate_sha256(&value, $field)?;
                Ok(Self(value))
            }

            /// Returns the canonical hash text.
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

canonical_hash!(
    /// Canonical hash of an immutable Task Contract.
    ContractHash,
    "contractHash"
);
canonical_hash!(
    /// Hash of a fencing token; the original token never enters the Aggregate.
    FencingTokenHash,
    "fencingTokenHash"
);
canonical_hash!(
    /// Canonical hash of an immutable server-owned execution specification.
    ExecutionSpecDigest,
    "executionSpecDigest"
);

/// Non-zero ordinal assigned by the Authority to an Attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct AttemptOrdinal(u16);

impl AttemptOrdinal {
    /// Returns the first Authority-created Attempt ordinal.
    pub const fn first() -> Self {
        Self(1)
    }

    /// Constructs an ordinal starting at one.
    pub fn new(value: u16) -> Result<Self, ModelError> {
        if value == 0 {
            return Err(ModelError::new(
                "attemptOrdinal",
                ModelErrorKind::OutOfRange,
            ));
        }
        Ok(Self(value))
    }

    /// Returns the numeric ordinal.
    pub fn get(self) -> u16 {
        self.0
    }

    pub(crate) fn checked_next(self) -> Option<Self> {
        self.0.checked_add(1).map(Self)
    }
}

impl<'de> Deserialize<'de> for AttemptOrdinal {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = u16::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

/// Non-zero lease epoch used to fence an old Worker claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct LeaseEpoch(u64);

impl LeaseEpoch {
    /// Constructs a lease epoch starting at one.
    pub fn new(value: u64) -> Result<Self, ModelError> {
        if value == 0 {
            return Err(ModelError::new("leaseEpoch", ModelErrorKind::OutOfRange));
        }
        Ok(Self(value))
    }

    /// Returns the numeric lease epoch.
    pub fn get(self) -> u64 {
        self.0
    }

    pub(crate) fn checked_next(self) -> Option<Self> {
        self.0.checked_add(1).map(Self)
    }
}

impl<'de> Deserialize<'de> for LeaseEpoch {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

/// Strictly increasing sequence emitted by one current Worker run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ProducerSequence(u64);

impl ProducerSequence {
    /// Constructs a sequence starting at one for each Worker run.
    pub fn new(value: u64) -> Result<Self, ModelError> {
        if value == 0 {
            return Err(ModelError::new(
                "producerSequence",
                ModelErrorKind::OutOfRange,
            ));
        }
        Ok(Self(value))
    }

    /// Returns the numeric Worker sequence.
    pub fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for ProducerSequence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = u64::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

/// Non-negative Unix timestamp in integer seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct UnixTimestamp(i64);

impl UnixTimestamp {
    /// Constructs a non-negative timestamp.
    pub fn new(value: i64) -> Result<Self, ModelError> {
        if value < 0 {
            return Err(ModelError::new("timestamp", ModelErrorKind::OutOfRange));
        }
        Ok(Self(value))
    }

    /// Returns Unix seconds.
    pub fn get(self) -> i64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for UnixTimestamp {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = i64::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

fn validate_bounded_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), ModelError> {
    let kind = if value.trim().is_empty() {
        Some(ModelErrorKind::Empty)
    } else if value.len() > max_bytes {
        Some(ModelErrorKind::TooLong)
    } else if value.chars().any(char::is_control) {
        Some(ModelErrorKind::ControlCharacter)
    } else {
        None
    };
    if let Some(kind) = kind {
        return Err(ModelError::new(field, kind));
    }
    Ok(())
}

fn validate_sha256(value: &str, field: &'static str) -> Result<(), ModelError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(ModelError::new(field, ModelErrorKind::InvalidHash));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ModelError::new(field, ModelErrorKind::InvalidHash));
    }
    Ok(())
}
