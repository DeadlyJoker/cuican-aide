use std::io::ErrorKind;
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
use std::os::fd::OwnedFd;
use std::os::unix::process::CommandExt;
use std::process::Child;
use std::process::ChildStdin;
use std::process::Command;
use std::process::ExitStatus;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use crate::GuardianError;
use crate::GuardianFailure;
use crate::TargetSpec;

const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

pub(crate) struct ContainedChild {
    target: Child,
    watchdog: Child,
    process_group: i32,
    watchdog_liveness: Option<OwnedFd>,
}

impl ContainedChild {
    pub(crate) fn spawn(target: &TargetSpec) -> Result<Self, GuardianFailure> {
        mark_inherited_descriptors_cloexec().map_err(GuardianFailure::cleanup_proven)?;
        let (watchdog_read, watchdog_write) =
            cloexec_pipe().map_err(GuardianFailure::cleanup_proven)?;
        let watchdog = spawn_watchdog(watchdog_read).map_err(GuardianFailure::cleanup_proven)?;
        let process_group = match i32::try_from(watchdog.id()) {
            Ok(process_group) => process_group,
            Err(_) => {
                return Err(cleanup_watchdog_after_failed_spawn(
                    watchdog,
                    watchdog_write,
                    GuardianError::ContainmentFailed,
                ));
            }
        };

        let mut target_command = Command::new(&target.program);
        target_command
            .args(&target.arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .process_group(process_group);
        let target = match target_command.spawn() {
            Ok(target) => target,
            Err(_) => {
                return Err(cleanup_watchdog_after_failed_spawn(
                    watchdog,
                    watchdog_write,
                    GuardianError::TargetSpawnFailed,
                ));
            }
        };

        Ok(Self {
            target,
            watchdog,
            process_group,
            watchdog_liveness: Some(watchdog_write),
        })
    }

    pub(crate) fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.target.stdin.take()
    }

    pub(crate) fn try_wait(&mut self) -> Result<Option<ExitStatus>, GuardianError> {
        self.target
            .try_wait()
            .map_err(|_| GuardianError::WaitFailed)
    }

    pub(crate) fn terminate(
        &mut self,
        graceful_timeout: Duration,
    ) -> Result<ExitStatus, GuardianError> {
        signal_group(self.process_group, libc::SIGTERM)?;
        let deadline = Instant::now() + graceful_timeout;
        while Instant::now() < deadline {
            if self.try_wait()?.is_some() {
                break;
            }
            std::thread::sleep(
                WAIT_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
            );
        }

        // The watchdog ignores SIGTERM and remains a group member even if the target leader has
        // exited. This single final SIGKILL therefore cannot hit a recycled process-group ID.
        signal_group(self.process_group, libc::SIGKILL)?;
        self.watchdog_liveness.take();
        let status = wait_child(&mut self.target)?;
        let _watchdog_status = wait_child(&mut self.watchdog)?;
        Ok(status)
    }
}

pub(crate) fn run_watchdog(read_fd: i32) -> Result<i32, GuardianError> {
    let process_group = unsafe { libc::getpgrp() };
    if process_group <= 0 || unsafe { libc::getpid() } != process_group {
        return Err(GuardianError::WatchdogInvalid);
    }
    // SAFETY: the guardian passes sole ownership of this inherited descriptor to watchdog mode.
    let read_end = unsafe { OwnedFd::from_raw_fd(read_fd) };
    ignore_signal(libc::SIGTERM)?;
    let mut byte = [0_u8; 1];
    loop {
        let read = unsafe { libc::read(read_end.as_raw_fd(), byte.as_mut_ptr().cast(), 1) };
        if read == 0 {
            break;
        }
        if read < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == ErrorKind::Interrupted {
                continue;
            }
            break;
        }
    }
    signal_group(process_group, libc::SIGKILL)?;
    Err(GuardianError::ContainmentFailed)
}

fn spawn_watchdog(read_end: OwnedFd) -> Result<Child, GuardianError> {
    set_cloexec(read_end.as_raw_fd(), false)?;
    let executable = std::env::current_exe().map_err(|_| GuardianError::ContainmentFailed)?;
    let mut command = Command::new(executable);
    command
        .arg("--watchdog")
        .arg(read_end.as_raw_fd().to_string())
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    // SAFETY: `signal` is async-signal-safe. Ignoring SIGTERM before exec ensures the watchdog
    // remains the process-group anchor during graceful target shutdown.
    unsafe {
        command.pre_exec(|| {
            if libc::signal(libc::SIGTERM, libc::SIG_IGN) == libc::SIG_ERR {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command
        .spawn()
        .map_err(|_| GuardianError::ContainmentFailed)?;
    drop(read_end);
    Ok(child)
}

fn cleanup_watchdog_after_failed_spawn(
    mut watchdog: Child,
    watchdog_liveness: OwnedFd,
    error: GuardianError,
) -> GuardianFailure {
    drop(watchdog_liveness);
    match wait_child(&mut watchdog) {
        Ok(_) => GuardianFailure::cleanup_proven(error),
        Err(cleanup_error) => GuardianFailure::cleanup_unproven(cleanup_error),
    }
}

fn cloexec_pipe() -> Result<(OwnedFd, OwnedFd), GuardianError> {
    let mut descriptors = [-1_i32; 2];
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err(GuardianError::ContainmentFailed);
    }
    // SAFETY: a successful `pipe` call returned two newly owned descriptors.
    let read_end = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    // SAFETY: ownership of the second descriptor is independent from the first.
    let write_end = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    set_cloexec(read_end.as_raw_fd(), true)?;
    set_cloexec(write_end.as_raw_fd(), true)?;
    Ok((read_end, write_end))
}

fn mark_inherited_descriptors_cloexec() -> Result<(), GuardianError> {
    let entries = ["/proc/self/fd", "/dev/fd"]
        .into_iter()
        .find_map(|path| std::fs::read_dir(path).ok())
        .ok_or(GuardianError::ContainmentFailed)?;
    let mut descriptors = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| GuardianError::ContainmentFailed)?;
        let descriptor = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<i32>().ok())
            .ok_or(GuardianError::ContainmentFailed)?;
        if descriptor >= 3 {
            descriptors.push(descriptor);
        }
    }
    for descriptor in descriptors {
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        if flags < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EBADF) {
                continue;
            }
            return Err(GuardianError::ContainmentFailed);
        }
        if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err(GuardianError::ContainmentFailed);
        }
    }
    Ok(())
}

fn set_cloexec(fd: i32, enabled: bool) -> Result<(), GuardianError> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(GuardianError::ContainmentFailed);
    }
    let next = if enabled {
        flags | libc::FD_CLOEXEC
    } else {
        flags & !libc::FD_CLOEXEC
    };
    if unsafe { libc::fcntl(fd, libc::F_SETFD, next) } < 0 {
        return Err(GuardianError::ContainmentFailed);
    }
    Ok(())
}

fn ignore_signal(signal: i32) -> Result<(), GuardianError> {
    if unsafe { libc::signal(signal, libc::SIG_IGN) } == libc::SIG_ERR {
        Err(GuardianError::ContainmentFailed)
    } else {
        Ok(())
    }
}

fn signal_group(process_group: i32, signal: i32) -> Result<(), GuardianError> {
    if unsafe { libc::kill(-process_group, signal) } == 0 {
        return Ok(());
    }
    Err(GuardianError::ContainmentFailed)
}

fn wait_child(child: &mut Child) -> Result<ExitStatus, GuardianError> {
    loop {
        match child.wait() {
            Ok(status) => return Ok(status),
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(_) => return Err(GuardianError::WaitFailed),
        }
    }
}
