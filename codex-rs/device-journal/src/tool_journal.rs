use crewon_device_protocol::DeviceExecutionAck;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::DeviceExecutionEvent;
use crewon_device_protocol::parse_device_execution_ack;
use crewon_device_protocol::parse_device_execution_command;
use crewon_device_protocol::parse_device_execution_event;
use sha2::Digest as _;
use sha2::Sha256;

use crate::DeviceJournalError;
use crate::DeviceWorkspaceJournal;
use crate::authority;

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
        let mut connection = self.pool.acquire().await?;
        load(&mut connection, execution_id).await
    }

    pub async fn list_tool_acknowledgements(
        &self,
    ) -> Result<Vec<ToolJournalAcknowledgement>, DeviceJournalError> {
        use sqlx::Row as _;
        let rows = sqlx::query("SELECT execution_id, acknowledged_through FROM tool_executions WHERE acknowledged_through > 0 ORDER BY execution_id")
            .fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|row| {
                Ok(ToolJournalAcknowledgement {
                    execution_id: row.try_get("execution_id")?,
                    through_sequence: u64::try_from(row.try_get::<i64, _>("acknowledged_through")?)
                        .map_err(|_| authority("device_journal_authority_corrupt"))?,
                })
            })
            .collect()
    }

    pub async fn prepare_tool_with_admission<T, E>(
        &self,
        command: &DeviceExecutionCommand,
        admit: impl FnOnce() -> Result<(DeviceExecutionEvent, T), E>,
    ) -> Result<PrepareToolOutcome<T>, PrepareToolError<E>> {
        let command_json = encode_command(command).map_err(PrepareToolError::Journal)?;
        let fingerprint = fingerprint(&command_json);
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
        let accepted_json = encode_event(&accepted).map_err(PrepareToolError::Journal)?;
        let envelope = envelope(&accepted);
        let inserted = sqlx::query("INSERT INTO tool_executions (execution_id, command_json, command_fingerprint, device_id, capability, lease_id, lease_epoch, action_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&command.execution_id).bind(command_json).bind(fingerprint)
            .bind(&command.device_id).bind(&command.capability).bind(&command.lease_id)
            .bind(i64::try_from(command.lease_epoch).map_err(|_| authority("device_tool_command_invalid")).map_err(PrepareToolError::Journal)?)
            .bind(&command.action_digest).bind(&envelope.observed_at)
            .execute(&mut *tx).await.map_err(DeviceJournalError::from).map_err(PrepareToolError::Journal)?;
        if inserted.rows_affected() != 1 {
            return Err(PrepareToolError::Journal(authority(
                "device_journal_authority_corrupt",
            )));
        }
        insert_event(&mut tx, &accepted, &accepted_json)
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
        if envelope(terminal).sequence != 2
            || matches!(
                terminal,
                DeviceExecutionEvent::Accepted { .. } | DeviceExecutionEvent::Output { .. }
            )
        {
            return Err(authority("device_tool_terminal_invalid"));
        }
        let execution_id = envelope(terminal).execution_id.clone();
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
        let json = encode_event(terminal)?;
        insert_event(&mut tx, terminal, &json).await?;
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
        let json = encode_ack(ack)?;
        let parsed = parse_device_execution_ack(
            serde_json::from_str(&json).map_err(|_| authority("device_tool_ack_invalid"))?,
        )
        .map_err(|_| authority("device_tool_ack_invalid"))?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let existing = load(&mut tx, &parsed.execution_id)
            .await?
            .ok_or_else(|| authority("device_tool_execution_missing"))?;
        if parsed.device_id != existing.command.device_id
            || !(1..=2).contains(&parsed.through_sequence)
            || parsed.through_sequence > if existing.terminal.is_some() { 2 } else { 1 }
        {
            return Err(authority("device_tool_ack_identity_mismatch"));
        }
        if parsed.through_sequence < existing.acknowledged_through {
            return Err(authority("device_tool_ack_backward"));
        }
        if parsed.through_sequence == existing.acknowledged_through {
            let prior: Option<String> = sqlx::query_scalar(
                "SELECT ack_json FROM tool_acks WHERE execution_id = ? AND through_sequence = ?",
            )
            .bind(&parsed.execution_id)
            .bind(
                i64::try_from(parsed.through_sequence)
                    .map_err(|_| authority("device_tool_ack_invalid"))?,
            )
            .fetch_optional(&mut *tx)
            .await?;
            if prior.as_deref() != Some(&json) {
                return Err(authority("device_tool_ack_conflict"));
            }
            tx.rollback().await?;
            return Ok(AcknowledgeToolOutcome::Replayed(existing));
        }
        sqlx::query("INSERT INTO tool_acks (execution_id, through_sequence, ack_json, ack_fingerprint, acknowledged_at) VALUES (?, ?, ?, ?, ?)")
            .bind(&parsed.execution_id).bind(i64::try_from(parsed.through_sequence).map_err(|_| authority("device_tool_ack_invalid"))?)
            .bind(&json).bind(fingerprint(&json)).bind(&parsed.acknowledged_at).execute(&mut *tx).await?;
        sqlx::query("UPDATE tool_executions SET acknowledged_through = ? WHERE execution_id = ? AND acknowledged_through = ?")
            .bind(i64::try_from(parsed.through_sequence).map_err(|_| authority("device_tool_ack_invalid"))?)
            .bind(&parsed.execution_id).bind(i64::try_from(existing.acknowledged_through).map_err(|_| authority("device_journal_authority_corrupt"))?)
            .execute(&mut *tx).await?;
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
        let ids: Vec<String> = sqlx::query_scalar("SELECT execution_id FROM tool_executions WHERE execution_id > ? AND acknowledged_through < CASE WHEN EXISTS (SELECT 1 FROM tool_events e WHERE e.execution_id = tool_executions.execution_id AND e.sequence = 2) THEN 2 ELSE 1 END ORDER BY execution_id LIMIT ?")
            .bind(after).bind(i64::from(query.limit) + 1).fetch_all(&self.pool).await?;
        let has_more = ids.len() > usize::from(query.limit);
        let selected = &ids[..ids.len().min(usize::from(query.limit))];
        let mut executions = Vec::with_capacity(selected.len());
        for id in selected {
            let mut connection = self.pool.acquire().await?;
            executions.push(
                load(&mut connection, id)
                    .await?
                    .ok_or_else(|| authority("device_journal_authority_corrupt"))?,
            );
        }
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
    use sqlx::Row as _;
    let Some(row) = sqlx::query("SELECT command_json, command_fingerprint, device_id, capability, lease_id, lease_epoch, action_digest, acknowledged_through FROM tool_executions WHERE execution_id = ?").bind(execution_id).fetch_optional(&mut *connection).await? else { return Ok(None); };
    let command_json: String = row.try_get("command_json")?;
    if fingerprint(&command_json) != row.try_get::<String, _>("command_fingerprint")? {
        return Err(authority("device_journal_authority_corrupt"));
    }
    let command = parse_device_execution_command(
        serde_json::from_str(&command_json)
            .map_err(|_| authority("device_journal_authority_corrupt"))?,
    )
    .map_err(|_| authority("device_journal_authority_corrupt"))?;
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
    let event_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT event_json, event_fingerprint FROM tool_events WHERE execution_id = ? ORDER BY sequence",
    )
    .bind(execution_id)
    .fetch_all(&mut *connection)
    .await?;
    if event_rows.is_empty() || event_rows.len() > 2 {
        return Err(authority("device_journal_authority_corrupt"));
    }
    let mut events = event_rows
        .into_iter()
        .map(|(json, stored_fingerprint)| {
            if fingerprint(&json) != stored_fingerprint {
                return Err(authority("device_journal_authority_corrupt"));
            }
            parse_device_execution_event(
                serde_json::from_str(&json)
                    .map_err(|_| authority("device_journal_authority_corrupt"))?,
            )
            .map_err(|_| authority("device_journal_authority_corrupt"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let accepted = events.remove(0);
    validate_accepted(&command, &accepted)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let terminal = events.pop();
    let acknowledged_through = u64::try_from(row.try_get::<i64, _>("acknowledged_through")?)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let ack_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tool_acks WHERE execution_id = ?")
            .bind(execution_id)
            .fetch_one(&mut *connection)
            .await?;
    let ack_head: Option<i64> =
        sqlx::query_scalar("SELECT max(through_sequence) FROM tool_acks WHERE execution_id = ?")
            .bind(execution_id)
            .fetch_one(&mut *connection)
            .await?;
    if (acknowledged_through == 0 && ack_count != 0)
        || (acknowledged_through > 0
            && (!(1..=2).contains(&ack_count)
                || ack_head
                    != Some(
                        i64::try_from(acknowledged_through)
                            .map_err(|_| authority("device_journal_authority_corrupt"))?,
                    )))
    {
        return Err(authority("device_journal_authority_corrupt"));
    }
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
    Ok(Some(execution))
}

async fn insert_event(
    connection: &mut sqlx::SqliteConnection,
    event: &DeviceExecutionEvent,
    json: &str,
) -> Result<(), DeviceJournalError> {
    let e = envelope(event);
    let event_type = match event {
        DeviceExecutionEvent::Accepted { .. } => "execution.accepted",
        DeviceExecutionEvent::Completed { .. } => "execution.completed",
        DeviceExecutionEvent::Failed { .. } => "execution.failed",
        DeviceExecutionEvent::Canceled { .. } => "execution.canceled",
        DeviceExecutionEvent::UnknownOutcome { .. } => "execution.unknown_outcome",
        DeviceExecutionEvent::Output { .. } => return Err(authority("device_tool_event_invalid")),
    };
    sqlx::query("INSERT INTO tool_events (execution_id, sequence, event_json, event_fingerprint, event_type, receipt_id, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&e.execution_id).bind(i64::try_from(e.sequence).map_err(|_| authority("device_tool_event_invalid"))?).bind(json).bind(fingerprint(json)).bind(event_type).bind(&e.receipt_id).bind(&e.observed_at).execute(connection).await?;
    Ok(())
}

fn validate_accepted(
    command: &DeviceExecutionCommand,
    event: &DeviceExecutionEvent,
) -> Result<(), DeviceJournalError> {
    let DeviceExecutionEvent::Accepted { envelope, data } = event else {
        return Err(authority("device_tool_accepted_invalid"));
    };
    if envelope.sequence != 1
        || envelope.device_id != command.device_id
        || envelope.execution_id != command.execution_id
        || data.lease_epoch != command.lease_epoch
        || data.action_digest != command.action_digest
    {
        return Err(authority("device_tool_accepted_invalid"));
    }
    Ok(())
}

fn validate_terminal(
    execution: &ToolJournalExecution,
    terminal: &DeviceExecutionEvent,
) -> Result<(), DeviceJournalError> {
    let accepted = envelope(&execution.accepted);
    let terminal = envelope(terminal);
    if terminal.sequence != 2
        || terminal.device_id != accepted.device_id
        || terminal.execution_id != accepted.execution_id
        || terminal.receipt_id != accepted.receipt_id
    {
        return Err(authority("device_tool_terminal_invalid"));
    }
    Ok(())
}

fn envelope(event: &DeviceExecutionEvent) -> &crewon_device_protocol::DeviceExecutionEventEnvelope {
    match event {
        DeviceExecutionEvent::Accepted { envelope, .. }
        | DeviceExecutionEvent::Output { envelope, .. }
        | DeviceExecutionEvent::Completed { envelope, .. }
        | DeviceExecutionEvent::Failed { envelope, .. }
        | DeviceExecutionEvent::Canceled { envelope, .. }
        | DeviceExecutionEvent::UnknownOutcome { envelope, .. } => envelope,
    }
}
fn encode_command(value: &DeviceExecutionCommand) -> Result<String, DeviceJournalError> {
    serde_json::to_string(value).map_err(|_| authority("device_tool_record_invalid"))
}
fn encode_event(value: &DeviceExecutionEvent) -> Result<String, DeviceJournalError> {
    serde_json::to_string(value).map_err(|_| authority("device_tool_record_invalid"))
}
fn encode_ack(value: &DeviceExecutionAck) -> Result<String, DeviceJournalError> {
    serde_json::to_string(value).map_err(|_| authority("device_tool_record_invalid"))
}
fn fingerprint(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}
