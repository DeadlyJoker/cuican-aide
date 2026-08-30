use std::collections::BTreeMap;
use std::collections::HashSet;
use std::io;
use std::path::Path;

use crewon_app_server_protocol::CrewonDomainConfigRecord;
use crewon_app_server_protocol::JSONRPCErrorError;
use tokio::fs;
use tokio::io::AsyncReadExt;

use super::super::DomainKind;
use super::super::PersistedDomainConfigRecord;
use super::super::domain_directory;
use super::super::map_io_error;
use super::super::office_thread_id;
use super::super::sha256_hex;
use super::MAX_OFFICE_RECORD_BYTES;
use super::MAX_OFFICE_RECORD_ID_CHARS;
use super::OfficeIdentityLookup;
use super::office_record_id;
use super::office_record_revision;
use super::set_office_record_id;
use super::set_office_record_revision;
use super::validate_office_record_id;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;

const MAX_OFFICE_SCHEDULER_RECORD_PAGE_LIMIT: usize = 100;

#[derive(Clone, Copy)]
enum UnreadableOfficeRecordPolicy {
    FailIfNoMatch,
    Ignore,
}

pub(crate) async fn find_office_record(
    directory: &Path,
    lookup: OfficeIdentityLookup<'_>,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    find_office_record_with_policy(
        directory,
        lookup,
        UnreadableOfficeRecordPolicy::FailIfNoMatch,
    )
    .await
}

pub(in super::super) async fn find_office_record_ignoring_unreadable(
    directory: &Path,
    lookup: OfficeIdentityLookup<'_>,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    find_office_record_with_policy(directory, lookup, UnreadableOfficeRecordPolicy::Ignore).await
}

async fn find_office_record_with_policy(
    directory: &Path,
    lookup: OfficeIdentityLookup<'_>,
    unreadable_policy: UnreadableOfficeRecordPolicy,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    let mut entries = match fs::read_dir(directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(map_io_error(err)),
    };
    let mut seen_record_ids = HashSet::new();
    let mut matching_record = None;
    let mut first_unreadable_error = None;
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let record = match read_office_record_strict(&path).await {
            Ok(Some(record)) => record,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(
                    file_path = %path.display(),
                    error = %error.message,
                    "isolating an unreadable Office record during identity lookup"
                );
                first_unreadable_error.get_or_insert(error);
                continue;
            }
        };
        let record_id = office_record_id(&record.config).ok_or_else(|| {
            internal_error("Office identity scan returned a record without recordId")
        })?;
        if !seen_record_ids.insert(record_id.to_string()) {
            return Err(invalid_params(
                "multiple office configs match the same workspace.recordId",
            ));
        }
        let matches = match lookup {
            OfficeIdentityLookup::RecordId(expected) => record_id == expected,
            OfficeIdentityLookup::LegacyThreadId(expected) => {
                office_thread_id(&record.config) == Some(expected)
            }
        };
        if !matches {
            continue;
        }
        if matching_record.is_some() {
            let field = match lookup {
                OfficeIdentityLookup::RecordId(_) => "workspace.recordId",
                OfficeIdentityLookup::LegacyThreadId(_) => "workspace.threadId",
            };
            return Err(invalid_params(format!(
                "multiple office configs match the same {field}"
            )));
        }
        matching_record = Some(record);
    }
    if matching_record.is_some()
        || matches!(unreadable_policy, UnreadableOfficeRecordPolicy::Ignore)
    {
        return Ok(matching_record);
    }
    match first_unreadable_error {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

pub(crate) async fn validate_office_thread_ownership(
    directory: &Path,
    thread_id: &str,
    record_id: &str,
) -> Result<(), JSONRPCErrorError> {
    let Some(owner) = find_office_record_ignoring_unreadable(
        directory,
        OfficeIdentityLookup::LegacyThreadId(thread_id),
    )
    .await?
    else {
        return Ok(());
    };
    if office_record_id(&owner.config) == Some(record_id) {
        return Ok(());
    }
    Err(invalid_params(format!(
        "workspace.threadId {thread_id} is already bound to another Office record"
    )))
}

pub(crate) async fn read_office_record_strict(
    path: &Path,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    if path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .is_some_and(|file_name| file_name.starts_with('.'))
    {
        return Ok(None);
    }
    let file = match fs::File::open(path).await {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(internal_error(format!(
                "failed to resolve Office identity from {}: {err}",
                path.display()
            )));
        }
    };
    let metadata = file.metadata().await.map_err(map_io_error)?;
    if metadata.len() > MAX_OFFICE_RECORD_BYTES {
        return Err(internal_error(format!(
            "failed to resolve Office identity from oversized record {}",
            path.display()
        )));
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or_default()
            .min(usize::try_from(MAX_OFFICE_RECORD_BYTES).unwrap_or(usize::MAX)),
    );
    file.take(MAX_OFFICE_RECORD_BYTES.saturating_add(/*rhs*/ 1))
        .read_to_end(&mut bytes)
        .await
        .map_err(map_io_error)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_OFFICE_RECORD_BYTES {
        return Err(internal_error(format!(
            "failed to resolve Office identity from record that exceeded the read limit {}",
            path.display()
        )));
    }
    let mut record =
        serde_json::from_slice::<PersistedDomainConfigRecord>(&bytes).map_err(|err| {
            internal_error(format!(
                "failed to resolve Office identity from {}: {err}",
                path.display()
            ))
        })?;
    if record.version != 1
        || record.kind != DomainKind::Office.record_kind()
        || !DomainKind::Office.config_matches(&record.config)
        || office_thread_id(&record.config)
            .is_some_and(|thread_id| thread_id.trim().is_empty() || thread_id != thread_id.trim())
    {
        return Err(internal_error(format!(
            "failed to resolve Office identity from invalid record {}",
            path.display()
        )));
    }
    match validate_office_record_id(&record.config) {
        Ok(Some(_)) => {}
        Ok(None) => {
            let file_name = path.file_name().ok_or_else(|| {
                internal_error(format!(
                    "failed to derive legacy Office recordId from {}",
                    path.display()
                ))
            })?;
            let derived_record_id = format!(
                "legacy-{}",
                sha256_hex(file_name.to_string_lossy().as_bytes())
            );
            set_office_record_id(&mut record.config, &derived_record_id)?;
        }
        Err(message) => {
            return Err(internal_error(format!(
                "failed to resolve Office identity from invalid record {}: {message}",
                path.display()
            )));
        }
    }
    if office_record_revision(&record.config).is_none() {
        let derived_record_revision = format!("legacy-{}", sha256_hex(&bytes));
        set_office_record_revision(&mut record.config, &derived_record_revision)?;
    }
    Ok(Some(CrewonDomainConfigRecord {
        file_path: path.to_string_lossy().into_owned(),
        saved_at: record.saved_at.unwrap_or_default(),
        config: record.config,
    }))
}

pub(crate) async fn list_office_records_for_scheduler(
    cwd: &str,
    record_cursor: Option<&str>,
    limit: usize,
) -> Result<(Vec<CrewonDomainConfigRecord>, Option<String>), JSONRPCErrorError> {
    if limit == 0 || limit > MAX_OFFICE_SCHEDULER_RECORD_PAGE_LIMIT {
        return Err(invalid_params(
            "office scheduler record page limit must be between 1 and 100",
        ));
    }
    if let Some(record_cursor) = record_cursor {
        validate_office_scheduler_record_cursor(record_cursor).map_err(invalid_params)?;
    }
    let directory = domain_directory(cwd, DomainKind::Office)?;
    let mut entries = match fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok((Vec::new(), None)),
        Err(err) => {
            return Err(internal_error(format!(
                "failed to read {}: {err}",
                directory.display()
            )));
        }
    };

    let retained_limit = limit.saturating_add(1);
    let mut seen_record_ids = HashSet::new();
    let mut records_by_id = BTreeMap::new();
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let record = match read_office_record_strict(&path).await {
            Ok(Some(record)) => record,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(
                    file_path = %path.display(),
                    error = %error.message,
                    "skipping an unreadable Office record during scheduler listing"
                );
                continue;
            }
        };
        let record_id = office_record_id(&record.config)
            .ok_or_else(|| internal_error("strict Office read returned a record without recordId"))?
            .to_string();
        if !seen_record_ids.insert(record_id.clone()) {
            return Err(invalid_params(
                "multiple office configs match the same workspace.recordId",
            ));
        }
        if record_cursor.is_some_and(|cursor| record_id.as_str() <= cursor) {
            continue;
        }
        records_by_id.insert(record_id, record);
        if records_by_id.len() > retained_limit {
            records_by_id.pop_last();
        }
    }

    let has_more = records_by_id.len() > limit;
    if has_more {
        records_by_id.pop_last();
    }
    let next_cursor = if has_more {
        records_by_id
            .last_key_value()
            .map(|(record_id, _)| record_id.clone())
    } else {
        None
    };
    Ok((records_by_id.into_values().collect(), next_cursor))
}

fn validate_office_scheduler_record_cursor(record_cursor: &str) -> Result<(), String> {
    if record_cursor.is_empty()
        || record_cursor != record_cursor.trim()
        || record_cursor.chars().any(char::is_whitespace)
    {
        return Err(
            "office scheduler record cursor must be non-empty and contain no whitespace"
                .to_string(),
        );
    }
    if record_cursor.chars().count() > MAX_OFFICE_RECORD_ID_CHARS {
        return Err(format!(
            "office scheduler record cursor must not exceed {MAX_OFFICE_RECORD_ID_CHARS} characters"
        ));
    }
    Ok(())
}
