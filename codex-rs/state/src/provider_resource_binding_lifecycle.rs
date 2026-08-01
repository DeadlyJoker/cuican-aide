use std::fmt;

use crate::ProviderResourceBindingRecord;
use crate::ProviderResourceBindingRecordError;
use crate::provider_resource_binding_records::validate_binding_id;
use crate::provider_resource_binding_records::validate_resource_binding_owner;
use crate::provider_resource_binding_records::validate_resource_binding_revision;
use crate::provider_resource_binding_records::validate_resource_binding_timestamp;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderResourceBindingResolveOutcome {
    Created(ProviderResourceBindingRecord),
    Existing(ProviderResourceBindingRecord),
    Reactivated(ProviderResourceBindingRecord),
    ConnectionNotFound,
    WorkspaceNotFound,
    ParentMismatch,
    CapacityExceeded,
    Conflict,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderResourceBindingUnbindRequest {
    pub binding_id: String,
    pub local_actor_id: String,
    pub local_tenant_id: String,
    pub local_space_id: String,
    pub expected_revision: u64,
    pub unbound_at: i64,
}

impl ProviderResourceBindingUnbindRequest {
    pub(crate) fn validate(&self) -> Result<(), ProviderResourceBindingRecordError> {
        validate_binding_id(&self.binding_id)?;
        validate_resource_binding_owner(
            &self.local_actor_id,
            &self.local_tenant_id,
            &self.local_space_id,
        )?;
        validate_resource_binding_revision(self.expected_revision, "expectedRevision")?;
        validate_resource_binding_timestamp(self.unbound_at, "unboundAt")
    }
}

impl fmt::Debug for ProviderResourceBindingUnbindRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderResourceBindingUnbindRequest")
            .field("binding_id", &self.binding_id)
            .field("owner", &"[REDACTED]")
            .field("expected_revision", &self.expected_revision)
            .field("unbound_at", &self.unbound_at)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderResourceBindingUnbindOutcome {
    Unbound,
    ExistingUnbound,
    NotFound,
    Conflict,
}
