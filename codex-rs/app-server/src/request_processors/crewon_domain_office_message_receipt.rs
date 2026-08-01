use std::io;
use std::path::Path;
use std::path::PathBuf;

use crewon_app_server_protocol::JSONRPCErrorError;
use serde::Deserialize;
use serde::Serialize;
use tokio::fs;
use tokio::io::AsyncReadExt;

use super::DomainKind;
use super::domain_directory;
use super::map_io_error;
use super::office_authority_lock;
use super::office_record_lock;
use super::office_storage;
use super::sha256_hex;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;

const RECEIPT_STORE_VERSION: u32 = 1;
const MAX_RECEIPTS_PER_OFFICE: usize = 256;
const MAX_ACTIVE_RECEIPTS_PER_OFFICE: usize = 8;
// The mirror is a strict subset of the canonical Office record, whose storage cap is 4 MiB.
const MAX_RECEIPT_STORE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ID_BYTES: usize = 256;
const MAX_HASH_BYTES: usize = 128;
const MAX_TIMESTAMP_BYTES: usize = 64;
const MAX_ERROR_BYTES: usize = 320;
pub(super) const MAX_DISPATCH_ATTEMPTS: u32 = 3;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ReceiptStatus {
    Reserved,
    Dispatching,
    Queued,
    Delivered,
    Failed,
}

impl ReceiptStatus {
    fn is_active(self) -> bool {
        matches!(self, Self::Reserved | Self::Dispatching | Self::Queued)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ReceiptAction {
    Pending,
    StartRun,
    SteerRun,
    QueueAfterRun,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OfficeMessageReceipt {
    pub(super) receipt_id: String,
    pub(super) client_user_message_id: String,
    pub(super) payload_hash: String,
    pub(super) message_id: String,
    pub(super) sequence: u64,
    pub(super) text: String,
    pub(super) locale: Option<String>,
    pub(super) mentions: Vec<String>,
    #[serde(default)]
    pub(super) message_intent: Option<String>,
    #[serde(default)]
    pub(super) intent_classifier_version: Option<u64>,
    pub(super) status: ReceiptStatus,
    pub(super) action: ReceiptAction,
    pub(super) run_id: Option<String>,
    pub(super) thread_id: Option<String>,
    pub(super) expected_turn_id: Option<String>,
    pub(super) turn_id: Option<String>,
    pub(super) after_run_id: Option<String>,
    pub(super) queue_position: Option<u32>,
    pub(super) lease_id: Option<String>,
    pub(super) lease_expires_at: Option<String>,
    pub(super) attempts: u32,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    pub(super) error: Option<String>,
}

impl OfficeMessageReceipt {
    fn is_valid(&self) -> bool {
        valid_required(&self.receipt_id, MAX_ID_BYTES)
            && valid_required(&self.client_user_message_id, MAX_ID_BYTES)
            && valid_required(&self.payload_hash, MAX_HASH_BYTES)
            && valid_required(&self.message_id, MAX_ID_BYTES)
            && self.sequence > 0
            && valid_required(&self.text, 900)
            && valid_optional(self.locale.as_deref(), 32)
            && self.mentions.len() <= 16
            && self
                .mentions
                .iter()
                .all(|member_id| valid_required(member_id, 128))
            && matches!(
                (
                    self.message_intent.as_deref(),
                    self.intent_classifier_version,
                ),
                (None, None) | (Some("conversation" | "task"), Some(1))
            )
            && valid_optional(self.run_id.as_deref(), MAX_ID_BYTES)
            && valid_optional(self.thread_id.as_deref(), MAX_ID_BYTES)
            && valid_optional(self.expected_turn_id.as_deref(), MAX_ID_BYTES)
            && valid_optional(self.turn_id.as_deref(), MAX_ID_BYTES)
            && valid_optional(self.after_run_id.as_deref(), MAX_ID_BYTES)
            && valid_optional(self.lease_id.as_deref(), MAX_ID_BYTES)
            && valid_optional(self.lease_expires_at.as_deref(), MAX_TIMESTAMP_BYTES)
            && valid_required(&self.created_at, MAX_TIMESTAMP_BYTES)
            && valid_required(&self.updated_at, MAX_TIMESTAMP_BYTES)
            && valid_optional(self.error.as_deref(), MAX_ERROR_BYTES)
            && self.attempts <= MAX_DISPATCH_ATTEMPTS
            && self.queue_position.is_none_or(|position| position > 0)
    }
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfficeMessageReceiptStore {
    version: u32,
    office_record_id: String,
    record_revision: String,
    receipts: Vec<OfficeMessageReceipt>,
}

pub(super) async fn sync_from_canonical(
    cwd: &str,
    office_record_id: &str,
    record_revision: &str,
    receipts: Vec<OfficeMessageReceipt>,
) -> Result<(), JSONRPCErrorError> {
    if !valid_required(office_record_id, MAX_ID_BYTES)
        || !valid_required(record_revision, MAX_ID_BYTES)
        || receipts.len() > MAX_RECEIPTS_PER_OFFICE
        || receipts
            .iter()
            .filter(|receipt| receipt.status.is_active())
            .count()
            > MAX_ACTIVE_RECEIPTS_PER_OFFICE
        || receipts.iter().any(|receipt| !receipt.is_valid())
    {
        return Err(invalid_params(
            "canonical Office message receipts are invalid or exceed their hard limits",
        ));
    }
    let mut client_ids = std::collections::HashSet::with_capacity(receipts.len());
    let mut receipt_ids = std::collections::HashSet::with_capacity(receipts.len());
    if receipts.iter().any(|receipt| {
        !client_ids.insert(receipt.client_user_message_id.as_str())
            || !receipt_ids.insert(receipt.receipt_id.as_str())
    }) {
        return Err(invalid_params(
            "canonical Office message receipts contain duplicate identities",
        ));
    }
    let authority_guard = office_authority_lock::lock(cwd).await?;
    let canonical_revision =
        office_storage::record_revision_under_authority(cwd, &authority_guard, office_record_id)
            .await?;
    if canonical_revision.as_deref() != Some(record_revision) {
        return Ok(());
    }
    let path = receipt_store_path(cwd, office_record_id)?;
    let _receipt_guard = office_record_lock::lock(&path)
        .await
        .map_err(map_io_error)?;
    let store = OfficeMessageReceiptStore {
        version: RECEIPT_STORE_VERSION,
        office_record_id: office_record_id.to_string(),
        record_revision: record_revision.to_string(),
        receipts,
    };
    if read_store(&path, office_record_id).await? == store {
        return Ok(());
    }
    write_store(&path, &store).await
}

pub(super) async fn delete_for_office(
    cwd: &str,
    office_record_id: &str,
) -> Result<(), JSONRPCErrorError> {
    let path = receipt_store_path(cwd, office_record_id)?;
    let _receipt_guard = office_record_lock::lock(&path)
        .await
        .map_err(map_io_error)?;
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(map_io_error(error)),
    }
}

fn receipt_store_path(cwd: &str, office_record_id: &str) -> Result<PathBuf, JSONRPCErrorError> {
    let digest = sha256_hex(office_record_id.as_bytes());
    domain_directory(cwd, DomainKind::Office)
        .map(|directory| directory.join(format!(".message-receipts-{digest}.state")))
}

async fn read_store(
    path: &Path,
    office_record_id: &str,
) -> Result<OfficeMessageReceiptStore, JSONRPCErrorError> {
    let file = match fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(empty_store(office_record_id));
        }
        Err(error) => return Err(map_io_error(error)),
    };
    let metadata = file.metadata().await.map_err(map_io_error)?;
    if metadata.len() > MAX_RECEIPT_STORE_BYTES {
        return Ok(empty_store(office_record_id));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
    file.take(MAX_RECEIPT_STORE_BYTES.saturating_add(/*rhs*/ 1))
        .read_to_end(&mut bytes)
        .await
        .map_err(map_io_error)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_RECEIPT_STORE_BYTES {
        return Ok(empty_store(office_record_id));
    }
    let Ok(store) = serde_json::from_slice::<OfficeMessageReceiptStore>(&bytes) else {
        return Ok(empty_store(office_record_id));
    };
    if store.version != RECEIPT_STORE_VERSION
        || store.office_record_id != office_record_id
        || !valid_required(&store.record_revision, MAX_ID_BYTES)
        || store.receipts.len() > MAX_RECEIPTS_PER_OFFICE
        || store
            .receipts
            .iter()
            .filter(|receipt| receipt.status.is_active())
            .count()
            > MAX_ACTIVE_RECEIPTS_PER_OFFICE
        || store.receipts.iter().any(|receipt| !receipt.is_valid())
    {
        return Ok(empty_store(office_record_id));
    }
    Ok(store)
}

fn empty_store(office_record_id: &str) -> OfficeMessageReceiptStore {
    OfficeMessageReceiptStore {
        version: RECEIPT_STORE_VERSION,
        office_record_id: office_record_id.to_string(),
        record_revision: String::new(),
        receipts: Vec::new(),
    }
}

async fn write_store(
    path: &Path,
    store: &OfficeMessageReceiptStore,
) -> Result<(), JSONRPCErrorError> {
    let mut bytes = serde_json::to_vec_pretty(store).map_err(|error| {
        internal_error(format!(
            "failed to serialize Office message receipt store: {error}"
        ))
    })?;
    bytes.push(b'\n');
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_RECEIPT_STORE_BYTES {
        return Err(internal_error(
            "Office message receipt store exceeds its size limit",
        ));
    }
    let contents = String::from_utf8(bytes).map_err(|error| {
        internal_error(format!(
            "Office message receipt store is not UTF-8: {error}"
        ))
    })?;
    office_storage::write_atomically_preserving_permissions(path, contents).await
}

fn valid_required(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value == value.trim() && value.len() <= max_bytes
}

fn valid_optional(value: Option<&str>, max_bytes: usize) -> bool {
    value.is_none_or(|value| valid_required(value, max_bytes))
}

#[cfg(test)]
#[path = "crewon_domain_office_message_receipt_tests.rs"]
mod tests;
