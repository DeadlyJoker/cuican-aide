use crewon_app_server_protocol::ThreadSource as ApiThreadSource;
use crewon_protocol::protocol::ThreadSource;

use super::CLOUD_AGENT_PROVIDER_BINDING_SOURCE_V1;
use super::ensure_source_creation_allowed;
use super::ensure_thread_source_mutation_allowed;

#[test]
fn compatibility_fence_recognizes_but_never_creates_reserved_source() {
    let api_source = ApiThreadSource::Feature(CLOUD_AGENT_PROVIDER_BINDING_SOURCE_V1.to_string());
    assert!(ensure_source_creation_allowed(Some(&api_source)).is_err());

    let stored_source = ThreadSource::Feature(CLOUD_AGENT_PROVIDER_BINDING_SOURCE_V1.to_string());
    for method in [
        "turn/start",
        "thread/archive",
        "thread/unarchive",
        "thread/delete",
    ] {
        assert!(ensure_thread_source_mutation_allowed(Some(&stored_source), method).is_err());
    }
}

#[test]
fn compatibility_fence_preserves_existing_thread_sources() {
    for source in [
        ThreadSource::User,
        ThreadSource::Subagent,
        ThreadSource::Feature("office_member_runtime".to_string()),
        ThreadSource::MemoryConsolidation,
    ] {
        ensure_thread_source_mutation_allowed(Some(&source), "turn/start")
            .expect("ordinary source remains mutable");
    }
    ensure_source_creation_allowed(Some(&ApiThreadSource::Feature(
        "office_member_runtime".to_string(),
    )))
    .expect("ordinary feature source can still be created");
}
