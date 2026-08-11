use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Command;

use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use zeroize::Zeroizing;

use super::ControlRuntimeStartError;

const GUARDIAN_SIDECAR: &str = "crewon-process-guardian";
const MAGIC: &[u8; 4] = b"CRWG";
const VERSION: u8 = 0;
const HEADER_BYTES: usize = 12;
const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_TARGET_ARGUMENTS: usize = 64;
const MAX_TARGET_ARGUMENT_BYTES: usize = 16 * 1024;
const MAX_TARGET_COMMAND_BYTES: usize = 64 * 1024;
const CLEAN_EXIT_CODES: &[i32] = &[0, 10, 20];

#[derive(Clone, Copy)]
pub(super) enum GuardianFrameKind {
    BootstrapInput = 1,
    Input = 2,
    Shutdown = 3,
}

pub(super) struct GuardianLaunch {
    pub(super) bootstrap: Zeroizing<Vec<u8>>,
    pub(super) command: Command,
}

struct GuardianTarget {
    arguments: Vec<OsString>,
    current_dir: PathBuf,
    environment: Vec<(OsString, OsString)>,
    program: OsString,
}

impl std::fmt::Debug for GuardianTarget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("GuardianTarget([REDACTED])")
    }
}

pub(super) fn prepare_guardian_launch(
    app: &AppHandle,
    target: Command,
    bootstrap: &[u8],
) -> Result<GuardianLaunch, ControlRuntimeStartError> {
    let guardian: Command = app
        .shell()
        .sidecar(GUARDIAN_SIDECAR)
        .map_err(|_| ControlRuntimeStartError::ProcessSpawnFailed)?
        .into();
    prepare_guardian_launch_with_command(guardian, target, bootstrap)
}

#[cfg(test)]
pub(super) fn prepare_guardian_launch_with_program(
    guardian: &OsStr,
    target: Command,
    bootstrap: &[u8],
) -> Result<GuardianLaunch, ControlRuntimeStartError> {
    prepare_guardian_launch_with_command(Command::new(guardian), target, bootstrap)
}

fn prepare_guardian_launch_with_command(
    guardian: Command,
    target: Command,
    bootstrap: &[u8],
) -> Result<GuardianLaunch, ControlRuntimeStartError> {
    let target = GuardianTarget::from_command(&target)?;
    let command = target.apply_to(guardian);
    let bootstrap = encode_frame(GuardianFrameKind::BootstrapInput, bootstrap)?;
    Ok(GuardianLaunch { bootstrap, command })
}

impl GuardianTarget {
    fn from_command(command: &Command) -> Result<Self, ControlRuntimeStartError> {
        let program = command.get_program().to_os_string();
        let arguments = command
            .get_args()
            .map(OsStr::to_os_string)
            .collect::<Vec<_>>();
        let current_dir = command
            .get_current_dir()
            .filter(|path| path.is_absolute())
            .map(PathBuf::from)
            .ok_or(ControlRuntimeStartError::ProcessSpawnFailed)?;
        let environment = command
            .get_envs()
            .map(|(key, value)| {
                value
                    .map(|value| (key.to_os_string(), value.to_os_string()))
                    .ok_or(ControlRuntimeStartError::ProcessSpawnFailed)
            })
            .collect::<Result<Vec<_>, _>>()?;
        validate_target(&program, &arguments)?;
        Ok(Self {
            arguments,
            current_dir,
            environment,
            program,
        })
    }

    fn apply_to(self, mut guardian: Command) -> Command {
        guardian
            .arg("--")
            .arg(self.program)
            .args(self.arguments)
            .env_clear()
            .envs(self.environment)
            .current_dir(self.current_dir);
        guardian
    }
}

fn validate_target(
    program: &OsStr,
    arguments: &[OsString],
) -> Result<(), ControlRuntimeStartError> {
    if arguments.len() > MAX_TARGET_ARGUMENTS {
        return Err(ControlRuntimeStartError::ProcessSpawnFailed);
    }
    let mut total_bytes = target_argument_bytes(program)?;
    for argument in arguments {
        total_bytes = total_bytes
            .checked_add(target_argument_bytes(argument)?)
            .ok_or(ControlRuntimeStartError::ProcessSpawnFailed)?;
    }
    if total_bytes > MAX_TARGET_COMMAND_BYTES {
        return Err(ControlRuntimeStartError::ProcessSpawnFailed);
    }
    Ok(())
}

fn target_argument_bytes(argument: &OsStr) -> Result<usize, ControlRuntimeStartError> {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt as _;
        argument.as_bytes().len()
    };
    #[cfg(windows)]
    let bytes = {
        use std::os::windows::ffi::OsStrExt as _;
        argument.encode_wide().count().saturating_mul(2)
    };
    if bytes == 0 || bytes > MAX_TARGET_ARGUMENT_BYTES {
        Err(ControlRuntimeStartError::ProcessSpawnFailed)
    } else {
        Ok(bytes)
    }
}

pub(super) fn encode_frame(
    kind: GuardianFrameKind,
    payload: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ControlRuntimeStartError> {
    if payload.len() > MAX_FRAME_BYTES
        || (matches!(kind, GuardianFrameKind::Shutdown) && !payload.is_empty())
    {
        return Err(ControlRuntimeStartError::ProcessSpawnFailed);
    }
    let payload_bytes =
        u32::try_from(payload.len()).map_err(|_| ControlRuntimeStartError::ProcessSpawnFailed)?;
    let mut encoded = Zeroizing::new(Vec::with_capacity(HEADER_BYTES + payload.len()));
    encoded.extend_from_slice(MAGIC);
    encoded.push(VERSION);
    encoded.push(kind as u8);
    encoded.extend_from_slice(&[0, 0]);
    encoded.extend_from_slice(&payload_bytes.to_be_bytes());
    encoded.extend_from_slice(payload);
    Ok(encoded)
}

pub(super) fn exit_code_proves_cleanup(code: Option<i32>) -> bool {
    code.is_some_and(|code| CLEAN_EXIT_CODES.contains(&code))
}

#[cfg(test)]
#[path = "control_runtime_process_guardian_tests.rs"]
mod tests;
