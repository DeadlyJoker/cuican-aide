use std::path::Path;

use crewon_device_protocol::DeviceWorkspaceListAck;
use crewon_device_protocol::DeviceWorkspaceListCommand;
use crewon_device_protocol::DeviceWorkspaceListEvent;
use sqlx::SqlitePool;

use crate::AcknowledgeWorkspaceListOutcome;
use crate::DeviceJournalError;
use crate::MAX_JOURNAL_PAGE_SIZE;
use crate::PrepareWorkspaceListOutcome;
use crate::PrepareWorkspaceListWithAdmissionError;
use crate::PrepareWorkspaceListWithAdmissionOutcome;
use crate::RecordTerminalOutcome;
use crate::WorkspaceJournalExecution;
use crate::WorkspaceJournalListQuery;
use crate::WorkspaceJournalPage;
use crate::authority;
use crate::codec::EncodedAck;
use crate::codec::EncodedCommand;
use crate::codec::EncodedEvent;
use crate::codec::encode_ack;
use crate::codec::encode_command;
use crate::codec::encode_event;
use crate::codec::event_envelope;
use crate::codec::same_ack_identity;
use crate::codec::valid_cursor;
use crate::codec::validate_ack_identity;
use crate::codec::validate_ack_time;
use crate::codec::validate_fresh_acceptance;
use crate::codec::validate_terminal_identity;
use crate::records::load_ack;
use crate::records::load_execution;
use crate::schema::open_pool;

#[derive(Clone)]
pub struct DeviceWorkspaceJournal {
    pub(crate) pool: SqlitePool,
}

impl DeviceWorkspaceJournal {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, DeviceJournalError> {
        Ok(Self {
            pool: open_pool(path.as_ref()).await?,
        })
    }

    pub async fn close(self) {
        self.pool.close().await;
    }

    pub async fn prepare_workspace_list(
        &self,
        command: &DeviceWorkspaceListCommand,
        accepted: &DeviceWorkspaceListEvent,
    ) -> Result<PrepareWorkspaceListOutcome, DeviceJournalError> {
        let command = encode_command(command)?;
        let accepted = encode_event(accepted)?;
        validate_fresh_acceptance(&command.record, &accepted.record)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing) = load_execution(&mut tx, &command.record.execution_id).await? {
            let outcome = replay_prepare(existing, &command, &accepted)?;
            tx.rollback().await?;
            return Ok(outcome);
        }
        let accepted_receipt = &event_envelope(&accepted.record).receipt_id;
        let receipt_owner: Option<String> = sqlx::query_scalar(
            "SELECT execution_id FROM workspace_events WHERE sequence = 1 AND receipt_id = ?",
        )
        .bind(accepted_receipt)
        .fetch_optional(&mut *tx)
        .await?;
        if receipt_owner.is_some() {
            return Err(authority("device_journal_accepted_receipt_conflict"));
        }
        insert_execution(&mut tx, &command, &accepted).await?;
        insert_event(&mut tx, &accepted).await?;
        let execution = load_execution(&mut tx, &command.record.execution_id)
            .await?
            .ok_or_else(|| authority("device_journal_authority_corrupt"))?;
        tx.commit().await?;
        Ok(PrepareWorkspaceListOutcome::New(execution))
    }

    /// Serializes receipt lookup before invoking fresh Native admission.
    ///
    /// The closure is called only for a command with no durable execution and
    /// must not acquire or wait for a capability, scan, or otherwise perform
    /// the workspace operation. It may verify bounded current authority and
    /// non-blocking binding metadata; accepted sequence 1 is committed before
    /// the admitted value is returned.
    pub async fn prepare_workspace_list_with_admission<T, E>(
        &self,
        command: &DeviceWorkspaceListCommand,
        admit: impl FnOnce() -> Result<(DeviceWorkspaceListEvent, T), E>,
    ) -> Result<
        PrepareWorkspaceListWithAdmissionOutcome<T>,
        PrepareWorkspaceListWithAdmissionError<E>,
    > {
        let command =
            encode_command(command).map_err(PrepareWorkspaceListWithAdmissionError::Journal)?;
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(DeviceJournalError::from)
            .map_err(PrepareWorkspaceListWithAdmissionError::Journal)?;
        let existing = load_execution(&mut tx, &command.record.execution_id)
            .await
            .map_err(PrepareWorkspaceListWithAdmissionError::Journal)?;
        if let Some(existing) = existing {
            if existing.command != command.record {
                return Err(PrepareWorkspaceListWithAdmissionError::Journal(authority(
                    "device_journal_command_conflict",
                )));
            }
            tx.rollback()
                .await
                .map_err(DeviceJournalError::from)
                .map_err(PrepareWorkspaceListWithAdmissionError::Journal)?;
            return Ok(if existing.terminal.is_some() {
                PrepareWorkspaceListWithAdmissionOutcome::TerminalReplay(existing)
            } else {
                PrepareWorkspaceListWithAdmissionOutcome::AcceptedReplay(existing)
            });
        }
        let (accepted, admitted) =
            admit().map_err(PrepareWorkspaceListWithAdmissionError::Admission)?;
        let accepted =
            encode_event(&accepted).map_err(PrepareWorkspaceListWithAdmissionError::Journal)?;
        validate_fresh_acceptance(&command.record, &accepted.record)
            .map_err(PrepareWorkspaceListWithAdmissionError::Journal)?;
        let accepted_receipt = &event_envelope(&accepted.record).receipt_id;
        let receipt_owner: Option<String> = sqlx::query_scalar(
            "SELECT execution_id FROM workspace_events WHERE sequence = 1 AND receipt_id = ?",
        )
        .bind(accepted_receipt)
        .fetch_optional(&mut *tx)
        .await
        .map_err(DeviceJournalError::from)
        .map_err(PrepareWorkspaceListWithAdmissionError::Journal)?;
        if receipt_owner.is_some() {
            return Err(PrepareWorkspaceListWithAdmissionError::Journal(authority(
                "device_journal_accepted_receipt_conflict",
            )));
        }
        insert_execution(&mut tx, &command, &accepted)
            .await
            .map_err(PrepareWorkspaceListWithAdmissionError::Journal)?;
        insert_event(&mut tx, &accepted)
            .await
            .map_err(PrepareWorkspaceListWithAdmissionError::Journal)?;
        let execution = load_execution(&mut tx, &command.record.execution_id)
            .await
            .map_err(PrepareWorkspaceListWithAdmissionError::Journal)?
            .ok_or_else(|| {
                PrepareWorkspaceListWithAdmissionError::Journal(authority(
                    "device_journal_authority_corrupt",
                ))
            })?;
        tx.commit()
            .await
            .map_err(DeviceJournalError::from)
            .map_err(PrepareWorkspaceListWithAdmissionError::Journal)?;
        Ok(PrepareWorkspaceListWithAdmissionOutcome::New {
            execution,
            admitted,
        })
    }

    pub async fn record_terminal(
        &self,
        terminal: &DeviceWorkspaceListEvent,
    ) -> Result<RecordTerminalOutcome, DeviceJournalError> {
        let terminal = encode_event(terminal)?;
        if event_envelope(&terminal.record).sequence != 2 {
            return Err(authority("device_journal_terminal_invalid"));
        }
        let execution_id = event_envelope(&terminal.record).execution_id.clone();
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let existing = load_execution(&mut tx, &execution_id)
            .await?
            .ok_or_else(|| authority("device_journal_execution_missing"))?;
        validate_terminal_identity(&existing, &terminal.record)?;
        if let Some(prior) = &existing.terminal {
            if prior != &terminal.record {
                return Err(authority("device_journal_terminal_conflict"));
            }
            tx.rollback().await?;
            return Ok(RecordTerminalOutcome::Replayed(existing));
        }
        insert_event(&mut tx, &terminal).await?;
        let committed = load_execution(&mut tx, &execution_id)
            .await?
            .ok_or_else(|| authority("device_journal_authority_corrupt"))?;
        tx.commit().await?;
        Ok(RecordTerminalOutcome::Committed(committed))
    }

    pub async fn acknowledge_workspace_list(
        &self,
        ack: &DeviceWorkspaceListAck,
    ) -> Result<AcknowledgeWorkspaceListOutcome, DeviceJournalError> {
        let ack = encode_ack(ack)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let existing = load_execution(&mut tx, &ack.record.execution_id)
            .await?
            .ok_or_else(|| authority("device_journal_execution_missing"))?;
        validate_ack_identity(&existing, &ack.record)?;
        if ack.record.through_sequence > existing.head_sequence() {
            return Err(authority("device_journal_ack_event_missing"));
        }
        if ack.record.through_sequence < existing.acknowledged_through {
            return Err(authority("device_journal_ack_backward"));
        }
        let prior = if existing.acknowledged_through == 0 {
            None
        } else {
            Some(
                load_ack(&mut tx, &existing, existing.acknowledged_through)
                    .await?
                    .ok_or_else(|| authority("device_journal_authority_corrupt"))?,
            )
        };
        validate_ack_time(&existing, &ack.record, prior.as_ref())?;
        if ack.record.through_sequence == existing.acknowledged_through {
            let prior = prior.ok_or_else(|| authority("device_journal_authority_corrupt"))?;
            if !same_ack_identity(&prior, &ack.record) {
                return Err(authority("device_journal_ack_conflict"));
            }
            tx.rollback().await?;
            return Ok(AcknowledgeWorkspaceListOutcome::Replayed(existing));
        }
        insert_ack(&mut tx, &ack).await?;
        let updated = sqlx::query(
            r#"
UPDATE workspace_executions
SET acknowledged_through = ?
WHERE execution_id = ? AND acknowledged_through = ?
            "#,
        )
        .bind(
            i64::try_from(ack.record.through_sequence)
                .map_err(|_| authority("device_journal_ack_invalid"))?,
        )
        .bind(&ack.record.execution_id)
        .bind(
            i64::try_from(existing.acknowledged_through)
                .map_err(|_| authority("device_journal_authority_corrupt"))?,
        )
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(authority("device_journal_authority_corrupt"));
        }
        let advanced = load_execution(&mut tx, &ack.record.execution_id)
            .await?
            .ok_or_else(|| authority("device_journal_authority_corrupt"))?;
        tx.commit().await?;
        Ok(AcknowledgeWorkspaceListOutcome::Advanced(advanced))
    }

    pub async fn get_workspace_list(
        &self,
        execution_id: &str,
    ) -> Result<Option<WorkspaceJournalExecution>, DeviceJournalError> {
        if !valid_cursor(execution_id) {
            return Err(authority("device_journal_execution_id_invalid"));
        }
        let mut tx = self.pool.begin().await?;
        let execution = load_execution(&mut tx, execution_id).await?;
        tx.commit().await?;
        Ok(execution)
    }

    pub async fn list_unacknowledged_workspace_lists(
        &self,
        query: &WorkspaceJournalListQuery,
    ) -> Result<WorkspaceJournalPage, DeviceJournalError> {
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
        let rows = if let Some(cursor) = &query.after_execution_id {
            sqlx::query_scalar::<_, String>(
                r#"
SELECT execution_id
FROM workspace_executions
WHERE execution_id > ?
  AND acknowledged_through < CASE
      WHEN EXISTS (
          SELECT 1 FROM workspace_events
          WHERE workspace_events.execution_id = workspace_executions.execution_id
            AND sequence = 2
      ) THEN 2 ELSE 1 END
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
WHERE acknowledged_through < CASE
    WHEN EXISTS (
        SELECT 1 FROM workspace_events
        WHERE workspace_events.execution_id = workspace_executions.execution_id
          AND sequence = 2
    ) THEN 2 ELSE 1 END
ORDER BY execution_id
LIMIT ?
                "#,
            )
            .bind(fetch_limit)
            .fetch_all(&mut *tx)
            .await?
        };
        let has_more = rows.len() > usize::from(query.limit);
        let selected = if has_more {
            &rows[..usize::from(query.limit)]
        } else {
            &rows
        };
        let mut executions = Vec::with_capacity(selected.len());
        for execution_id in selected {
            executions.push(
                load_execution(&mut tx, execution_id)
                    .await?
                    .ok_or_else(|| authority("device_journal_authority_corrupt"))?,
            );
        }
        let next_cursor = if has_more {
            selected.last().cloned()
        } else {
            None
        };
        tx.commit().await?;
        Ok(WorkspaceJournalPage {
            executions,
            next_cursor,
        })
    }
}

fn replay_prepare(
    existing: WorkspaceJournalExecution,
    command: &EncodedCommand,
    accepted: &EncodedEvent,
) -> Result<PrepareWorkspaceListOutcome, DeviceJournalError> {
    if existing.command != command.record {
        return Err(authority("device_journal_command_conflict"));
    }
    if existing.accepted != accepted.record {
        return Err(authority("device_journal_accepted_conflict"));
    }
    Ok(if existing.terminal.is_some() {
        PrepareWorkspaceListOutcome::TerminalReplay(existing)
    } else {
        PrepareWorkspaceListOutcome::AcceptedReplay(existing)
    })
}

async fn insert_execution(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    command: &EncodedCommand,
    accepted: &EncodedEvent,
) -> Result<(), DeviceJournalError> {
    let accepted_envelope = event_envelope(&accepted.record);
    let inserted = sqlx::query(
        r#"
INSERT INTO workspace_executions (
    execution_id, execution_kind, command_fingerprint, command_json, device_id,
    lease_id, lease_epoch, expires_at, workspace_binding_id, incarnation_id,
    device_binding_id, runtime_binding_id, policy_snapshot_id, action_digest,
    command_digest, idempotency_key, acknowledged_through, created_at
) VALUES (?, 'workspaceList', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        "#,
    )
    .bind(&command.record.execution_id)
    .bind(&command.fingerprint)
    .bind(&command.json)
    .bind(&command.record.device_id)
    .bind(&command.record.lease_id)
    .bind(
        i64::try_from(command.record.lease_epoch)
            .map_err(|_| authority("device_journal_command_invalid"))?,
    )
    .bind(&command.record.expires_at)
    .bind(&command.record.workspace_binding_id)
    .bind(&command.record.incarnation_id)
    .bind(&command.record.device_binding_id)
    .bind(&command.record.runtime_binding_id)
    .bind(&command.record.policy_snapshot_id)
    .bind(&command.record.action_digest)
    .bind(&command.record.command_digest)
    .bind(&command.record.idempotency_key)
    .bind(&accepted_envelope.observed_at)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() != 1 {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(())
}

async fn insert_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &EncodedEvent,
) -> Result<(), DeviceJournalError> {
    let envelope = event_envelope(&event.record);
    let inserted = sqlx::query(
        r#"
INSERT INTO workspace_events (
    execution_id, sequence, event_type, event_fingerprint, event_json, device_id,
    receipt_id, connection_epoch, workspace_binding_id, incarnation_id,
    device_binding_id, runtime_binding_id, action_digest, command_digest, observed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&envelope.execution_id)
    .bind(i64::try_from(envelope.sequence).map_err(|_| authority("device_journal_event_invalid"))?)
    .bind(event.event_type)
    .bind(&event.fingerprint)
    .bind(&event.json)
    .bind(&envelope.device_id)
    .bind(&envelope.receipt_id)
    .bind(
        i64::try_from(envelope.connection_epoch)
            .map_err(|_| authority("device_journal_event_invalid"))?,
    )
    .bind(&envelope.workspace_binding_id)
    .bind(&envelope.incarnation_id)
    .bind(&envelope.device_binding_id)
    .bind(&envelope.runtime_binding_id)
    .bind(&envelope.action_digest)
    .bind(&envelope.command_digest)
    .bind(&envelope.observed_at)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() != 1 {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(())
}

async fn insert_ack(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    ack: &EncodedAck,
) -> Result<(), DeviceJournalError> {
    let inserted = sqlx::query(
        r#"
INSERT INTO workspace_acks (
    execution_id, through_sequence, ack_fingerprint, ack_json, device_id,
    receipt_id, connection_epoch, workspace_binding_id, incarnation_id,
    device_binding_id, runtime_binding_id, action_digest, command_digest, acknowledged_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&ack.record.execution_id)
    .bind(
        i64::try_from(ack.record.through_sequence)
            .map_err(|_| authority("device_journal_ack_invalid"))?,
    )
    .bind(&ack.fingerprint)
    .bind(&ack.json)
    .bind(&ack.record.device_id)
    .bind(&ack.record.receipt_id)
    .bind(
        i64::try_from(ack.record.connection_epoch)
            .map_err(|_| authority("device_journal_ack_invalid"))?,
    )
    .bind(&ack.record.workspace_binding_id)
    .bind(&ack.record.incarnation_id)
    .bind(&ack.record.device_binding_id)
    .bind(&ack.record.runtime_binding_id)
    .bind(&ack.record.action_digest)
    .bind(&ack.record.command_digest)
    .bind(&ack.record.acknowledged_at)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() != 1 {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(())
}
