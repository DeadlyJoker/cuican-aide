pub(super) fn wait_for_matching_ready<T>(
    events: &ProcessEvents,
    timeout: Duration,
    mut project: impl FnMut(&[u8]) -> Option<T>,
) -> Result<T, ()> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(remaining) {
            Ok(CommandEvent::Stdout(line)) => {
                let without_newline = line.strip_suffix(b"\n").unwrap_or(&line);
                let line = without_newline
                    .strip_suffix(b"\r")
                    .unwrap_or(without_newline);
                if let Some(value) = project(line) {
                    return Ok(value);
                }
            }
            Ok(CommandEvent::Terminated(_) | CommandEvent::Error(_)) | Err(_) => return Err(()),
            Ok(CommandEvent::Stderr(_)) => {}
            #[allow(unreachable_patterns)]
            Ok(_) => {}
        }
    }
}

pub(super) fn wait_for_bounded_json_exit(
    events: &ProcessEvents,
    timeout: Duration,
    maximum_bytes: usize,
) -> Result<Vec<u8>, ()> {
    let deadline = Instant::now() + timeout;
    let mut stdout = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(remaining) {
            Ok(CommandEvent::Stdout(bytes)) => {
                if stdout.len().saturating_add(bytes.len()) > maximum_bytes {
                    return Err(());
                }
                stdout.extend_from_slice(&bytes);
            }
            Ok(CommandEvent::Terminated(payload)) if payload.code == Some(0) => {
                let line = stdout.strip_suffix(b"\n").unwrap_or(&stdout);
                let line = line.strip_suffix(b"\r").unwrap_or(line);
                return (!line.is_empty()).then(|| line.to_vec()).ok_or(());
            }
            Ok(CommandEvent::Terminated(_) | CommandEvent::Error(_)) | Err(_) => return Err(()),
            Ok(CommandEvent::Stderr(_)) => {}
            #[allow(unreachable_patterns)]
            Ok(_) => {}
        }
    }
}
