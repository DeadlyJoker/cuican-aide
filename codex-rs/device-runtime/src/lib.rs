mod bootstrap;
mod diagnostics;
mod dispatch;
mod runtime;
mod session;
mod tls;

#[cfg(test)]
mod test_support;

pub use bootstrap::DeviceRuntimeBootstrap;
pub use bootstrap::DeviceRuntimeWorkspace;
pub use bootstrap::read_bootstrap;
pub use runtime::DeviceRuntime;
pub use runtime::DeviceRuntimeReady;
pub use runtime::run_from_stdin;
pub use runtime::run_from_stdin_with_ready;

use thiserror::Error;

#[derive(Debug, Error)]
#[error("{code}")]
pub struct DeviceRuntimeError {
    pub code: &'static str,
    #[source]
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl DeviceRuntimeError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self { code, source: None }
    }

    pub(crate) fn with_source(
        code: &'static str,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            code,
            source: Some(Box::new(source)),
        }
    }
}
