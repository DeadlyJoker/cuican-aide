use sqlx::Row;

use super::StateRuntime;
use super::provider_execution_storage::journal_from_row;
use super::provider_execution_storage::journal_query;
use super::provider_execution_storage::storage_i64;
use super::provider_execution_storage::storage_u64;
use crate::ProviderRunEventProjectionRecord;
use crate::ProviderRunJournalEventPage;
use crate::ProviderRunJournalEventPageQuery;
use crate::ProviderRunJournalEventRecord;
use crate::ProviderRunJournalRecord;

impl StateRuntime {
    /// Reads one bounded contiguous page of durable Provider event projections.
    ///
    /// The journal mapping and event rows are read from the same SQLite snapshot. Missing,
    /// metadata-only, non-contiguous, or digest-invalid event rows fail closed.
    pub async fn read_provider_run_journal_event_page(
        &self,
        query: &ProviderRunJournalEventPageQuery,
    ) -> anyhow::Result<Option<ProviderRunJournalEventPage>> {
        query.key.validate()?;
        if query.limit == 0 || query.limit > 100 {
            anyhow::bail!("invalid Provider Run event page limit");
        }
        let after_sequence = storage_i64(query.after_sequence, "providerAfterSequence")?;
        let mut tx = self.pool.begin().await?;
        let journal = journal_query()
            .bind(&query.key.task_id)
            .bind(&query.key.attempt_id)
            .bind(&query.key.worker_run_id)
            .fetch_optional(&mut *tx)
            .await?
            .map(journal_from_row)
            .transpose()?;
        let Some(journal) = journal else {
            tx.commit().await?;
            return Ok(None);
        };
        if query.after_sequence > journal.last_sequence {
            anyhow::bail!("Provider Run event page starts after the journal cursor");
        }
        let rows = sqlx::query(
            r#"
SELECT event_id, sequence, cursor, event_type, event_hash,
       payload_digest, projection_json, created_at
FROM provider_run_journal_events
WHERE provider_id = ? AND provider_run_id = ? AND sequence > ?
ORDER BY sequence ASC
LIMIT ?
            "#,
        )
        .bind(&journal.provider_id)
        .bind(&journal.provider_run_id)
        .bind(after_sequence)
        .bind(i64::from(query.limit))
        .fetch_all(&mut *tx)
        .await?;
        let events = rows
            .into_iter()
            .map(|row| event_from_row(row, &journal))
            .collect::<anyhow::Result<Vec<_>>>()?;
        validate_page_continuity(query, &journal, &events)?;
        tx.commit().await?;
        Ok(Some(ProviderRunJournalEventPage {
            journal_last_sequence: journal.last_sequence,
            events,
        }))
    }

    /// Reads one exact durable Provider event projection by journal sequence.
    pub async fn get_provider_run_journal_event_record(
        &self,
        key: &crate::ProviderRunJournalKey,
        sequence: u64,
    ) -> anyhow::Result<Option<ProviderRunJournalEventRecord>> {
        key.validate()?;
        if sequence == 0 {
            anyhow::bail!("invalid Provider Run event sequence");
        }
        let mut tx = self.pool.begin().await?;
        let journal = journal_query()
            .bind(&key.task_id)
            .bind(&key.attempt_id)
            .bind(&key.worker_run_id)
            .fetch_optional(&mut *tx)
            .await?
            .map(journal_from_row)
            .transpose()?;
        let Some(journal) = journal else {
            tx.commit().await?;
            return Ok(None);
        };
        let event = event_by_sequence(&mut tx, &journal, sequence).await?;
        tx.commit().await?;
        Ok(event)
    }
}

pub(super) async fn event_by_sequence(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    journal: &ProviderRunJournalRecord,
    sequence: u64,
) -> anyhow::Result<Option<ProviderRunJournalEventRecord>> {
    if sequence == 0 || sequence > journal.last_sequence {
        return Ok(None);
    }
    sqlx::query(
        r#"
SELECT event_id, sequence, cursor, event_type, event_hash,
       payload_digest, projection_json, created_at
FROM provider_run_journal_events
WHERE provider_id = ? AND provider_run_id = ? AND sequence = ?
        "#,
    )
    .bind(&journal.provider_id)
    .bind(&journal.provider_run_id)
    .bind(storage_i64(sequence, "providerSequence")?)
    .fetch_optional(&mut **tx)
    .await?
    .map(|row| event_from_row(row, journal))
    .transpose()
}

pub(super) fn event_from_row(
    row: sqlx::sqlite::SqliteRow,
    journal: &ProviderRunJournalRecord,
) -> anyhow::Result<ProviderRunJournalEventRecord> {
    let payload_digest = row
        .try_get::<Option<String>, _>("payload_digest")?
        .ok_or_else(|| anyhow::anyhow!("Provider Run event projection is missing"))?;
    let projection_json = row
        .try_get::<Option<String>, _>("projection_json")?
        .ok_or_else(|| anyhow::anyhow!("Provider Run event projection is missing"))?;
    let event_hash: String = row.try_get("event_hash")?;
    let event = ProviderRunJournalEventRecord {
        event_id: row.try_get("event_id")?,
        sequence: storage_u64(row.try_get("sequence")?, "providerSequence")?,
        cursor: row.try_get("cursor")?,
        event_type: row.try_get("event_type")?,
        projection: ProviderRunEventProjectionRecord {
            payload_digest,
            projection_json,
        },
        created_at: row.try_get("created_at")?,
    };
    event.validate(&journal.key.task_id)?;
    if event.canonical_hash(&journal.provider_run_id) != event_hash {
        anyhow::bail!("Provider Run event hash does not match its projection");
    }
    Ok(event)
}

fn validate_page_continuity(
    query: &ProviderRunJournalEventPageQuery,
    journal: &ProviderRunJournalRecord,
    events: &[ProviderRunJournalEventRecord],
) -> anyhow::Result<()> {
    let mut expected_sequence = query
        .after_sequence
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("Provider Run event sequence exhausted"))?;
    for event in events {
        if event.sequence != expected_sequence || event.sequence > journal.last_sequence {
            anyhow::bail!("Provider Run event page is not contiguous");
        }
        expected_sequence = expected_sequence
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Provider Run event sequence exhausted"))?;
    }
    if events.is_empty() && query.after_sequence < journal.last_sequence {
        anyhow::bail!("Provider Run event page is missing durable events");
    }
    if events.len() < query.limit as usize
        && events
            .last()
            .map_or(query.after_sequence, |event| event.sequence)
            != journal.last_sequence
    {
        anyhow::bail!("Provider Run event page ended before the journal cursor");
    }
    Ok(())
}
