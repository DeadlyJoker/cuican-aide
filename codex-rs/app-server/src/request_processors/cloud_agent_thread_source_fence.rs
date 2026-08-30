use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::ThreadSource as ApiThreadSource;
use crewon_protocol::protocol::ThreadSource;

use super::CrewonThread;
use crate::error_code::invalid_request;

/// Reserved source emitted only by the future Cloud Agent cutover release.
pub(crate) const CLOUD_AGENT_PROVIDER_BINDING_SOURCE_V1: &str =
    "crewon_cloud_agent_provider_binding_v1";

pub(crate) fn ensure_source_creation_allowed(
    source: Option<&ApiThreadSource>,
) -> Result<(), JSONRPCErrorError> {
    if matches!(
        source,
        Some(ApiThreadSource::Feature(feature))
            if feature == CLOUD_AGENT_PROVIDER_BINDING_SOURCE_V1
    ) {
        return Err(invalid_request(
            "this compatibility version cannot create Cloud Agent Threads",
        ));
    }
    Ok(())
}

pub(crate) async fn ensure_loaded_thread_mutation_allowed(
    thread: &CrewonThread,
    method: &'static str,
) -> Result<(), JSONRPCErrorError> {
    let snapshot = thread.config_snapshot().await;
    ensure_thread_source_mutation_allowed(snapshot.thread_source.as_ref(), method)
}

pub(crate) fn ensure_thread_source_mutation_allowed(
    source: Option<&ThreadSource>,
    method: &'static str,
) -> Result<(), JSONRPCErrorError> {
    if source.is_some_and(|source| source.as_str() == CLOUD_AGENT_PROVIDER_BINDING_SOURCE_V1) {
        return Err(invalid_request(format!(
            "Cloud Agent Thread is read-only in this compatibility version; {method} is unavailable"
        )));
    }
    Ok(())
}

#[cfg(test)]
#[path = "cloud_agent_thread_source_fence_tests.rs"]
mod tests;
