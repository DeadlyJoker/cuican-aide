use std::ffi::OsStr;
use std::ffi::OsString;
use std::io::Read;
use std::io::Write;
use std::process::ExitStatus;
use std::sync::mpsc;
use std::time::Duration;

use protocol::FrameKind;
use protocol::FrameReader;
use zeroize::Zeroizing;

#[cfg(unix)]
mod posix;
mod protocol;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use posix::ContainedChild;
#[cfg(windows)]
use windows::ContainedChild;

const MAX_TARGET_ARGUMENTS: usize = 64;
const MAX_TARGET_ARGUMENT_BYTES: usize = 16 * 1024;
const MAX_TARGET_COMMAND_BYTES: usize = 64 * 1024;
const CONTROL_POLL_INTERVAL: Duration = Duration::from_millis(10);
const TERMINATION_GRACE: Duration = Duration::from_secs(2);

/// The target succeeded, or its owner requested shutdown, and tree cleanup was proven.
pub const GUARDIAN_EXIT_CLEAN_SUCCESS: i32 = 0;
/// The target failed or was signaled, and tree cleanup was proven.
pub const GUARDIAN_EXIT_CLEAN_TARGET_FAILURE: i32 = 10;
/// Guardian setup or protocol handling failed with no target or after proven cleanup.
pub const GUARDIAN_EXIT_CLEAN_RUNTIME_FAILURE: i32 = 20;
/// Containment cleanup could not be proven. Callers must fail closed.
pub const GUARDIAN_EXIT_CONTAINMENT_UNPROVEN: i32 = 70;
const GUARDIAN_EXIT_ARGUMENT_INVALID: i32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuardianError {
    ArgumentInvalid,
    BootstrapMissing,
    BootstrapInvalid,
    FrameInvalid,
    ControlReadFailed,
    InputQueueFull,
    TargetInputFailed,
    TargetSpawnFailed,
    ContainmentFailed,
    WaitFailed,
    WatchdogInvalid,
}

impl GuardianError {
    pub fn code(self) -> &'static str {
        match self {
            Self::ArgumentInvalid => "guardian_argument_invalid",
            Self::BootstrapMissing => "guardian_bootstrap_missing",
            Self::BootstrapInvalid => "guardian_bootstrap_invalid",
            Self::FrameInvalid => "guardian_frame_invalid",
            Self::ControlReadFailed => "guardian_control_read_failed",
            Self::InputQueueFull => "guardian_input_queue_full",
            Self::TargetInputFailed => "guardian_target_input_failed",
            Self::TargetSpawnFailed => "guardian_target_spawn_failed",
            Self::ContainmentFailed => "guardian_containment_failed",
            Self::WaitFailed => "guardian_wait_failed",
            Self::WatchdogInvalid => "guardian_watchdog_invalid",
        }
    }
}

impl std::fmt::Display for GuardianError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for GuardianError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GuardianFailure {
    error: GuardianError,
    exit_code: i32,
}

impl GuardianFailure {
    pub fn code(self) -> &'static str {
        self.error.code()
    }

    pub fn exit_code(self) -> i32 {
        self.exit_code
    }

    fn invalid_invocation(error: GuardianError) -> Self {
        Self {
            error,
            exit_code: GUARDIAN_EXIT_ARGUMENT_INVALID,
        }
    }

    pub(crate) fn cleanup_proven(error: GuardianError) -> Self {
        Self {
            error,
            exit_code: GUARDIAN_EXIT_CLEAN_RUNTIME_FAILURE,
        }
    }

    pub(crate) fn cleanup_unproven(error: GuardianError) -> Self {
        Self {
            error,
            exit_code: GUARDIAN_EXIT_CONTAINMENT_UNPROVEN,
        }
    }
}

#[derive(Debug)]
struct TargetSpec {
    program: OsString,
    arguments: Vec<OsString>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ControlEvent {
    OwnerClosed,
    Shutdown,
    ProtocolFailed(GuardianError),
    TargetInputFailed,
}

#[derive(Debug)]
enum ActiveCompletion {
    OwnerStopped,
    TargetExited(ExitStatus),
}

#[derive(Debug)]
enum Invocation {
    Guardian(TargetSpec),
    #[cfg(unix)]
    Watchdog {
        read_fd: i32,
    },
}

pub fn run_from_process() -> Result<i32, GuardianFailure> {
    let invocation =
        parse_invocation(std::env::args_os()).map_err(GuardianFailure::invalid_invocation)?;
    match invocation {
        Invocation::Guardian(target) => run_guardian(target, std::io::stdin()),
        #[cfg(unix)]
        Invocation::Watchdog { read_fd } => {
            posix::run_watchdog(read_fd).map_err(GuardianFailure::cleanup_unproven)
        }
    }
}

fn run_guardian<R>(target: TargetSpec, input: R) -> Result<i32, GuardianFailure>
where
    R: Read + Send + 'static,
{
    let mut frames = FrameReader::new(input);
    let bootstrap = frames
        .read_bootstrap()
        .map_err(GuardianFailure::cleanup_proven)?;
    let mut child = ContainedChild::spawn(&target)?;

    let active_result = run_active_guardian(&mut child, frames, bootstrap.payload);
    child
        .terminate(TERMINATION_GRACE)
        .map_err(GuardianFailure::cleanup_unproven)?;

    match active_result {
        Ok(ActiveCompletion::OwnerStopped) => Ok(GUARDIAN_EXIT_CLEAN_SUCCESS),
        Ok(ActiveCompletion::TargetExited(status)) if status.success() => {
            Ok(GUARDIAN_EXIT_CLEAN_SUCCESS)
        }
        Ok(ActiveCompletion::TargetExited(_)) => Ok(GUARDIAN_EXIT_CLEAN_TARGET_FAILURE),
        Err(error) => Err(GuardianFailure::cleanup_proven(error)),
    }
}

fn run_active_guardian<R>(
    child: &mut ContainedChild,
    frames: FrameReader<R>,
    bootstrap: Zeroizing<Vec<u8>>,
) -> Result<ActiveCompletion, GuardianError>
where
    R: Read + Send + 'static,
{
    let target_stdin = child.take_stdin().ok_or(GuardianError::TargetSpawnFailed)?;
    let (input_tx, input_rx) = mpsc::sync_channel::<Zeroizing<Vec<u8>>>(1);
    let (event_tx, event_rx) = mpsc::channel::<ControlEvent>();
    spawn_target_input_writer(target_stdin, input_rx, event_tx.clone())?;
    input_tx
        .try_send(bootstrap)
        .map_err(|_| GuardianError::InputQueueFull)?;
    spawn_control_reader(frames, input_tx, event_tx)?;

    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(ActiveCompletion::TargetExited(status));
        }
        match event_rx.recv_timeout(CONTROL_POLL_INTERVAL) {
            Ok(ControlEvent::OwnerClosed | ControlEvent::Shutdown) => {
                return Ok(ActiveCompletion::OwnerStopped);
            }
            Ok(ControlEvent::ProtocolFailed(error)) => {
                return Err(error);
            }
            Ok(ControlEvent::TargetInputFailed) => {
                return Err(GuardianError::TargetInputFailed);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(GuardianError::ControlReadFailed);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

fn spawn_target_input_writer(
    mut target_stdin: std::process::ChildStdin,
    input_rx: mpsc::Receiver<Zeroizing<Vec<u8>>>,
    event_tx: mpsc::Sender<ControlEvent>,
) -> Result<(), GuardianError> {
    std::thread::Builder::new()
        .name("crewon-guardian-target-input".to_string())
        .spawn(move || {
            for input in input_rx {
                if target_stdin.write_all(&input).is_err() {
                    let _ = event_tx.send(ControlEvent::TargetInputFailed);
                    return;
                }
            }
        })
        .map(|_| ())
        .map_err(|_| GuardianError::ContainmentFailed)
}

fn spawn_control_reader<R>(
    mut frames: FrameReader<R>,
    input_tx: mpsc::SyncSender<Zeroizing<Vec<u8>>>,
    event_tx: mpsc::Sender<ControlEvent>,
) -> Result<(), GuardianError>
where
    R: Read + Send + 'static,
{
    std::thread::Builder::new()
        .name("crewon-guardian-control".to_string())
        .spawn(move || {
            loop {
                match frames.read_frame() {
                    Ok(Some(frame)) if frame.kind == FrameKind::Input => {
                        if input_tx.try_send(frame.payload).is_err() {
                            let _ = event_tx
                                .send(ControlEvent::ProtocolFailed(GuardianError::InputQueueFull));
                            return;
                        }
                    }
                    Ok(Some(frame)) if frame.kind == FrameKind::Shutdown => {
                        let _ = event_tx.send(ControlEvent::Shutdown);
                        return;
                    }
                    Ok(Some(_)) => {
                        let _ = event_tx
                            .send(ControlEvent::ProtocolFailed(GuardianError::FrameInvalid));
                        return;
                    }
                    Ok(None) => {
                        let _ = event_tx.send(ControlEvent::OwnerClosed);
                        return;
                    }
                    Err(error) => {
                        let _ = event_tx.send(ControlEvent::ProtocolFailed(error));
                        return;
                    }
                }
            }
        })
        .map(|_| ())
        .map_err(|_| GuardianError::ContainmentFailed)
}

fn parse_invocation(
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<Invocation, GuardianError> {
    let mut arguments = arguments.into_iter();
    let _program = arguments.next().ok_or(GuardianError::ArgumentInvalid)?;
    let tail = arguments.collect::<Vec<_>>();

    #[cfg(unix)]
    if tail
        .first()
        .is_some_and(|argument| argument == "--watchdog")
    {
        if tail.len() != 2 {
            return Err(GuardianError::WatchdogInvalid);
        }
        let read_fd = parse_positive_i32(&tail[1])?;
        return Ok(Invocation::Watchdog { read_fd });
    }

    if tail.first().is_none_or(|argument| argument != "--") || tail.len() < 2 {
        return Err(GuardianError::ArgumentInvalid);
    }
    let target = &tail[1..];
    if target.len() > MAX_TARGET_ARGUMENTS + 1 {
        return Err(GuardianError::ArgumentInvalid);
    }
    let mut total_bytes = 0_usize;
    for argument in target {
        let bytes = os_string_bytes(argument);
        if bytes == 0 || bytes > MAX_TARGET_ARGUMENT_BYTES {
            return Err(GuardianError::ArgumentInvalid);
        }
        total_bytes = total_bytes
            .checked_add(bytes)
            .ok_or(GuardianError::ArgumentInvalid)?;
    }
    if total_bytes > MAX_TARGET_COMMAND_BYTES {
        return Err(GuardianError::ArgumentInvalid);
    }
    Ok(Invocation::Guardian(TargetSpec {
        program: target[0].clone(),
        arguments: target[1..].to_vec(),
    }))
}

#[cfg(unix)]
fn parse_positive_i32(value: &OsStr) -> Result<i32, GuardianError> {
    let parsed = value
        .to_str()
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|value| *value > 0)
        .ok_or(GuardianError::WatchdogInvalid)?;
    Ok(parsed)
}

#[cfg(unix)]
fn os_string_bytes(value: &OsStr) -> usize {
    use std::os::unix::ffi::OsStrExt as _;
    value.as_bytes().len()
}

#[cfg(windows)]
fn os_string_bytes(value: &OsStr) -> usize {
    use std::os::windows::ffi::OsStrExt as _;
    value.encode_wide().count().saturating_mul(2)
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
