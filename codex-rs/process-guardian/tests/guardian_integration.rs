use std::io::Write;
use std::process::Child;
use std::process::ChildStdin;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

#[cfg(unix)]
use crewon_process_guardian::GUARDIAN_EXIT_CLEAN_RUNTIME_FAILURE;
use crewon_process_guardian::GUARDIAN_EXIT_CLEAN_SUCCESS;
#[cfg(unix)]
use crewon_process_guardian::GUARDIAN_EXIT_CLEAN_TARGET_FAILURE;

#[cfg(unix)]
const MAX_FRAME_BYTES: usize = 64 * 1024;
const TEST_TIMEOUT: Duration = Duration::from_secs(5);

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(12 + payload.len());
    encoded.extend_from_slice(b"CRWG");
    encoded.push(0);
    encoded.push(kind);
    encoded.extend_from_slice(&[0, 0]);
    encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    encoded.extend_from_slice(payload);
    encoded
}

fn spawn_guardian(program: &str, arguments: &[&str]) -> (Child, ChildStdin) {
    let mut command = Command::new(
        crewon_utils_cargo_bin::cargo_bin("crewon-process-guardian").expect("guardian binary"),
    );
    command
        .arg("--")
        .arg(program)
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().expect("spawn guardian");
    let stdin = child.stdin.take().expect("guardian stdin");
    (child, stdin)
}

fn wait_child(child: &mut Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + TEST_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().expect("poll child") {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "child did not exit before deadline"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
mod unix {
    use std::fs;
    use std::os::fd::AsRawFd;
    use std::os::fd::FromRawFd;
    use std::os::fd::OwnedFd;
    use std::os::unix::process::ExitStatusExt;
    use std::path::Path;

    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    use super::*;

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
    }

    fn wait_for_pids(path: &Path) -> (i32, i32) {
        let deadline = Instant::now() + TEST_TIMEOUT;
        loop {
            if let Ok(contents) = fs::read_to_string(path) {
                let pids = contents
                    .split_ascii_whitespace()
                    .map(|value| value.parse::<i32>().expect("pid"))
                    .collect::<Vec<_>>();
                if let [target, grandchild] = pids.as_slice() {
                    return (*target, *grandchild);
                }
            }
            assert!(
                Instant::now() < deadline,
                "pid file not written before deadline"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn process_exists(pid: i32) -> bool {
        if unsafe { libc::kill(pid, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    fn assert_processes_gone(pids: &[i32]) {
        let deadline = Instant::now() + TEST_TIMEOUT;
        loop {
            if pids.iter().all(|pid| !process_exists(*pid)) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "contained processes remained alive: {pids:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn shutdown_kills_target_and_stubborn_grandchild() {
        let temp = TempDir::new().unwrap();
        let pids_path = temp.path().join("pids");
        let script = format!(
            "trap '' TERM; /bin/sh -c 'trap \"\" TERM; while :; do sleep 1; done' & \
             printf '%s %s' \"$$\" \"$!\" > {}; wait",
            shell_quote(&pids_path)
        );
        let (mut guardian, mut stdin) = spawn_guardian("/bin/sh", &["-c", &script]);
        stdin.write_all(&frame(1, b"")).unwrap();
        let pids = wait_for_pids(&pids_path);
        stdin.write_all(&frame(3, b"")).unwrap();
        drop(stdin);
        assert_eq!(
            wait_child(&mut guardian).code(),
            Some(GUARDIAN_EXIT_CLEAN_SUCCESS)
        );
        assert_processes_gone(&[pids.0, pids.1]);
    }

    #[test]
    fn guardian_sigkill_still_kills_target_tree() {
        let temp = TempDir::new().unwrap();
        let pids_path = temp.path().join("pids");
        let script = format!(
            "sleep 30 & printf '%s %s' \"$$\" \"$!\" > {}; wait",
            shell_quote(&pids_path)
        );
        let (mut guardian, mut stdin) = spawn_guardian("/bin/sh", &["-c", &script]);
        stdin.write_all(&frame(1, b"")).unwrap();
        let pids = wait_for_pids(&pids_path);
        assert_eq!(
            unsafe { libc::kill(guardian.id() as i32, libc::SIGKILL) },
            0
        );
        drop(stdin);
        let status = wait_child(&mut guardian);
        assert_eq!(status.code(), None);
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        assert_processes_gone(&[pids.0, pids.1]);
    }

    #[test]
    fn target_nonzero_is_normalized_after_proven_cleanup() {
        let (mut guardian, mut stdin) = spawn_guardian("/bin/sh", &["-c", "exit 7"]);
        stdin.write_all(&frame(1, b"")).unwrap();
        assert_eq!(
            wait_child(&mut guardian).code(),
            Some(GUARDIAN_EXIT_CLEAN_TARGET_FAILURE)
        );
        drop(stdin);
    }

    #[test]
    fn target_natural_exit_cleans_lingering_grandchild() {
        let temp = TempDir::new().unwrap();
        let pids_path = temp.path().join("pids");
        let script = format!(
            "sleep 30 & printf '%s %s' \"$$\" \"$!\" > {}; exit 0",
            shell_quote(&pids_path)
        );
        let (mut guardian, mut stdin) = spawn_guardian("/bin/sh", &["-c", &script]);
        stdin.write_all(&frame(1, b"")).unwrap();
        let pids = wait_for_pids(&pids_path);
        assert_eq!(
            wait_child(&mut guardian).code(),
            Some(GUARDIAN_EXIT_CLEAN_SUCCESS)
        );
        drop(stdin);
        assert_processes_gone(&[pids.0, pids.1]);
    }

    #[test]
    fn post_spawn_protocol_error_proves_tree_cleanup() {
        let temp = TempDir::new().unwrap();
        let pids_path = temp.path().join("pids");
        let script = format!(
            "sleep 30 & printf '%s %s' \"$$\" \"$!\" > {}; wait",
            shell_quote(&pids_path)
        );
        let (mut guardian, mut stdin) = spawn_guardian("/bin/sh", &["-c", &script]);
        stdin.write_all(&frame(1, b"")).unwrap();
        let pids = wait_for_pids(&pids_path);
        stdin.write_all(&frame(1, b"duplicate-bootstrap")).unwrap();
        drop(stdin);
        assert_eq!(
            wait_child(&mut guardian).code(),
            Some(GUARDIAN_EXIT_CLEAN_RUNTIME_FAILURE)
        );
        assert_processes_gone(&[pids.0, pids.1]);
    }

    #[test]
    fn malformed_and_oversized_bootstrap_never_spawn_target() {
        for bytes in [b"not-a-frame".to_vec(), {
            let mut bytes = frame(1, b"");
            bytes[8..12].copy_from_slice(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes());
            bytes
        }] {
            let temp = TempDir::new().unwrap();
            let marker = temp.path().join("spawned");
            let script = format!("touch {}", shell_quote(&marker));
            let (mut guardian, mut stdin) = spawn_guardian("/bin/sh", &["-c", &script]);
            stdin.write_all(&bytes).unwrap();
            drop(stdin);
            assert_eq!(
                wait_child(&mut guardian).code(),
                Some(GUARDIAN_EXIT_CLEAN_RUNTIME_FAILURE)
            );
            assert!(!marker.exists());
        }
    }

    #[test]
    fn target_spawn_failure_is_proven_without_running_a_target() {
        let (mut guardian, mut stdin) = spawn_guardian(
            "/__crewon_guardian_target_must_not_exist__",
            &["never-spawn"],
        );
        stdin.write_all(&frame(1, b"")).unwrap();
        assert_eq!(
            wait_child(&mut guardian).code(),
            Some(GUARDIAN_EXIT_CLEAN_RUNTIME_FAILURE)
        );
        drop(stdin);
    }

    #[test]
    fn target_cannot_observe_inherited_owner_descriptors() {
        let mut descriptors = [-1_i32; 2];
        assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
        // SAFETY: `pipe` returned two new, independently owned descriptors.
        let inherited_read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
        // SAFETY: ownership of the write end is independent from the read end.
        let inherited_write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
        let script = format!(
            "if test -e /dev/fd/{}; then exit 42; else exit 0; fi",
            inherited_read.as_raw_fd()
        );
        let (mut guardian, mut stdin) = spawn_guardian("/bin/sh", &["-c", &script]);
        stdin.write_all(&frame(1, b"")).unwrap();
        assert_eq!(
            wait_child(&mut guardian).code(),
            Some(GUARDIAN_EXIT_CLEAN_SUCCESS)
        );
        drop(stdin);
        drop(inherited_read);
        drop(inherited_write);
    }

    #[test]
    fn blocked_target_input_does_not_hide_parent_eof() {
        let temp = TempDir::new().unwrap();
        let pids_path = temp.path().join("pids");
        let script = format!(
            "sleep 30 & printf '%s %s' \"$$\" \"$!\" > {}; wait",
            shell_quote(&pids_path)
        );
        let (mut guardian, mut stdin) = spawn_guardian("/bin/sh", &["-c", &script]);
        stdin
            .write_all(&frame(1, &vec![b's'; MAX_FRAME_BYTES]))
            .unwrap();
        let pids = wait_for_pids(&pids_path);
        drop(stdin);
        assert_eq!(
            wait_child(&mut guardian).code(),
            Some(GUARDIAN_EXIT_CLEAN_SUCCESS)
        );
        assert_processes_gone(&[pids.0, pids.1]);
    }

    #[test]
    fn forwards_bootstrap_input_without_exposing_it_in_guardian_output() {
        let temp = TempDir::new().unwrap();
        let output = temp.path().join("input");
        let script = format!(
            "IFS= read -r line; printf '%s' \"$line\" > {}",
            shell_quote(&output)
        );
        let (mut guardian, mut stdin) = spawn_guardian("/bin/sh", &["-c", &script]);
        stdin.write_all(&frame(1, b"private-value\n")).unwrap();
        assert_eq!(
            wait_child(&mut guardian).code(),
            Some(GUARDIAN_EXIT_CLEAN_SUCCESS)
        );
        drop(stdin);
        assert_eq!(fs::read_to_string(output).unwrap(), "private-value");
    }
}

#[cfg(windows)]
#[test]
fn windows_job_accepts_shutdown_and_waits_for_target() {
    let (mut guardian, mut stdin) =
        spawn_guardian("cmd.exe", &["/D", "/S", "/C", "ping -n 30 127.0.0.1 >NUL"]);
    stdin.write_all(&frame(1, b"")).unwrap();
    stdin.write_all(&frame(3, b"")).unwrap();
    drop(stdin);
    assert_eq!(
        wait_child(&mut guardian).code(),
        Some(GUARDIAN_EXIT_CLEAN_SUCCESS)
    );
}
