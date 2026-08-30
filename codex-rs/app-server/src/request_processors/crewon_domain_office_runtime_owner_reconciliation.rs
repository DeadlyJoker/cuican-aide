use std::io;
use std::path::Path;

use crewon_app_server_protocol::JSONRPCErrorError;
use tokio::fs;

use super::map_io_error;
use super::office_runtime_owner_registry;
use super::office_runtime_owner_registry::OfficeRuntimeOwnerReconciliation;
use super::office_storage;
use crate::error_code::internal_error;

const MAX_RECONCILIATION_RECORDS: usize = 256;
const MAX_RECONCILIATION_BYTES: u64 = 64 * 1024 * 1024;

pub(super) async fn reconcile_if_needed(
    directory: &Path,
    registry: &mut office_runtime_owner_registry::OfficeRuntimeOwnerRegistryGuard<'_>,
) -> Result<(), JSONRPCErrorError> {
    if !registry.needs_reconciliation() {
        return Ok(());
    }
    let mut entries = match fs::read_dir(directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return registry
                .reconcile_persisted_configs(
                    std::iter::empty(),
                    OfficeRuntimeOwnerReconciliation::Complete,
                )
                .await;
        }
        Err(err) => return Err(map_io_error(err)),
    };
    let mut records = Vec::new();
    let mut candidate_records = 0usize;
    let mut total_bytes = 0u64;
    let mut quarantined_unreadable_record = false;
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(error) => {
                tracing::warn!(
                    file_path = %path.display(),
                    %error,
                    "quarantining an Office record with unreadable file metadata during runtime owner reconciliation"
                );
                quarantined_unreadable_record = true;
                continue;
            }
        };
        if !file_type.is_file() {
            continue;
        }
        candidate_records = candidate_records.saturating_add(1);
        if candidate_records > MAX_RECONCILIATION_RECORDS {
            return Err(internal_error(format!(
                "Office runtime owner reconciliation exceeds {MAX_RECONCILIATION_RECORDS} records"
            )));
        }
        let metadata = match entry.metadata().await {
            Ok(metadata) => metadata,
            Err(error) => {
                tracing::warn!(
                    file_path = %path.display(),
                    %error,
                    "quarantining an Office record with unreadable metadata during runtime owner reconciliation"
                );
                quarantined_unreadable_record = true;
                continue;
            }
        };
        total_bytes = total_bytes.saturating_add(
            metadata
                .len()
                .min(office_storage::MAX_OFFICE_RECORD_BYTES.saturating_add(/*rhs*/ 1)),
        );
        if total_bytes > MAX_RECONCILIATION_BYTES {
            return Err(internal_error(format!(
                "Office runtime owner reconciliation exceeds {MAX_RECONCILIATION_BYTES} bytes"
            )));
        }
        match office_storage::read_office_record_strict(&path).await {
            Ok(Some(record)) => records.push(record),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    file_path = %path.display(),
                    error = %error.message,
                    "quarantining an unreadable Office record during runtime owner reconciliation"
                );
                quarantined_unreadable_record = true;
            }
        }
    }
    let reconciliation = if quarantined_unreadable_record {
        OfficeRuntimeOwnerReconciliation::QuarantinedUnreadableRecords
    } else {
        OfficeRuntimeOwnerReconciliation::Complete
    };
    registry
        .reconcile_persisted_configs(records.iter().map(|record| &record.config), reconciliation)
        .await
}

#[cfg(test)]
#[path = "crewon_domain_office_runtime_owner_reconciliation_tests.rs"]
mod tests;
