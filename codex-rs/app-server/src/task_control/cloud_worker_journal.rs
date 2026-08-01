use crewon_state::ProviderRunJournalAdvanceOutcome;
use crewon_state::ProviderRunJournalAdvanceRecord;
use crewon_state::ProviderRunJournalCreateOutcome;
use crewon_state::ProviderRunJournalRecord;
use crewon_state::StateRuntime;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProviderRunJournalStoreError {
    BackendUnavailable,
}

/// Durable Provider Run mapping port used by CloudWorker coordination.
///
/// Implementations must preserve compare-or-insert identity and cursor CAS semantics.
pub(super) trait ProviderRunJournalStore: Send + Sync {
    fn read_for_attempt(
        &self,
        task_id: &str,
        attempt_id: &str,
    ) -> impl std::future::Future<
        Output = Result<Option<ProviderRunJournalRecord>, ProviderRunJournalStoreError>,
    > + Send;

    fn create(
        &self,
        record: &ProviderRunJournalRecord,
    ) -> impl std::future::Future<
        Output = Result<ProviderRunJournalCreateOutcome, ProviderRunJournalStoreError>,
    > + Send;

    fn advance(
        &self,
        record: &ProviderRunJournalAdvanceRecord,
    ) -> impl std::future::Future<
        Output = Result<ProviderRunJournalAdvanceOutcome, ProviderRunJournalStoreError>,
    > + Send;
}

impl ProviderRunJournalStore for StateRuntime {
    async fn read_for_attempt(
        &self,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<Option<ProviderRunJournalRecord>, ProviderRunJournalStoreError> {
        self.get_provider_run_journal_record_for_attempt(task_id, attempt_id)
            .await
            .map_err(|_| ProviderRunJournalStoreError::BackendUnavailable)
    }

    async fn create(
        &self,
        record: &ProviderRunJournalRecord,
    ) -> Result<ProviderRunJournalCreateOutcome, ProviderRunJournalStoreError> {
        self.create_provider_run_journal_record(record)
            .await
            .map_err(|_| ProviderRunJournalStoreError::BackendUnavailable)
    }

    async fn advance(
        &self,
        record: &ProviderRunJournalAdvanceRecord,
    ) -> Result<ProviderRunJournalAdvanceOutcome, ProviderRunJournalStoreError> {
        self.advance_provider_run_journal(record)
            .await
            .map_err(|_| ProviderRunJournalStoreError::BackendUnavailable)
    }
}
