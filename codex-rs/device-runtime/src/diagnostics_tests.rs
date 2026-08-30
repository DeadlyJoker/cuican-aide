use std::cell::Cell;
use std::io;
use std::io::Write as _;
use std::rc::Rc;
use std::time::Duration;

use pretty_assertions::assert_eq;

use super::DIAGNOSTIC_PREFIX;
use super::DIAGNOSTIC_WINDOW;
use super::DiagnosticReporter;
use super::MAX_DIAGNOSTICS_PER_WINDOW;
use crate::DeviceRuntimeError;

#[derive(Clone, Default)]
struct SharedWriter(Rc<std::cell::RefCell<Vec<u8>>>);

impl io::Write for SharedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl SharedWriter {
    fn text(&self) -> String {
        String::from_utf8(self.0.borrow().clone()).expect("diagnostics are UTF-8")
    }
}

#[test]
fn deduplicates_repeated_error_storm_without_exposing_error_sources() {
    let output = SharedWriter::default();
    let mut reporter = DiagnosticReporter::new(output.clone(), || Duration::ZERO);
    for _ in 0..1_000 {
        reporter.observe(&Err(DeviceRuntimeError::with_source(
            "device_runtime_socket_failed",
            io::Error::other("/secret/workspace command --token=hunter2"),
        )));
    }

    assert_eq!(
        output.text(),
        "CrewON Device Runtime diagnostic:device_runtime_socket_failed\n"
    );
}

#[test]
fn emits_distinct_stable_codes_up_to_the_hard_window_capacity() {
    const CODES: [&str; 10] = [
        "device_runtime_socket_failed",
        "device_runtime_socket_timeout",
        "device_runtime_welcome_timeout",
        "device_runtime_welcome_missing",
        "device_runtime_welcome_invalid",
        "device_runtime_welcome_rejected",
        "device_runtime_writer_unavailable",
        "device_runtime_frame_invalid",
        "device_runtime_journal_invalid",
        "device_runtime_replay_capacity_exceeded",
    ];
    let output = SharedWriter::default();
    let mut reporter = DiagnosticReporter::new(output.clone(), || Duration::ZERO);
    for code in CODES {
        reporter.observe(&Err(DeviceRuntimeError::new(code)));
    }

    let expected = CODES[..MAX_DIAGNOSTICS_PER_WINDOW]
        .iter()
        .map(|code| format!("{DIAGNOSTIC_PREFIX}{code}\n"))
        .collect::<String>();
    assert_eq!(output.text(), expected);
}

#[test]
fn resets_deduplication_and_capacity_at_the_exact_window_boundary() {
    let now = Rc::new(Cell::new(Duration::ZERO));
    let output = SharedWriter::default();
    let clock = Rc::clone(&now);
    let mut reporter = DiagnosticReporter::new(output.clone(), move || clock.get());
    let error = || Err(DeviceRuntimeError::new("device_runtime_socket_failed"));

    reporter.observe(&error());
    now.set(DIAGNOSTIC_WINDOW - Duration::from_nanos(1));
    reporter.observe(&error());
    now.set(DIAGNOSTIC_WINDOW);
    reporter.observe(&error());

    assert_eq!(
        output.text(),
        concat!(
            "CrewON Device Runtime diagnostic:device_runtime_socket_failed\n",
            "CrewON Device Runtime diagnostic:device_runtime_socket_failed\n",
        )
    );
}

#[test]
fn diagnostics_use_only_stderr_writer_and_clean_shutdown_is_silent() {
    let stdout = SharedWriter::default();
    let stderr = SharedWriter::default();
    let mut reporter = DiagnosticReporter::new(stderr.clone(), || Duration::ZERO);
    let ready = crate::DeviceRuntimeReady {
        device_id: "device-1".to_string(),
        runtime_binding_id: "runtime-1".to_string(),
        connection_epoch: 7,
    };
    let mut ready_output = stdout.clone();
    writeln!(ready_output, "{}", ready.supervisor_line()).expect("write ready line");

    reporter.observe(&Err(DeviceRuntimeError::new(
        "device_runtime_socket_failed",
    )));
    reporter.observe(&Ok(()));

    assert_eq!(
        stdout.text(),
        "CrewON Device Runtime ready:device-1:runtime-1:7\n"
    );
    assert_eq!(
        stderr.text(),
        "CrewON Device Runtime diagnostic:device_runtime_socket_failed\n"
    );
}
