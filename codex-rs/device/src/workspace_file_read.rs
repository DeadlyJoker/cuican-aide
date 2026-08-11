use std::time::Duration;
use std::time::Instant;

use serde::Serialize;

use crate::WorkspaceDirectoryBinding;
use crate::WorkspaceDirectoryError;
use crate::WorkspaceDirectoryRegistry;
use crate::WorkspaceListCancellation;
use crate::workspace_directory::DirectoryLease;
use crate::workspace_directory::MAX_WORKSPACE_LIST_TIMEOUT;
use crate::workspace_directory::validation::validate_binding;

pub const MAX_WORKSPACE_FILE_READ_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileReadResult {
    pub schema_version: String,
    pub encoding: String,
    pub content: String,
    pub byte_length: usize,
}

impl WorkspaceDirectoryRegistry {
    /// Reads through the registered stable handle without reopening a raw path.
    pub fn read_file(
        &self,
        binding: &WorkspaceDirectoryBinding,
        components: &[String],
        max_bytes: usize,
        timeout: Duration,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<WorkspaceFileReadResult, WorkspaceDirectoryError> {
        self.acquire_file_read(binding, components, max_bytes, timeout, cancellation)?
            .read(cancellation)
    }

    /// Acquires the stable directory handle without performing file I/O.
    pub(crate) fn acquire_file_read(
        &self,
        binding: &WorkspaceDirectoryBinding,
        components: &[String],
        max_bytes: usize,
        timeout: Duration,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<WorkspaceFileReadLease<'_>, WorkspaceDirectoryError> {
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
        if cancellation.is_canceled() {
            return Err(WorkspaceDirectoryError::new(
                "workspace_file_read_canceled",
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
        Ok(WorkspaceFileReadLease {
            lease: DirectoryLease {
                registry: self,
                workspace_binding_id: binding.workspace_binding_id.clone(),
                directory: Some(directory),
            },
            binding: binding.clone(),
            components: components.to_vec(),
            max_bytes,
            deadline,
        })
    }
}

pub(crate) struct WorkspaceFileReadLease<'a> {
    lease: DirectoryLease<'a>,
    binding: WorkspaceDirectoryBinding,
    components: Vec<String>,
    max_bytes: usize,
    deadline: Instant,
}

impl WorkspaceFileReadLease<'_> {
    pub(crate) fn read(
        mut self,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<WorkspaceFileReadResult, WorkspaceDirectoryError> {
        let content = self
            .lease
            .read_file(&self.components, self.max_bytes, self.deadline, cancellation)
            .map_err(read_error)?;
        self.lease.registry.validate_current_binding(&self.binding)?;
        let result = WorkspaceFileReadResult {
            schema_version: "crewon.workspace-file-read-result.v0".to_string(),
            encoding: "utf8".to_string(),
            byte_length: content.len(),
            content,
        };
        let encoded = serde_json::to_vec(&result).map_err(|error| {
            WorkspaceDirectoryError::with_source("workspace_file_read_result_invalid", error)
        })?;
        if encoded.len() > self.max_bytes {
            return Err(WorkspaceDirectoryError::new(
                "workspace_file_read_output_too_large",
            ));
        }
        Ok(result)
    }
}

fn read_error(error: WorkspaceDirectoryError) -> WorkspaceDirectoryError {
    match error.code {
        "workspace_list_canceled" => WorkspaceDirectoryError::new("workspace_file_read_canceled"),
        "workspace_list_deadline_exceeded" => {
            WorkspaceDirectoryError::new("workspace_file_read_deadline_exceeded")
        }
        _ => error,
    }
}
