use std::collections::HashSet;
use std::io::Write;
use std::time::Duration;

use crate::DeviceRuntimeError;

const DIAGNOSTIC_WINDOW: Duration = Duration::from_secs(60);
const MAX_DIAGNOSTICS_PER_WINDOW: usize = 8;
const DIAGNOSTIC_PREFIX: &str = "CrewON Device Runtime diagnostic:";

pub(crate) struct DiagnosticReporter<Writer, Clock> {
    writer: Writer,
    clock: Clock,
    window_started_at: Duration,
    emitted_codes: HashSet<&'static str>,
}

impl<Writer, Clock> DiagnosticReporter<Writer, Clock>
where
    Writer: Write,
    Clock: Fn() -> Duration,
{
    pub(crate) fn new(writer: Writer, clock: Clock) -> Self {
        let window_started_at = clock();
        Self {
            writer,
            clock,
            window_started_at,
            emitted_codes: HashSet::with_capacity(MAX_DIAGNOSTICS_PER_WINDOW),
        }
    }

    pub(crate) fn observe(&mut self, result: &Result<(), DeviceRuntimeError>) {
        let Err(error) = result else {
            return;
        };
        let now = (self.clock)();
        if now.saturating_sub(self.window_started_at) >= DIAGNOSTIC_WINDOW {
            self.window_started_at = now;
            self.emitted_codes.clear();
        }
        if self.emitted_codes.len() >= MAX_DIAGNOSTICS_PER_WINDOW
            || !self.emitted_codes.insert(error.code)
        {
            return;
        }
        let _ = writeln!(self.writer, "{DIAGNOSTIC_PREFIX}{}", error.code);
    }
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;
