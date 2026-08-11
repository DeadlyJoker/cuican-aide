use std::time::Duration;
use std::time::Instant;

use pretty_assertions::assert_eq;
use tauri_plugin_shell::process::CommandEvent;

use super::spawn_guardian_managed_for_test;
use super::spawn_managed;
use super::terminate_managed_children;
use super::wait_for_ready;
use super::ManagedChildProtocol;

#[cfg(unix)]
#[test]
fn managed_child_keeps_exact_reusable_kill_and_wait_ownership() {
    let mut command = std::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg("read line; printf 'ready:%s\\n' \"$line\"; exec /bin/cat");
    let (events, mut child) = spawn_managed(command, "managed-child-test").unwrap();
    child.write(b"bound\n").unwrap();
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        CommandEvent::Stdout(line) if line == b"ready:bound"
    ));
    assert_eq!(child.wait_timeout(Duration::ZERO).unwrap(), None);
    assert!(child.kill().is_ok());
    assert!(child
        .wait_timeout(Duration::from_secs(1))
        .unwrap()
        .is_some());
    assert!(child.kill().is_ok());
}

#[cfg(unix)]
#[test]
fn bounded_group_termination_waits_for_every_exact_child() {
    let children = (0..2)
        .map(|index| {
            let mut command = std::process::Command::new("/bin/sh");
            command.arg("-c").arg("exec /bin/cat");
            spawn_managed(
                command,
                if index == 0 {
                    "managed-group-first"
                } else {
                    "managed-group-second"
                },
            )
            .unwrap()
            .1
        })
        .collect::<Vec<_>>();
    assert!(terminate_managed_children(
        &children,
        Duration::from_secs(1)
    ));
    assert!(children
        .iter()
        .all(|child| child.wait_timeout(Duration::ZERO).unwrap().is_some()));
}

#[cfg(unix)]
#[test]
fn trailing_output_is_always_delivered_before_terminal() {
    let mut command = std::process::Command::new("/bin/sh");
    command.arg("-c").arg("printf trailing-output");
    let (events, child) = spawn_managed(command, "managed-trailing-output").unwrap();
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        CommandEvent::Stdout(line) if line == b"trailing-output"
    ));
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        CommandEvent::Terminated(_)
    ));
    assert!(child.wait_timeout(Duration::ZERO).unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn managed_output_preserves_tauri_cr_lf_line_semantics() {
    let mut command = std::process::Command::new("/bin/sh");
    command.arg("-c").arg("printf 'cr\rlf\ncrlf\r\ntail'");
    let (events, child) = spawn_managed(command, "managed-line-semantics").unwrap();
    let mut stdout = Vec::new();
    loop {
        match events.recv_timeout(Duration::from_secs(1)).unwrap() {
            CommandEvent::Stdout(line) => stdout.push(line),
            CommandEvent::Terminated(_) => break,
            CommandEvent::Error(error) => panic!("unexpected process error: {error}"),
            CommandEvent::Stderr(_) => {}
            #[allow(unreachable_patterns)]
            _ => {}
        }
    }
    assert_eq!(
        stdout,
        vec![
            b"cr".to_vec(),
            b"lf".to_vec(),
            b"crlf".to_vec(),
            b"tail".to_vec(),
        ]
    );
    assert!(child.wait_timeout(Duration::ZERO).unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn guardian_frames_bootstrap_and_input_before_preserving_target_output() {
    let root = tempfile::tempdir().unwrap();
    let mut target = std::process::Command::new("/bin/sh");
    target
        .arg("-c")
        .arg(
            "IFS= read -r bootstrap; printf 'bootstrap:%s\n' \"$bootstrap\"; \
             IFS= read -r input; printf 'ready:%s\n' \"$input\"; printf trailing",
        )
        .env_clear()
        .current_dir(root.path());
    let (events, mut child) = spawn_guardian_managed_for_test(
        guardian_sidecar().as_os_str(),
        target,
        b"bootstrap\n",
        "guardian-frame-test",
    )
    .unwrap();
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        CommandEvent::Stdout(line) if line == b"bootstrap:bootstrap"
    ));
    child.write(b"activate\n").unwrap();

    let ready = events.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(
        matches!(
        ready,
        CommandEvent::Stdout(ref line) if line == b"ready:activate"
        ),
        "unexpected guardian target readiness: {ready:?}"
    );
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        CommandEvent::Stdout(line) if line == b"trailing"
    ));
    let terminal = events.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(
        matches!(
        terminal,
        CommandEvent::Terminated(ref payload) if payload.code == Some(0)
        ),
        "unexpected guardian terminal event: {terminal:?}"
    );
    assert!(child.wait_timeout(Duration::ZERO).unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn guardian_shutdown_cleans_stubborn_target_and_grandchild() {
    let (events, child, pids) = spawn_guarded_tree("guardian-shutdown-tree");
    assert!(child.kill().is_ok());
    let terminal = events.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(
        matches!(
        terminal,
        CommandEvent::Terminated(ref payload) if payload.code == Some(0)
        ),
        "unexpected guardian shutdown event: {terminal:?}"
    );
    assert_processes_gone(pids);
    assert!(child.kill().is_ok());
}

#[cfg(target_os = "macos")]
#[test]
fn guardian_sigkill_still_cleans_the_contained_target_tree() {
    let (events, child, pids) = spawn_guarded_tree("guardian-sigkill-tree");
    assert_eq!(unsafe { libc::kill(child.pid() as i32, libc::SIGKILL) }, 0);
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(5)).unwrap(),
        CommandEvent::Terminated(payload) if payload.signal == Some(libc::SIGKILL)
    ));
    assert!(child
        .wait_timeout(Duration::from_secs(1))
        .unwrap()
        .is_some());
    assert!(!child.cleanup_is_proven());
    assert_processes_gone(pids);
}

#[cfg(unix)]
#[test]
fn nonzero_target_exit_is_cleanup_proof_without_becoming_business_success() {
    let root = tempfile::tempdir().unwrap();
    let mut target = std::process::Command::new("/bin/sh");
    target
        .arg("-c")
        .arg("exit 7")
        .env_clear()
        .current_dir(root.path());
    let (events, child) = spawn_guardian_managed_for_test(
        guardian_sidecar().as_os_str(),
        target,
        &[],
        "guardian-nonzero-target",
    )
    .unwrap();
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        CommandEvent::Terminated(payload) if payload.code == Some(10)
    ));
    assert!(child.cleanup_is_proven());

    let mut second = std::process::Command::new("/bin/sh");
    second
        .arg("-c")
        .arg("exit 9")
        .env_clear()
        .current_dir(root.path());
    let (events, second) = spawn_guardian_managed_for_test(
        guardian_sidecar().as_os_str(),
        second,
        &[],
        "guardian-nonzero-business-result",
    )
    .unwrap();
    assert!(super::wait_for_successful_exit(&events, Duration::from_secs(1)).is_err());
    assert!(second.cleanup_is_proven());
}

#[cfg(unix)]
#[test]
fn malformed_guardian_bootstrap_never_reaches_target_readiness() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("target-spawned");
    let mut guardian = std::process::Command::new(guardian_sidecar());
    guardian
        .arg("--")
        .arg("/bin/sh")
        .arg("-c")
        .arg(format!("touch '{}'", marker.display()))
        .env_clear()
        .current_dir(root.path());
    let (events, child) = super::spawn_managed_with_protocol(
        guardian,
        "guardian-malformed-test",
        ManagedChildProtocol::Guardian,
    )
    .unwrap();
    child.write_encoded(b"BAD!\0\0\0\0\0\0\0\0").unwrap();

    assert!(wait_for_ready(&events, b"impossible-ready", Duration::from_secs(1)).is_err());
    assert!(!marker.exists());
    assert!(child
        .wait_timeout(Duration::from_secs(1))
        .unwrap()
        .is_some());
    assert!(child.cleanup_is_proven());
}

#[cfg(target_os = "macos")]
#[test]
fn unproven_active_guardian_crash_enters_fail_closed_quarantine() {
    let root = tempfile::tempdir().unwrap();
    let control = running_guardian(root.path(), "active-crash-control");
    let worker = running_guardian(root.path(), "active-crash-worker");
    let control_pid = control.pid();
    let supervisor = crate::control_runtime::ControlRuntimeSupervisor::started(
        crate::control_runtime::SessionMaterial::generate().unwrap(),
        control,
        worker,
        None,
        None,
    );
    assert_eq!(unsafe { libc::kill(control_pid as i32, libc::SIGKILL) }, 0);
    supervisor.process_terminated(super::ProcessRole::ControlApi(1), false);

    assert!(!supervisor.lifecycle.lock().unwrap().available);
    let quarantine = supervisor.failed_process_quarantine.lock().unwrap();
    assert!(quarantine.disables_runtime);
    assert_eq!(quarantine.processes.len(), 2);
}

#[cfg(unix)]
fn spawn_guarded_tree(
    thread_name: &'static str,
) -> (super::ProcessEvents, super::ManagedChild, (i32, i32)) {
    let mut target = std::process::Command::new("/bin/sh");
    target
        .arg("-c")
        .arg(
            "trap '' TERM; \
             /bin/sh -c 'trap \"\" TERM; while :; do sleep 1; done' & \
             printf 'pids:%s:%s\n' \"$$\" \"$!\"; wait",
        )
        .env_clear()
        .current_dir("/");
    let (events, child) =
        spawn_guardian_managed_for_test(guardian_sidecar().as_os_str(), target, &[], thread_name)
            .unwrap();
    let line = match events.recv_timeout(Duration::from_secs(1)).unwrap() {
        CommandEvent::Stdout(line) => line,
        event => panic!("expected pid readiness, got {event:?}"),
    };
    let pids = std::str::from_utf8(&line)
        .unwrap()
        .strip_prefix("pids:")
        .unwrap()
        .split(':')
        .map(|value| value.parse::<i32>().unwrap())
        .collect::<Vec<_>>();
    let [target_pid, grandchild_pid] = pids.as_slice() else {
        panic!("expected two process identifiers")
    };
    (events, child, (*target_pid, *grandchild_pid))
}

#[cfg(unix)]
fn running_guardian(
    current_dir: &std::path::Path,
    thread_name: &'static str,
) -> super::ManagedChild {
    let mut target = std::process::Command::new("/bin/sh");
    target
        .arg("-c")
        .arg("exec /bin/cat")
        .env_clear()
        .current_dir(current_dir);
    spawn_guardian_managed_for_test(guardian_sidecar().as_os_str(), target, &[], thread_name)
        .unwrap()
        .1
}

#[cfg(unix)]
fn guardian_sidecar() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!(
            "crewon-process-guardian-{}",
            env!("TAURI_ENV_TARGET_TRIPLE")
        ))
}

#[cfg(unix)]
fn assert_processes_gone(pids: (i32, i32)) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while [pids.0, pids.1].into_iter().any(process_exists) {
        assert!(Instant::now() < deadline, "contained process tree survived");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn process_exists(pid: i32) -> bool {
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}
