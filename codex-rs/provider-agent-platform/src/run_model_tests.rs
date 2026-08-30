use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use pretty_assertions::assert_eq;

use super::*;

fn binding(task_id: &str) -> ProviderRunAuthorizationBinding {
    ProviderRunAuthorizationBinding::new(
        ResourceRef {
            provider: ProviderRef {
                provider_id: ProviderId::new("agent-platform").expect("provider id"),
                protocol_version: ProviderProtocolVersion::new("3.0.0").expect("protocol"),
            },
            kind: ResourceKind::Agent,
            resource_id: ResourceId::new("agent-demo").expect("resource id"),
            revision: ResourceRevision::new("agent-version:7").expect("revision"),
        },
        task_id,
        "credential-demo",
        /*credential_revision*/ 7,
    )
    .expect("binding")
}

fn artifact(task_id: &str, artifact_id: &str) -> ProviderArtifactRef {
    ProviderArtifactRef::new(
        artifact_id,
        task_id,
        ProviderArtifactKind::Evidence,
        1,
        ProviderArtifactRetention::Task,
        1_784_505_500,
    )
    .expect("artifact")
}

#[test]
fn start_request_binds_context_to_task_and_rejects_duplicate_artifacts() {
    let request = ProviderRunStartRequest::new(
        binding("task-demo"),
        "command-start-001",
        "task-demo:start:1",
        "sha256:request-demo",
        "Produce the requested result.",
        vec![artifact("task-demo", "artifact-context-demo")],
    )
    .expect("start request");
    assert_eq!(request.authorization().task_id(), "task-demo");
    assert_eq!(request.context_refs().len(), 1);
    let debug = format!("{request:?}");
    assert!(!debug.contains("Produce the requested result."));
    assert!(debug.contains("[REDACTED]"));

    assert_eq!(
        ProviderRunStartRequest::new(
            binding("task-demo"),
            "command-start-001",
            "task-demo:start:1",
            "sha256:request-demo",
            "prompt",
            vec![artifact("task-other", "artifact-context-demo")],
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
    let duplicate = artifact("task-demo", "artifact-context-demo");
    assert_eq!(
        ProviderRunStartRequest::new(
            binding("task-demo"),
            "command-start-001",
            "task-demo:start:1",
            "sha256:request-demo",
            "prompt",
            vec![duplicate.clone(), duplicate],
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
}

#[test]
fn start_request_enforces_prompt_digest_and_input_bounds() {
    assert_eq!(
        ProviderRunStartRequest::new(
            binding("task-demo"),
            "command-start-001",
            "task-demo:start:1",
            "not-a-digest",
            "prompt",
            Vec::new(),
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
    assert_eq!(
        ProviderRunStartRequest::new(
            binding("task-demo"),
            "command-start-001",
            "task-demo:start:1",
            "sha256:request-demo",
            "x".repeat(MAX_PROMPT_CHARS + 1),
            Vec::new(),
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
}

#[test]
fn events_and_cancel_requests_are_bounded_before_network_use() {
    let events = ProviderRunEventsRequest::new(
        binding("task-demo"),
        "command-events-001",
        "provider-run-demo",
        Some("event-0003".to_string()),
        100,
    )
    .expect("events request");
    assert_eq!(events.after_cursor(), Some("event-0003"));
    assert_eq!(events.limit(), 100);

    assert_eq!(
        ProviderRunEventsRequest::new(
            binding("task-demo"),
            "command-events-001",
            "provider-run-demo",
            Some("cursor-three".to_string()),
            100,
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
    assert_eq!(
        ProviderRunCancelRequest::new(
            binding("task-demo"),
            "command-cancel-001",
            "provider-run-demo",
            "userRequested",
            0,
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
}

#[test]
fn artifact_reference_rejects_invalid_revision_and_control_characters() {
    assert_eq!(
        ProviderArtifactRef::new(
            "artifact\nforged",
            "task-demo",
            ProviderArtifactKind::Evidence,
            1,
            ProviderArtifactRetention::Task,
            10,
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
    assert_eq!(
        ProviderArtifactRef::new(
            "artifact-demo",
            "task-demo",
            ProviderArtifactKind::Evidence,
            0,
            ProviderArtifactRetention::Task,
            10,
        ),
        Err(AgentPlatformProviderError::InvalidRequest)
    );
}
