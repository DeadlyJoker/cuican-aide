use std::time::Duration;

use crewon_device_protocol::DeviceWorkspaceListCommand;
use serde::Serialize;

use crate::NativeDeviceAdmissionError;
use crate::WorkspaceDirectoryBinding;
use crate::WorkspaceDirectoryEntry;
use crate::WorkspaceDirectoryRegistry;
use crate::WorkspaceListCancellation;
use crate::WorkspaceListLimits;
use crate::WorkspaceListPageRequest;
use crate::workspace_directory::WorkspaceDirectoryListingLease;

const RESULT_SCHEMA_VERSION: &str = "crewon.workspace-list-result.v0";
const PAGE_ENTRIES: usize = 64;

/// A transient, bounded projection of one stable-handle top-level listing.
///
/// This result is not a durable Native receipt. Until a Gateway transport and
/// receipt authority exist, replay, reconciliation, retry, and HA remain
/// unavailable to callers of this crate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWorkspaceListResult {
    pub schema_version: String,
    pub execution_id: String,
    pub action_digest: String,
    pub command_digest: String,
    pub entries: Vec<WorkspaceDirectoryEntry>,
    pub truncated: bool,
}

pub(crate) struct AdmittedWorkspaceList<'a> {
    listing: WorkspaceDirectoryListingLease<'a>,
    execution_id: String,
    action_digest: String,
    command_digest: String,
    maximum_entries: usize,
    maximum_output_bytes: usize,
}

pub(crate) fn admit_workspace_list<'a>(
    registry: &'a WorkspaceDirectoryRegistry,
    command: &DeviceWorkspaceListCommand,
    cancellation: &WorkspaceListCancellation,
) -> Result<AdmittedWorkspaceList<'a>, NativeDeviceAdmissionError> {
    let binding = WorkspaceDirectoryBinding {
        workspace_binding_id: command.workspace_binding_id.clone(),
        incarnation_id: command.incarnation_id.clone(),
    };
    let limits = native_limits(command)?;
    let maximum_output_bytes = limits.max_output_bytes;
    let maximum_entries = limits.max_entries;
    let listing = registry
        .acquire_listing(&binding, limits, cancellation)
        .map_err(NativeDeviceAdmissionError::from_workspace)?;
    Ok(AdmittedWorkspaceList {
        listing,
        execution_id: command.execution_id.clone(),
        action_digest: command.action_digest.clone(),
        command_digest: command.command_digest.clone(),
        maximum_entries,
        maximum_output_bytes,
    })
}

pub(crate) fn execute_admitted_workspace_list(
    admitted: AdmittedWorkspaceList<'_>,
    cancellation: &WorkspaceListCancellation,
) -> Result<DeviceWorkspaceListResult, NativeDeviceAdmissionError> {
    let mut listing = admitted
        .listing
        .scan(cancellation)
        .map_err(NativeDeviceAdmissionError::from_workspace)?;
    let mut entries = Vec::with_capacity(admitted.maximum_entries);
    let mut cursor = None;
    loop {
        let remaining = admitted.maximum_entries.saturating_sub(entries.len());
        if remaining == 0 {
            return Err(NativeDeviceAdmissionError::new(
                "workspace_list_result_invalid",
            ));
        }
        let page = listing
            .next_page(WorkspaceListPageRequest {
                cursor,
                max_entries: remaining.min(PAGE_ENTRIES),
            })
            .map_err(NativeDeviceAdmissionError::from_workspace)?;
        entries.extend(page.entries);
        let Some(next_cursor) = page.next_cursor else {
            let result = DeviceWorkspaceListResult {
                schema_version: RESULT_SCHEMA_VERSION.to_string(),
                execution_id: admitted.execution_id,
                action_digest: admitted.action_digest,
                command_digest: admitted.command_digest,
                entries,
                truncated: page.truncated,
            };
            require_result_bound(&result, admitted.maximum_output_bytes)?;
            return Ok(result);
        };
        cursor = Some(next_cursor);
    }
}

fn native_limits(
    command: &DeviceWorkspaceListCommand,
) -> Result<WorkspaceListLimits, NativeDeviceAdmissionError> {
    let limits = &command.limits;
    if limits.depth != 0 {
        return Err(NativeDeviceAdmissionError::new(
            "device_workspace_depth_invalid",
        ));
    }
    Ok(WorkspaceListLimits {
        max_entries: usize::try_from(limits.max_entries)
            .map_err(|_| NativeDeviceAdmissionError::new("device_workspace_limits_invalid"))?,
        max_name_bytes: usize::try_from(limits.max_name_bytes)
            .map_err(|_| NativeDeviceAdmissionError::new("device_workspace_limits_invalid"))?,
        max_output_bytes: usize::try_from(limits.max_output_bytes)
            .map_err(|_| NativeDeviceAdmissionError::new("device_workspace_limits_invalid"))?,
        max_scanned_entries: usize::try_from(limits.max_scanned_entries)
            .map_err(|_| NativeDeviceAdmissionError::new("device_workspace_limits_invalid"))?,
        max_scanned_name_bytes: usize::try_from(limits.max_scanned_name_bytes)
            .map_err(|_| NativeDeviceAdmissionError::new("device_workspace_limits_invalid"))?,
        timeout: Duration::from_millis(limits.timeout_ms),
    })
}

fn require_result_bound(
    result: &DeviceWorkspaceListResult,
    maximum: usize,
) -> Result<(), NativeDeviceAdmissionError> {
    let encoded = serde_json::to_vec(result).map_err(|error| {
        NativeDeviceAdmissionError::with_source("workspace_list_result_invalid", error)
    })?;
    if encoded.len() > maximum {
        return Err(NativeDeviceAdmissionError::new(
            "workspace_list_output_too_large",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "workspace_list_dispatcher_tests.rs"]
mod tests;
