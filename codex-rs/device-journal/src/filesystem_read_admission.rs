use crewon_device_protocol::DeviceFilesystemReadCommand;
use crewon_device_protocol::DeviceFilesystemReadEvent;

use crate::DeviceJournalError;
use crate::DeviceWorkspaceJournal;
use crate::FilesystemReadJournalExecution;
use crate::authority;
use crate::filesystem_read::envelope;
use crate::filesystem_read::insert_event;
use crate::filesystem_read::load;
use crate::filesystem_read::validate_acceptance;
use crate::filesystem_read_codec::encode_command;
use crate::filesystem_read_codec::encode_event;
use crate::filesystem_read_codec::fingerprint;

#[derive(Debug)]
pub enum PrepareFilesystemReadWithAdmissionOutcome<T> {
    New { execution: FilesystemReadJournalExecution, admitted: T },
    AcceptedReplay(FilesystemReadJournalExecution),
    TerminalReplay(FilesystemReadJournalExecution),
}

#[derive(Debug)]
pub enum PrepareFilesystemReadWithAdmissionError<E> {
    Journal(DeviceJournalError),
    Admission(E),
}

impl DeviceWorkspaceJournal {
    pub async fn prepare_filesystem_read_with_admission<T, E>(
        &self,
        command: &DeviceFilesystemReadCommand,
        admit: impl FnOnce() -> Result<(DeviceFilesystemReadEvent, T), E>,
    ) -> Result<PrepareFilesystemReadWithAdmissionOutcome<T>, PrepareFilesystemReadWithAdmissionError<E>> {
        let command_json = encode_command(command).map_err(PrepareFilesystemReadWithAdmissionError::Journal)?;
        let command_fingerprint = fingerprint(&command_json);
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(DeviceJournalError::from).map_err(PrepareFilesystemReadWithAdmissionError::Journal)?;
        if let Some(existing) = load(&mut tx, &command.command.execution_id).await.map_err(PrepareFilesystemReadWithAdmissionError::Journal)? {
            if existing.command != *command {
                return Err(PrepareFilesystemReadWithAdmissionError::Journal(authority("device_journal_filesystem_read_command_conflict")));
            }
            tx.rollback().await.map_err(DeviceJournalError::from).map_err(PrepareFilesystemReadWithAdmissionError::Journal)?;
            return Ok(if existing.terminal.is_some() {
                PrepareFilesystemReadWithAdmissionOutcome::TerminalReplay(existing)
            } else {
                PrepareFilesystemReadWithAdmissionOutcome::AcceptedReplay(existing)
            });
        }
        let (accepted, admitted) = admit().map_err(PrepareFilesystemReadWithAdmissionError::Admission)?;
        let (accepted_envelope, accepted_type) = envelope(&accepted);
        validate_acceptance(command, &accepted, accepted_envelope, accepted_type).map_err(PrepareFilesystemReadWithAdmissionError::Journal)?;
        let accepted_json = encode_event(&accepted).map_err(PrepareFilesystemReadWithAdmissionError::Journal)?;
        let owner: Option<String> = sqlx::query_scalar("SELECT execution_id FROM filesystem_read_events WHERE receipt_id = ? AND sequence = 1")
            .bind(&accepted_envelope.receipt_id).fetch_optional(&mut *tx).await.map_err(DeviceJournalError::from).map_err(PrepareFilesystemReadWithAdmissionError::Journal)?;
        if owner.is_some() {
            return Err(PrepareFilesystemReadWithAdmissionError::Journal(authority("device_journal_filesystem_read_receipt_conflict")));
        }
        sqlx::query(r#"INSERT INTO filesystem_read_executions
(execution_id, command_fingerprint, command_json, device_id, lease_id, lease_epoch,
 workspace_binding_id, incarnation_id, command_digest, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#)
            .bind(&command.command.execution_id).bind(command_fingerprint).bind(command_json)
            .bind(&command.command.device_id).bind(&command.command.lease_id)
            .bind(i64::try_from(command.command.lease_epoch).map_err(|_| PrepareFilesystemReadWithAdmissionError::Journal(authority("device_journal_filesystem_read_invalid")))?)
            .bind(&command.command.workspace_binding_id).bind(&command.arguments.workspace_incarnation_id)
            .bind(&accepted_envelope.command_digest).bind(&accepted_envelope.observed_at)
            .execute(&mut *tx).await.map_err(DeviceJournalError::from).map_err(PrepareFilesystemReadWithAdmissionError::Journal)?;
        insert_event(&mut tx, accepted_envelope, accepted_type, accepted_json).await.map_err(PrepareFilesystemReadWithAdmissionError::Journal)?;
        let execution = load(&mut tx, &command.command.execution_id).await.map_err(PrepareFilesystemReadWithAdmissionError::Journal)?
            .ok_or_else(|| PrepareFilesystemReadWithAdmissionError::Journal(authority("device_journal_authority_corrupt")))?;
        tx.commit().await.map_err(DeviceJournalError::from).map_err(PrepareFilesystemReadWithAdmissionError::Journal)?;
        Ok(PrepareFilesystemReadWithAdmissionOutcome::New { execution, admitted })
    }
}
