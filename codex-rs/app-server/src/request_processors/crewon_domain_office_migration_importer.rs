use std::fs;
use std::fs::File;
use std::io::Read;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use crewon_state::MAX_OFFICE_MIGRATION_SOURCE_BYTES;
use crewon_state::OfficeMigrationAdvanceSource;
use crewon_state::OfficeMigrationBeginImport;
use crewon_state::OfficeMigrationCommit;
use crewon_state::OfficeMigrationJournalRecord;
use crewon_state::OfficeMigrationMutationOutcome;
use crewon_state::OfficeMigrationPhase;
use crewon_state::OfficeMigrationStart;
use crewon_state::OfficeMigrationStartOutcome;
use crewon_state::StateRuntime;

use super::office_authority_lock;
use super::office_migration_snapshot::OfficeLegacyMigrationSnapshot;
use super::office_migration_snapshot::OfficeMigrationBlockingRun;
use super::office_migration_snapshot::OfficeMigrationQuiesceState;
use super::office_migration_snapshot::normalize_legacy_office_record;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum OfficeMigrationFailureInjection {
    Disabled,
    AfterJournal,
    AfterBeginImport,
}

pub(super) struct OfficeLegacyImportRequest<'a> {
    pub(super) cwd: &'a str,
    pub(super) file_path: &'a str,
    pub(super) workspace_key: &'a str,
    pub(super) now: i64,
    pub(super) failure_injection: OfficeMigrationFailureInjection,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum OfficeLegacyImportOutcome {
    Imported {
        journal_revision: u64,
    },
    Existing {
        phase: OfficeMigrationPhase,
        journal_revision: u64,
    },
    Quiescing(OfficeMigrationBlockingRun),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum OfficeQuiescedSourceOutcome {
    Advanced { journal_revision: u64 },
    Existing { journal_revision: u64 },
    Blocked(OfficeMigrationBlockingRun),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub(super) enum OfficeLegacyImportError {
    #[error("Office migration request is invalid")]
    InvalidRequest,
    #[error("Office migration source was not found")]
    SourceNotFound,
    #[error("Office migration source is invalid")]
    InvalidSource,
    #[error("Office migration source changed without a quiescing advance")]
    SourceDrift,
    #[error("Office migration conflicts with durable state")]
    Conflict,
    #[error("Office migration workspace does not exist")]
    WorkspaceNotFound,
    #[error("Office migration capacity was exceeded")]
    CapacityExceeded,
    #[error("Office migration state is unavailable")]
    StateUnavailable,
    #[error("Office migration simulated a process crash")]
    SimulatedCrash,
}

pub(super) struct OfficeLegacyImporter {
    state: Arc<StateRuntime>,
}

impl OfficeLegacyImporter {
    pub(super) fn new(state: Arc<StateRuntime>) -> Self {
        Self { state }
    }

    pub(super) async fn import(
        &self,
        request: OfficeLegacyImportRequest<'_>,
    ) -> Result<OfficeLegacyImportOutcome, OfficeLegacyImportError> {
        validate_request(&request)?;
        let _authority = office_authority_lock::lock(request.cwd)
            .await
            .map_err(|_| OfficeLegacyImportError::InvalidSource)?;
        let snapshot = read_snapshot(request.cwd, request.file_path).await?;
        let journal = self
            .resolve_journal(&snapshot, request.workspace_key, request.now)
            .await?;
        if matches!(
            journal.phase,
            OfficeMigrationPhase::Imported | OfficeMigrationPhase::Active
        ) {
            validate_imported_snapshot(&journal, &snapshot)?;
            return Ok(OfficeLegacyImportOutcome::Existing {
                phase: journal.phase,
                journal_revision: journal.journal_revision,
            });
        }
        if let OfficeMigrationQuiesceState::Blocked(blocking) = &snapshot.quiesce_state {
            return Ok(OfficeLegacyImportOutcome::Quiescing(blocking.clone()));
        }
        if request.failure_injection == OfficeMigrationFailureInjection::AfterJournal {
            return Err(OfficeLegacyImportError::SimulatedCrash);
        }

        let importing = match journal.phase {
            OfficeMigrationPhase::Quiescing => self.begin_import(&journal, request.now).await?,
            OfficeMigrationPhase::Importing => journal,
            OfficeMigrationPhase::Imported | OfficeMigrationPhase::Active => unreachable!(),
        };
        if request.failure_injection == OfficeMigrationFailureInjection::AfterBeginImport {
            return Err(OfficeLegacyImportError::SimulatedCrash);
        }
        let confirmed = read_snapshot(request.cwd, request.file_path).await?;
        if !same_source(&snapshot, &confirmed)
            || confirmed.quiesce_state != OfficeMigrationQuiesceState::Idle
        {
            return Err(OfficeLegacyImportError::SourceDrift);
        }
        let commit = OfficeMigrationCommit {
            record_id: confirmed.record_id,
            source_digest: confirmed.source_digest,
            expected_journal_revision: importing.journal_revision,
            snapshot_digest: confirmed.snapshot_digest,
            snapshot_json: confirmed.snapshot_json,
            imported_at: request.now.max(importing.updated_at),
        };
        match self
            .state
            .commit_office_migration(&commit)
            .await
            .map_err(|_| OfficeLegacyImportError::StateUnavailable)?
        {
            OfficeMigrationMutationOutcome::Updated(record) => {
                Ok(OfficeLegacyImportOutcome::Imported {
                    journal_revision: record.journal_revision,
                })
            }
            OfficeMigrationMutationOutcome::Existing(record) => {
                Ok(OfficeLegacyImportOutcome::Existing {
                    phase: record.phase,
                    journal_revision: record.journal_revision,
                })
            }
            OfficeMigrationMutationOutcome::NotFound | OfficeMigrationMutationOutcome::Conflict => {
                Err(OfficeLegacyImportError::Conflict)
            }
        }
    }

    pub(super) async fn advance_quiesced_source(
        &self,
        request: OfficeLegacyImportRequest<'_>,
    ) -> Result<OfficeQuiescedSourceOutcome, OfficeLegacyImportError> {
        validate_request(&request)?;
        let _authority = office_authority_lock::lock(request.cwd)
            .await
            .map_err(|_| OfficeLegacyImportError::InvalidSource)?;
        let snapshot = read_snapshot(request.cwd, request.file_path).await?;
        if let OfficeMigrationQuiesceState::Blocked(blocking) = snapshot.quiesce_state {
            return Ok(OfficeQuiescedSourceOutcome::Blocked(blocking));
        }
        let journal = self
            .state
            .get_office_migration_journal(&snapshot.record_id)
            .await
            .map_err(|_| OfficeLegacyImportError::StateUnavailable)?
            .ok_or(OfficeLegacyImportError::Conflict)?;
        if journal.workspace_key != request.workspace_key
            || journal.phase != OfficeMigrationPhase::Quiescing
        {
            return Err(OfficeLegacyImportError::Conflict);
        }
        if same_journal_source(&journal, &snapshot) {
            return Ok(OfficeQuiescedSourceOutcome::Existing {
                journal_revision: journal.journal_revision,
            });
        }
        let advance = OfficeMigrationAdvanceSource {
            record_id: snapshot.record_id,
            expected_source_digest: journal.source_digest,
            expected_journal_revision: journal.journal_revision,
            source_revision: snapshot.source_revision,
            source_digest: snapshot.source_digest,
            source_bytes: snapshot.source_bytes,
            updated_at: request.now.max(journal.updated_at),
        };
        match self
            .state
            .advance_office_migration_source(&advance)
            .await
            .map_err(|_| OfficeLegacyImportError::StateUnavailable)?
        {
            OfficeMigrationMutationOutcome::Updated(record) => {
                Ok(OfficeQuiescedSourceOutcome::Advanced {
                    journal_revision: record.journal_revision,
                })
            }
            OfficeMigrationMutationOutcome::Existing(record) => {
                Ok(OfficeQuiescedSourceOutcome::Existing {
                    journal_revision: record.journal_revision,
                })
            }
            OfficeMigrationMutationOutcome::NotFound | OfficeMigrationMutationOutcome::Conflict => {
                Err(OfficeLegacyImportError::Conflict)
            }
        }
    }

    async fn resolve_journal(
        &self,
        snapshot: &OfficeLegacyMigrationSnapshot,
        workspace_key: &str,
        now: i64,
    ) -> Result<OfficeMigrationJournalRecord, OfficeLegacyImportError> {
        if let Some(journal) = self
            .state
            .get_office_migration_journal(&snapshot.record_id)
            .await
            .map_err(|_| OfficeLegacyImportError::StateUnavailable)?
        {
            if journal.workspace_key != workspace_key || !same_journal_source(&journal, snapshot) {
                return Err(OfficeLegacyImportError::Conflict);
            }
            return Ok(journal);
        }
        let start = OfficeMigrationStart {
            record_id: snapshot.record_id.clone(),
            workspace_key: workspace_key.to_string(),
            source_revision: snapshot.source_revision.clone(),
            source_digest: snapshot.source_digest.clone(),
            source_bytes: snapshot.source_bytes,
            started_at: now,
        };
        match self
            .state
            .start_office_migration(&start)
            .await
            .map_err(|_| OfficeLegacyImportError::StateUnavailable)?
        {
            OfficeMigrationStartOutcome::Started(record)
            | OfficeMigrationStartOutcome::Existing(record) => Ok(record),
            OfficeMigrationStartOutcome::Conflict => Err(OfficeLegacyImportError::Conflict),
            OfficeMigrationStartOutcome::WorkspaceNotFound => {
                Err(OfficeLegacyImportError::WorkspaceNotFound)
            }
            OfficeMigrationStartOutcome::CapacityExceeded => {
                Err(OfficeLegacyImportError::CapacityExceeded)
            }
        }
    }

    async fn begin_import(
        &self,
        journal: &OfficeMigrationJournalRecord,
        now: i64,
    ) -> Result<OfficeMigrationJournalRecord, OfficeLegacyImportError> {
        match self
            .state
            .begin_office_migration_import(&OfficeMigrationBeginImport {
                record_id: journal.record_id.clone(),
                source_digest: journal.source_digest.clone(),
                expected_journal_revision: journal.journal_revision,
                updated_at: now.max(journal.updated_at),
            })
            .await
            .map_err(|_| OfficeLegacyImportError::StateUnavailable)?
        {
            OfficeMigrationMutationOutcome::Updated(record)
            | OfficeMigrationMutationOutcome::Existing(record) => Ok(record),
            OfficeMigrationMutationOutcome::NotFound | OfficeMigrationMutationOutcome::Conflict => {
                Err(OfficeLegacyImportError::Conflict)
            }
        }
    }
}

fn validate_request(
    request: &OfficeLegacyImportRequest<'_>,
) -> Result<(), OfficeLegacyImportError> {
    if request.cwd.is_empty()
        || request.file_path.is_empty()
        || request.workspace_key.is_empty()
        || request.now < 0
    {
        return Err(OfficeLegacyImportError::InvalidRequest);
    }
    Ok(())
}

async fn read_snapshot(
    cwd: &str,
    file_path: &str,
) -> Result<OfficeLegacyMigrationSnapshot, OfficeLegacyImportError> {
    let cwd = PathBuf::from(cwd);
    let file_path = PathBuf::from(file_path);
    let source = tokio::task::spawn_blocking(move || read_source(&cwd, &file_path))
        .await
        .map_err(|_| OfficeLegacyImportError::InvalidSource)??;
    normalize_legacy_office_record(&source.file_name, &source.bytes)
        .map_err(|_| OfficeLegacyImportError::InvalidSource)
}

struct StrictOfficeSource {
    file_name: String,
    bytes: Vec<u8>,
}

fn read_source(
    cwd: &Path,
    file_path: &Path,
) -> Result<StrictOfficeSource, OfficeLegacyImportError> {
    if !cwd.is_absolute()
        || !file_path.is_absolute()
        || file_path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        || file_path.extension().and_then(|value| value.to_str()) != Some("json")
    {
        return Err(OfficeLegacyImportError::InvalidRequest);
    }
    let office_directory = cwd.join(".crewon").join("offices");
    if file_path.parent() != Some(office_directory.as_path()) {
        return Err(OfficeLegacyImportError::InvalidRequest);
    }
    let cwd_metadata = fs::symlink_metadata(cwd).map_err(map_source_io)?;
    if cwd_metadata.file_type().is_symlink() || !cwd_metadata.is_dir() {
        return Err(OfficeLegacyImportError::InvalidSource);
    }
    let crewon_directory = cwd.join(".crewon");
    let crewon_metadata = fs::symlink_metadata(&crewon_directory).map_err(map_source_io)?;
    let office_metadata = fs::symlink_metadata(&office_directory).map_err(map_source_io)?;
    if crewon_metadata.file_type().is_symlink()
        || !crewon_metadata.is_dir()
        || office_metadata.file_type().is_symlink()
        || !office_metadata.is_dir()
    {
        return Err(OfficeLegacyImportError::InvalidSource);
    }
    let canonical_cwd = fs::canonicalize(cwd).map_err(map_source_io)?;
    let canonical_office_directory = fs::canonicalize(&office_directory).map_err(map_source_io)?;
    if canonical_office_directory != canonical_cwd.join(".crewon").join("offices") {
        return Err(OfficeLegacyImportError::InvalidSource);
    }
    let file_metadata = fs::symlink_metadata(file_path).map_err(map_source_io)?;
    if file_metadata.file_type().is_symlink()
        || !file_metadata.is_file()
        || file_metadata.len() == 0
        || file_metadata.len() > MAX_OFFICE_MIGRATION_SOURCE_BYTES
    {
        return Err(OfficeLegacyImportError::InvalidSource);
    }
    let canonical_file = fs::canonicalize(file_path).map_err(map_source_io)?;
    if canonical_file.parent() != Some(canonical_office_directory.as_path()) {
        return Err(OfficeLegacyImportError::InvalidSource);
    }
    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or(OfficeLegacyImportError::InvalidSource)?
        .to_string();
    let file = File::open(file_path).map_err(map_source_io)?;
    let opened_metadata = file.metadata().map_err(map_source_io)?;
    let current_metadata = fs::symlink_metadata(file_path).map_err(map_source_io)?;
    if current_metadata.file_type().is_symlink()
        || !current_metadata.is_file()
        || !opened_metadata.is_file()
        || opened_metadata.len() == 0
        || opened_metadata.len() > MAX_OFFICE_MIGRATION_SOURCE_BYTES
    {
        return Err(OfficeLegacyImportError::InvalidSource);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened_metadata.dev() != current_metadata.dev()
            || opened_metadata.ino() != current_metadata.ino()
        {
            return Err(OfficeLegacyImportError::InvalidSource);
        }
    }
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.take(MAX_OFFICE_MIGRATION_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(map_source_io)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_OFFICE_MIGRATION_SOURCE_BYTES {
        return Err(OfficeLegacyImportError::InvalidSource);
    }
    Ok(StrictOfficeSource { file_name, bytes })
}

fn map_source_io(error: std::io::Error) -> OfficeLegacyImportError {
    if error.kind() == std::io::ErrorKind::NotFound {
        OfficeLegacyImportError::SourceNotFound
    } else {
        OfficeLegacyImportError::InvalidSource
    }
}

fn same_source(
    left: &OfficeLegacyMigrationSnapshot,
    right: &OfficeLegacyMigrationSnapshot,
) -> bool {
    left.record_id == right.record_id
        && left.source_revision == right.source_revision
        && left.source_digest == right.source_digest
        && left.source_bytes == right.source_bytes
        && left.snapshot_digest == right.snapshot_digest
        && left.snapshot_json == right.snapshot_json
}

fn same_journal_source(
    journal: &OfficeMigrationJournalRecord,
    snapshot: &OfficeLegacyMigrationSnapshot,
) -> bool {
    journal.record_id == snapshot.record_id
        && journal.source_revision == snapshot.source_revision
        && journal.source_digest == snapshot.source_digest
        && journal.source_bytes == snapshot.source_bytes
}

fn validate_imported_snapshot(
    journal: &OfficeMigrationJournalRecord,
    snapshot: &OfficeLegacyMigrationSnapshot,
) -> Result<(), OfficeLegacyImportError> {
    if journal.snapshot_digest.as_deref() != Some(snapshot.snapshot_digest.as_str())
        || journal.snapshot_json.as_deref() != Some(snapshot.snapshot_json.as_str())
    {
        return Err(OfficeLegacyImportError::Conflict);
    }
    Ok(())
}

#[cfg(test)]
#[path = "crewon_domain_office_migration_importer_tests.rs"]
mod tests;
