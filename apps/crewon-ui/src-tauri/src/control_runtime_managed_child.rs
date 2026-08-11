use std::io::Write;
use std::process::ChildStdin;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use super::guardian::encode_frame;
use super::guardian::exit_code_proves_cleanup;
use super::guardian::GuardianFrameKind;

const MINIMUM_GUARDIAN_CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ManagedChildProtocol {
    #[cfg(test)]
    Direct,
    Guardian,
}

pub(crate) struct ManagedChild {
    pub(super) cleanup_proven: Arc<AtomicBool>,
    pub(super) inner: Arc<shared_child::SharedChild>,
    pub(super) protocol: ManagedChildProtocol,
    pub(super) stdin: Mutex<ChildStdin>,
}

impl std::fmt::Debug for ManagedChild {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ManagedChild([REDACTED])")
    }
}

impl ManagedChild {
    pub(crate) fn write(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        match self.protocol {
            #[cfg(test)]
            ManagedChildProtocol::Direct => self.write_encoded(bytes),
            ManagedChildProtocol::Guardian => {
                let frame = encode_frame(GuardianFrameKind::Input, bytes)
                    .map_err(|_| std::io::Error::other("managed_child_input_invalid"))?;
                self.write_encoded(&frame)
            }
        }
    }

    pub(super) fn write_encoded(&self, bytes: &[u8]) -> std::io::Result<()> {
        self.stdin
            .lock()
            .map_err(|_| std::io::Error::other("managed_child_stdin_poisoned"))?
            .write_all(bytes)
    }

    pub(crate) fn kill(&self) -> std::io::Result<()> {
        if self.cleanup_is_proven() {
            return Ok(());
        }
        if let Err(error) = self.request_shutdown() {
            let _ = self.inner.kill();
            return Err(error);
        }
        let deadline = Instant::now() + MINIMUM_GUARDIAN_CLEANUP_TIMEOUT;
        if self.wait_for_cleanup_until(deadline) {
            return Ok(());
        }
        let _ = self.inner.kill();
        Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "managed_child_cleanup_unproven",
        ))
    }

    pub(crate) fn wait_timeout(
        &self,
        timeout: Duration,
    ) -> std::io::Result<Option<std::process::ExitStatus>> {
        let status = self.inner.wait_timeout(timeout)?;
        if let Some(status) = status.as_ref() {
            self.observe_exit(status);
        }
        Ok(status)
    }

    pub(crate) fn is_running(&self) -> bool {
        self.wait_timeout(Duration::ZERO)
            .is_ok_and(|status| status.is_none())
    }

    #[cfg(test)]
    pub(super) fn pid(&self) -> u32 {
        self.inner.id()
    }

    fn is_terminated(&self) -> bool {
        self.cleanup_is_proven()
    }

    pub(super) fn cleanup_is_proven(&self) -> bool {
        if self.cleanup_proven.load(Ordering::Acquire) {
            return true;
        }
        let _ = self.wait_timeout(Duration::ZERO);
        self.cleanup_proven.load(Ordering::Acquire)
    }

    fn request_shutdown(&self) -> std::io::Result<()> {
        match self.protocol {
            #[cfg(test)]
            ManagedChildProtocol::Direct => self.inner.kill(),
            ManagedChildProtocol::Guardian => {
                let frame = encode_frame(GuardianFrameKind::Shutdown, &[])
                    .map_err(|_| std::io::Error::other("managed_child_shutdown_invalid"))?;
                self.write_encoded(&frame)
            }
        }
    }

    fn wait_for_cleanup_until(&self, deadline: Instant) -> bool {
        if self.cleanup_is_proven() {
            return true;
        }
        let _ = self.wait_timeout(deadline.saturating_duration_since(Instant::now()));
        self.cleanup_is_proven()
    }

    fn observe_exit(&self, status: &std::process::ExitStatus) {
        if Self::exit_proves_cleanup(self.protocol, status.code()) {
            self.cleanup_proven.store(true, Ordering::Release);
        }
    }

    pub(super) fn exit_proves_cleanup(protocol: ManagedChildProtocol, code: Option<i32>) -> bool {
        match protocol {
            #[cfg(test)]
            ManagedChildProtocol::Direct => true,
            ManagedChildProtocol::Guardian => exit_code_proves_cleanup(code),
        }
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

pub(crate) fn terminate_managed_children(children: &[ManagedChild], timeout: Duration) -> bool {
    let _shutdown_results = children
        .iter()
        .map(ManagedChild::request_shutdown)
        .collect::<Vec<_>>();
    let requires_guardian_deadline = children
        .iter()
        .any(|child| child.protocol == ManagedChildProtocol::Guardian);
    let timeout = if requires_guardian_deadline {
        timeout.max(MINIMUM_GUARDIAN_CLEANUP_TIMEOUT)
    } else {
        timeout
    };
    let deadline = Instant::now() + timeout;
    let proven = children
        .iter()
        .map(|child| child.wait_for_cleanup_until(deadline))
        .collect::<Vec<_>>();
    for (child, proven) in children.iter().zip(&proven) {
        if !proven {
            let _ = child.inner.kill();
        }
    }
    proven.into_iter().all(|proven| proven)
}

pub(crate) fn managed_children_are_terminated(children: &[ManagedChild]) -> bool {
    children.iter().all(ManagedChild::is_terminated)
}

pub(crate) fn terminate_startup_children(children: Vec<ManagedChild>) {
    if !terminate_managed_children(&children, super::super::TERMINATION_TIMEOUT) {
        super::super::quarantine_startup_processes(children);
    }
}
