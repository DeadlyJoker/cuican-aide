use crate::FencingTokenHash;
use crate::LeaseEpoch;
use crate::UnixTimestamp;
use serde::Deserialize;
use serde::Serialize;

/// Monotonic optimistic-concurrency version of the Task Aggregate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AggregateVersion(u64);

impl AggregateVersion {
    /// Constructs a persisted Aggregate version.
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    /// Returns the version of a new genesis Aggregate.
    pub const fn initial() -> Self {
        Self(0)
    }

    /// Returns the numeric Aggregate version.
    pub fn get(self) -> u64 {
        self.0
    }

    pub(crate) fn checked_next(self) -> Option<Self> {
        self.0.checked_add(1).map(Self)
    }
}

/// Authority-assigned monotonic cursor for a Task event stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TaskStreamOffset(u64);

impl TaskStreamOffset {
    /// Constructs an Authority-assigned Task stream cursor.
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    /// Returns the cursor before the first committed event.
    pub const fn initial() -> Self {
        Self(0)
    }

    /// Returns the numeric stream offset.
    pub fn get(self) -> u64 {
        self.0
    }

    pub(crate) fn checked_next(self) -> Option<Self> {
        self.0.checked_add(1).map(Self)
    }
}

/// The only component allowed to create Attempts and decide Task terminal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskAuthority {
    LocalAppServer,
    CloudTaskControl,
}

/// Closed first-version strategy set backed by real durable consumers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StrategyKind {
    Single,
    Office,
}

/// Deterministic lifecycle state of an authoritative Task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Created,
    Queued,
    Running,
    Suspended,
    Reconciling,
    Completed,
    Failed,
    Cancelled,
}

impl TaskStatus {
    /// Returns whether no future event may move the Task back to active state.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

/// Deterministic lifecycle state of an Authority-created Attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttemptStatus {
    Created,
    Started,
    Suspended,
    Unknown,
    Succeeded,
    Failed,
    Cancelled,
}

impl AttemptStatus {
    /// Returns whether the Attempt has a final known outcome.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

/// Reason an active Task cannot currently advance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SuspensionReason {
    ProviderPaused,
    ApprovalRequired,
    RetryDecision,
}

/// Immutable lease evidence attached to the current Worker claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeaseGrant {
    pub(crate) epoch: LeaseEpoch,
    pub(crate) fencing_token_hash: FencingTokenHash,
    pub(crate) expires_at: UnixTimestamp,
}

impl LeaseGrant {
    /// Constructs a lease from an Authority-issued token hash and expiry.
    pub fn new(
        epoch: LeaseEpoch,
        fencing_token_hash: FencingTokenHash,
        expires_at: UnixTimestamp,
    ) -> Self {
        Self {
            epoch,
            fencing_token_hash,
            expires_at,
        }
    }

    /// Returns the monotonic fencing epoch.
    pub fn epoch(&self) -> LeaseEpoch {
        self.epoch
    }

    /// Returns the token hash used to reject stale Workers.
    pub fn fencing_token_hash(&self) -> &FencingTokenHash {
        &self.fencing_token_hash
    }

    /// Returns the last timestamp accepted by this lease.
    pub fn expires_at(&self) -> UnixTimestamp {
        self.expires_at
    }

    /// Returns whether the lease was already expired at a received timestamp.
    pub fn is_expired_at(&self, received_at: UnixTimestamp) -> bool {
        received_at > self.expires_at
    }
}
