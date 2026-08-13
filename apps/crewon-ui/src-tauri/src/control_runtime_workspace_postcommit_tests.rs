use std::time::Duration;

use pretty_assertions::assert_eq;

use super::prepare_repair_generation;
use crate::control_runtime::process::spawn_managed;
use crate::control_runtime::process::ProcessRole;
use crate::control_runtime::reload::RuntimeGeneration;
use crate::control_runtime::ControlRuntimeSupervisor;

#[test]
fn old_monitor_before_replacement_install_cannot_poison_repair() {
    let supervisor = ControlRuntimeSupervisor::unavailable();
    let failed = RuntimeGeneration {
        control: 0,
        worker: 0,
    };

    let repair = prepare_repair_generation(&supervisor, failed).unwrap();
    supervisor.process_monitor_failed(ProcessRole::ControlApi(failed.control));
    supervisor.process_terminated(ProcessRole::Worker(failed.worker), true);

    let lifecycle = supervisor.lifecycle.lock().unwrap();
    assert_eq!(
        (
            RuntimeGeneration {
                control: lifecycle.control_generation,
                worker: lifecycle.worker_generation,
            },
            lifecycle.available,
            lifecycle.candidate_failures.clone(),
        ),
        (repair, false, Vec::new())
    );
}

#[cfg(unix)]
#[test]
fn old_monitor_after_replacement_publish_cannot_shutdown_repair() {
    let supervisor = ControlRuntimeSupervisor::unavailable();
    let failed = RuntimeGeneration {
        control: 0,
        worker: 0,
    };
    let repair = prepare_repair_generation(&supervisor, failed).unwrap();
    {
        let mut lifecycle = supervisor.lifecycle.lock().unwrap();
        lifecycle.control_api = Some(running_child("repair-control"));
        lifecycle.worker = Some(running_child("repair-worker"));
        lifecycle.available = true;
    }

    supervisor.process_monitor_failed(ProcessRole::ControlApi(failed.control));
    supervisor.process_terminated(ProcessRole::Worker(failed.worker), true);

    let lifecycle = supervisor.lifecycle.lock().unwrap();
    assert_eq!(
        (
            RuntimeGeneration {
                control: lifecycle.control_generation,
                worker: lifecycle.worker_generation,
            },
            lifecycle.available,
            lifecycle.candidate_failures.clone(),
            lifecycle.control_api.is_some(),
            lifecycle.worker.is_some(),
        ),
        (repair, true, Vec::new(), true, true)
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
