use std::io;
use std::path::Path;
use std::path::PathBuf;

use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_core::path_utils::write_atomically;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::task;

use super::map_io_error;
use super::office_authority_lock;
use super::office_record_lock;
use super::office_storage;
use super::office_thread_id;
use super::sha256_hex;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;

const SIDECAR_VERSION: u32 = 1;
const SIDECAR_DIRECTORY_NAME: &str = ".workspace-identities";
const MAX_SIDECAR_BYTES: u64 = 4 * 1024;
const MAX_RECORD_ID_CHARS: usize = 128;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct OfficeWorkspaceIdentity {
    version: u32,
    thread_id_hash: String,
    record_id: String,
    generation: u64,
    state: OfficeWorkspaceIdentityState,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum OfficeWorkspaceIdentityState {
    Active,
    Deleting,
    Deleted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum OfficeWriteIntent {
    Create,
    Update,
    LegacyMigration,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OfficeWorkspaceThreadState {
    Unbound,
    ActiveIdle,
    ActiveRun,
    Retired,
}

pub(super) struct LockedOfficeWorkspaceIdentity {
    _guard: office_record_lock::OfficeRecordMutationGuard,
    sidecar_path: PathBuf,
    thread_id_hash: String,
}

pub(super) struct OfficeWorkspaceIdentityWrite {
    locked: Vec<(String, LockedOfficeWorkspaceIdentity)>,
    writes: Vec<(usize, OfficeWorkspaceIdentity)>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OfficeWorkspaceTargetRole {
    ExistingSource,
    NewBinding,
}

impl OfficeWriteIntent {
    pub(super) fn update_or_legacy_migration(config: &JsonValue) -> Self {
        if config
            .get("workspace")
            .and_then(|workspace| workspace.get("recordId"))
            .is_some()
        {
            Self::Update
        } else {
            Self::LegacyMigration
        }
    }
}

impl OfficeWorkspaceIdentity {
    pub(super) fn active(
        thread_id_hash: String,
        record_id: String,
        generation: u64,
    ) -> Result<Self, JSONRPCErrorError> {
        let identity = Self {
            version: SIDECAR_VERSION,
            thread_id_hash,
            record_id,
            generation,
            state: OfficeWorkspaceIdentityState::Active,
        };
        identity.validate().map_err(invalid_params)?;
        Ok(identity)
    }

    pub(super) fn record_id(&self) -> &str {
        &self.record_id
    }

    #[cfg(test)]
    pub(super) fn generation(&self) -> u64 {
        self.generation
    }

    pub(super) fn state(&self) -> OfficeWorkspaceIdentityState {
        self.state
    }

    pub(super) fn with_state(&self, state: OfficeWorkspaceIdentityState) -> Self {
        Self {
            state,
            ..self.clone()
        }
    }

    pub(super) fn next_generation(&self) -> Result<u64, JSONRPCErrorError> {
        self.generation.checked_add(1).ok_or_else(|| {
            internal_error("Office workspace identity generation exhausted its supported range")
        })
    }

    fn validate(&self) -> Result<(), String> {
        if self.version != SIDECAR_VERSION {
            return Err(format!(
                "unsupported Office workspace identity version {}",
                self.version
            ));
        }
        if self.thread_id_hash.len() != 64
            || !self
                .thread_id_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("Office workspace identity has an invalid threadId hash".to_string());
        }
        if self.record_id.is_empty()
            || self.record_id != self.record_id.trim()
            || self.record_id.chars().any(char::is_whitespace)
            || self.record_id.chars().count() > MAX_RECORD_ID_CHARS
        {
            return Err("Office workspace identity has an invalid recordId".to_string());
        }
        if self.generation == 0 {
            return Err("Office workspace identity generation must be positive".to_string());
        }
        Ok(())
    }
}

impl LockedOfficeWorkspaceIdentity {
    pub(super) fn thread_id_hash(&self) -> &str {
        &self.thread_id_hash
    }

    pub(super) async fn read(&self) -> Result<Option<OfficeWorkspaceIdentity>, JSONRPCErrorError> {
        read_sidecar(&self.sidecar_path, &self.thread_id_hash).await
    }

    pub(super) async fn write(
        &self,
        identity: &OfficeWorkspaceIdentity,
    ) -> Result<(), JSONRPCErrorError> {
        identity.validate().map_err(|message| {
            internal_error(format!(
                "refusing to persist an invalid Office workspace identity: {message}"
            ))
        })?;
        if identity.thread_id_hash != self.thread_id_hash {
            return Err(internal_error(
                "refusing to persist an Office workspace identity under a different threadId hash",
            ));
        }
        let contents = serde_json::to_string(identity).map_err(|err| {
            internal_error(format!(
                "failed to serialize Office workspace identity sidecar: {err}"
            ))
        })?;
        if u64::try_from(contents.len()).unwrap_or(u64::MAX) > MAX_SIDECAR_BYTES {
            return Err(internal_error(
                "Office workspace identity sidecar exceeds its persistence limit",
            ));
        }
        let parent = self.sidecar_path.parent().ok_or_else(|| {
            internal_error("Office workspace identity sidecar has no parent directory")
        })?;
        fs::create_dir_all(parent)
            .await
            .map_err(|err| map_sidecar_io_error(&self.sidecar_path, err))?;
        let sidecar_path = self.sidecar_path.clone();
        task::spawn_blocking(move || write_atomically(&sidecar_path, &contents))
            .await
            .map_err(|err| {
                internal_error(format!(
                    "Office workspace identity persistence task failed: {err}"
                ))
            })?
            .map_err(|err| map_sidecar_io_error(&self.sidecar_path, err))
    }
}

impl OfficeWorkspaceIdentityWrite {
    pub(super) async fn prepare(
        office_directory: &Path,
        source_thread_id: Option<&str>,
        target_thread_id: Option<&str>,
        record_id: &str,
        intent: OfficeWriteIntent,
    ) -> Result<Self, JSONRPCErrorError> {
        let mut thread_ids = source_thread_id
            .into_iter()
            .chain(target_thread_id)
            .map(str::to_string)
            .collect::<Vec<_>>();
        thread_ids.sort();
        thread_ids.dedup();
        let mut locked = Vec::with_capacity(thread_ids.len());
        for thread_id in thread_ids {
            let identity = lock(office_directory, &thread_id).await?;
            locked.push((thread_id, identity));
        }

        if let Some(source_thread_id) = source_thread_id {
            let source = read_locked_identity(&locked, source_thread_id).await?;
            validate_source_identity(source.as_ref(), source_thread_id, record_id)?;
        }

        let mut writes = Vec::with_capacity(/*capacity*/ 2);
        if let Some(target_thread_id) = target_thread_id {
            let target_index = locked_identity_index(&locked, target_thread_id)?;
            let target = locked[target_index].1.read().await?;
            let target_role = if source_thread_id == Some(target_thread_id) {
                OfficeWorkspaceTargetRole::ExistingSource
            } else {
                OfficeWorkspaceTargetRole::NewBinding
            };
            let active = active_target_identity(
                &locked[target_index].1,
                target.as_ref(),
                target_thread_id,
                record_id,
                intent,
                target_role,
            )?;
            if target.as_ref() != Some(&active) {
                writes.push((target_index, active));
            }
        }

        if let Some(source_thread_id) = source_thread_id
            && Some(source_thread_id) != target_thread_id
        {
            let source_index = locked_identity_index(&locked, source_thread_id)?;
            let source = locked[source_index].1.read().await?;
            let deleted = match source {
                Some(identity) => {
                    validate_source_identity(Some(&identity), source_thread_id, record_id)?;
                    identity.with_state(OfficeWorkspaceIdentityState::Deleted)
                }
                None => OfficeWorkspaceIdentity::active(
                    locked[source_index].1.thread_id_hash().to_string(),
                    record_id.to_string(),
                    /*generation*/ 1,
                )?
                .with_state(OfficeWorkspaceIdentityState::Deleted),
            };
            writes.push((source_index, deleted));
        }

        Ok(Self { locked, writes })
    }

    pub(super) async fn commit(self) -> Result<(), JSONRPCErrorError> {
        for (index, identity) in &self.writes {
            self.locked[*index].1.write(identity).await?;
        }
        Ok(())
    }
}

pub(super) async fn reconcile_under_authority(
    authority_guard: &office_authority_lock::OfficeAuthorityGuard,
    office_directory: &Path,
    thread_id: &str,
) -> Result<Option<OfficeWorkspaceIdentity>, JSONRPCErrorError> {
    let Some(peeked) = read_under_authority(authority_guard, office_directory, thread_id).await?
    else {
        return Ok(None);
    };
    let record_id = peeked.record_id().to_string();
    let _record_identity_guard = office_record_lock::lock(&office_storage::record_identity_path(
        office_directory,
        &record_id,
    ))
    .await
    .map_err(map_io_error)?;
    let record = office_storage::find_office_record(
        office_directory,
        office_storage::OfficeIdentityLookup::RecordId(&record_id),
    )
    .await?;
    let record_path = record
        .as_ref()
        .map(|record| PathBuf::from(&record.file_path));
    let _record_guard = match record_path.as_ref() {
        Some(record_path) => Some(
            office_record_lock::lock(record_path)
                .await
                .map_err(map_io_error)?,
        ),
        None => None,
    };
    let locked = lock(office_directory, thread_id).await?;
    let Some(current) = locked.read().await? else {
        return Ok(None);
    };
    if current.record_id() != record_id {
        return Err(internal_error(
            "Office workspace identity changed while acquiring its reconciliation lock",
        ));
    }
    let latest = match record_path.as_ref() {
        Some(record_path) => office_storage::read_office_record_strict(record_path).await?,
        None => None,
    };
    let latest_matches_identity = latest.as_ref().is_some_and(|record| {
        office_storage::office_record_id(&record.config) == Some(record_id.as_str())
            && office_thread_id(&record.config) == Some(thread_id)
    });
    match current.state() {
        OfficeWorkspaceIdentityState::Active if latest_matches_identity => Ok(Some(current)),
        OfficeWorkspaceIdentityState::Active => {
            let deleted = current.with_state(OfficeWorkspaceIdentityState::Deleted);
            locked.write(&deleted).await?;
            Ok(Some(deleted))
        }
        OfficeWorkspaceIdentityState::Deleting => {
            if latest.is_some() && !latest_matches_identity {
                return Err(internal_error(
                    "Office workspace identity deletion target no longer matches its record",
                ));
            }
            if let Some(record_path) = record_path {
                match fs::remove_file(&record_path).await {
                    Ok(()) => {}
                    Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                    Err(err) => return Err(map_sidecar_io_error(&record_path, err)),
                }
            }
            let deleted = current.with_state(OfficeWorkspaceIdentityState::Deleted);
            locked.write(&deleted).await?;
            Ok(Some(deleted))
        }
        OfficeWorkspaceIdentityState::Deleted => {
            if latest_matches_identity && let Some(record_path) = record_path {
                match fs::remove_file(&record_path).await {
                    Ok(()) => {}
                    Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                    Err(err) => return Err(map_sidecar_io_error(&record_path, err)),
                }
            }
            Ok(Some(current))
        }
    }
}

pub(super) async fn read_under_authority(
    _authority_guard: &office_authority_lock::OfficeAuthorityGuard,
    office_directory: &Path,
    thread_id: &str,
) -> Result<Option<OfficeWorkspaceIdentity>, JSONRPCErrorError> {
    validate_thread_id(thread_id)?;
    let thread_id_hash = sha256_hex(thread_id.as_bytes());
    let sidecar_path = sidecar_path(office_directory, &thread_id_hash);
    read_sidecar(&sidecar_path, &thread_id_hash).await
}

pub(crate) async fn workspace_thread_state(
    cwd: &str,
    thread_id: &str,
) -> Result<OfficeWorkspaceThreadState, JSONRPCErrorError> {
    let office_directory = super::domain_directory(cwd, super::DomainKind::Office)?;
    if !fs::try_exists(&office_directory)
        .await
        .map_err(map_io_error)?
    {
        return Ok(OfficeWorkspaceThreadState::Unbound);
    }
    let authority_guard = office_authority_lock::lock(cwd).await?;
    let identity = match reconcile_under_authority(&authority_guard, &office_directory, thread_id)
        .await?
    {
        Some(identity) => identity,
        None => {
            let Some(record) = office_storage::find_office_record_ignoring_unreadable(
                &office_directory,
                office_storage::OfficeIdentityLookup::LegacyThreadId(thread_id),
            )
            .await?
            else {
                return Ok(OfficeWorkspaceThreadState::Unbound);
            };
            let record_id = office_storage::office_record_id(&record.config).ok_or_else(|| {
                internal_error("legacy Office manager record has no canonical recordId")
            })?;
            OfficeWorkspaceIdentityWrite::prepare(
                &office_directory,
                Some(thread_id),
                Some(thread_id),
                record_id,
                OfficeWriteIntent::LegacyMigration,
            )
            .await?
            .commit()
            .await?;
            read_under_authority(&authority_guard, &office_directory, thread_id)
                .await?
                .ok_or_else(|| {
                    internal_error("legacy Office workspace identity backfill was not persisted")
                })?
        }
    };
    if identity.state() != OfficeWorkspaceIdentityState::Active {
        return Ok(OfficeWorkspaceThreadState::Retired);
    }
    let record = office_storage::find_office_record(
        &office_directory,
        office_storage::OfficeIdentityLookup::RecordId(identity.record_id()),
    )
    .await?
    .ok_or_else(|| {
        internal_error("active Office workspace identity has no canonical Office record")
    })?;
    if office_storage::office_record_id(&record.config) != Some(identity.record_id())
        || super::office_thread_id(&record.config) != Some(thread_id)
    {
        return Err(internal_error(
            "active Office workspace identity does not match its canonical Office record",
        ));
    }
    let has_nonterminal_run = record
        .config
        .get("workspace")
        .and_then(|workspace| workspace.get("activity"))
        .and_then(|activity| activity.get("runs"))
        .and_then(JsonValue::as_array)
        .is_some_and(|runs| {
            runs.iter().any(|run| {
                !matches!(
                    run.get("status").and_then(JsonValue::as_str),
                    Some("completed" | "failed" | "interrupted")
                )
            })
        });
    Ok(if has_nonterminal_run {
        OfficeWorkspaceThreadState::ActiveRun
    } else {
        OfficeWorkspaceThreadState::ActiveIdle
    })
}

pub(super) async fn lock(
    office_directory: &Path,
    thread_id: &str,
) -> Result<LockedOfficeWorkspaceIdentity, JSONRPCErrorError> {
    validate_thread_id(thread_id)?;
    fs::create_dir_all(office_directory)
        .await
        .map_err(map_io_error)?;
    let thread_id_hash = sha256_hex(thread_id.as_bytes());
    let lock_path = office_directory.join(format!(".workspace-{thread_id_hash}.identity"));
    let guard = office_record_lock::lock(&lock_path)
        .await
        .map_err(map_io_error)?;
    Ok(LockedOfficeWorkspaceIdentity {
        _guard: guard,
        sidecar_path: sidecar_path(office_directory, &thread_id_hash),
        thread_id_hash,
    })
}

async fn read_sidecar(
    sidecar_path: &Path,
    expected_thread_id_hash: &str,
) -> Result<Option<OfficeWorkspaceIdentity>, JSONRPCErrorError> {
    let file = match fs::File::open(sidecar_path).await {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(map_sidecar_io_error(sidecar_path, err)),
    };
    let metadata = file
        .metadata()
        .await
        .map_err(|err| map_sidecar_io_error(sidecar_path, err))?;
    if !metadata.is_file() || metadata.len() > MAX_SIDECAR_BYTES {
        return Err(internal_error(format!(
            "Office workspace identity sidecar is invalid or oversized: {}",
            sidecar_path.display()
        )));
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or_default()
            .min(usize::try_from(MAX_SIDECAR_BYTES).unwrap_or(usize::MAX)),
    );
    file.take(MAX_SIDECAR_BYTES.saturating_add(/*rhs*/ 1))
        .read_to_end(&mut bytes)
        .await
        .map_err(|err| map_sidecar_io_error(sidecar_path, err))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_SIDECAR_BYTES {
        return Err(internal_error(format!(
            "Office workspace identity sidecar exceeded its read limit: {}",
            sidecar_path.display()
        )));
    }
    let identity = serde_json::from_slice::<OfficeWorkspaceIdentity>(&bytes).map_err(|err| {
        internal_error(format!(
            "failed to parse Office workspace identity sidecar {}: {err}",
            sidecar_path.display()
        ))
    })?;
    identity.validate().map_err(|message| {
        internal_error(format!(
            "invalid Office workspace identity sidecar {}: {message}",
            sidecar_path.display()
        ))
    })?;
    if identity.thread_id_hash != expected_thread_id_hash {
        return Err(internal_error(format!(
            "Office workspace identity sidecar key mismatch: {}",
            sidecar_path.display()
        )));
    }
    Ok(Some(identity))
}

fn validate_thread_id(thread_id: &str) -> Result<(), JSONRPCErrorError> {
    if thread_id.trim().is_empty() || thread_id != thread_id.trim() {
        return Err(invalid_params(
            "workspace.threadId must be non-empty and must not contain surrounding whitespace",
        ));
    }
    Ok(())
}

fn sidecar_path(office_directory: &Path, thread_id_hash: &str) -> PathBuf {
    office_directory
        .join(SIDECAR_DIRECTORY_NAME)
        .join(format!("{thread_id_hash}.json"))
}

async fn read_locked_identity(
    locked: &[(String, LockedOfficeWorkspaceIdentity)],
    thread_id: &str,
) -> Result<Option<OfficeWorkspaceIdentity>, JSONRPCErrorError> {
    let index = locked_identity_index(locked, thread_id)?;
    locked[index].1.read().await
}

fn locked_identity_index(
    locked: &[(String, LockedOfficeWorkspaceIdentity)],
    thread_id: &str,
) -> Result<usize, JSONRPCErrorError> {
    locked
        .iter()
        .position(|(locked_thread_id, _)| locked_thread_id == thread_id)
        .ok_or_else(|| internal_error("Office workspace identity lock set is incomplete"))
}

fn validate_source_identity(
    identity: Option<&OfficeWorkspaceIdentity>,
    thread_id: &str,
    record_id: &str,
) -> Result<(), JSONRPCErrorError> {
    match identity {
        None => Ok(()),
        Some(identity)
            if identity.record_id() == record_id
                && identity.state() == OfficeWorkspaceIdentityState::Active =>
        {
            Ok(())
        }
        Some(identity) if identity.record_id() != record_id => Err(invalid_params(format!(
            "workspace.threadId {thread_id} is already bound to another Office record"
        ))),
        Some(_) => Err(invalid_params(
            "office record identity no longer exists; reload the Office list before retrying",
        )),
    }
}

fn active_target_identity(
    locked: &LockedOfficeWorkspaceIdentity,
    current: Option<&OfficeWorkspaceIdentity>,
    thread_id: &str,
    record_id: &str,
    intent: OfficeWriteIntent,
    target_role: OfficeWorkspaceTargetRole,
) -> Result<OfficeWorkspaceIdentity, JSONRPCErrorError> {
    match current {
        None => OfficeWorkspaceIdentity::active(
            locked.thread_id_hash().to_string(),
            record_id.to_string(),
            /*generation*/ 1,
        ),
        Some(identity)
            if identity.state() == OfficeWorkspaceIdentityState::Active
                && identity.record_id() == record_id =>
        {
            Ok(identity.clone())
        }
        Some(identity) if identity.state() == OfficeWorkspaceIdentityState::Active => {
            Err(invalid_params(format!(
                "workspace.threadId {thread_id} is already bound to another Office record"
            )))
        }
        Some(identity) if identity.state() == OfficeWorkspaceIdentityState::Deleting => {
            Err(invalid_params(format!(
                "workspace.threadId {thread_id} is being deleted; reload the Office list before retrying"
            )))
        }
        Some(identity)
            if target_role == OfficeWorkspaceTargetRole::ExistingSource
                && identity.record_id() == record_id =>
        {
            Err(invalid_params(
                "office record identity no longer exists; reload the Office list before retrying",
            ))
        }
        Some(_) if intent == OfficeWriteIntent::LegacyMigration => Err(invalid_params(format!(
            "workspace.threadId {thread_id} belongs to a deleted Office generation; use office/create to create a new Office"
        ))),
        Some(identity) => OfficeWorkspaceIdentity::active(
            locked.thread_id_hash().to_string(),
            record_id.to_string(),
            identity.next_generation()?,
        ),
    }
}

fn map_sidecar_io_error(path: &Path, err: io::Error) -> JSONRPCErrorError {
    internal_error(format!(
        "Office workspace identity sidecar operation failed for {}: {err}",
        path.display()
    ))
}

#[cfg(test)]
#[path = "crewon_domain_office_workspace_identity_tests.rs"]
mod tests;
