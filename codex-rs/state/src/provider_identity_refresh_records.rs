use std::fmt;

use crate::ProviderIdentityBindingRecord;
use crate::ProviderIdentityBindingRecordError;
use crate::ProviderIdentityBindingRecordErrorKind;
use crate::provider_identity_validation::error;
use crate::provider_identity_validation::validate_revision;
use crate::provider_identity_validation::validate_text;

const MAX_ID_BYTES: usize = 255;

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderIdentityBindingRefreshRequest {
    pub binding_id: String,
    pub expected_revision: u64,
    pub authority_id: String,
    pub source_binding_id: String,
    pub source_revision: u64,
    pub source_fresh_until: i64,
}

impl ProviderIdentityBindingRefreshRequest {
    pub(crate) fn validate(&self) -> Result<(), ProviderIdentityBindingRecordError> {
        validate_text(&self.binding_id, "bindingId", MAX_ID_BYTES)?;
        validate_revision(self.expected_revision, "expectedRevision")?;
        validate_text(&self.authority_id, "authorityId", MAX_ID_BYTES)?;
        validate_text(&self.source_binding_id, "sourceBindingId", MAX_ID_BYTES)?;
        validate_revision(self.source_revision, "sourceRevision")?;
        if self.source_fresh_until <= 0 {
            return Err(error(
                "sourceFreshUntil",
                ProviderIdentityBindingRecordErrorKind::OutOfRange,
            ));
        }
        Ok(())
    }
}

impl fmt::Debug for ProviderIdentityBindingRefreshRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderIdentityBindingRefreshRequest")
            .field("binding_id", &self.binding_id)
            .field("expected_revision", &self.expected_revision)
            .field("authority", &"[REDACTED]")
            .field("source_revision", &self.source_revision)
            .field("source_fresh_until", &self.source_fresh_until)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderIdentityBindingRefreshOutcome {
    Refreshed,
    ExistingFresh,
    NotFound,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderIdentityBindingPage {
    pub data: Vec<ProviderIdentityBindingRecord>,
    pub next_cursor: Option<String>,
}
