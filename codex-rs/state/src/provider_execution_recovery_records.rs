use std::fmt;

use crate::ProviderRunJournalKey;
use crate::ProviderRunJournalRecord;

/// Bounded cursor query for non-terminal Provider Runs that need event supervision after restart.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderRunJournalRecoveryQuery {
    pub after: Option<ProviderRunJournalKey>,
    pub limit: u32,
}

impl fmt::Debug for ProviderRunJournalRecoveryQuery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRunJournalRecoveryQuery")
            .field("after", &self.after.as_ref().map(|_| "[REDACTED]"))
            .field("limit", &self.limit)
            .finish()
    }
}

/// Bounded due-page query for the supervised Provider event pump.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderRunSupervisionQuery {
    pub after: Option<ProviderRunJournalKey>,
    pub now: i64,
    pub limit: u32,
}

impl fmt::Debug for ProviderRunSupervisionQuery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRunSupervisionQuery")
            .field("after", &self.after.as_ref().map(|_| "[REDACTED]"))
            .field("now", &self.now)
            .field("limit", &self.limit)
            .finish()
    }
}

/// Durable poll state paired with the exact non-terminal Provider Run journal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunSupervisionRecord {
    pub journal: ProviderRunJournalRecord,
    pub poll_attempts: u64,
    pub available_at: i64,
    pub updated_at: i64,
}

/// CAS update that schedules the next supervised Provider event poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRunSupervisionUpdate {
    pub key: ProviderRunJournalKey,
    pub expected_poll_attempts: u64,
    pub expected_available_at: i64,
    pub next_poll_attempts: u64,
    pub available_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderRunSupervisionUpdateOutcome {
    Updated,
    Conflict,
    NotFound,
}
