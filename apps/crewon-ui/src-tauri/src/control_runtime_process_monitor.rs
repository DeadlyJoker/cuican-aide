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
    prepare_process_monitor(app, events, process_name, role).map(|monitor| monitor.activate())
}

pub(super) fn prepare_process_monitor(
    app: AppHandle,
    events: ProcessEvents,
    process_name: &'static str,
    role: ProcessRole,
) -> Result<PreparedProcessMonitor, ControlRuntimeStartError> {
    prepare_process_monitor_inner(app, events, process_name, role, None)
}

pub(super) fn prepare_process_monitor_with_ready(
    app: AppHandle,
    events: ProcessEvents,
    process_name: &'static str,
    role: ProcessRole,
    expected: &[u8],
) -> Result<PreparedProcessMonitor, ControlRuntimeStartError> {
    prepare_process_monitor_inner(
        app,
        events,
        process_name,
        role,
        Some(Arc::new(ProcessReadiness {
            state: Mutex::new(None),
            changed: Condvar::new(),
            expected: expected.to_vec(),
        })),
    )
}

fn prepare_process_monitor_inner(
    app: AppHandle,
    events: ProcessEvents,
    process_name: &'static str,
    role: ProcessRole,
    readiness: Option<Arc<ProcessReadiness>>,
) -> Result<PreparedProcessMonitor, ControlRuntimeStartError> {
    let gate = Arc::new(ProcessMonitorGate {
        state: Mutex::new(ProcessMonitorGateState::Waiting),
        changed: Condvar::new(),
    });
    let monitor_gate = Arc::clone(&gate);
    let monitor_readiness = readiness.clone();
    std::thread::Builder::new()
        .name(format!("crewon-{process_name}-supervisor"))
        .spawn(move || {
            let Ok(mut state) = monitor_gate.state.lock() else {
                return;
            };
            while *state == ProcessMonitorGateState::Waiting {
                let Ok(next) = monitor_gate.changed.wait(state) else {
                    return;
                };
                state = next;
            }
            if *state == ProcessMonitorGateState::Canceled {
                return;
            }
            drop(state);
            let mut failed = false;
            loop {
                match events.recv() {
                    Ok(CommandEvent::Terminated(payload)) => {
                        settle_readiness(&monitor_readiness, false);
                        if let Some(supervisor) = app.try_state::<ControlRuntimeSupervisor>() {
                            supervisor
                                .process_terminated(role, exit_code_proves_cleanup(payload.code));
                        }
                        return;
                    }
                    Ok(CommandEvent::Error(_)) => {
                        settle_readiness(&monitor_readiness, false);
                        failed = true;
                        if let Some(supervisor) = app.try_state::<ControlRuntimeSupervisor>() {
                            supervisor.process_monitor_failed(role);
                        }
                    }
                    Err(_) => break,
                    Ok(CommandEvent::Stdout(line)) => {
                        if monitor_readiness.as_ref().is_some_and(|readiness| {
                            output_line_matches(&line, &readiness.expected)
                        }) {
                            settle_readiness(&monitor_readiness, true);
                        }
                    }
                    Ok(CommandEvent::Stderr(_)) => {}
                    #[allow(unreachable_patterns)]
                    Ok(_) => {}
                }
            }
            settle_readiness(&monitor_readiness, false);
            if failed {
                return;
            }
            let Some(supervisor) = app.try_state::<ControlRuntimeSupervisor>() else {
                return;
            };
            supervisor.process_monitor_failed(role);
        })
        .map(|_| PreparedProcessMonitor { gate, readiness })
        .map_err(|_| ControlRuntimeStartError::ProcessEventUnavailable)
}

fn settle_readiness(readiness: &Option<Arc<ProcessReadiness>>, ready: bool) {
    let Some(readiness) = readiness else {
        return;
    };
    let Ok(mut state) = readiness.state.lock() else {
        return;
    };
    if state.is_none() {
        *state = Some(ready);
        readiness.changed.notify_all();
    }
}
