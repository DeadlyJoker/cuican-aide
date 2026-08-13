use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::RwLock;
use std::time::Duration;
use std::time::Instant;

use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use zeroize::Zeroizing;

use super::environment::ChildEnvironment;
use super::ControlRuntimeStartError;
use super::ControlRuntimeSupervisor;

#[path = "control_runtime_process_guardian.rs"]
mod guardian;

use self::guardian::exit_code_proves_cleanup;
use self::guardian::prepare_guardian_launch;
use self::guardian::GuardianLaunch;
#[path = "control_runtime_managed_child.rs"]
mod managed_child;
pub(super) use self::managed_child::managed_children_are_terminated;
pub(super) use self::managed_child::terminate_managed_children;
pub(super) use self::managed_child::terminate_startup_children;
pub(crate) use self::managed_child::ManagedChild;
use self::managed_child::ManagedChildProtocol;

pub(crate) type ProcessEvents = mpsc::Receiver<CommandEvent>;
const MAX_PROCESS_OUTPUT_LINE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum ProcessRole {
    ControlApi(u64),
    Device(u64),
    Gateway(u64),
    Worker(u64),
}

pub(super) struct PreparedProcessMonitor {
    gate: Arc<ProcessMonitorGate>,
    readiness: Option<Arc<ProcessReadiness>>,
}

struct ProcessMonitorGate {
    state: Mutex<ProcessMonitorGateState>,
    changed: Condvar,
}

struct ProcessReadiness {
    state: Mutex<Option<bool>>,
    changed: Condvar,
    expected: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProcessMonitorGateState {
    Waiting,
    Active,
    Canceled,
}

impl PreparedProcessMonitor {
    pub(super) fn activate(self) {
        let Ok(mut state) = self.gate.state.lock() else {
            return;
        };
        if *state == ProcessMonitorGateState::Waiting {
            *state = ProcessMonitorGateState::Active;
            self.gate.changed.notify_all();
        }
    }

    pub(super) fn activate_and_wait_ready(self, timeout: Duration) -> Result<(), ()> {
        let readiness = self.readiness.clone().ok_or(())?;
        self.activate();
        let state = readiness.state.lock().map_err(|_| ())?;
        let (state, _) = readiness
            .changed
            .wait_timeout_while(state, timeout, |state| state.is_none())
            .map_err(|_| ())?;
        match *state {
            Some(true) => Ok(()),
            Some(false) | None => Err(()),
        }
    }
}

impl Drop for PreparedProcessMonitor {
    fn drop(&mut self) {
        let Ok(mut state) = self.gate.state.lock() else {
            return;
        };
        if *state == ProcessMonitorGateState::Waiting {
            *state = ProcessMonitorGateState::Canceled;
            self.gate.changed.notify_all();
        }
    }
}

pub(super) fn spawn_node(
    app: &AppHandle,
    bundle: &Path,
    current_dir: &Path,
    environment: ChildEnvironment,
    event_thread_name: &'static str,
) -> Result<(ProcessEvents, ManagedChild), ControlRuntimeStartError> {
    spawn_node_with_bootstrap(
        app,
        bundle,
        current_dir,
        environment,
        event_thread_name,
        &[],
    )
}

pub(super) fn spawn_node_with_input(
    app: &AppHandle,
    _supervisor: Option<&ControlRuntimeSupervisor>,
    bundle: &Path,
    current_dir: &Path,
    environment: ChildEnvironment,
    event_thread_name: &'static str,
    input: &[u8],
) -> Result<(ProcessEvents, ManagedChild), ControlRuntimeStartError> {
    let mut line = Zeroizing::new(Vec::with_capacity(input.len().saturating_add(1)));
    line.extend_from_slice(input);
    line.push(b'\n');
    spawn_node_with_bootstrap(
        app,
        bundle,
        current_dir,
        environment,
        event_thread_name,
        &line,
    )
}

fn spawn_node_with_bootstrap(
    app: &AppHandle,
    bundle: &Path,
    current_dir: &Path,
    environment: ChildEnvironment,
    event_thread_name: &'static str,
    bootstrap: &[u8],
) -> Result<(ProcessEvents, ManagedChild), ControlRuntimeStartError> {
    let target = app
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
    let launch = prepare_guardian_launch(app, target.into(), bootstrap)?;
    spawn_guardian_managed(launch, event_thread_name)
}

include!("control_runtime_process_wait.rs");

#[cfg(test)]
pub(super) fn spawn_managed(
    command: std::process::Command,
    thread_name: &'static str,
) -> Result<(ProcessEvents, ManagedChild), ControlRuntimeStartError> {
    spawn_managed_with_protocol(command, thread_name, ManagedChildProtocol::Direct)
}

fn spawn_guardian_managed(
    launch: GuardianLaunch,
    thread_name: &'static str,
) -> Result<(ProcessEvents, ManagedChild), ControlRuntimeStartError> {
    let (events, child) =
        spawn_managed_with_protocol(launch.command, thread_name, ManagedChildProtocol::Guardian)?;
    if child.write_encoded(&launch.bootstrap).is_err() {
        let _ = child.inner.kill();
        let _ = child.inner.wait_timeout(super::TERMINATION_TIMEOUT);
        return Err(ControlRuntimeStartError::ProcessSpawnFailed);
    }
    Ok((events, child))
}

#[cfg(test)]
pub(super) fn spawn_guardian_managed_for_test(
    guardian_program: &std::ffi::OsStr,
    target: std::process::Command,
    bootstrap: &[u8],
    thread_name: &'static str,
) -> Result<(ProcessEvents, ManagedChild), ControlRuntimeStartError> {
    let launch =
        guardian::prepare_guardian_launch_with_program(guardian_program, target, bootstrap)?;
    spawn_guardian_managed(launch, thread_name)
}

fn spawn_managed_with_protocol(
    mut command: std::process::Command,
    thread_name: &'static str,
    protocol: ManagedChildProtocol,
) -> Result<(ProcessEvents, ManagedChild), ControlRuntimeStartError> {
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = Arc::new(
        shared_child::SharedChild::spawn(&mut command)
            .map_err(|_| ControlRuntimeStartError::ProcessSpawnFailed)?,
    );
    let cleanup_proven = Arc::new(AtomicBool::new(false));
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.take_stdin(), child.take_stdout(), child.take_stderr())
    else {
        stop_failed_spawn(&child);
        return Err(ControlRuntimeStartError::ProcessSpawnFailed);
    };
    let (sender, events) = mpsc::channel();
    let output_gate = Arc::new(RwLock::new(()));
    if spawn_output_reader(
        stdout,
        sender.clone(),
        Arc::clone(&output_gate),
        thread_name,
        "stdout",
        CommandEvent::Stdout,
    )
    .is_err()
        || spawn_output_reader(
            stderr,
            sender.clone(),
            Arc::clone(&output_gate),
            thread_name,
            "stderr",
            CommandEvent::Stderr,
        )
        .is_err()
    {
        stop_failed_spawn(&child);
        return Err(ControlRuntimeStartError::ProcessEventUnavailable);
    }
    let waiting = Arc::clone(&child);
    let waiting_cleanup_proven = Arc::clone(&cleanup_proven);
    if std::thread::Builder::new()
        .name(format!("{thread_name}-wait"))
        .spawn(move || {
            let event = match waiting.wait() {
                Ok(status) => {
                    #[cfg(unix)]
                    use std::os::unix::process::ExitStatusExt as _;
                    let payload = tauri_plugin_shell::process::TerminatedPayload {
                        code: status.code(),
                        #[cfg(unix)]
                        signal: status.signal(),
                        #[cfg(windows)]
                        signal: None,
                    };
                    let proven = match protocol {
                        #[cfg(test)]
                        ManagedChildProtocol::Direct => true,
                        ManagedChildProtocol::Guardian => exit_code_proves_cleanup(payload.code),
                    };
                    if proven {
                        waiting_cleanup_proven.store(true, Ordering::Release);
                    }
                    CommandEvent::Terminated(payload)
                }
                Err(error) => CommandEvent::Error(error.to_string()),
            };
            let _output_drained = output_gate.write();
            let _ = sender.send(event);
        })
        .is_err()
    {
        stop_failed_spawn(&child);
        return Err(ControlRuntimeStartError::ProcessEventUnavailable);
    }
    Ok((
        events,
        ManagedChild {
            cleanup_proven,
            inner: child,
            protocol,
            stdin: Mutex::new(stdin),
        },
    ))
}

fn spawn_output_reader<R: std::io::Read + Send + 'static>(
    reader: R,
    sender: mpsc::Sender<CommandEvent>,
    gate: Arc<RwLock<()>>,
    thread_name: &'static str,
    stream: &'static str,
    project: fn(Vec<u8>) -> CommandEvent,
) -> Result<(), ControlRuntimeStartError> {
    std::thread::Builder::new()
        .name(format!("{thread_name}-{stream}"))
        .spawn(move || {
            let Ok(_output_guard) = gate.read() else {
                return;
            };
            let mut reader = BufReader::new(reader);
            loop {
                let mut line = Vec::new();
                let read = {
                    let mut limited = reader
                        .by_ref()
                        .take(MAX_PROCESS_OUTPUT_LINE_BYTES.saturating_add(2));
                    tauri::utils::io::read_line(&mut limited, &mut line)
                };
                match read {
                    Ok(0) => return,
                    Ok(_) => {
                        if line.last() == Some(&b'\r')
                            && reader
                                .fill_buf()
                                .is_ok_and(|next| next.first() == Some(&b'\n'))
                        {
                            reader.consume(1);
                        }
                        if send_output_lines(&sender, &line, project).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(CommandEvent::Error(error.to_string()));
                        return;
                    }
                }
            }
        })
        .map(|_| ())
        .map_err(|_| ControlRuntimeStartError::ProcessEventUnavailable)
}

fn send_output_lines(
    sender: &mpsc::Sender<CommandEvent>,
    bytes: &[u8],
    project: fn(Vec<u8>) -> CommandEvent,
) -> Result<(), ()> {
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if !matches!(bytes[index], b'\r' | b'\n') {
            index += 1;
            continue;
        }
        send_output_line(sender, &bytes[start..index], project)?;
        if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
            index += 1;
        }
        index += 1;
        start = index;
    }
    if start < bytes.len() {
        send_output_line(sender, &bytes[start..], project)?;
    }
    Ok(())
}

fn send_output_line(
    sender: &mpsc::Sender<CommandEvent>,
    bytes: &[u8],
    project: fn(Vec<u8>) -> CommandEvent,
) -> Result<(), ()> {
    if bytes.len() as u64 > MAX_PROCESS_OUTPUT_LINE_BYTES {
        let _ = sender.send(CommandEvent::Error(
            "managed_child_output_line_too_large".to_string(),
        ));
        return Err(());
    }
    sender.send(project(bytes.to_vec())).map_err(|_| ())
}

fn stop_failed_spawn(child: &Arc<shared_child::SharedChild>) {
    let _ = child.kill();
    let _ = child.wait();
}

include!("control_runtime_process_monitor.rs");

pub(super) fn port_in_use(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(200),
    )
    .is_ok()
}

#[cfg(test)]
#[path = "control_runtime_process_tests.rs"]
mod tests;
