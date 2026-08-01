use std::future::Future;

use crewon_provider_agent_platform::ProviderIdentitySourceSnapshot;
use crewon_state::ProviderIdentityBindingLookup;
use crewon_state::StateRuntime;

use super::provider_identity_refresh::apply_provider_identity_source_snapshot;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderIdentitySourceReadRequest {
    pub source_binding_id: String,
    pub expected_owner: ProviderIdentityBindingLookup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("provider identity source read failed")]
pub(crate) struct ProviderIdentitySourceReadError;

/// Reads one exact source binding using service-owned authority and bounded transport.
pub(crate) trait ProviderIdentitySourceReader: Send + Sync {
    fn read(
        &self,
        request: ProviderIdentitySourceReadRequest,
        now: i64,
    ) -> impl Future<
        Output = Result<ProviderIdentitySourceSnapshot, ProviderIdentitySourceReadError>,
    > + Send;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProviderIdentityRefreshSettings {
    page_size: u32,
    max_bindings: usize,
}

impl ProviderIdentityRefreshSettings {
    pub(crate) fn new(
        page_size: u32,
        max_bindings: usize,
    ) -> Result<Self, ProviderIdentityRefreshSupervisorError> {
        if page_size == 0 || page_size > 100 || max_bindings == 0 {
            return Err(ProviderIdentityRefreshSupervisorError::InvalidSettings);
        }
        Ok(Self {
            page_size,
            max_bindings,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ProviderIdentityRefreshSupervisorError {
    #[error("provider identity refresh settings are invalid")]
    InvalidSettings,
    #[error("provider identity refresh capacity was exceeded")]
    CapacityExceeded,
    #[error("provider identity refresh source is unavailable")]
    SourceUnavailable,
    #[error("provider identity refresh local state is unavailable")]
    StateUnavailable,
    #[error("provider identity refresh snapshot conflicts with local state")]
    SnapshotConflict,
}

#[derive(Debug)]
pub(crate) struct ReadyProviderIdentityMappings {
    refreshed_bindings: usize,
    completed_at: i64,
}

impl ReadyProviderIdentityMappings {
    pub(crate) fn refreshed_bindings(&self) -> usize {
        self.refreshed_bindings
    }

    pub(crate) fn completed_at(&self) -> i64 {
        self.completed_at
    }
}

pub(crate) struct ProviderIdentityRefreshSupervisor<'a, Reader> {
    state: &'a StateRuntime,
    reader: &'a Reader,
    settings: ProviderIdentityRefreshSettings,
}

impl<'a, Reader> ProviderIdentityRefreshSupervisor<'a, Reader>
where
    Reader: ProviderIdentitySourceReader,
{
    pub(crate) fn new(
        state: &'a StateRuntime,
        reader: &'a Reader,
        settings: ProviderIdentityRefreshSettings,
    ) -> Self {
        Self {
            state,
            reader,
            settings,
        }
    }

    pub(crate) async fn refresh_all(
        &self,
        now: i64,
    ) -> Result<ReadyProviderIdentityMappings, ProviderIdentityRefreshSupervisorError> {
        if now < 0 {
            return Err(ProviderIdentityRefreshSupervisorError::InvalidSettings);
        }
        let mut cursor = None;
        let mut refreshed_bindings = 0_usize;
        loop {
            let page = self
                .state
                .list_active_provider_identity_binding_records(
                    cursor.as_deref(),
                    self.settings.page_size,
                )
                .await
                .map_err(|_| ProviderIdentityRefreshSupervisorError::StateUnavailable)?;
            for record in page.data {
                if refreshed_bindings >= self.settings.max_bindings {
                    return Err(ProviderIdentityRefreshSupervisorError::CapacityExceeded);
                }
                let expected_owner = ProviderIdentityBindingLookup {
                    local_actor_id: record.local_actor_id,
                    local_tenant_id: record.local_tenant_id,
                    local_space_id: record.local_space_id,
                    provider_id: record.provider_id,
                };
                let expected_source_binding_id = record.source_binding_id;
                let snapshot = self
                    .reader
                    .read(
                        ProviderIdentitySourceReadRequest {
                            source_binding_id: expected_source_binding_id.clone(),
                            expected_owner: expected_owner.clone(),
                        },
                        now,
                    )
                    .await
                    .map_err(|_| ProviderIdentityRefreshSupervisorError::SourceUnavailable)?;
                if snapshot.binding().source_binding_id() != expected_source_binding_id {
                    return Err(ProviderIdentityRefreshSupervisorError::SnapshotConflict);
                }
                apply_provider_identity_source_snapshot(self.state, &expected_owner, &snapshot)
                    .await
                    .map_err(|error| match error {
                        super::provider_identity_refresh::ProviderIdentityRefreshError::StateUnavailable => {
                            ProviderIdentityRefreshSupervisorError::StateUnavailable
                        }
                        super::provider_identity_refresh::ProviderIdentityRefreshError::OwnerMismatch
                        | super::provider_identity_refresh::ProviderIdentityRefreshError::Conflict => {
                            ProviderIdentityRefreshSupervisorError::SnapshotConflict
                        }
                    })?;
                refreshed_bindings += 1;
            }
            let Some(next_cursor) = page.next_cursor else {
                break;
            };
            cursor = Some(next_cursor);
        }
        Ok(ReadyProviderIdentityMappings {
            refreshed_bindings,
            completed_at: now,
        })
    }
}
