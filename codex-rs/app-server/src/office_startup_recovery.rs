use std::future::Future;

use futures::StreamExt;

pub(crate) const OFFICE_STARTUP_RECOVERY_CONCURRENCY: usize = 8;

/// Runs per-workspace Office startup recovery without allowing one waiting
/// workspace to stall every workspace behind it.
pub(crate) async fn recover_office_startup_cwds_with<F, Fut>(cwds: Vec<String>, recover: F)
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = ()>,
{
    futures::stream::iter(cwds)
        .for_each_concurrent(OFFICE_STARTUP_RECOVERY_CONCURRENCY, recover)
        .await;
}

#[cfg(test)]
#[path = "office_startup_recovery_tests.rs"]
mod tests;
