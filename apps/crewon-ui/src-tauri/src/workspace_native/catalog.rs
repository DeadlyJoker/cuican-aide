use std::path::PathBuf;

use serde::Deserialize;
use serde::Serialize;

use super::catalog_io::catalog_file_identity;
use super::catalog_io::catalog_mutation_replay_is_safe;
use super::catalog_io::prepare_authority_directory;
use super::catalog_io::read_catalog;
use super::catalog_io::sync_directory;
use super::catalog_io::write_catalog;
use super::catalog_io::CatalogWriteError;
use super::catalog_migration::decode_authority;
use super::catalog_validation::validate_authority;
use super::catalog_values::random_id;
use super::WorkspaceNativeError;

pub(super) const AUTHORITY_SCHEMA: &str = "crewon.desktop-workspace-authority.v1";
pub(crate) const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
const CATALOG_FILE_NAME: &str = "workspace-authority.json";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopWorkspaceAuthority {
    pub(super) schema_version: String,
    pub(super) device_id: String,
    pub(super) device_binding_id: String,
    pub(super) revision: u64,
    pub(super) current: Option<SelectedWorkspaceAuthority>,
    pub(super) pending: Option<PendingWorkspaceAuthority>,
    pub(super) last_operation: Option<WorkspaceAuthorityOperationReceipt>,
}

impl std::fmt::Debug for DesktopWorkspaceAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("DesktopWorkspaceAuthority([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectedWorkspaceAuthority {
    pub(super) trusted_path: String,
    pub(super) workspace_binding_id: String,
    pub(super) incarnation_id: String,
    pub(super) workspace_runtime_binding_id: String,
    pub(super) display_name: String,
    pub(super) revision: u64,
}

impl std::fmt::Debug for SelectedWorkspaceAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SelectedWorkspaceAuthority([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingWorkspaceAuthority {
    pub(super) operation_id: String,
    pub(super) expected_revision: u64,
    pub(super) result_revision: u64,
    pub(super) candidate: Option<SelectedWorkspaceAuthority>,
    pub(super) intent: WorkspaceAuthorityIntent,
    pub(super) phase: WorkspaceAuthorityPendingPhase,
}

impl std::fmt::Debug for PendingWorkspaceAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PendingWorkspaceAuthority([REDACTED])")
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum WorkspaceAuthorityOperationResolution {
    Committed,
    UserCanceled,
    Aborted,
    LegacyNoOp,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkspaceAuthorityOperationReceipt {
    pub(super) operation_id: String,
    pub(super) expected_revision: u64,
    pub(super) result_revision: u64,
    pub(super) candidate: Option<SelectedWorkspaceAuthority>,
    pub(super) resolution: WorkspaceAuthorityOperationResolution,
    pub(super) intent: WorkspaceAuthorityIntent,
}

// The native selector is strictly serial: one pending transition and only the
// latest settled operation are retained. Once a later operation is prepared,
// an older operation ID intentionally becomes a conflict rather than a replay.

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum WorkspaceAuthorityPrepareResult {
    Pending(PendingWorkspaceAuthority),
    Committed(Option<SelectedWorkspaceAuthority>),
    Aborted,
}

impl std::fmt::Debug for WorkspaceAuthorityPrepareResult {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WorkspaceAuthorityPrepareResult([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkspaceAuthorityIntent {
    Select,
    Clear,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkspaceAuthorityPendingPhase {
    SelectAwaitingDialog,
    Prepared,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum WorkspaceAuthorityIntentReplay {
    Pending,
    Committed(Option<SelectedWorkspaceAuthority>),
    UserCanceled,
    Aborted,
    LegacyNoOp,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum WorkspaceSelectionBeginResult {
    Fresh,
    Awaiting,
    Replayed(WorkspaceAuthorityIntentReplay),
}

impl std::fmt::Debug for WorkspaceSelectionBeginResult {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WorkspaceSelectionBeginResult([REDACTED])")
    }
}

impl std::fmt::Debug for WorkspaceAuthorityIntentReplay {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WorkspaceAuthorityIntentReplay([REDACTED])")
    }
}

impl DesktopWorkspaceAuthority {
    pub(crate) fn device_id(&self) -> &str {
        &self.device_id
    }

    pub(crate) fn device_binding_id(&self) -> &str {
        &self.device_binding_id
    }

    pub(crate) fn current_revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn current_workspace(
        &self,
    ) -> Result<&SelectedWorkspaceAuthority, WorkspaceNativeError> {
        if self.pending.is_some() {
            return Err(WorkspaceNativeError::AuthorityRecoveryRequired);
        }
        self.current
            .as_ref()
            .ok_or(WorkspaceNativeError::AuthorityUnavailable)
    }

    pub(crate) fn pending(&self) -> Option<&PendingWorkspaceAuthority> {
        self.pending.as_ref()
    }

    pub(crate) fn current_snapshot(&self) -> Option<&SelectedWorkspaceAuthority> {
        self.current.as_ref()
    }
}

impl SelectedWorkspaceAuthority {
    pub(crate) fn trusted_path(&self) -> &str {
        &self.trusted_path
    }

    pub(crate) fn workspace_binding_id(&self) -> &str {
        &self.workspace_binding_id
    }

    pub(crate) fn incarnation_id(&self) -> &str {
        &self.incarnation_id
    }

    pub(crate) fn workspace_runtime_binding_id(&self) -> &str {
        &self.workspace_runtime_binding_id
    }

    pub(crate) fn display_name(&self) -> &str {
        &self.display_name
    }

    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }
}

impl PendingWorkspaceAuthority {
    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub(crate) fn expected_revision(&self) -> u64 {
        self.expected_revision
    }

    pub(crate) fn result_revision(&self) -> u64 {
        self.result_revision
    }

    pub(crate) fn candidate(&self) -> Option<&SelectedWorkspaceAuthority> {
        self.candidate.as_ref()
    }

    pub(super) fn intent(&self) -> WorkspaceAuthorityIntent {
        self.intent
    }

    pub(crate) fn phase(&self) -> WorkspaceAuthorityPendingPhase {
        self.phase
    }
}

impl WorkspaceAuthorityOperationReceipt {
    pub(super) fn intent(&self) -> WorkspaceAuthorityIntent {
        self.intent
    }
}

pub(crate) struct DesktopWorkspaceAuthorityManager {
    pub(super) authority_directory: PathBuf,
    pub(super) catalog_path: PathBuf,
    pub(super) authority: DesktopWorkspaceAuthority,
    pub(super) writer: CatalogWriter,
    pub(super) syncer: CatalogSyncer,
}

pub(super) type CatalogWriter = fn(
    &std::path::Path,
    &std::path::Path,
    &DesktopWorkspaceAuthority,
) -> Result<(), CatalogWriteError>;
pub(super) type CatalogSyncer = fn(&std::path::Path) -> Result<(), WorkspaceNativeError>;

impl std::fmt::Debug for DesktopWorkspaceAuthorityManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("DesktopWorkspaceAuthorityManager([REDACTED])")
    }
}

impl DesktopWorkspaceAuthorityManager {
    pub(crate) fn open(authority_directory: PathBuf) -> Result<Self, WorkspaceNativeError> {
        prepare_authority_directory(&authority_directory)?;
        let catalog_path = authority_directory.join(CATALOG_FILE_NAME);
        let (authority, migrated) = match read_catalog::<serde_json::Value>(&catalog_path)? {
            Some(value) => decode_authority(value)?,
            None => {
                let authority = new_authority()?;
                write_or_confirm(
                    &authority_directory,
                    &catalog_path,
                    &authority,
                    write_catalog,
                    sync_directory,
                )?;
                (authority, false)
            }
        };
        validate_authority(&authority)?;
        if migrated {
            write_or_confirm(
                &authority_directory,
                &catalog_path,
                &authority,
                write_catalog,
                sync_directory,
            )?;
        }
        Ok(Self {
            authority_directory,
            catalog_path,
            authority,
            writer: write_catalog,
            syncer: sync_directory,
        })
    }

    pub(crate) fn open_durable(authority_directory: PathBuf) -> Result<Self, WorkspaceNativeError> {
        open_durable_with_sync(authority_directory, sync_directory)
    }

    pub(crate) fn authority(&self) -> &DesktopWorkspaceAuthority {
        &self.authority
    }

    pub(crate) fn reload_if_unchanged(&mut self) -> Result<bool, WorkspaceNativeError> {
        let mut reopened = open_durable_with_sync(self.authority_directory.clone(), self.syncer)?;
        if reopened.authority != self.authority {
            return Ok(false);
        }
        reopened.writer = self.writer;
        reopened.syncer = self.syncer;
        *self = reopened;
        Ok(true)
    }

    pub(crate) fn reload_durable(&mut self) -> Result<(), WorkspaceNativeError> {
        let mut reopened = open_durable_with_sync(self.authority_directory.clone(), self.syncer)?;
        reopened.writer = self.writer;
        reopened.syncer = self.syncer;
        *self = reopened;
        Ok(())
    }

    pub(super) fn persist(
        &mut self,
        next: DesktopWorkspaceAuthority,
    ) -> Result<(), WorkspaceNativeError> {
        write_or_confirm(
            &self.authority_directory,
            &self.catalog_path,
            &next,
            self.writer,
            self.syncer,
        )?;
        self.authority = next;
        Ok(())
    }
}

fn open_durable_with_sync(
    authority_directory: PathBuf,
    syncer: CatalogSyncer,
) -> Result<DesktopWorkspaceAuthorityManager, WorkspaceNativeError> {
    if !catalog_mutation_replay_is_safe() {
        return Err(WorkspaceNativeError::AuthorityMutationUnknown);
    }
    let first = DesktopWorkspaceAuthorityManager::open(authority_directory.clone())?;
    #[cfg(windows)]
    write_catalog(&authority_directory, &first.catalog_path, &first.authority)
        .map_err(WorkspaceNativeError::from)?;
    let first_identity = catalog_file_identity(&first.catalog_path)?;
    #[cfg(not(windows))]
    syncer(&authority_directory).map_err(|_| WorkspaceNativeError::AuthorityMutationUnknown)?;
    let mut second = DesktopWorkspaceAuthorityManager::open(authority_directory)?;
    let second_identity = catalog_file_identity(&second.catalog_path)?;
    if first_identity != second_identity || first.authority != second.authority {
        return Err(WorkspaceNativeError::AuthorityMutationUnknown);
    }
    if !catalog_mutation_replay_is_safe() {
        return Err(WorkspaceNativeError::AuthorityMutationUnknown);
    }
    second.syncer = syncer;
    Ok(second)
}

fn write_or_confirm(
    directory: &std::path::Path,
    path: &std::path::Path,
    intended: &DesktopWorkspaceAuthority,
    writer: CatalogWriter,
    syncer: CatalogSyncer,
) -> Result<(), WorkspaceNativeError> {
    match writer(directory, path, intended) {
        Ok(()) => Ok(()),
        Err(CatalogWriteError::BeforeReplace(error)) => Err(error),
        Err(CatalogWriteError::AfterReplaceUnknown) => {
            let value = read_catalog::<serde_json::Value>(path)
                .map_err(|_| WorkspaceNativeError::AuthorityMutationUnknown)?
                .ok_or(WorkspaceNativeError::AuthorityMutationUnknown)?;
            let (reloaded, migrated) = decode_authority(value)
                .map_err(|_| WorkspaceNativeError::AuthorityMutationUnknown)?;
            validate_authority(&reloaded)
                .map_err(|_| WorkspaceNativeError::AuthorityMutationUnknown)?;
            if migrated || reloaded != *intended {
                return Err(WorkspaceNativeError::AuthorityMutationUnknown);
            }
            syncer(directory).map_err(|_| WorkspaceNativeError::AuthorityMutationUnknown)
        }
    }
}

fn new_authority() -> Result<DesktopWorkspaceAuthority, WorkspaceNativeError> {
    Ok(DesktopWorkspaceAuthority {
        schema_version: AUTHORITY_SCHEMA.to_string(),
        device_id: random_id("desktop-device")?,
        device_binding_id: random_id("desktop-device-binding")?,
        revision: 0,
        current: None,
        pending: None,
        last_operation: None,
    })
}
