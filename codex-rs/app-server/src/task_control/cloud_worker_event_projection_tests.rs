use crewon_provider_agent_platform::ProviderArtifactKind;
use crewon_provider_agent_platform::ProviderArtifactRef;
use crewon_provider_agent_platform::ProviderArtifactRetention;
use crewon_provider_agent_platform::ProviderRunEvent;
use crewon_provider_agent_platform::ProviderRunEventMetadata;
use crewon_provider_agent_platform::ProviderRunEventPayload;
use pretty_assertions::assert_eq;

use super::provider_event_projection;

#[test]
fn completed_projection_is_exact_and_payload_bound() {
    let first = completed_event("artifact-1");
    let second = completed_event("artifact-2");

    let first_projection =
        provider_event_projection(&first, "completed", "task-1").expect("first projection");
    let second_projection =
        provider_event_projection(&second, "completed", "task-1").expect("second projection");

    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&first_projection.projection_json)
            .expect("projection JSON"),
        serde_json::json!({
            "type": "completed",
            "outputArtifacts": [{
                "artifactId": "artifact-1",
                "taskId": "task-1",
                "kind": "report",
                "revision": 1,
                "retention": "task",
                "createdAt": 100,
            }],
        })
    );
    assert_ne!(
        first_projection.payload_digest,
        second_projection.payload_digest
    );
}

fn completed_event(artifact_id: &str) -> ProviderRunEvent {
    let artifact = ProviderArtifactRef::new(
        artifact_id,
        "task-1",
        ProviderArtifactKind::Report,
        /*revision*/ 1,
        ProviderArtifactRetention::Task,
        /*created_at*/ 100,
    )
    .expect("artifact");
    ProviderRunEvent::new(
        ProviderRunEventMetadata::new(
            "provider-event-1".to_string(),
            "provider-run-1".to_string(),
            "provider-attempt-1".to_string(),
            /*sequence*/ 1,
            "event-0001".to_string(),
            "3.0.0".to_string(),
            /*created_at*/ 100,
        )
        .expect("metadata"),
        ProviderRunEventPayload::Completed {
            output_artifacts: vec![artifact],
        },
        "task-1",
    )
    .expect("event")
}
