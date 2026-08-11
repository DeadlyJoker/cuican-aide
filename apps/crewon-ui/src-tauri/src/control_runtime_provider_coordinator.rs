use serde::Deserialize;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;

use super::environment::coordinator_environment;
use super::process::spawn_node_with_input;
use super::process::wait_for_bounded_json_exit;
use super::ControlRuntimeStartError;
use super::RuntimePaths;
use super::READY_TIMEOUT;
use crate::provider_credentials::ProviderCredentialKind;

const MAX_COORDINATOR_INPUT_BYTES: usize = 64 * 1024;
const MAX_COORDINATOR_RESULT_BYTES: usize = 8 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProviderAuthorityBinding {
    pub(super) provider_id: String,
    pub(super) display_name: String,
    pub(super) endpoint: String,
    pub(super) credential_kind: ProviderCredentialKind,
    pub(super) environment_variable: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "phase")]
enum ProviderCoordinatorCommand<'a> {
    Inspect,
    Prepare {
        operation_id: &'a str,
        runtime_binding_id: Option<&'a str>,
        expected_revision: u64,
        active_provider_id: Option<&'a str>,
        bindings: &'a [ProviderAuthorityBinding],
        ttl_ms: u64,
    },
    Finalize {
        operation_id: &'a str,
        runtime_binding_id: &'a str,
    },
    Abort {
        operation_id: &'a str,
        runtime_binding_id: &'a str,
    },
    Recover {
        operation_id: &'a str,
        runtime_binding_id: &'a str,
        recovery_binding: &'a str,
    },
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProviderAuthorityCatalog {
    pub(super) revision: u64,
    pub(super) active_provider_id: Option<String>,
    pub(super) runtime_binding_id: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PendingProviderAuthority {
    pub(super) operation_id: String,
    pub(super) base_revision: u64,
    pub(super) runtime_binding_id: Option<String>,
    pub(super) expires_at: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProviderCoordinatorResult {
    pub(super) phase: String,
    pub(super) disposition: Option<String>,
    pub(super) catalog: Option<ProviderAuthorityCatalog>,
    pub(super) pending: Option<PendingProviderAuthority>,
}

pub(super) fn inspect(
    app: &AppHandle,
    paths: &RuntimePaths,
) -> Result<ProviderCoordinatorResult, ControlRuntimeStartError> {
    run(app, paths, &ProviderCoordinatorCommand::Inspect)
}

pub(super) fn prepare(
    app: &AppHandle,
    paths: &RuntimePaths,
    input: PrepareProviderAuthority<'_>,
) -> Result<ProviderCoordinatorResult, ControlRuntimeStartError> {
    run(
        app,
        paths,
        &ProviderCoordinatorCommand::Prepare {
            operation_id: input.operation_id,
            runtime_binding_id: input.runtime_binding_id,
            expected_revision: input.expected_revision,
            active_provider_id: input.active_provider_id,
            bindings: input.bindings,
            ttl_ms: input.ttl_ms,
        },
    )
}

pub(super) struct PrepareProviderAuthority<'a> {
    pub(super) operation_id: &'a str,
    pub(super) runtime_binding_id: Option<&'a str>,
    pub(super) expected_revision: u64,
    pub(super) active_provider_id: Option<&'a str>,
    pub(super) bindings: &'a [ProviderAuthorityBinding],
    pub(super) ttl_ms: u64,
}

pub(super) fn finalize(
    app: &AppHandle,
    paths: &RuntimePaths,
    operation_id: &str,
    runtime_binding_id: &str,
) -> Result<ProviderCoordinatorResult, ControlRuntimeStartError> {
    run(
        app,
        paths,
        &ProviderCoordinatorCommand::Finalize {
            operation_id,
            runtime_binding_id,
        },
    )
}

pub(super) fn abort(
    app: &AppHandle,
    paths: &RuntimePaths,
    operation_id: &str,
    runtime_binding_id: &str,
) -> Result<ProviderCoordinatorResult, ControlRuntimeStartError> {
    run(
        app,
        paths,
        &ProviderCoordinatorCommand::Abort {
            operation_id,
            runtime_binding_id,
        },
    )
}

pub(super) fn recover(
    app: &AppHandle,
    paths: &RuntimePaths,
    operation_id: &str,
    runtime_binding_id: &str,
    recovery_binding: &str,
) -> Result<ProviderCoordinatorResult, ControlRuntimeStartError> {
    run(
        app,
        paths,
        &ProviderCoordinatorCommand::Recover {
            operation_id,
            runtime_binding_id,
            recovery_binding,
        },
    )
}

fn run(
    app: &AppHandle,
    paths: &RuntimePaths,
    command: &ProviderCoordinatorCommand<'_>,
) -> Result<ProviderCoordinatorResult, ControlRuntimeStartError> {
    let encoded = serde_json::to_vec(command)
        .map_err(|_| ControlRuntimeStartError::ProviderCoordinatorFailed)?;
    if encoded.len() > MAX_COORDINATOR_INPUT_BYTES {
        return Err(ControlRuntimeStartError::ProviderCoordinatorFailed);
    }
    let supervisor = app.try_state::<super::ControlRuntimeSupervisor>();
    let (events, child) = spawn_node_with_input(
        app,
        supervisor.as_deref(),
        &paths.provider_coordinator_bundle,
        &paths.root,
        coordinator_environment(paths),
        "crewon-provider-coordinator-events",
        &encoded,
    )?;
    let output =
        match wait_for_bounded_json_exit(&events, READY_TIMEOUT, MAX_COORDINATOR_RESULT_BYTES) {
            Ok(output) => output,
            Err(()) => {
                if let Some(supervisor) = app.try_state::<super::ControlRuntimeSupervisor>() {
                    supervisor.quarantine_candidate_processes(vec![child]);
                } else {
                    super::process::terminate_startup_children(vec![child]);
                }
                return Err(ControlRuntimeStartError::ProviderCoordinatorFailed);
            }
        };
    serde_json::from_slice(&output).map_err(|_| ControlRuntimeStartError::ProviderCoordinatorFailed)
}
