use std::path::Path;

use crewon_protocol::ThreadId;
use crewon_protocol::error::CodexErr;
use crewon_thread_store::ThreadStoreError;

use super::map_session_init_error;

#[test]
fn writer_conflict_maps_to_invalid_request() {
    let error = anyhow::Error::new(ThreadStoreError::Conflict {
        message: "thread already has an active rollout writer".to_string(),
    })
    .context("failed to resume rollout recorder");

    let mapped = map_session_init_error(&error, Path::new("/tmp/crewon-home"));

    assert!(matches!(
        mapped,
        CodexErr::InvalidRequest(message)
            if message == "thread already has an active rollout writer"
    ));
}

#[test]
fn thread_not_found_preserves_thread_identity() {
    let thread_id = ThreadId::new();
    let error = anyhow::Error::new(ThreadStoreError::ThreadNotFound { thread_id });

    let mapped = map_session_init_error(&error, Path::new("/tmp/crewon-home"));

    assert!(matches!(
        mapped,
        CodexErr::ThreadNotFound(mapped_thread_id) if mapped_thread_id == thread_id
    ));
}
