use crewon_device_protocol::DeviceWorkspaceListAck;
use crewon_device_protocol::DeviceWorkspaceListEvent;
use sqlx::Row as _;
use sqlx::SqliteConnection;

use crate::DeviceJournalError;
use crate::WorkspaceJournalExecution;
use crate::authority;
use crate::codec::decode_ack;
use crate::codec::decode_command;
use crate::codec::decode_event;
use crate::codec::event_envelope;
use crate::codec::validate_ack_identity;
use crate::codec::validate_ack_time;
use crate::codec::validate_fresh_acceptance;
use crate::codec::validate_terminal_identity;

pub(crate) async fn load_execution(
    connection: &mut SqliteConnection,
    execution_id: &str,
) -> Result<Option<WorkspaceJournalExecution>, DeviceJournalError> {
    let Some(row) = sqlx::query(
        r#"
SELECT execution_id, execution_kind, command_fingerprint, command_json, device_id,
       lease_id, lease_epoch, expires_at, workspace_binding_id, incarnation_id,
       device_binding_id, runtime_binding_id, policy_snapshot_id, action_digest,
       command_digest, idempotency_key, acknowledged_through, created_at
FROM workspace_executions
WHERE execution_id = ?
        "#,
    )
    .bind(execution_id)
    .fetch_optional(&mut *connection)
    .await?
    else {
        return Ok(None);
    };
    let command_json: String = row.try_get("command_json")?;
    let command_fingerprint: String = row.try_get("command_fingerprint")?;
    let command = decode_command(&command_json, &command_fingerprint)?.record;
    let acknowledged_through = integer_u64(&row, "acknowledged_through")?;
    if row.try_get::<String, _>("execution_id")? != command.execution_id
        || row.try_get::<String, _>("execution_kind")? != "workspaceList"
        || row.try_get::<String, _>("device_id")? != command.device_id
        || row.try_get::<String, _>("lease_id")? != command.lease_id
        || integer_u64(&row, "lease_epoch")? != command.lease_epoch
        || row.try_get::<String, _>("expires_at")? != command.expires_at
        || row.try_get::<String, _>("workspace_binding_id")? != command.workspace_binding_id
        || row.try_get::<String, _>("incarnation_id")? != command.incarnation_id
        || row.try_get::<String, _>("device_binding_id")? != command.device_binding_id
        || row.try_get::<String, _>("runtime_binding_id")? != command.runtime_binding_id
        || row.try_get::<String, _>("policy_snapshot_id")? != command.policy_snapshot_id
        || row.try_get::<String, _>("action_digest")? != command.action_digest
        || row.try_get::<String, _>("command_digest")? != command.command_digest
        || row.try_get::<String, _>("idempotency_key")? != command.idempotency_key
        || acknowledged_through > 2
    {
        return Err(authority("device_journal_authority_corrupt"));
    }
    let event_rows = sqlx::query(
        r#"
SELECT execution_id, sequence, event_type, event_fingerprint, event_json, device_id,
       receipt_id, connection_epoch, workspace_binding_id, incarnation_id,
       device_binding_id, runtime_binding_id, action_digest, command_digest, observed_at
FROM workspace_events
WHERE execution_id = ?
ORDER BY sequence
        "#,
    )
    .bind(execution_id)
    .fetch_all(&mut *connection)
    .await?;
    if !(event_rows.len() == 1 || event_rows.len() == 2) {
        return Err(authority("device_journal_authority_corrupt"));
    }
    let accepted = decode_event_row(&event_rows[0])?;
    if event_envelope(&accepted).sequence != 1 {
        return Err(authority("device_journal_authority_corrupt"));
    }
    validate_fresh_acceptance(&command, &accepted)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    if row.try_get::<String, _>("created_at")? != event_envelope(&accepted).observed_at {
        return Err(authority("device_journal_authority_corrupt"));
    }
    let terminal = event_rows.get(1).map(decode_event_row).transpose()?;
    let execution = WorkspaceJournalExecution {
        command,
        accepted,
        terminal,
        acknowledged_through,
    };
    if execution
        .terminal
        .as_ref()
        .is_some_and(|terminal| validate_terminal_identity(&execution, terminal).is_err())
        || acknowledged_through > execution.head_sequence()
    {
        return Err(authority("device_journal_authority_corrupt"));
    }
    validate_ack_rows(connection, &execution).await?;
    Ok(Some(execution))
}

pub(crate) async fn load_ack(
    connection: &mut SqliteConnection,
    execution: &WorkspaceJournalExecution,
    through_sequence: u64,
) -> Result<Option<DeviceWorkspaceListAck>, DeviceJournalError> {
    let row = sqlx::query(
        r#"
SELECT execution_id, through_sequence, ack_fingerprint, ack_json, device_id,
       receipt_id, connection_epoch, workspace_binding_id, incarnation_id,
       device_binding_id, runtime_binding_id, action_digest, command_digest, acknowledged_at
FROM workspace_acks
WHERE execution_id = ? AND through_sequence = ?
        "#,
    )
    .bind(&execution.command.execution_id)
    .bind(i64::try_from(through_sequence).map_err(|_| authority("device_journal_authority_corrupt"))?)
    .fetch_optional(&mut *connection)
    .await?;
    row.map(|row| decode_ack_row(&row, execution)).transpose()
}

async fn validate_ack_rows(
    connection: &mut SqliteConnection,
    execution: &WorkspaceJournalExecution,
) -> Result<(), DeviceJournalError> {
    let rows = sqlx::query(
        r#"
SELECT execution_id, through_sequence, ack_fingerprint, ack_json, device_id,
       receipt_id, connection_epoch, workspace_binding_id, incarnation_id,
       device_binding_id, runtime_binding_id, action_digest, command_digest, acknowledged_at
FROM workspace_acks
WHERE execution_id = ?
ORDER BY through_sequence
        "#,
    )
    .bind(&execution.command.execution_id)
    .fetch_all(&mut *connection)
    .await?;
    let mut sequences = Vec::with_capacity(rows.len());
    let mut prior = None;
    for row in &rows {
        let ack = decode_ack_row(row, execution)?;
        validate_ack_time(execution, &ack, prior.as_ref())
            .map_err(|_| authority("device_journal_authority_corrupt"))?;
        sequences.push(ack.through_sequence);
        prior = Some(ack);
    }
    let valid = match execution.acknowledged_through {
        0 => sequences.is_empty(),
        1 => sequences == [1],
        2 => sequences == [2] || sequences == [1, 2],
        _ => false,
    };
    if !valid {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(())
}

fn decode_event_row(row: &sqlx::sqlite::SqliteRow) -> Result<DeviceWorkspaceListEvent, DeviceJournalError> {
    let event_json: String = row.try_get("event_json")?;
    let event_fingerprint: String = row.try_get("event_fingerprint")?;
    let event_type: String = row.try_get("event_type")?;
    let event = decode_event(&event_json, &event_fingerprint, &event_type)?.record;
    let envelope = event_envelope(&event);
    if row.try_get::<String, _>("execution_id")? != envelope.execution_id
        || integer_u64(row, "sequence")? != envelope.sequence
        || row.try_get::<String, _>("device_id")? != envelope.device_id
        || row.try_get::<String, _>("receipt_id")? != envelope.receipt_id
        || integer_u64(row, "connection_epoch")? != envelope.connection_epoch
        || row.try_get::<String, _>("workspace_binding_id")? != envelope.workspace_binding_id
        || row.try_get::<String, _>("incarnation_id")? != envelope.incarnation_id
        || row.try_get::<String, _>("device_binding_id")? != envelope.device_binding_id
        || row.try_get::<String, _>("runtime_binding_id")? != envelope.runtime_binding_id
        || row.try_get::<String, _>("action_digest")? != envelope.action_digest
        || row.try_get::<String, _>("command_digest")? != envelope.command_digest
        || row.try_get::<String, _>("observed_at")? != envelope.observed_at
    {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(event)
}

fn decode_ack_row(
    row: &sqlx::sqlite::SqliteRow,
    execution: &WorkspaceJournalExecution,
) -> Result<DeviceWorkspaceListAck, DeviceJournalError> {
    let ack_json: String = row.try_get("ack_json")?;
    let ack_fingerprint: String = row.try_get("ack_fingerprint")?;
    let ack = decode_ack(&ack_json, &ack_fingerprint)?.record;
    validate_ack_identity(execution, &ack)
        .map_err(|_| authority("device_journal_authority_corrupt"))?;
    if row.try_get::<String, _>("execution_id")? != ack.execution_id
        || integer_u64(row, "through_sequence")? != ack.through_sequence
        || row.try_get::<String, _>("device_id")? != ack.device_id
        || row.try_get::<String, _>("receipt_id")? != ack.receipt_id
        || integer_u64(row, "connection_epoch")? != ack.connection_epoch
        || row.try_get::<String, _>("workspace_binding_id")? != ack.workspace_binding_id
        || row.try_get::<String, _>("incarnation_id")? != ack.incarnation_id
        || row.try_get::<String, _>("device_binding_id")? != ack.device_binding_id
        || row.try_get::<String, _>("runtime_binding_id")? != ack.runtime_binding_id
        || row.try_get::<String, _>("action_digest")? != ack.action_digest
        || row.try_get::<String, _>("command_digest")? != ack.command_digest
        || row.try_get::<String, _>("acknowledged_at")? != ack.acknowledged_at
    {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(ack)
}

fn integer_u64(
    row: &sqlx::sqlite::SqliteRow,
    column: &str,
) -> Result<u64, DeviceJournalError> {
    u64::try_from(row.try_get::<i64, _>(column)?)
        .map_err(|_| authority("device_journal_authority_corrupt"))
}
