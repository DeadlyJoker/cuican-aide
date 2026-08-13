use std::time::Duration;

use pretty_assertions::assert_eq;

use super::commit_workspace_install;
use crate::control_runtime::process::spawn_managed;
use crate::control_runtime::process::ProcessRole;
use crate::control_runtime::reload::RuntimeGeneration;
use crate::control_runtime::workspace_fence::WorkspaceSwitchFence;
use crate::control_runtime::ControlRuntimeSupervisor;
use crate::control_runtime::SessionMaterial;
use crate::workspace_native::DesktopWorkspaceAuthorityManager;

#[cfg(unix)]
#[test]
fn monitor_error_while_candidate_process_is_running_blocks_publication() {
    let root = tempfile::tempdir().unwrap();
    let database_path = root.path().join("control.sqlite");
    let database = rusqlite::Connection::open(&database_path).unwrap();
    database
        .execute_batch(
            "PRAGMA user_version = 22;
             CREATE TABLE run_snapshots (
               tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, run_id TEXT PRIMARY KEY,
               revision INTEGER NOT NULL, last_sequence INTEGER NOT NULL,
               state_json TEXT NOT NULL, updated_at TEXT NOT NULL,
               UNIQUE (tenant_id, run_id)
             );
             CREATE TABLE work_items (
               work_item_order INTEGER PRIMARY KEY AUTOINCREMENT,
               work_item_id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, run_id TEXT NOT NULL,
               kind TEXT NOT NULL, work_item_json TEXT NOT NULL, created_at TEXT NOT NULL,
               status TEXT, available_at_ms INTEGER NOT NULL, lease_owner_id TEXT, lease_id TEXT,
               lease_epoch INTEGER NOT NULL, lease_expires_at_ms INTEGER,
               attempt_count INTEGER NOT NULL, completed_at_ms INTEGER, last_error_code TEXT,
               FOREIGN KEY (tenant_id, run_id) REFERENCES run_snapshots(tenant_id, run_id)
             );
             CREATE INDEX work_items_claim_idx
               ON work_items(status, available_at_ms, lease_expires_at_ms, work_item_order);",
        )
        .unwrap();
    drop(database);
    let authority = DesktopWorkspaceAuthorityManager::open(root.path().join("authority"))
        .unwrap()
        .authority()
        .clone();
    let control = running_child("candidate-control");
    let worker = running_child("candidate-worker");
    let supervisor = ControlRuntimeSupervisor::started(
        SessionMaterial::generate().unwrap(),
        control,
        worker,
        None,
        None,
    );
    {
        let mut lifecycle = supervisor.lifecycle.lock().unwrap();
        lifecycle.available = false;
    }
    supervisor.process_monitor_failed(ProcessRole::ControlApi(1));
    let fence = WorkspaceSwitchFence::begin(&database_path).unwrap();
    assert!(commit_workspace_install(
        &supervisor,
        RuntimeGeneration {
            control: 1,
            worker: 1,
        },
        &authority,
        fence,
    )
    .is_err());
    let lifecycle = supervisor.lifecycle.lock().unwrap();
    assert_eq!(lifecycle.available, false);
    assert_eq!(
        lifecycle.candidate_failures,
        vec![ProcessRole::ControlApi(1)]
    );
    drop(lifecycle);
    supervisor.shutdown();
}

#[cfg(unix)]
fn running_child(name: &'static str) -> crate::control_runtime::process::ManagedChild {
    let mut command = std::process::Command::new("/bin/sh");
    command.arg("-c").arg("exec /bin/cat");
    let (_, child) = spawn_managed(command, name).unwrap();
    assert!(child.is_running());
    assert_eq!(child.wait_timeout(Duration::ZERO).unwrap(), None);
    child
}
