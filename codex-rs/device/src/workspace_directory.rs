use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use serde::Deserialize;
use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;

#[cfg(unix)]
#[path = "workspace_directory_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "workspace_directory_windows.rs"]
mod platform;
#[path = "workspace_directory_validation.rs"]
mod validation;

use validation::entry_from_utf8_bytes;
use validation::require_output_bound;
use validation::validate_binding;

const OUTPUT_SCHEMA_VERSION: &str = "crewon.workspace-list-native-result.v0";
const CURSOR_PREFIX: &str = "workspace-page-";

pub const MAX_WORKSPACE_LIST_ENTRIES: usize = 200;
pub const MAX_WORKSPACE_NAME_BYTES: usize = 255;
pub const MAX_WORKSPACE_OUTPUT_BYTES: usize = 64 * 1024;
pub const MAX_WORKSPACE_SCANNED_ENTRIES: usize = 10_000;
pub const MAX_WORKSPACE_SCANNED_NAME_BYTES: usize = 1024 * 1024;
pub const MAX_WORKSPACE_LIST_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_WORKSPACE_FILE_READ_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDirectoryBinding {
    pub workspace_binding_id: String,
    pub incarnation_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceDirectoryEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDirectoryEntry {
    pub name: String,
    pub kind: WorkspaceDirectoryEntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceListLimits {
    pub max_entries: usize,
    pub max_name_bytes: usize,
    pub max_output_bytes: usize,
    pub max_scanned_entries: usize,
    pub max_scanned_name_bytes: usize,
    pub timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileReadResult {
    pub schema_version: String,
    pub encoding: String,
    pub content: String,
    pub byte_length: usize,
}

impl WorkspaceListLimits {
    pub fn hard_maximums() -> Self {
        Self {
            max_entries: MAX_WORKSPACE_LIST_ENTRIES,
            max_name_bytes: MAX_WORKSPACE_NAME_BYTES,
            max_output_bytes: MAX_WORKSPACE_OUTPUT_BYTES,
            max_scanned_entries: MAX_WORKSPACE_SCANNED_ENTRIES,
            max_scanned_name_bytes: MAX_WORKSPACE_SCANNED_NAME_BYTES,
            timeout: MAX_WORKSPACE_LIST_TIMEOUT,
        }
    }

    fn validate(&self) -> Result<(), WorkspaceDirectoryError> {
        if self.max_entries == 0
            || self.max_entries > MAX_WORKSPACE_LIST_ENTRIES
            || self.max_name_bytes == 0
            || self.max_name_bytes > MAX_WORKSPACE_NAME_BYTES
            || self.max_output_bytes == 0
            || self.max_output_bytes > MAX_WORKSPACE_OUTPUT_BYTES
            || self.max_scanned_entries < self.max_entries
            || self.max_scanned_entries > MAX_WORKSPACE_SCANNED_ENTRIES
            || self.max_scanned_name_bytes == 0
            || self.max_scanned_name_bytes > MAX_WORKSPACE_SCANNED_NAME_BYTES
            || self.max_scanned_name_bytes < self.max_name_bytes
            || self.timeout.is_zero()
            || self.timeout > MAX_WORKSPACE_LIST_TIMEOUT
        {
            return Err(WorkspaceDirectoryError::new(
                "workspace_list_limits_invalid",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceListPageRequest {
    pub cursor: Option<String>,
    pub max_entries: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListPage {
    pub entries: Vec<WorkspaceDirectoryEntry>,
    pub next_cursor: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default)]
pub struct WorkspaceListCancellation {
    canceled: Arc<AtomicBool>,
}

impl WorkspaceListCancellation {
    pub fn cancel(&self) {
        self.canceled.store(true, Ordering::Release);
    }

    fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::Acquire)
    }
}

/// Trusted registry that binds opaque workspace identities to open directories.
///
/// The caller path is consumed only while registering. It is never retained,
/// logged, returned, or used to reopen a directory during listing.
#[derive(Debug)]
pub struct WorkspaceDirectoryRegistry {
    entries: Mutex<HashMap<String, RegisteredDirectory>>,
}

impl WorkspaceDirectoryRegistry {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn register(
        &self,
        workspace_binding_id: impl Into<String>,
        trusted_path: &Path,
    ) -> Result<WorkspaceDirectoryBinding, WorkspaceDirectoryError> {
        let workspace_binding_id = workspace_binding_id.into();
        self.register_with_incarnation(
            workspace_binding_id,
            format!("incarnation-{}", Uuid::new_v4()),
            trusted_path,
        )
    }

    pub fn register_with_incarnation(
        &self,
        workspace_binding_id: impl Into<String>,
        incarnation_id: impl Into<String>,
        trusted_path: &Path,
    ) -> Result<WorkspaceDirectoryBinding, WorkspaceDirectoryError> {
        let binding = WorkspaceDirectoryBinding {
            workspace_binding_id: workspace_binding_id.into(),
            incarnation_id: incarnation_id.into(),
        };
        validate_binding(&binding)?;
        let directory = platform::StableDirectory::open(trusted_path)?;
        let mut entries = self.lock_entries()?;
        if entries.contains_key(&binding.workspace_binding_id) {
            return Err(WorkspaceDirectoryError::new("workspace_binding_conflict"));
        }
        entries.insert(
            binding.workspace_binding_id.clone(),
            RegisteredDirectory {
                binding: binding.clone(),
                directory: Some(directory),
            },
        );
        Ok(binding)
    }

    pub fn unregister(
        &self,
        binding: &WorkspaceDirectoryBinding,
    ) -> Result<(), WorkspaceDirectoryError> {
        validate_binding(binding)?;
        let mut entries = self.lock_entries()?;
        let Some(current) = entries.get(&binding.workspace_binding_id) else {
            return Err(WorkspaceDirectoryError::new(
                "workspace_binding_unavailable",
            ));
        };
        if current.binding != *binding || current.directory.is_none() {
            return Err(WorkspaceDirectoryError::new(
                "workspace_binding_unavailable",
            ));
        }
        entries.remove(&binding.workspace_binding_id);
        Ok(())
    }

    pub(crate) fn validate_current_binding(
        &self,
        binding: &WorkspaceDirectoryBinding,
    ) -> Result<(), WorkspaceDirectoryError> {
        validate_binding(binding)?;
        let entries = self.lock_entries()?;
        let Some(registered) = entries.get(&binding.workspace_binding_id) else {
            return Err(WorkspaceDirectoryError::new(
                "workspace_binding_unavailable",
            ));
        };
        if registered.binding != *binding {
            return Err(WorkspaceDirectoryError::new(
                "workspace_binding_unavailable",
            ));
        }
        Ok(())
    }

    /// Builds one bounded snapshot from the already-open directory handle.
    ///
    /// Cancellation and deadline checks occur between native enumeration
    /// calls. A single kernel call that never returns cannot be preempted by
    /// this in-process API; callers requiring a strict wall-clock boundary must
    /// run the operation in a supervised process and treat timeout as
    /// unavailable until that process is terminated.
    pub fn begin_listing(
        &self,
        binding: &WorkspaceDirectoryBinding,
        limits: WorkspaceListLimits,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<WorkspaceDirectoryListing, WorkspaceDirectoryError> {
        self.acquire_listing(binding, limits, cancellation)?
            .scan(cancellation)
    }

    /// Reads one bounded UTF-8 regular file through the registered directory
    /// handle. Components are traversed by the platform implementation without
    /// resolving or reopening an absolute path.
    pub fn read_file(
        &self,
        binding: &WorkspaceDirectoryBinding,
        components: &[String],
        max_bytes: usize,
        timeout: Duration,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<WorkspaceFileReadResult, WorkspaceDirectoryError> {
        validate_binding(binding)?;
        if components.is_empty()
            || components.len() > 32
            || max_bytes == 0
            || max_bytes > MAX_WORKSPACE_FILE_READ_BYTES
            || timeout.is_zero()
            || timeout > MAX_WORKSPACE_LIST_TIMEOUT
        {
            return Err(WorkspaceDirectoryError::new(
                "workspace_file_read_limits_invalid",
            ));
        }
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| WorkspaceDirectoryError::new("workspace_file_read_limits_invalid"))?;
        let directory = {
            let mut entries = self.lock_entries()?;
            let registered = entries
                .get_mut(&binding.workspace_binding_id)
                .filter(|registered| registered.binding == *binding)
                .ok_or_else(|| WorkspaceDirectoryError::new("workspace_binding_unavailable"))?;
            registered
                .directory
                .take()
                .ok_or_else(|| WorkspaceDirectoryError::new("workspace_binding_unavailable"))?
        };
        let mut lease = DirectoryLease {
            registry: self,
            workspace_binding_id: binding.workspace_binding_id.clone(),
            directory: Some(directory),
        };
        let content =
            lease
                .directory_mut()?
                .read_file(components, max_bytes, deadline, cancellation)?;
        self.validate_current_binding(binding)?;
        let result = WorkspaceFileReadResult {
            schema_version: "crewon.workspace-file-read-result.v0".to_string(),
            encoding: "utf8".to_string(),
            byte_length: content.len(),
            content,
        };
        let encoded = serde_json::to_vec(&result).map_err(|error| {
            WorkspaceDirectoryError::with_source("workspace_file_read_result_invalid", error)
        })?;
        if encoded.len() > max_bytes {
            return Err(WorkspaceDirectoryError::new(
                "workspace_file_read_output_too_large",
            ));
        }
        Ok(result)
    }

    /// Exclusively acquires the already-open handle without performing I/O.
    ///
    /// Native connection admission uses this as its epoch linearization point,
    /// then releases the epoch permit before any potentially blocking kernel
    /// enumeration call.
    pub(crate) fn acquire_listing(
        &self,
        binding: &WorkspaceDirectoryBinding,
        limits: WorkspaceListLimits,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<WorkspaceDirectoryListingLease<'_>, WorkspaceDirectoryError> {
        validate_binding(binding)?;
        limits.validate()?;
        if cancellation.is_canceled() {
            return Err(WorkspaceDirectoryError::new("workspace_list_canceled"));
        }
        let deadline = Instant::now()
            .checked_add(limits.timeout)
            .ok_or_else(|| WorkspaceDirectoryError::new("workspace_list_limits_invalid"))?;
        let directory = {
            let mut entries = self.lock_entries()?;
            let Some(registered) = entries.get_mut(&binding.workspace_binding_id) else {
                return Err(WorkspaceDirectoryError::new(
                    "workspace_binding_unavailable",
                ));
            };
            if registered.binding != *binding {
                return Err(WorkspaceDirectoryError::new(
                    "workspace_binding_unavailable",
                ));
            }
            registered
                .directory
                .take()
                .ok_or_else(|| WorkspaceDirectoryError::new("workspace_binding_unavailable"))?
        };
        Ok(WorkspaceDirectoryListingLease {
            lease: DirectoryLease {
                registry: self,
                workspace_binding_id: binding.workspace_binding_id.clone(),
                directory: Some(directory),
            },
            limits,
            deadline,
        })
    }

    fn lock_entries(
        &self,
    ) -> Result<
        std::sync::MutexGuard<'_, HashMap<String, RegisteredDirectory>>,
        WorkspaceDirectoryError,
    > {
        self.entries
            .lock()
            .map_err(|_| WorkspaceDirectoryError::new("workspace_registry_poisoned"))
    }
}

impl Default for WorkspaceDirectoryRegistry {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) struct WorkspaceDirectoryListingLease<'a> {
    lease: DirectoryLease<'a>,
    limits: WorkspaceListLimits,
    deadline: Instant,
}

impl WorkspaceDirectoryListingLease<'_> {
    pub(crate) fn scan(
        mut self,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<WorkspaceDirectoryListing, WorkspaceDirectoryError> {
        let mut entries = self.lease.directory_mut()?.scan(
            ScanBudget {
                max_name_bytes: self.limits.max_name_bytes,
                max_scanned_entries: self.limits.max_scanned_entries,
                max_scanned_name_bytes: self.limits.max_scanned_name_bytes,
                deadline: self.deadline,
            },
            cancellation,
        )?;
        entries.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
        let truncated = entries.len() > self.limits.max_entries;
        entries.truncate(self.limits.max_entries);
        require_output_bound(&entries, truncated, self.limits.max_output_bytes)?;
        Ok(WorkspaceDirectoryListing {
            entries,
            truncated,
            position: 0,
            next_page: 0,
            max_output_bytes: self.limits.max_output_bytes,
        })
    }
}

#[derive(Debug)]
pub struct WorkspaceDirectoryListing {
    entries: Vec<WorkspaceDirectoryEntry>,
    truncated: bool,
    position: usize,
    next_page: usize,
    max_output_bytes: usize,
}

impl WorkspaceDirectoryListing {
    pub fn next_page(
        &mut self,
        request: WorkspaceListPageRequest,
    ) -> Result<WorkspaceListPage, WorkspaceDirectoryError> {
        if request.max_entries == 0 || request.max_entries > MAX_WORKSPACE_LIST_ENTRIES {
            return Err(WorkspaceDirectoryError::new("workspace_list_page_invalid"));
        }
        let expected_cursor =
            (self.next_page != 0).then(|| format!("{CURSOR_PREFIX}{}", self.next_page));
        if request.cursor != expected_cursor {
            return Err(WorkspaceDirectoryError::new(
                "workspace_list_cursor_invalid",
            ));
        }
        let end = self
            .position
            .saturating_add(request.max_entries)
            .min(self.entries.len());
        let entries = self.entries[self.position..end].to_vec();
        self.position = end;
        self.next_page += 1;
        let next_cursor = (self.position < self.entries.len())
            .then(|| format!("{CURSOR_PREFIX}{}", self.next_page));
        let page = WorkspaceListPage {
            entries,
            next_cursor,
            truncated: self.truncated,
        };
        let encoded = serde_json::to_vec(&page).map_err(|error| {
            WorkspaceDirectoryError::with_source("workspace_list_result_invalid", error)
        })?;
        if encoded.len() > self.max_output_bytes {
            return Err(WorkspaceDirectoryError::new(
                "workspace_list_output_too_large",
            ));
        }
        Ok(page)
    }
}

#[derive(Debug, Error)]
#[error("{code}")]
pub struct WorkspaceDirectoryError {
    pub code: &'static str,
    #[source]
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl WorkspaceDirectoryError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self { code, source: None }
    }

    pub(crate) fn with_source(
        code: &'static str,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            code,
            source: Some(Box::new(source)),
        }
    }
}

#[derive(Debug)]
struct RegisteredDirectory {
    binding: WorkspaceDirectoryBinding,
    directory: Option<platform::StableDirectory>,
}

struct DirectoryLease<'a> {
    registry: &'a WorkspaceDirectoryRegistry,
    workspace_binding_id: String,
    directory: Option<platform::StableDirectory>,
}

impl DirectoryLease<'_> {
    fn directory_mut(&mut self) -> Result<&mut platform::StableDirectory, WorkspaceDirectoryError> {
        self.directory
            .as_mut()
            .ok_or_else(|| WorkspaceDirectoryError::new("workspace_binding_unavailable"))
    }
}

impl Drop for DirectoryLease<'_> {
    fn drop(&mut self) {
        let Some(directory) = self.directory.take() else {
            return;
        };
        let Ok(mut entries) = self.registry.entries.lock() else {
            drop(directory);
            return;
        };
        let Some(registered) = entries.get_mut(&self.workspace_binding_id) else {
            drop(directory);
            return;
        };
        if registered.directory.is_none() {
            registered.directory = Some(directory);
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ScanBudget {
    pub max_name_bytes: usize,
    pub max_scanned_entries: usize,
    pub max_scanned_name_bytes: usize,
    pub deadline: Instant,
}

pub(crate) fn validate_scan_progress(
    cancellation: &WorkspaceListCancellation,
    deadline: Instant,
) -> Result<(), WorkspaceDirectoryError> {
    if cancellation.is_canceled() {
        return Err(WorkspaceDirectoryError::new("workspace_list_canceled"));
    }
    if Instant::now() >= deadline {
        return Err(WorkspaceDirectoryError::new(
            "workspace_list_deadline_exceeded",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "workspace_directory_tests.rs"]
mod tests;
