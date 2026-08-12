use crewon_device_protocol::DeviceExecutionAck;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::DeviceExecutionEvent;
use sqlx::Row as _;

use crate::DeviceJournalError;
use crate::DeviceWorkspaceJournal;
use crate::authority;
use crate::tool_journal_codec::decode_ack;
use crate::tool_journal_codec::decode_command;
use crate::tool_journal_codec::decode_event;
use crate::tool_journal_codec::encode_ack;
use crate::tool_journal_codec::encode_command;
use crate::tool_journal_codec::encode_event;
use crate::tool_journal_codec::event_envelope;
use crate::tool_journal_validation::same_ack_identity;
use crate::tool_journal_validation::validate_accepted;
use crate::tool_journal_validation::validate_ack;
use crate::tool_journal_validation::validate_ack_time;
use crate::tool_journal_validation::validate_terminal;

#[derive(Debug, Clone, PartialEq)]
pub struct ToolJournalExecution {
    pub command: DeviceExecutionCommand,
    pub accepted: DeviceExecutionEvent,
    pub terminal: Option<DeviceExecutionEvent>,
    pub acknowledged_through: u64,
}

#[derive(Debug)]
pub enum PrepareToolOutcome<T> {
    New {
        execution: ToolJournalExecution,
        admitted: T,
    },
    AcceptedReplay(ToolJournalExecution),
    TerminalReplay(ToolJournalExecution),
}

#[derive(Debug)]
pub enum PrepareToolError<E> {
    Journal(DeviceJournalError),
    Admission(E),
}

#[derive(Debug, Clone, PartialEq)]
pub enum RecordToolTerminalOutcome {
    Committed(ToolJournalExecution),
    Replayed(ToolJournalExecution),
}

#[derive(Debug, Clone, PartialEq)]
pub enum AcknowledgeToolOutcome {
    Advanced(ToolJournalExecution),
    Replayed(ToolJournalExecution),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolJournalListQuery {
    pub after_execution_id: Option<String>,
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolJournalPage {
    pub executions: Vec<ToolJournalExecution>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolJournalAcknowledgement {
    pub execution_id: String,
    pub through_sequence: u64,
}

impl DeviceWorkspaceJournal {
    pub async fn get_tool(
        &self,
        execution_id: &str,
    ) -> Result<Option<ToolJournalExecution>, DeviceJournalError> {
        if execution_id.is_empty() || execution_id.len() > 512 {
            return Err(authority("device_tool_execution_id_invalid"));
        }
        let mut tx = self.pool.begin().await?;
        let execution = load(&mut tx, execution_id).await?;
        tx.commit().await?;
        Ok(execution)
    }

    pub async fn list_tool_acknowledgements(
        &self,
    ) -> Result<Vec<ToolJournalAcknowledgement>, DeviceJournalError> {
        let mut tx = self.pool.begin().await?;
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT execution_id FROM tool_executions WHERE acknowledged_through > 0 ORDER BY execution_id",
        )
        .fetch_all(&mut *tx)
        .await?;
        let mut acknowledgements = Vec::with_capacity(ids.len());
        for execution_id in ids {
            let execution = load(&mut tx, &execution_id)
                .await?
                .ok_or_else(|| authority("device_journal_authority_corrupt"))?;
            acknowledgements.push(ToolJournalAcknowledgement {
                execution_id,
                through_sequence: execution.acknowledged_through,
            });
        }
        tx.commit().await?;
        Ok(acknowledgements)
    }

    pub async fn prepare_tool_with_admission<T, E>(
        &self,
        command: &DeviceExecutionCommand,
        admit: impl FnOnce() -> Result<(DeviceExecutionEvent, T), E>,
    ) -> Result<PrepareToolOutcome<T>, PrepareToolError<E>> {
        let encoded_command = encode_command(command).map_err(PrepareToolError::Journal)?;
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(DeviceJournalError::from)
            .map_err(PrepareToolError::Journal)?;
        if let Some(existing) = load(&mut tx, &command.execution_id)
            .await
            .map_err(PrepareToolError::Journal)?
        {
            if existing.command != *command {
                return Err(PrepareToolError::Journal(authority(
                    "device_tool_command_conflict",
                )));
            }
            tx.rollback()
                .await
                .map_err(DeviceJournalError::from)
                .map_err(PrepareToolError::Journal)?;
            return Ok(if existing.terminal.is_some() {
                PrepareToolOutcome::TerminalReplay(existing)
            } else {
                PrepareToolOutcome::AcceptedReplay(existing)
            });
        }
        let (accepted, admitted) = admit().map_err(PrepareToolError::Admission)?;
        validate_accepted(command, &accepted).map_err(PrepareToolError::Journal)?;
        let accepted_record = encode_event(&accepted).map_err(PrepareToolError::Journal)?;
        let envelope = event_envelope(&accepted_record.record);
        let receipt_owner: Option<String> = sqlx::query_scalar(
            "SELECT execution_id FROM tool_events WHERE receipt_id = ? AND sequence = 1",
        )
        .bind(&envelope.receipt_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(DeviceJournalError::from)
        .map_err(PrepareToolError::Journal)?;
        if receipt_owner.is_some() {
            return Err(PrepareToolError::Journal(authority(
                "device_tool_receipt_conflict",
            )));
        }
        let inserted = sqlx::query("INSERT INTO tool_executions (execution_id, command_json, command_fingerprint, device_id, capability, lease_id, lease_epoch, action_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&command.execution_id).bind(encoded_command.json).bind(encoded_command.fingerprint)
            .bind(&command.device_id).bind(&command.capability).bind(&command.lease_id)
            .bind(i64::try_from(command.lease_epoch).map_err(|_| authority("device_tool_command_invalid")).map_err(PrepareToolError::Journal)?)
            .bind(&command.action_digest).bind(&envelope.observed_at)
            .execute(&mut *tx).await.map_err(DeviceJournalError::from).map_err(PrepareToolError::Journal)?;
        if inserted.rows_affected() != 1 {
            return Err(PrepareToolError::Journal(authority(
                "device_journal_authority_corrupt",
            )));
        }
        insert_event(&mut tx, &accepted_record)
            .await
            .map_err(PrepareToolError::Journal)?;
        let execution = load(&mut tx, &command.execution_id)
            .await
            .map_err(PrepareToolError::Journal)?
            .ok_or_else(|| {
                PrepareToolError::Journal(authority("device_journal_authority_corrupt"))
            })?;
        tx.commit()
            .await
            .map_err(DeviceJournalError::from)
            .map_err(PrepareToolError::Journal)?;
        Ok(PrepareToolOutcome::New {
            execution,
            admitted,
        })
    }

    pub async fn record_tool_terminal(
        &self,
        terminal: &DeviceExecutionEvent,
    ) -> Result<RecordToolTerminalOutcome, DeviceJournalError> {
        if event_envelope(terminal).sequence != 2
            || matches!(
                terminal,
                DeviceExecutionEvent::Accepted { .. } | DeviceExecutionEvent::Output { .. }
            )
        {
            return Err(authority("device_tool_terminal_invalid"));
        }
        let execution_id = event_envelope(terminal).execution_id.clone();
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let existing = load(&mut tx, &execution_id)
            .await?
            .ok_or_else(|| authority("device_tool_execution_missing"))?;
        validate_terminal(&existing, terminal)?;
        if let Some(prior) = &existing.terminal {
            if prior != terminal {
                return Err(authority("device_tool_terminal_conflict"));
            }
            tx.rollback().await?;
            return Ok(RecordToolTerminalOutcome::Replayed(existing));
        }
        let encoded = encode_event(terminal)?;
        insert_event(&mut tx, &encoded).await?;
        let committed = load(&mut tx, &execution_id)
            .await?
            .ok_or_else(|| authority("device_journal_authority_corrupt"))?;
        tx.commit().await?;
        Ok(RecordToolTerminalOutcome::Committed(committed))
    }

    pub async fn acknowledge_tool(
        &self,
        ack: &DeviceExecutionAck,
    ) -> Result<AcknowledgeToolOutcome, DeviceJournalError> {
        let encoded = encode_ack(ack)?;
        let parsed = &encoded.record;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let existing = load(&mut tx, &parsed.execution_id)
            .await?
            .ok_or_else(|| authority("device_tool_execution_missing"))?;
        validate_ack(&existing, parsed)?;
        if parsed.through_sequence < existing.acknowledged_through {
            return Err(authority("device_tool_ack_backward"));
        }
        let prior = load_latest_ack(&mut tx, &existing).await?;
        validate_ack_time(&existing, parsed, prior.as_ref())?;
        if parsed.through_sequence == existing.acknowledged_through {
            let prior = prior.ok_or_else(|| authority("device_journal_authority_corrupt"))?;
            if !same_ack_identity(&prior, parsed) {
                return Err(authority("device_tool_ack_conflict"));
            }
            tx.rollback().await?;
            return Ok(AcknowledgeToolOutcome::Replayed(existing));
        }
        let inserted = sqlx::query("INSERT INTO tool_acks (execution_id, through_sequence, ack_json, ack_fingerprint, acknowledged_at) VALUES (?, ?, ?, ?, ?)")
            .bind(&parsed.execution_id).bind(i64::try_from(parsed.through_sequence).map_err(|_| authority("device_tool_ack_invalid"))?)
            .bind(encoded.json).bind(encoded.fingerprint).bind(&parsed.acknowledged_at).execute(&mut *tx).await?;
        if inserted.rows_affected() != 1 {
            return Err(authority("device_journal_authority_corrupt"));
        }
        let updated = sqlx::query("UPDATE tool_executions SET acknowledged_through = ? WHERE execution_id = ? AND acknowledged_through = ?")
            .bind(i64::try_from(parsed.through_sequence).map_err(|_| authority("device_tool_ack_invalid"))?)
            .bind(&parsed.execution_id).bind(i64::try_from(existing.acknowledged_through).map_err(|_| authority("device_journal_authority_corrupt"))?)
            .execute(&mut *tx).await?;
        if updated.rows_affected() != 1 {
            return Err(authority("device_journal_authority_corrupt"));
        }
        let advanced = load(&mut tx, &parsed.execution_id)
            .await?
            .ok_or_else(|| authority("device_journal_authority_corrupt"))?;
        tx.commit().await?;
        Ok(AcknowledgeToolOutcome::Advanced(advanced))
    }

    pub async fn list_unacknowledged_tools(
        &self,
        query: &ToolJournalListQuery,
    ) -> Result<ToolJournalPage, DeviceJournalError> {
        if query.limit == 0 || query.limit > crate::MAX_JOURNAL_PAGE_SIZE {
            return Err(authority("device_tool_page_invalid"));
        }
        let after = query.after_execution_id.as_deref().unwrap_or("");
        let mut tx = self.pool.begin().await?;
        let ids: Vec<String> = sqlx::query_scalar("SELECT execution_id FROM tool_executions WHERE execution_id > ? AND acknowledged_through < CASE WHEN EXISTS (SELECT 1 FROM tool_events e WHERE e.execution_id = tool_executions.execution_id AND e.sequence = 2) THEN 2 ELSE 1 END ORDER BY execution_id LIMIT ?")
            .bind(after).bind(i64::from(query.limit) + 1).fetch_all(&mut *tx).await?;
        let has_more = ids.len() > usize::from(query.limit);
        let selected = &ids[..ids.len().min(usize::from(query.limit))];
        let mut executions = Vec::with_capacity(selected.len());
        for id in selected {
            executions.push(
                load(&mut tx, id)
                    .await?
                    .ok_or_else(|| authority("device_journal_authority_corrupt"))?,
            );
        }
        tx.commit().await?;
        Ok(ToolJournalPage {
            next_cursor: has_more.then(|| selected.last().cloned()).flatten(),
            executions,
        })
    }
}

async fn load(
    connection: &mut sqlx::SqliteConnection,
    execution_id: &str,
) -> Result<Option<ToolJournalExecution>, DeviceJournalError> {
    let Some(row) = sqlx::query("SELECT command_json, command_fingerprint, device_id, capability, lease_id, lease_epoch, action_digest, acknowledged_through, created_at FROM tool_executions WHERE execution_id = ?").bind(execution_id).fetch_optional(&mut *connection).await? else { return Ok(None); };
    let command_json: String = row.try_get("command_json")?;
    let command_fingerprint: String = row.try_get("command_fingerprint")?;
    let command = decode_command(&command_json, &command_fingerprint)?.record;
    if command.execution_id != execution_id
        || row.try_get::<String, _>("device_id")? != command.device_id
        || row.try_get::<String, _>("capability")? != command.capability
        || row.try_get::<String, _>("lease_id")? != command.lease_id
        || u64::try_from(row.try_get::<i64, _>("lease_epoch")?)
            .map_err(|_| authority("device_journal_authority_corrupt"))?
            != command.lease_epoch
        || row.try_get::<String, _>("action_digest")? != command.action_digest
    {
        return Err(authority("device_journal_authority_corrupt"));
    }
    let event_rows = sqlx::query("SELECT sequence, event_json, event_fingerprint, event_type, receipt_id, observed_at FROM tool_events WHERE execution_id = ? ORDER BY sequence")
        .bind(execution_id).fetch_all(&mut *connection).await?;
    if event_rows.is_empty() || event_rows.len() > 2 {
        return Err(authority("device_journal_authority_corrupt"));
    }
    let mut events = Vec::with_capacity(event_rows.len());
    for row in event_rows {
        let json: String = row.try_get("event_json")?;
        let stored_fingerprint: String = row.try_get("event_fingerprint")?;
        let stored_type: String = row.try_get("event_type")?;
        let event = decode_event(&json, &stored_fingerprint, &stored_type)
            .map_err(|_| authority("device_journal_authority_corrupt"))?
            .record;
        let envelope = event_envelope(&event);
        if row.try_get::<i64, _>("sequence")?
            != i64::try_from(envelope.sequence)
                .map_err(|_| authority("device_journal_authority_corrupt"))?
            || row.try_get::<String, _>("receipt_id")? != envelope.receipt_id
            || row.try_get::<String, _>("observed_at")? != envelope.observed_at
        {
            return Err(authority("device_journal_authority_corrupt"));
        }
        events.push(event);
    }
    let accepted = events.remove(0);
    validate_accepted(&command, &accepted)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let terminal = events.pop();
    if row.try_get::<String, _>("created_at")? != event_envelope(&accepted).observed_at {
        return Err(authority("device_journal_authority_corrupt"));
    }
    let acknowledged_through = u64::try_from(row.try_get::<i64, _>("acknowledged_through")?)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let execution = ToolJournalExecution {
        command,
        accepted,
        terminal,
        acknowledged_through,
    };
    if execution
        .terminal
        .as_ref()
        .is_some_and(|event| validate_terminal(&execution, event).is_err())
        || acknowledged_through > if execution.terminal.is_some() { 2 } else { 1 }
    {
        return Err(authority("device_journal_authority_corrupt"));
    }
    let ack_rows = sqlx::query("SELECT through_sequence, ack_json, ack_fingerprint, acknowledged_at FROM tool_acks WHERE execution_id = ? ORDER BY through_sequence")
        .bind(execution_id).fetch_all(&mut *connection).await?;
    let mut sequences = Vec::with_capacity(ack_rows.len());
    let mut prior = None;
    for row in ack_rows {
        let json: String = row.try_get("ack_json")?;
        let fingerprint: String = row.try_get("ack_fingerprint")?;
        let ack = decode_ack(&json, &fingerprint)
            .map_err(|_| authority("device_journal_authority_corrupt"))?
            .record;
        validate_ack(&execution, &ack)
            .map_err(|_| authority("device_journal_authority_corrupt"))?;
        validate_ack_time(&execution, &ack, prior.as_ref())
            .map_err(|_| authority("device_journal_authority_corrupt"))?;
        if row.try_get::<i64, _>("through_sequence")?
            != i64::try_from(ack.through_sequence)
                .map_err(|_| authority("device_journal_authority_corrupt"))?
            || row.try_get::<String, _>("acknowledged_at")? != ack.acknowledged_at
        {
            return Err(authority("device_journal_authority_corrupt"));
        }
        sequences.push(ack.through_sequence);
        prior = Some(ack);
    }
    if !matches!(
        (execution.acknowledged_through, sequences.as_slice()),
        (0, []) | (1, [1]) | (2, [2]) | (2, [1, 2])
    ) {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(Some(execution))
}

async fn insert_event(
    connection: &mut sqlx::SqliteConnection,
    encoded: &crate::tool_journal_codec::EncodedEvent,
) -> Result<(), DeviceJournalError> {
    let envelope = event_envelope(&encoded.record);
    let inserted = sqlx::query("INSERT INTO tool_events (execution_id, sequence, event_json, event_fingerprint, event_type, receipt_id, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&envelope.execution_id).bind(i64::try_from(envelope.sequence).map_err(|_| authority("device_tool_event_invalid"))?)
        .bind(&encoded.json).bind(&encoded.fingerprint).bind(encoded.event_type)
        .bind(&envelope.receipt_id).bind(&envelope.observed_at).execute(connection).await?;
    if inserted.rows_affected() != 1 {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(())
}

async fn load_latest_ack(
    connection: &mut sqlx::SqliteConnection,
    execution: &ToolJournalExecution,
) -> Result<Option<DeviceExecutionAck>, DeviceJournalError> {
    if execution.acknowledged_through == 0 {
        return Ok(None);
    }
    let row = sqlx::query("SELECT ack_json, ack_fingerprint, acknowledged_at FROM tool_acks WHERE execution_id = ? AND through_sequence = ?")
        .bind(&execution.command.execution_id)
        .bind(i64::try_from(execution.acknowledged_through).map_err(|_| authority("device_journal_authority_corrupt"))?)
        .fetch_optional(&mut *connection).await?;
    row.map(|row| {
        let json: String = row.try_get("ack_json")?;
        let fingerprint: String = row.try_get("ack_fingerprint")?;
        let ack = decode_ack(&json, &fingerprint)?.record;
        if row.try_get::<String, _>("acknowledged_at")? != ack.acknowledged_at {
            return Err(authority("device_journal_authority_corrupt"));
        }
        Ok(ack)
    })
    .transpose()
}
