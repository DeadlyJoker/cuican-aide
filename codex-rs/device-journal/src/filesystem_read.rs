use crewon_device_protocol::DeviceFilesystemReadAck;
use crewon_device_protocol::DeviceFilesystemReadCommand;
use crewon_device_protocol::DeviceFilesystemReadEvent;
use crewon_device_protocol::canonical_device_filesystem_read_command_digest;
use crewon_device_protocol::parse_device_filesystem_read_ack;
use crewon_device_protocol::parse_device_filesystem_read_command;
use crewon_device_protocol::parse_device_filesystem_read_event;
use sha2::Digest as _;
use sha2::Sha256;
use sqlx::Row as _;

use crate::DeviceJournalError;
use crate::DeviceWorkspaceJournal;
use crate::authority;

#[derive(Debug, Clone, PartialEq)]
pub struct FilesystemReadJournalExecution {
    pub command: DeviceFilesystemReadCommand,
    pub accepted: DeviceFilesystemReadEvent,
    pub terminal: Option<DeviceFilesystemReadEvent>,
    pub acknowledged_through: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PrepareFilesystemReadOutcome {
    New(FilesystemReadJournalExecution),
    AcceptedReplay(FilesystemReadJournalExecution),
    TerminalReplay(FilesystemReadJournalExecution),
}

#[derive(Debug, Clone, PartialEq)]
pub enum RecordFilesystemReadTerminalOutcome {
    Committed(FilesystemReadJournalExecution),
    Replayed(FilesystemReadJournalExecution),
}

#[derive(Debug, Clone, PartialEq)]
pub enum AcknowledgeFilesystemReadOutcome {
    Advanced(FilesystemReadJournalExecution),
    Replayed(FilesystemReadJournalExecution),
}

impl DeviceWorkspaceJournal {
    /// Commits accepted sequence 1 before a caller may acquire a Native file handle.
    pub async fn prepare_filesystem_read(
        &self,
        command: &DeviceFilesystemReadCommand,
        accepted: &DeviceFilesystemReadEvent,
    ) -> Result<PrepareFilesystemReadOutcome, DeviceJournalError> {
        let command_json = encode_command(command)?;
        let command_fingerprint = fingerprint(&command_json);
        let (accepted_envelope, accepted_type) = envelope(accepted);
        validate_acceptance(command, accepted, accepted_envelope, accepted_type)?;
        let accepted_json = encode_event(accepted)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing) = load(&mut tx, &command.command.execution_id).await? {
            if existing.command != *command || existing.accepted != *accepted {
                return Err(authority("device_journal_filesystem_read_command_conflict"));
            }
            tx.rollback().await?;
            return Ok(if existing.terminal.is_some() {
                PrepareFilesystemReadOutcome::TerminalReplay(existing)
            } else {
                PrepareFilesystemReadOutcome::AcceptedReplay(existing)
            });
        }
        let owner: Option<String> = sqlx::query_scalar(
            "SELECT execution_id FROM filesystem_read_events WHERE receipt_id = ? AND sequence = 1",
        )
        .bind(&accepted_envelope.receipt_id)
        .fetch_optional(&mut *tx)
        .await?;
        if owner.is_some() {
            return Err(authority("device_journal_filesystem_read_receipt_conflict"));
        }
        sqlx::query(
            r#"INSERT INTO filesystem_read_executions
(execution_id, command_fingerprint, command_json, device_id, lease_id, lease_epoch,
 workspace_binding_id, incarnation_id, command_digest, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&command.command.execution_id)
        .bind(command_fingerprint)
        .bind(command_json)
        .bind(&command.command.device_id)
        .bind(&command.command.lease_id)
        .bind(
            i64::try_from(command.command.lease_epoch)
                .map_err(|_| authority("device_journal_filesystem_read_invalid"))?,
        )
        .bind(&command.command.workspace_binding_id)
        .bind(&command.arguments.workspace_incarnation_id)
        .bind(&accepted_envelope.command_digest)
        .bind(&accepted_envelope.observed_at)
        .execute(&mut *tx)
        .await?;
        insert_event(&mut tx, accepted_envelope, accepted_type, accepted_json).await?;
        let execution = load(&mut tx, &command.command.execution_id)
            .await?
            .ok_or_else(|| authority("device_journal_authority_corrupt"))?;
        tx.commit().await?;
        Ok(PrepareFilesystemReadOutcome::New(execution))
    }

    pub async fn record_filesystem_read_terminal(
        &self,
        terminal: &DeviceFilesystemReadEvent,
    ) -> Result<RecordFilesystemReadTerminalOutcome, DeviceJournalError> {
        let terminal_json = encode_event(terminal)?;
        let (terminal_envelope, terminal_type) = envelope(terminal);
        if terminal_envelope.sequence != 2 || terminal_type == "workspace_read.accepted" {
            return Err(authority("device_journal_filesystem_read_terminal_invalid"));
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let execution = load(&mut tx, &terminal_envelope.execution_id)
            .await?
            .ok_or_else(|| authority("device_journal_filesystem_read_execution_missing"))?;
        validate_same_identity(&execution.accepted, terminal)?;
        validate_event_time(&execution.accepted, terminal)?;
        if let Some(existing) = &execution.terminal {
            if existing != terminal {
                return Err(authority(
                    "device_journal_filesystem_read_terminal_conflict",
                ));
            }
            tx.rollback().await?;
            return Ok(RecordFilesystemReadTerminalOutcome::Replayed(execution));
        }
        insert_event(&mut tx, terminal_envelope, terminal_type, terminal_json).await?;
        let execution = load(&mut tx, &terminal_envelope.execution_id)
            .await?
            .ok_or_else(|| authority("device_journal_authority_corrupt"))?;
        tx.commit().await?;
        Ok(RecordFilesystemReadTerminalOutcome::Committed(execution))
    }

    pub async fn acknowledge_filesystem_read(
        &self,
        ack: &DeviceFilesystemReadAck,
    ) -> Result<AcknowledgeFilesystemReadOutcome, DeviceJournalError> {
        let ack_json = encode_ack(ack)?;
        parse_device_filesystem_read_ack(
            serde_json::to_value(ack)
                .map_err(|_| authority("device_journal_filesystem_read_invalid"))?,
        )
        .map_err(|_| authority("device_journal_filesystem_read_ack_invalid"))?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let execution = load(&mut tx, &ack.execution_id)
            .await?
            .ok_or_else(|| authority("device_journal_filesystem_read_execution_missing"))?;
        validate_ack(&execution, ack)?;
        if ack.through_sequence <= execution.acknowledged_through {
            tx.rollback().await?;
            return Ok(AcknowledgeFilesystemReadOutcome::Replayed(execution));
        }
        sqlx::query("INSERT INTO filesystem_read_acks (execution_id, through_sequence, ack_fingerprint, ack_json, acknowledged_at) VALUES (?, ?, ?, ?, ?)")
            .bind(&ack.execution_id).bind(i64::try_from(ack.through_sequence).map_err(|_| authority("device_journal_filesystem_read_ack_invalid"))?)
            .bind(fingerprint(&ack_json)).bind(ack_json).bind(&ack.acknowledged_at).execute(&mut *tx).await?;
        sqlx::query(
            "UPDATE filesystem_read_executions SET acknowledged_through = ? WHERE execution_id = ?",
        )
        .bind(
            i64::try_from(ack.through_sequence)
                .map_err(|_| authority("device_journal_filesystem_read_ack_invalid"))?,
        )
        .bind(&ack.execution_id)
        .execute(&mut *tx)
        .await?;
        let execution = load(&mut tx, &ack.execution_id)
            .await?
            .ok_or_else(|| authority("device_journal_authority_corrupt"))?;
        tx.commit().await?;
        Ok(AcknowledgeFilesystemReadOutcome::Advanced(execution))
    }

    pub async fn get_filesystem_read(
        &self,
        execution_id: &str,
    ) -> Result<Option<FilesystemReadJournalExecution>, DeviceJournalError> {
        let mut connection = self.pool.acquire().await?;
        load(&mut connection, execution_id).await
    }
}

async fn load(
    connection: &mut sqlx::SqliteConnection,
    execution_id: &str,
) -> Result<Option<FilesystemReadJournalExecution>, DeviceJournalError> {
    let Some(row) = sqlx::query("SELECT command_json, command_fingerprint, device_id, lease_id, lease_epoch, workspace_binding_id, incarnation_id, command_digest, created_at, acknowledged_through FROM filesystem_read_executions WHERE execution_id = ?")
        .bind(execution_id).fetch_optional(&mut *connection).await? else { return Ok(None); };
    let command_json: String = row.try_get("command_json")?;
    if fingerprint(&command_json) != row.try_get::<String, _>("command_fingerprint")? {
        return Err(authority("device_journal_authority_corrupt"));
    }
    let command = parse_device_filesystem_read_command(
        serde_json::from_str(&command_json)
            .map_err(|_| authority("device_journal_authority_corrupt"))?,
    )
    .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let rows = sqlx::query("SELECT sequence, event_type, event_json, event_fingerprint, receipt_id, connection_epoch, observed_at FROM filesystem_read_events WHERE execution_id = ? ORDER BY sequence")
        .bind(execution_id).fetch_all(&mut *connection).await?;
    if rows.is_empty() || rows.len() > 2 {
        return Err(authority("device_journal_authority_corrupt"));
    }
    let mut events = Vec::with_capacity(rows.len());
    for row in rows {
        let json: String = row.try_get("event_json")?;
        if fingerprint(&json) != row.try_get::<String, _>("event_fingerprint")? {
            return Err(authority("device_journal_authority_corrupt"));
        }
        let event = parse_device_filesystem_read_event(
            serde_json::from_str(&json)
                .map_err(|_| authority("device_journal_authority_corrupt"))?,
        )
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
        let (event_envelope, event_type) = envelope(&event);
        if row.try_get::<i64, _>("sequence")?
            != i64::try_from(event_envelope.sequence)
                .map_err(|_| authority("device_journal_authority_corrupt"))?
            || row.try_get::<String, _>("event_type")? != event_type
            || row.try_get::<String, _>("receipt_id")? != event_envelope.receipt_id
            || row.try_get::<i64, _>("connection_epoch")?
                != i64::try_from(event_envelope.connection_epoch)
                    .map_err(|_| authority("device_journal_authority_corrupt"))?
            || row.try_get::<String, _>("observed_at")? != event_envelope.observed_at
        {
            return Err(authority("device_journal_authority_corrupt"));
        }
        events.push(event);
    }
    let (accepted_envelope, accepted_type) = envelope(&events[0]);
    validate_acceptance(&command, &events[0], accepted_envelope, accepted_type)?;
    if row.try_get::<String, _>("device_id")? != command.command.device_id
        || row.try_get::<String, _>("lease_id")? != command.command.lease_id
        || row.try_get::<i64, _>("lease_epoch")?
            != i64::try_from(command.command.lease_epoch)
                .map_err(|_| authority("device_journal_authority_corrupt"))?
        || row.try_get::<String, _>("workspace_binding_id")? != command.command.workspace_binding_id
        || row.try_get::<String, _>("incarnation_id")? != command.arguments.workspace_incarnation_id
        || row.try_get::<String, _>("command_digest")? != accepted_envelope.command_digest
        || row.try_get::<String, _>("created_at")? != accepted_envelope.observed_at
    {
        return Err(authority("device_journal_authority_corrupt"));
    }
    if let Some(terminal) = events.get(1) {
        validate_same_identity(&events[0], terminal)?;
        validate_event_time(&events[0], terminal)?;
    }
    let acknowledged_through = u64::try_from(row_i64(&row, "acknowledged_through")?)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    if acknowledged_through > events.len() as u64 {
        return Err(authority("device_journal_authority_corrupt"));
    }
    let execution = FilesystemReadJournalExecution {
        command,
        accepted: events.remove(0),
        terminal: events.pop(),
        acknowledged_through,
    };
    let ack_rows = sqlx::query("SELECT through_sequence, ack_json, ack_fingerprint FROM filesystem_read_acks WHERE execution_id = ? ORDER BY through_sequence")
        .bind(execution_id).fetch_all(&mut *connection).await?;
    let mut sequences = Vec::with_capacity(ack_rows.len());
    for ack_row in ack_rows {
        let json: String = ack_row.try_get("ack_json")?;
        if fingerprint(&json) != ack_row.try_get::<String, _>("ack_fingerprint")? {
            return Err(authority("device_journal_authority_corrupt"));
        }
        let ack = parse_device_filesystem_read_ack(
            serde_json::from_str(&json)
                .map_err(|_| authority("device_journal_authority_corrupt"))?,
        )
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
        validate_ack(&execution, &ack)?;
        if ack_row.try_get::<i64, _>("through_sequence")?
            != i64::try_from(ack.through_sequence)
                .map_err(|_| authority("device_journal_authority_corrupt"))?
        {
            return Err(authority("device_journal_authority_corrupt"));
        }
        sequences.push(ack.through_sequence);
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
    envelope: &crewon_device_protocol::DeviceFilesystemReadEventEnvelope,
    event_type: &str,
    json: String,
) -> Result<(), DeviceJournalError> {
    sqlx::query("INSERT INTO filesystem_read_events (execution_id, sequence, event_type, event_fingerprint, event_json, receipt_id, connection_epoch, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&envelope.execution_id).bind(i64::try_from(envelope.sequence).map_err(|_| authority("device_journal_filesystem_read_invalid"))?)
        .bind(event_type).bind(fingerprint(&json)).bind(json).bind(&envelope.receipt_id)
        .bind(i64::try_from(envelope.connection_epoch).map_err(|_| authority("device_journal_filesystem_read_invalid"))?).bind(&envelope.observed_at)
        .execute(&mut *connection).await?;
    Ok(())
}

fn validate_acceptance(
    command: &DeviceFilesystemReadCommand,
    event: &DeviceFilesystemReadEvent,
    envelope: &crewon_device_protocol::DeviceFilesystemReadEventEnvelope,
    event_type: &str,
) -> Result<(), DeviceJournalError> {
    let DeviceFilesystemReadEvent::Accepted { data, .. } = event else {
        return Err(authority(
            "device_journal_filesystem_read_identity_mismatch",
        ));
    };
    if event_type != "workspace_read.accepted"
        || envelope.sequence != 1
        || command.command.execution_id != envelope.execution_id
        || command.command.device_id != envelope.device_id
        || command.command.workspace_binding_id != envelope.workspace_binding_id
        || command.arguments.workspace_incarnation_id != envelope.incarnation_id
        || command.command.lease_id != data.lease_id
        || command.command.lease_epoch != data.lease_epoch
        || command.command.expires_at != data.expires_at
        || canonical_device_filesystem_read_command_digest(command)
            .ok()
            .as_deref()
            != Some(envelope.command_digest.as_str())
    {
        return Err(authority(
            "device_journal_filesystem_read_identity_mismatch",
        ));
    }
    Ok(())
}

fn validate_same_identity(
    left: &DeviceFilesystemReadEvent,
    right: &DeviceFilesystemReadEvent,
) -> Result<(), DeviceJournalError> {
    let left = envelope(left).0;
    let right = envelope(right).0;
    if left.device_id != right.device_id
        || left.execution_id != right.execution_id
        || left.receipt_id != right.receipt_id
        || left.connection_epoch != right.connection_epoch
        || left.workspace_binding_id != right.workspace_binding_id
        || left.incarnation_id != right.incarnation_id
        || left.command_digest != right.command_digest
    {
        return Err(authority(
            "device_journal_filesystem_read_identity_mismatch",
        ));
    }
    Ok(())
}

fn validate_ack(
    execution: &FilesystemReadJournalExecution,
    ack: &DeviceFilesystemReadAck,
) -> Result<(), DeviceJournalError> {
    let accepted = envelope(&execution.accepted).0;
    if ack.execution_id != accepted.execution_id
        || ack.device_id != accepted.device_id
        || ack.receipt_id != accepted.receipt_id
        || ack.connection_epoch != accepted.connection_epoch
        || ack.workspace_binding_id != accepted.workspace_binding_id
        || ack.incarnation_id != accepted.incarnation_id
        || ack.command_digest != accepted.command_digest
        || ack.through_sequence > if execution.terminal.is_some() { 2 } else { 1 }
    {
        return Err(authority("device_journal_filesystem_read_ack_invalid"));
    }
    Ok(())
}

fn validate_event_time(
    accepted: &DeviceFilesystemReadEvent,
    terminal: &DeviceFilesystemReadEvent,
) -> Result<(), DeviceJournalError> {
    let accepted_at = chrono::DateTime::parse_from_rfc3339(&envelope(accepted).0.observed_at)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    let terminal_at = chrono::DateTime::parse_from_rfc3339(&envelope(terminal).0.observed_at)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    if terminal_at < accepted_at {
        return Err(authority("device_journal_filesystem_read_terminal_invalid"));
    }
    Ok(())
}

fn envelope(
    event: &DeviceFilesystemReadEvent,
) -> (
    &crewon_device_protocol::DeviceFilesystemReadEventEnvelope,
    &'static str,
) {
    match event {
        DeviceFilesystemReadEvent::Accepted { envelope, .. } => {
            (envelope, "workspace_read.accepted")
        }
        DeviceFilesystemReadEvent::Completed { envelope, .. } => {
            (envelope, "workspace_read.completed")
        }
        DeviceFilesystemReadEvent::Failed { envelope, .. } => (envelope, "workspace_read.failed"),
        DeviceFilesystemReadEvent::Canceled { envelope, .. } => {
            (envelope, "workspace_read.canceled")
        }
        DeviceFilesystemReadEvent::UnknownOutcome { envelope, .. } => {
            (envelope, "workspace_read.unknown_outcome")
        }
    }
}

fn encode_command(value: &DeviceFilesystemReadCommand) -> Result<String, DeviceJournalError> {
    serde_json::to_string(&value.command)
        .map_err(|_| authority("device_journal_filesystem_read_invalid"))
}
fn encode_event(value: &DeviceFilesystemReadEvent) -> Result<String, DeviceJournalError> {
    serde_json::to_string(value).map_err(|_| authority("device_journal_filesystem_read_invalid"))
}
fn encode_ack(value: &DeviceFilesystemReadAck) -> Result<String, DeviceJournalError> {
    serde_json::to_string(value).map_err(|_| authority("device_journal_filesystem_read_invalid"))
}
fn fingerprint(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}
fn row_i64(row: &sqlx::sqlite::SqliteRow, name: &str) -> Result<i64, DeviceJournalError> {
    Ok(row.try_get(name)?)
}
