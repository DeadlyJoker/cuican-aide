use crate::DeviceJournalError;
use crate::DeviceWorkspaceJournal;
use crate::MAX_JOURNAL_PAGE_SIZE;
use crate::WorkspaceJournalAcknowledgement;
use crate::WorkspaceJournalAcknowledgementPage;
use crate::WorkspaceJournalListQuery;
use crate::authority;
use crate::codec::valid_cursor;
use crate::records::load_execution;

impl DeviceWorkspaceJournal {
    pub async fn list_workspace_list_acknowledgements(
        &self,
        query: &WorkspaceJournalListQuery,
    ) -> Result<WorkspaceJournalAcknowledgementPage, DeviceJournalError> {
        if query.limit == 0
            || query.limit > MAX_JOURNAL_PAGE_SIZE
            || query
                .after_execution_id
                .as_deref()
                .is_some_and(|cursor| !valid_cursor(cursor))
        {
            return Err(authority("device_journal_query_invalid"));
        }
        let mut tx = self.pool.begin().await?;
        let fetch_limit = i64::from(query.limit) + 1;
        let execution_ids = if let Some(cursor) = &query.after_execution_id {
            sqlx::query_scalar::<_, String>(
                r#"
SELECT execution_id
FROM workspace_executions
WHERE execution_id > ? AND acknowledged_through > 0
ORDER BY execution_id
LIMIT ?
                "#,
            )
            .bind(cursor)
            .bind(fetch_limit)
            .fetch_all(&mut *tx)
            .await?
        } else {
            sqlx::query_scalar::<_, String>(
                r#"
SELECT execution_id
FROM workspace_executions
WHERE acknowledged_through > 0
ORDER BY execution_id
LIMIT ?
                "#,
            )
            .bind(fetch_limit)
            .fetch_all(&mut *tx)
            .await?
        };
        let has_more = execution_ids.len() > usize::from(query.limit);
        let selected = if has_more {
            &execution_ids[..usize::from(query.limit)]
        } else {
            &execution_ids
        };
        let mut acknowledgements = Vec::with_capacity(selected.len());
        for execution_id in selected {
            let execution = load_execution(&mut tx, execution_id)
                .await?
                .ok_or_else(|| authority("device_journal_authority_corrupt"))?;
            if execution.acknowledged_through == 0 {
                return Err(authority("device_journal_authority_corrupt"));
            }
            acknowledgements.push(WorkspaceJournalAcknowledgement {
                execution_id: execution.command.execution_id,
                through_sequence: execution.acknowledged_through,
            });
        }
        let next_cursor = if has_more {
            selected.last().cloned()
        } else {
            None
        };
        tx.commit().await?;
        Ok(WorkspaceJournalAcknowledgementPage {
            acknowledgements,
            next_cursor,
        })
    }
}
