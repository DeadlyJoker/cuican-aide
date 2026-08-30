use crewon_device_protocol::DeviceFilesystemReadAck;
use crewon_device_protocol::DeviceFilesystemReadCommand;
use crewon_device_protocol::DeviceFilesystemReadEvent;
use sha2::Digest as _;
use sha2::Sha256;
use sqlx::Row as _;

use crate::DeviceJournalError;
use crate::authority;

pub(super) fn encode_command(
    value: &DeviceFilesystemReadCommand,
) -> Result<String, DeviceJournalError> {
    serde_json::to_string(&value.command)
        .map_err(|_| authority("device_journal_filesystem_read_invalid"))
}

pub(super) fn encode_event(
    value: &DeviceFilesystemReadEvent,
) -> Result<String, DeviceJournalError> {
    serde_json::to_string(value).map_err(|_| authority("device_journal_filesystem_read_invalid"))
}

pub(super) fn encode_ack(value: &DeviceFilesystemReadAck) -> Result<String, DeviceJournalError> {
    serde_json::to_string(value).map_err(|_| authority("device_journal_filesystem_read_invalid"))
}

pub(super) fn fingerprint(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}

pub(super) fn row_i64(
    row: &sqlx::sqlite::SqliteRow,
    name: &str,
) -> Result<i64, DeviceJournalError> {
    Ok(row.try_get(name)?)
}

pub(super) fn valid_execution_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}
