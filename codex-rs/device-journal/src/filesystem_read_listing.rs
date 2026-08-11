use crate::DeviceJournalError;
use crate::DeviceWorkspaceJournal;
use crate::FilesystemReadJournalExecution;
use crate::MAX_JOURNAL_PAGE_SIZE;
use crate::WorkspaceJournalAcknowledgement;
use crate::WorkspaceJournalAcknowledgementPage;
use crate::authority;
use crate::filesystem_read::load;
use crate::filesystem_read_codec::valid_execution_id;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilesystemReadJournalListQuery {
    pub after_execution_id: Option<String>,
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FilesystemReadJournalPage {
    pub executions: Vec<FilesystemReadJournalExecution>,
    pub next_cursor: Option<String>,
}

impl DeviceWorkspaceJournal {
    pub async fn list_filesystem_read_acknowledgements(
        &self,
        query: &FilesystemReadJournalListQuery,
    ) -> Result<WorkspaceJournalAcknowledgementPage, DeviceJournalError> {
        if query.limit == 0
            || query.limit > MAX_JOURNAL_PAGE_SIZE
            || query
                .after_execution_id
                .as_deref()
                .is_some_and(|id| !valid_execution_id(id))
        {
            return Err(authority("device_journal_query_invalid"));
        }
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query_as::<_, (String, i64)>(
            "SELECT execution_id, acknowledged_through FROM filesystem_read_executions WHERE acknowledged_through > 0 AND (? IS NULL OR execution_id > ?) ORDER BY execution_id LIMIT ?",
        )
        .bind(query.after_execution_id.as_deref())
        .bind(query.after_execution_id.as_deref())
        .bind(i64::from(query.limit) + 1)
        .fetch_all(&mut *tx)
        .await?;
        let has_more = rows.len() > usize::from(query.limit);
        let selected = &rows[..rows.len().min(usize::from(query.limit))];
        let acknowledgements = selected
            .iter()
            .map(|(execution_id, through)| {
                Ok(WorkspaceJournalAcknowledgement {
                    execution_id: execution_id.clone(),
                    through_sequence: u64::try_from(*through)
                        .map_err(|_| authority("device_journal_authority_corrupt"))?,
                })
            })
            .collect::<Result<Vec<_>, DeviceJournalError>>()?;
        let next_cursor = has_more.then(|| selected.last().map(|row| row.0.clone())).flatten();
        tx.commit().await?;
        Ok(WorkspaceJournalAcknowledgementPage {
            acknowledgements,
            next_cursor,
        })
    }

    pub async fn list_unacknowledged_filesystem_reads(
        &self,
        query: &FilesystemReadJournalListQuery,
    ) -> Result<FilesystemReadJournalPage, DeviceJournalError> {
        if query.limit == 0
            || query.limit > MAX_JOURNAL_PAGE_SIZE
            || query
                .after_execution_id
                .as_deref()
                .is_some_and(|id| !valid_execution_id(id))
        {
            return Err(authority("device_journal_query_invalid"));
        }
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT execution_id FROM filesystem_read_executions WHERE (? IS NULL OR execution_id > ?) AND acknowledged_through < CASE WHEN EXISTS (SELECT 1 FROM filesystem_read_events WHERE filesystem_read_events.execution_id = filesystem_read_executions.execution_id AND sequence = 2) THEN 2 ELSE 1 END ORDER BY execution_id LIMIT ?",
        )
        .bind(query.after_execution_id.as_deref())
        .bind(query.after_execution_id.as_deref())
        .bind(i64::from(query.limit) + 1)
        .fetch_all(&mut *tx)
        .await?;
        let has_more = rows.len() > usize::from(query.limit);
        let selected = &rows[..rows.len().min(usize::from(query.limit))];
        let mut executions = Vec::with_capacity(selected.len());
        for id in selected {
            executions.push(
                load(&mut tx, id)
                    .await?
                    .ok_or_else(|| authority("device_journal_authority_corrupt"))?,
            );
        }
        let next_cursor = has_more.then(|| selected.last().cloned()).flatten();
        tx.commit().await?;
        Ok(FilesystemReadJournalPage {
            executions,
            next_cursor,
        })
    }
}
