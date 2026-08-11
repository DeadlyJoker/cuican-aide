use std::time::Duration;

use chrono::DateTime;
use chrono::Utc;
use crewon_device_protocol::DeviceFilesystemReadCommand;
use crewon_device_protocol::MAX_DEVICE_COMMAND_BYTES;
use crewon_device_protocol::parse_device_filesystem_read_command;

use crate::AcceptedGatewayConnection;
use crate::DeviceCommandAuthorizer;
use crate::NativeDeviceAdmissionError;
use crate::NativeDeviceConnection;
use crate::NativeDeviceRuntimeBinding;
use crate::WorkspaceDirectoryBinding;
use crate::WorkspaceDirectoryRegistry;
use crate::WorkspaceListCancellation;
use crate::native_connection::parse_bounded_json;
use crate::workspace_file_read::WorkspaceFileReadLease;

impl DeviceCommandAuthorizer {
    pub(crate) fn verify_filesystem_read_command(
        &self,
        frame: &[u8],
        now: DateTime<Utc>,
    ) -> Result<DeviceFilesystemReadCommand, NativeDeviceAdmissionError> {
        let value = parse_bounded_json(
            frame,
            MAX_DEVICE_COMMAND_BYTES,
            "device_filesystem_read_command_invalid",
            "device_command_too_large",
        )?;
        let command = parse_device_filesystem_read_command(value)
            .map_err(NativeDeviceAdmissionError::from_protocol)?;
        self.verify(&command.command, now)?;
        Ok(command)
    }
}

impl NativeDeviceConnection<'_> {
    pub fn verify_filesystem_read_command(
        &self,
        command_frame: &[u8],
        now: DateTime<Utc>,
    ) -> Result<VerifiedDeviceFilesystemReadCommand, NativeDeviceAdmissionError> {
        let command = self
            .authorizer
            .verify_filesystem_read_command(command_frame, now)?;
        self.validate_filesystem_read_binding(&command, now)?;
        Ok(VerifiedDeviceFilesystemReadCommand {
            connection: self.accepted.clone(),
            runtime_binding: self.runtime_binding.clone().ok_or_else(|| {
                NativeDeviceAdmissionError::new("device_workspace_runtime_unavailable")
            })?,
            command,
        })
    }

    pub(crate) fn admit_filesystem_read_metadata(
        &self,
        verified: VerifiedDeviceFilesystemReadCommand,
        now: DateTime<Utc>,
        registry: &WorkspaceDirectoryRegistry,
    ) -> Result<DeviceFilesystemReadCommand, NativeDeviceAdmissionError> {
        if verified.connection != self.accepted
            || self.runtime_binding.as_ref() != Some(&verified.runtime_binding)
        {
            return Err(NativeDeviceAdmissionError::new(
                "device_connection_epoch_stale",
            ));
        }
        self.authorizer.verify(&verified.command.command, now)?;
        self.validate_filesystem_read_binding(&verified.command, now)?;
        let permit = self
            .fence
            .authorize_command(&self.accepted, &verified.command.command)
            .map_err(NativeDeviceAdmissionError::from_fence)?;
        let binding = binding(&verified.command);
        let validated = registry
            .validate_current_binding(&binding)
            .map_err(NativeDeviceAdmissionError::from_workspace);
        drop(permit);
        validated?;
        Ok(verified.command)
    }

    pub(crate) fn acquire_filesystem_read_for_durable_dispatch<'registry>(
        &self,
        command: &DeviceFilesystemReadCommand,
        now: DateTime<Utc>,
        registry: &'registry WorkspaceDirectoryRegistry,
        cancellation: &WorkspaceListCancellation,
    ) -> Result<WorkspaceFileReadLease<'registry>, NativeDeviceAdmissionError> {
        self.authorizer.verify(&command.command, now)?;
        self.validate_filesystem_read_binding(command, now)?;
        let permit = self
            .fence
            .authorize_command(&self.accepted, &command.command)
            .map_err(NativeDeviceAdmissionError::from_fence)?;
        let max_bytes = usize::try_from(command.command.limits.max_output_bytes)
            .map_err(|_| NativeDeviceAdmissionError::new("workspace_file_read_limits_invalid"))?;
        let lease = registry.acquire_file_read(
            &binding(command),
            &command.arguments.relative_path_segments,
            max_bytes,
            Duration::from_millis(command.command.limits.timeout_ms),
            cancellation,
        );
        drop(permit);
        lease.map_err(NativeDeviceAdmissionError::from_workspace)
    }

    pub(crate) fn validate_filesystem_read_continuation(
        &self,
        command: &DeviceFilesystemReadCommand,
        now: DateTime<Utc>,
    ) -> Result<(), NativeDeviceAdmissionError> {
        self.validate_filesystem_read_binding(command, now)?;
        let permit = self
            .fence
            .authorize_command(&self.accepted, &command.command)
            .map_err(NativeDeviceAdmissionError::from_fence)?;
        drop(permit);
        Ok(())
    }

    fn validate_filesystem_read_binding(
        &self,
        command: &DeviceFilesystemReadCommand,
        now: DateTime<Utc>,
    ) -> Result<(), NativeDeviceAdmissionError> {
        if command.command.device_id != self.accepted.device_id {
            return Err(NativeDeviceAdmissionError::new(
                "device_connection_command_identity_mismatch",
            ));
        }
        self.runtime_binding.as_ref().ok_or_else(|| {
            NativeDeviceAdmissionError::new("device_workspace_runtime_unavailable")
        })?;
        let expires_at = DateTime::parse_from_rfc3339(&command.command.expires_at)
            .map_err(|_| NativeDeviceAdmissionError::new("device_lease_expiry_invalid"))?
            .with_timezone(&Utc);
        if expires_at <= now {
            return Err(NativeDeviceAdmissionError::new(
                "device_command_lease_expired",
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
#[must_use = "admit and durably dispatch through NativeFilesystemReadOrchestrator"]
pub struct VerifiedDeviceFilesystemReadCommand {
    connection: AcceptedGatewayConnection,
    runtime_binding: NativeDeviceRuntimeBinding,
    command: DeviceFilesystemReadCommand,
}

impl VerifiedDeviceFilesystemReadCommand {
    pub fn command(&self) -> &DeviceFilesystemReadCommand {
        &self.command
    }
}

fn binding(command: &DeviceFilesystemReadCommand) -> WorkspaceDirectoryBinding {
    WorkspaceDirectoryBinding {
        workspace_binding_id: command.command.workspace_binding_id.clone(),
        incarnation_id: command.arguments.workspace_incarnation_id.clone(),
    }
}
