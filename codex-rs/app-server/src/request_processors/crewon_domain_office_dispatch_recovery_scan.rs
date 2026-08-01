use crate::request_processors::crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery;
use crate::request_processors::crewon_domain_office_dispatch_recovery::locate_office_dispatch_recovery;
use serde_json::json;
use std::collections::BTreeMap;

use super::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ScannedOfficeDispatchRecovery {
    pub(crate) config: JsonValue,
    pub(crate) file_path: String,
    pub(crate) recovery: LocatedOfficeDispatchRecovery,
}

/// Scans canonical Office records for one exact durable dispatch recovery identity.
///
/// The scan never falls back to the next queued delegation. Corrupt receipts, an incomplete
/// bounded scan, and duplicate matches all fail closed because none can prove a unique recovery
/// target.
pub(crate) async fn scan_exact_office_dispatch_recovery(
    cwd: &str,
    intent_id: &str,
    source_thread_id: &str,
    source_turn_id: &str,
) -> Result<Option<ScannedOfficeDispatchRecovery>, JSONRPCErrorError> {
    validate_exact_recovery_key(intent_id, source_thread_id, source_turn_id)?;
    let directory = domain_directory(cwd, DomainKind::Office)?;
    let mut entries = match fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(map_io_error(err)),
    };

    let mut scanned = 0usize;
    let mut matched = None;
    let mut record_id_counts = BTreeMap::<String, usize>::new();
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        if scanned >= AUTO_SYNC_OFFICE_SCAN_LIMIT {
            return Err(invalid_params(format!(
                "Office dispatch recovery scan exceeds {AUTO_SYNC_OFFICE_SCAN_LIMIT} entries"
            )));
        }
        scanned += 1;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }

        let Some(record) = read_record(DomainKind::Office, &path).await? else {
            continue;
        };
        if let Some(record_id) = record
            .config
            .get("workspace")
            .and_then(|workspace| workspace.get("recordId"))
            .and_then(JsonValue::as_str)
        {
            *record_id_counts.entry(record_id.to_string()).or_default() += 1;
        }
        let recovery = locate_office_dispatch_recovery(
            &record.config,
            intent_id,
            source_thread_id,
            source_turn_id,
        )
        .map_err(|_| invalid_params("canonical Office dispatch recovery receipt is corrupt"))?;
        let Some(recovery) = recovery else {
            continue;
        };
        if matched.is_some() {
            return Err(invalid_params(
                "multiple canonical Office records contain the same dispatch recovery identity",
            ));
        }
        matched = Some(ScannedOfficeDispatchRecovery {
            config: record.config,
            file_path: record.file_path,
            recovery,
        });
    }
    if matched.as_ref().is_some_and(|matched| {
        record_id_counts
            .get(&matched.recovery.record_id)
            .copied()
            .unwrap_or_default()
            != 1
    }) {
        return Err(invalid_params(
            "canonical Office dispatch recovery recordId is not unique",
        ));
    }
    Ok(matched)
}

fn validate_exact_recovery_key(
    intent_id: &str,
    source_thread_id: &str,
    source_turn_id: &str,
) -> Result<(), JSONRPCErrorError> {
    let probe = json!({ "workspace": { "recordId": "recovery-scan-validation" } });
    locate_office_dispatch_recovery(&probe, intent_id, source_thread_id, source_turn_id)
        .map(|_| ())
        .map_err(|_| invalid_params("Office dispatch recovery identity is invalid"))
}

#[cfg(test)]
#[path = "crewon_domain_office_dispatch_recovery_scan_tests.rs"]
mod tests;
