use std::sync::Arc;

use crewon_device::AcceptedGatewayConnection;
use crewon_device::NativeDeviceConnection;
use crewon_device::NativeFilesystemReadDispatchOutcome;
use crewon_device::NativeWorkspaceListDispatchOutcome;
use crewon_device::WorkspaceListCancellation;
use crewon_device_protocol::DeviceExecutionCancel;
use crewon_device_protocol::DeviceFilesystemReadCommand;
use crewon_device_protocol::DeviceFilesystemReadEvent;
use crewon_device_protocol::DeviceWorkspaceListCommand;
use crewon_device_protocol::DeviceWorkspaceListEvent;
use crewon_device_protocol::parse_device_filesystem_read_command;
use crewon_device_protocol::parse_device_workspace_list_command;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::watch;

use crate::DeviceRuntimeError;
use crate::runtime::ActiveCancellation;
use crate::runtime::DeviceRuntimeState;
use crate::runtime::RuntimeEvent;

pub(crate) const MAX_BLOCKING_DISPATCHES: usize = 4;

pub(crate) struct DispatchRequest {
    command_frame: Vec<u8>,
    command: DispatchCommand,
    cancellation: WorkspaceListCancellation,
    owns_cancellation: bool,
}

enum DispatchCommand {
    WorkspaceList(DeviceWorkspaceListCommand),
    FilesystemRead(DeviceFilesystemReadCommand),
}

pub(crate) fn enqueue_command(
    state: &Arc<DeviceRuntimeState>,
    frame: &[u8],
    value: Value,
    dispatch_tx: &mpsc::Sender<DispatchRequest>,
) -> Result<(), DeviceRuntimeError> {
    let command = parse_device_workspace_list_command(value).map_err(|error| {
        DeviceRuntimeError::with_source("device_runtime_command_invalid", error)
    })?;
    if command.device_id != state.device_id {
        return Err(DeviceRuntimeError::new("device_runtime_command_invalid"));
    }
    let (cancellation, owns_cancellation) = register_cancellation(state, &command)?;
    let request = DispatchRequest {
        command_frame: frame.to_vec(),
        command: DispatchCommand::WorkspaceList(command.clone()),
        cancellation,
        owns_cancellation,
    };
    if dispatch_tx.try_send(request).is_err() {
        if owns_cancellation {
            remove_owned_cancellation(state, &command);
        }
        return Err(DeviceRuntimeError::new(
            "device_runtime_dispatch_capacity_exceeded",
        ));
    }
    Ok(())
}

pub(crate) fn enqueue_filesystem_read(
    state: &Arc<DeviceRuntimeState>,
    frame: &[u8],
    value: Value,
    dispatch_tx: &mpsc::Sender<DispatchRequest>,
) -> Result<(), DeviceRuntimeError> {
    let command = parse_device_filesystem_read_command(value).map_err(|error| {
        DeviceRuntimeError::with_source("device_runtime_command_invalid", error)
    })?;
    if command.command.device_id != state.device_id {
        return Err(DeviceRuntimeError::new("device_runtime_command_invalid"));
    }
    let (cancellation, owns_cancellation) = register_identity(
        state,
        &command.command.execution_id,
        &command.command.lease_id,
        command.command.lease_epoch,
    )?;
    let request = DispatchRequest {
        command_frame: frame.to_vec(),
        command: DispatchCommand::FilesystemRead(command.clone()),
        cancellation,
        owns_cancellation,
    };
    if dispatch_tx.try_send(request).is_err() {
        if owns_cancellation {
            remove_owned_identity(
                state,
                &command.command.execution_id,
                &command.command.lease_id,
                command.command.lease_epoch,
            );
        }
        return Err(DeviceRuntimeError::new(
            "device_runtime_dispatch_capacity_exceeded",
        ));
    }
    Ok(())
}

pub(crate) async fn run_dispatch_scheduler(
    state: Arc<DeviceRuntimeState>,
    accepted: AcceptedGatewayConnection,
    mut requests: mpsc::Receiver<DispatchRequest>,
    fatal: watch::Sender<bool>,
) {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_BLOCKING_DISPATCHES));
    while let Some(request) = requests.recv().await {
        let Ok(permit) = Arc::clone(&semaphore).acquire_owned().await else {
            return;
        };
        let worker_state = Arc::clone(&state);
        let worker_accepted = accepted.clone();
        let worker_fatal = fatal.clone();
        tokio::spawn(async move {
            let blocking_state = Arc::clone(&worker_state);
            let handle = tokio::runtime::Handle::current();
            let outcome = tokio::task::spawn_blocking(move || {
                dispatch_blocking(blocking_state, worker_accepted, request, handle)
            })
            .await;
            drop(permit);
            let Ok(Ok(outcome)) = outcome else {
                let _ = worker_fatal.send(true);
                return;
            };
            for event in outcome_events(outcome) {
                let _ = worker_state.events.send(event);
            }
        });
    }
}

fn dispatch_blocking(
    state: Arc<DeviceRuntimeState>,
    accepted: AcceptedGatewayConnection,
    request: DispatchRequest,
    handle: tokio::runtime::Handle,
) -> Result<DispatchOutcome, DeviceRuntimeError> {
    let connection = NativeDeviceConnection::resume_current(
        &state.fence,
        &state.authorizer,
        state.runtime_binding.clone(),
        accepted,
    )
    .map_err(|error| DeviceRuntimeError::with_source("device_runtime_connection_stale", error))?;
    let observer_state = Arc::clone(&state);
    let outcome = match &request.command {
        DispatchCommand::WorkspaceList(_) => handle
            .block_on(
                state
                    .orchestrator
                    .dispatch_workspace_list_with_accepted_observer(
                        &connection,
                        &request.command_frame,
                        &state.registry,
                        &request.cancellation,
                        move |accepted| {
                            let _ = observer_state
                                .events
                                .send(RuntimeEvent::WorkspaceList(accepted.clone()));
                        },
                    ),
            )
            .map(DispatchOutcome::WorkspaceList),
        DispatchCommand::FilesystemRead(_) => handle
            .block_on(state.read_orchestrator.dispatch_with_accepted_observer(
                &connection,
                &request.command_frame,
                &state.registry,
                &request.cancellation,
                move |accepted| {
                    let _ = observer_state
                        .events
                        .send(RuntimeEvent::FilesystemRead(accepted.clone()));
                },
            ))
            .map(DispatchOutcome::FilesystemRead),
    }
    .map_err(|error| DeviceRuntimeError::with_source("device_runtime_dispatch_failed", error));
    if request.owns_cancellation {
        match &request.command {
            DispatchCommand::WorkspaceList(command) => remove_owned_cancellation(&state, command),
            DispatchCommand::FilesystemRead(command) => remove_owned_identity(
                &state,
                &command.command.execution_id,
                &command.command.lease_id,
                command.command.lease_epoch,
            ),
        }
    }
    outcome
}

enum DispatchOutcome {
    WorkspaceList(NativeWorkspaceListDispatchOutcome),
    FilesystemRead(NativeFilesystemReadDispatchOutcome),
}

fn outcome_events(outcome: DispatchOutcome) -> Vec<RuntimeEvent> {
    match outcome {
        DispatchOutcome::FilesystemRead(outcome) => read_outcome_events(outcome)
            .into_iter()
            .map(RuntimeEvent::FilesystemRead)
            .collect(),
        DispatchOutcome::WorkspaceList(outcome) => workspace_outcome_events(outcome)
            .into_iter()
            .map(RuntimeEvent::WorkspaceList)
            .collect(),
    }
}

fn workspace_outcome_events(
    outcome: NativeWorkspaceListDispatchOutcome,
) -> Vec<DeviceWorkspaceListEvent> {
    match outcome {
        NativeWorkspaceListDispatchOutcome::FreshResolved { terminal, .. } => vec![terminal],
        NativeWorkspaceListDispatchOutcome::AcceptedInFlight { accepted } => vec![accepted],
        NativeWorkspaceListDispatchOutcome::RecoveredUnknownOutcome { accepted, terminal }
        | NativeWorkspaceListDispatchOutcome::TerminalReplay { accepted, terminal } => {
            vec![accepted, terminal]
        }
    }
}

fn read_outcome_events(
    outcome: NativeFilesystemReadDispatchOutcome,
) -> Vec<DeviceFilesystemReadEvent> {
    match outcome {
        NativeFilesystemReadDispatchOutcome::FreshResolved { terminal, .. } => vec![terminal],
        NativeFilesystemReadDispatchOutcome::AcceptedInFlight { accepted } => vec![accepted],
        NativeFilesystemReadDispatchOutcome::RecoveredUnknownOutcome { accepted, terminal }
        | NativeFilesystemReadDispatchOutcome::TerminalReplay { accepted, terminal } => {
            vec![accepted, terminal]
        }
    }
}

fn register_cancellation(
    state: &DeviceRuntimeState,
    command: &DeviceWorkspaceListCommand,
) -> Result<(WorkspaceListCancellation, bool), DeviceRuntimeError> {
    register_identity(
        state,
        &command.execution_id,
        &command.lease_id,
        command.lease_epoch,
    )
}

fn register_identity(
    state: &DeviceRuntimeState,
    execution_id: &str,
    lease_id: &str,
    lease_epoch: u64,
) -> Result<(WorkspaceListCancellation, bool), DeviceRuntimeError> {
    let mut cancellations = state.cancellations.lock().map_err(|_| {
        DeviceRuntimeError::new("device_runtime_cancellation_authority_unavailable")
    })?;
    if let Some(active) = cancellations.get(execution_id) {
        if active.lease_id != lease_id || active.lease_epoch != lease_epoch {
            return Err(DeviceRuntimeError::new("device_runtime_execution_conflict"));
        }
        return Ok((active.cancellation.clone(), false));
    }
    let cancellation = WorkspaceListCancellation::default();
    cancellations.insert(
        execution_id.to_string(),
        ActiveCancellation {
            lease_id: lease_id.to_string(),
            lease_epoch,
            cancellation: cancellation.clone(),
        },
    );
    Ok((cancellation, true))
}

fn remove_owned_cancellation(state: &DeviceRuntimeState, command: &DeviceWorkspaceListCommand) {
    remove_owned_identity(
        state,
        &command.execution_id,
        &command.lease_id,
        command.lease_epoch,
    );
}

fn remove_owned_identity(
    state: &DeviceRuntimeState,
    execution_id: &str,
    lease_id: &str,
    lease_epoch: u64,
) {
    if let Ok(mut cancellations) = state.cancellations.lock()
        && cancellations
            .get(execution_id)
            .is_some_and(|active| active.lease_id == lease_id && active.lease_epoch == lease_epoch)
    {
        cancellations.remove(execution_id);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CancelDisposition {
    Applied,
    IgnoredInactive,
}

pub(crate) async fn apply_cancel(
    state: &DeviceRuntimeState,
    cancel: &DeviceExecutionCancel,
) -> Result<CancelDisposition, DeviceRuntimeError> {
    if cancel.device_id != state.device_id {
        return Err(DeviceRuntimeError::new("device_runtime_cancel_invalid"));
    }
    {
        let cancellations = state.cancellations.lock().map_err(|_| {
            DeviceRuntimeError::new("device_runtime_cancellation_authority_unavailable")
        })?;
        if let Some(active) = cancellations.get(&cancel.execution_id) {
            if active.lease_id != cancel.lease_id || active.lease_epoch != cancel.lease_epoch {
                return Err(DeviceRuntimeError::new(
                    "device_runtime_cancel_identity_mismatch",
                ));
            }
            active.cancellation.cancel();
            return Ok(CancelDisposition::Applied);
        }
    }
    let execution = state
        .journal
        .get_workspace_list(&cancel.execution_id)
        .await
        .map_err(|error| {
            DeviceRuntimeError::with_source("device_runtime_journal_invalid", error)
        })?;
    if let Some(execution) = execution
        && (execution.command.device_id != cancel.device_id
            || execution.command.lease_id != cancel.lease_id
            || execution.command.lease_epoch != cancel.lease_epoch)
    {
        return Err(DeviceRuntimeError::new(
            "device_runtime_cancel_identity_mismatch",
        ));
    }
    let read = state
        .journal
        .get_filesystem_read(&cancel.execution_id)
        .await
        .map_err(|error| {
            DeviceRuntimeError::with_source("device_runtime_journal_invalid", error)
        })?;
    if let Some(execution) = read
        && (execution.command.command.device_id != cancel.device_id
            || execution.command.command.lease_id != cancel.lease_id
            || execution.command.command.lease_epoch != cancel.lease_epoch)
    {
        return Err(DeviceRuntimeError::new(
            "device_runtime_cancel_identity_mismatch",
        ));
    }
    Ok(CancelDisposition::IgnoredInactive)
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod tests;
