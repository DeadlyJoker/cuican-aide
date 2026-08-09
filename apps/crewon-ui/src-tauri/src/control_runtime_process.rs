use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use super::environment::ChildEnvironment;
use super::ControlRuntimeStartError;
use super::ControlRuntimeSupervisor;

pub(super) type ProcessEvents = mpsc::Receiver<CommandEvent>;

#[derive(Clone, Copy)]
pub(super) enum ProcessRole {
    ControlApi(u64),
    Worker(u64),
}

pub(super) fn spawn_node(
    app: &AppHandle,
    bundle: &Path,
    current_dir: &Path,
    environment: ChildEnvironment,
    event_thread_name: &'static str,
) -> Result<(ProcessEvents, CommandChild), ControlRuntimeStartError> {
    let command = app
        .shell()
        .sidecar("crewon-node")
        .map_err(|_| ControlRuntimeStartError::ProcessSpawnFailed)?
        .arg(bundle)
        .env_clear()
        .envs(
            environment
                .iter()
                .map(|variable| (&variable.key, variable.value.as_os_str())),
        )
        .current_dir(current_dir);
    let spawned = command
        .spawn()
        .map_err(|_| ControlRuntimeStartError::ProcessSpawnFailed);
    let (receiver, child) = spawned?;
    match bridge_events(receiver, event_thread_name) {
        Ok(events) => Ok((events, child)),
        Err(error) => {
            let _ = child.kill();
            Err(error)
        }
    }
}

fn bridge_events(
    mut receiver: tauri::async_runtime::Receiver<CommandEvent>,
    thread_name: &'static str,
) -> Result<ProcessEvents, ControlRuntimeStartError> {
    let (sender, events) = mpsc::channel();
    std::thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            while let Some(event) = receiver.blocking_recv() {
                if sender.send(event).is_err() {
                    break;
                }
            }
        })
        .map_err(|_| ControlRuntimeStartError::ProcessEventUnavailable)?;
    Ok(events)
}

pub(super) fn wait_for_ready(
    events: &ProcessEvents,
    expected_stdout: &[u8],
    timeout: Duration,
) -> Result<(), ()> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(remaining) {
            Ok(CommandEvent::Stdout(line)) if output_line_matches(&line, expected_stdout) => {
                return Ok(())
            }
            Ok(CommandEvent::Terminated(_)) | Err(_) => return Err(()),
            Ok(CommandEvent::Error(_) | CommandEvent::Stderr(_) | CommandEvent::Stdout(_)) => {}
            #[allow(unreachable_patterns)]
            Ok(_) => {}
        }
    }
}

fn output_line_matches(line: &[u8], expected: &[u8]) -> bool {
    let without_newline = line.strip_suffix(b"\n").unwrap_or(line);
    without_newline
        .strip_suffix(b"\r")
        .unwrap_or(without_newline)
        == expected
}

pub(super) fn wait_for_successful_exit(
    events: &ProcessEvents,
    timeout: Duration,
) -> Result<(), ()> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(remaining) {
            Ok(CommandEvent::Terminated(payload)) if payload.code == Some(0) => return Ok(()),
            Ok(CommandEvent::Terminated(_)) | Ok(CommandEvent::Error(_)) | Err(_) => return Err(()),
            Ok(CommandEvent::Stderr(_) | CommandEvent::Stdout(_)) => {}
            #[allow(unreachable_patterns)]
            Ok(_) => {}
        }
    }
}

pub(super) fn monitor_process(
    app: AppHandle,
    events: ProcessEvents,
    process_name: &'static str,
    role: ProcessRole,
) -> Result<(), ControlRuntimeStartError> {
    std::thread::Builder::new()
        .name(format!("crewon-{process_name}-supervisor"))
        .spawn(move || {
            while let Ok(event) = events.recv() {
                if matches!(event, CommandEvent::Terminated(_)) {
                    break;
                }
            }
            if let Some(supervisor) = app.try_state::<ControlRuntimeSupervisor>() {
                supervisor.process_terminated(role);
            }
        })
        .map(|_| ())
        .map_err(|_| ControlRuntimeStartError::ProcessEventUnavailable)
}

pub(super) fn port_in_use(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(200),
    )
    .is_ok()
}
