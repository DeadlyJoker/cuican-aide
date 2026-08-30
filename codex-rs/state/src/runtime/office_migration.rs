use sqlx::Row;

use super::StateRuntime;
use super::durable_workspace::root_by_workspace_key;
use crate::OfficeLegacyWriteStatus;
use crate::OfficeMigrationAdvanceSource;
use crate::OfficeMigrationBeginImport;
use crate::OfficeMigrationCommit;
use crate::OfficeMigrationJournalRecord;
use crate::OfficeMigrationMutationOutcome;
use crate::OfficeMigrationPhase;
use crate::OfficeMigrationStart;
use crate::OfficeMigrationStartOutcome;

const MAX_OFFICE_MIGRATION_JOURNALS: i64 = 1_000;

impl StateRuntime {
    pub async fn start_office_migration(
        &self,
        request: &OfficeMigrationStart,
    ) -> anyhow::Result<OfficeMigrationStartOutcome> {
        request.validate()?;
        let proposed = request.journal_record();
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing) = journal_by_record_id(&mut tx, &request.record_id).await? {
            tx.rollback().await?;
            return Ok(if same_source(&existing, &proposed) {
                OfficeMigrationStartOutcome::Existing(existing)
            } else {
                OfficeMigrationStartOutcome::Conflict
            });
        }
        if root_by_workspace_key(&mut tx, &request.workspace_key)
            .await?
            .is_none()
        {
            tx.rollback().await?;
            return Ok(OfficeMigrationStartOutcome::WorkspaceNotFound);
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM office_migration_journals")
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_OFFICE_MIGRATION_JOURNALS {
            tx.rollback().await?;
            return Ok(OfficeMigrationStartOutcome::CapacityExceeded);
        }
        insert_journal(&mut tx, &proposed).await?;
        tx.commit().await?;
        Ok(OfficeMigrationStartOutcome::Started(proposed))
    }

    pub async fn begin_office_migration_import(
        &self,
        request: &OfficeMigrationBeginImport,
    ) -> anyhow::Result<OfficeMigrationMutationOutcome> {
        request.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(mut current) = journal_by_record_id(&mut tx, &request.record_id).await? else {
            tx.rollback().await?;
            return Ok(OfficeMigrationMutationOutcome::NotFound);
        };
        let replay_revision = request.expected_journal_revision.checked_add(1);
        if current.phase == OfficeMigrationPhase::Importing
            && current.source_digest == request.source_digest
            && Some(current.journal_revision) == replay_revision
            && current.updated_at == request.updated_at
        {
            tx.rollback().await?;
            return Ok(OfficeMigrationMutationOutcome::Existing(current));
        }
        if current.phase != OfficeMigrationPhase::Quiescing
            || current.source_digest != request.source_digest
            || current.journal_revision != request.expected_journal_revision
            || request.updated_at < current.updated_at
        {
            tx.rollback().await?;
            return Ok(OfficeMigrationMutationOutcome::Conflict);
        }
        let expected_revision = current.journal_revision;
        current.phase = OfficeMigrationPhase::Importing;
        current.journal_revision = current
            .journal_revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Office migration journal revision overflow"))?;
        current.updated_at = request.updated_at;
        current.record_hash = current.canonical_hash();
        current.validate()?;
        if !update_journal(
            &mut tx,
            &current,
            expected_revision,
            OfficeMigrationPhase::Quiescing,
        )
        .await?
        {
            tx.rollback().await?;
            return Ok(OfficeMigrationMutationOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(OfficeMigrationMutationOutcome::Updated(current))
    }

    pub async fn advance_office_migration_source(
        &self,
        request: &OfficeMigrationAdvanceSource,
    ) -> anyhow::Result<OfficeMigrationMutationOutcome> {
        request.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(mut current) = journal_by_record_id(&mut tx, &request.record_id).await? else {
            tx.rollback().await?;
            return Ok(OfficeMigrationMutationOutcome::NotFound);
        };
        let replay_revision = request.expected_journal_revision.checked_add(1);
        if current.phase == OfficeMigrationPhase::Quiescing
            && current.source_revision == request.source_revision
            && current.source_digest == request.source_digest
            && current.source_bytes == request.source_bytes
            && Some(current.journal_revision) == replay_revision
            && current.updated_at == request.updated_at
        {
            tx.rollback().await?;
            return Ok(OfficeMigrationMutationOutcome::Existing(current));
        }
        if current.phase != OfficeMigrationPhase::Quiescing
            || current.source_digest != request.expected_source_digest
            || current.journal_revision != request.expected_journal_revision
            || request.updated_at < current.updated_at
        {
            tx.rollback().await?;
            return Ok(OfficeMigrationMutationOutcome::Conflict);
        }
        if current.source_revision == request.source_revision
            && current.source_digest == request.source_digest
            && current.source_bytes == request.source_bytes
        {
            tx.rollback().await?;
            return Ok(OfficeMigrationMutationOutcome::Existing(current));
        }
        let expected_revision = current.journal_revision;
        current.source_revision.clone_from(&request.source_revision);
        current.source_digest.clone_from(&request.source_digest);
        current.source_bytes = request.source_bytes;
        current.journal_revision = current
            .journal_revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Office migration journal revision overflow"))?;
        current.updated_at = request.updated_at;
        current.record_hash = current.canonical_hash();
        current.validate()?;
        if !update_quiescing_source(
            &mut tx,
            &current,
            expected_revision,
            &request.expected_source_digest,
        )
        .await?
        {
            tx.rollback().await?;
            return Ok(OfficeMigrationMutationOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(OfficeMigrationMutationOutcome::Updated(current))
    }

    pub async fn commit_office_migration(
        &self,
        request: &OfficeMigrationCommit,
    ) -> anyhow::Result<OfficeMigrationMutationOutcome> {
        request.validate()?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(mut current) = journal_by_record_id(&mut tx, &request.record_id).await? else {
            tx.rollback().await?;
            return Ok(OfficeMigrationMutationOutcome::NotFound);
        };
        if matches!(
            current.phase,
            OfficeMigrationPhase::Imported | OfficeMigrationPhase::Active
        ) {
            let replay_revision = request.expected_journal_revision.checked_add(1);
            let revision_matches = match current.phase {
                OfficeMigrationPhase::Imported => Some(current.journal_revision) == replay_revision,
                OfficeMigrationPhase::Active => {
                    replay_revision.is_some_and(|revision| current.journal_revision >= revision)
                }
                OfficeMigrationPhase::Quiescing | OfficeMigrationPhase::Importing => false,
            };
            let same = current.source_digest == request.source_digest
                && revision_matches
                && current.snapshot_digest.as_deref() == Some(&request.snapshot_digest)
                && current.snapshot_json.as_deref() == Some(&request.snapshot_json)
                && current.imported_at == Some(request.imported_at);
            tx.rollback().await?;
            return Ok(if same {
                OfficeMigrationMutationOutcome::Existing(current)
            } else {
                OfficeMigrationMutationOutcome::Conflict
            });
        }
        if current.phase != OfficeMigrationPhase::Importing
            || current.source_digest != request.source_digest
            || current.journal_revision != request.expected_journal_revision
            || request.imported_at < current.updated_at
        {
            tx.rollback().await?;
            return Ok(OfficeMigrationMutationOutcome::Conflict);
        }
        let expected_revision = current.journal_revision;
        current.phase = OfficeMigrationPhase::Imported;
        current.journal_revision = current
            .journal_revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Office migration journal revision overflow"))?;
        current.snapshot_digest = Some(request.snapshot_digest.clone());
        current.snapshot_json = Some(request.snapshot_json.clone());
        current.updated_at = request.imported_at;
        current.imported_at = Some(request.imported_at);
        current.record_hash = current.canonical_hash();
        current.validate()?;
        if !update_journal(
            &mut tx,
            &current,
            expected_revision,
            OfficeMigrationPhase::Importing,
        )
        .await?
        {
            tx.rollback().await?;
            return Ok(OfficeMigrationMutationOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(OfficeMigrationMutationOutcome::Updated(current))
    }

    pub async fn get_office_migration_journal(
        &self,
        record_id: &str,
    ) -> anyhow::Result<Option<OfficeMigrationJournalRecord>> {
        validate_lookup_id(record_id)?;
        journal_query()
            .bind(record_id)
            .fetch_optional(self.pool.as_ref())
            .await?
            .map(journal_from_row)
            .transpose()
    }

    pub async fn office_legacy_write_status(
        &self,
        record_id: &str,
    ) -> anyhow::Result<OfficeLegacyWriteStatus> {
        Ok(match self.get_office_migration_journal(record_id).await? {
            Some(record) => OfficeLegacyWriteStatus::Fenced {
                phase: record.phase,
                journal_revision: record.journal_revision,
            },
            None => OfficeLegacyWriteStatus::Writable,
        })
    }
}

async fn journal_by_record_id(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record_id: &str,
) -> anyhow::Result<Option<OfficeMigrationJournalRecord>> {
    journal_query()
        .bind(record_id)
        .fetch_optional(&mut **tx)
        .await?
        .map(journal_from_row)
        .transpose()
}

fn journal_query() -> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT record_id, workspace_key, source_revision, source_digest, source_bytes,
       phase, journal_revision, snapshot_digest, snapshot_json, record_hash,
       started_at, updated_at, imported_at
FROM office_migration_journals
WHERE record_id = ?
        "#,
    )
}

fn journal_from_row(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<OfficeMigrationJournalRecord> {
    let record = OfficeMigrationJournalRecord {
        record_id: row.try_get("record_id")?,
        workspace_key: row.try_get("workspace_key")?,
        source_revision: row.try_get("source_revision")?,
        source_digest: row.try_get("source_digest")?,
        source_bytes: u64::try_from(row.try_get::<i64, _>("source_bytes")?)?,
        phase: OfficeMigrationPhase::from_str(row.try_get("phase")?)?,
        journal_revision: u64::try_from(row.try_get::<i64, _>("journal_revision")?)?,
        snapshot_digest: row.try_get("snapshot_digest")?,
        snapshot_json: row.try_get("snapshot_json")?,
        record_hash: row.try_get("record_hash")?,
        started_at: row.try_get("started_at")?,
        updated_at: row.try_get("updated_at")?,
        imported_at: row.try_get("imported_at")?,
    };
    record.validate()?;
    Ok(record)
}

async fn insert_journal(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &OfficeMigrationJournalRecord,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
INSERT INTO office_migration_journals (
    record_id, workspace_key, source_revision, source_digest, source_bytes,
    phase, journal_revision, snapshot_digest, snapshot_json, record_hash,
    started_at, updated_at, imported_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&record.record_id)
    .bind(&record.workspace_key)
    .bind(&record.source_revision)
    .bind(&record.source_digest)
    .bind(i64::try_from(record.source_bytes)?)
    .bind(record.phase.as_str())
    .bind(i64::try_from(record.journal_revision)?)
    .bind(&record.snapshot_digest)
    .bind(&record.snapshot_json)
    .bind(&record.record_hash)
    .bind(record.started_at)
    .bind(record.updated_at)
    .bind(record.imported_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn update_journal(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &OfficeMigrationJournalRecord,
    expected_revision: u64,
    expected_phase: OfficeMigrationPhase,
) -> anyhow::Result<bool> {
    let result = sqlx::query(
        r#"
UPDATE office_migration_journals
SET phase = ?, journal_revision = ?, snapshot_digest = ?, snapshot_json = ?,
    record_hash = ?, updated_at = ?, imported_at = ?
WHERE record_id = ? AND journal_revision = ? AND phase = ? AND source_digest = ?
        "#,
    )
    .bind(record.phase.as_str())
    .bind(i64::try_from(record.journal_revision)?)
    .bind(&record.snapshot_digest)
    .bind(&record.snapshot_json)
    .bind(&record.record_hash)
    .bind(record.updated_at)
    .bind(record.imported_at)
    .bind(&record.record_id)
    .bind(i64::try_from(expected_revision)?)
    .bind(expected_phase.as_str())
    .bind(&record.source_digest)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

async fn update_quiescing_source(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &OfficeMigrationJournalRecord,
    expected_revision: u64,
    expected_source_digest: &str,
) -> anyhow::Result<bool> {
    let result = sqlx::query(
        r#"
UPDATE office_migration_journals
SET source_revision = ?, source_digest = ?, source_bytes = ?,
    journal_revision = ?, record_hash = ?, updated_at = ?
WHERE record_id = ? AND journal_revision = ? AND phase = 'quiescing'
  AND source_digest = ?
        "#,
    )
    .bind(&record.source_revision)
    .bind(&record.source_digest)
    .bind(i64::try_from(record.source_bytes)?)
    .bind(i64::try_from(record.journal_revision)?)
    .bind(&record.record_hash)
    .bind(record.updated_at)
    .bind(&record.record_id)
    .bind(i64::try_from(expected_revision)?)
    .bind(expected_source_digest)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

fn same_source(
    existing: &OfficeMigrationJournalRecord,
    proposed: &OfficeMigrationJournalRecord,
) -> bool {
    existing.record_id == proposed.record_id
        && existing.workspace_key == proposed.workspace_key
        && existing.source_revision == proposed.source_revision
        && existing.source_digest == proposed.source_digest
        && existing.source_bytes == proposed.source_bytes
}

fn validate_lookup_id(record_id: &str) -> anyhow::Result<()> {
    if record_id.is_empty()
        || record_id.trim() != record_id
        || record_id.len() > 128
        || record_id.chars().any(char::is_control)
    {
        anyhow::bail!("invalid Office migration recordId");
    }
    Ok(())
}
