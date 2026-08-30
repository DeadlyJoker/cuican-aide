use pretty_assertions::assert_eq;

use super::*;

fn metadata(sequence: u64, created_at: i64) -> ProviderRunEventMetadata {
    ProviderRunEventMetadata::new(
        format!("event-id-{sequence}"),
        "provider-run-demo".to_string(),
        "attempt-demo-001".to_string(),
        sequence,
        format!("event-{sequence:04}"),
        "3.0.0".to_string(),
        created_at,
    )
    .expect("metadata")
}

fn event(sequence: u64, payload: ProviderRunEventPayload) -> ProviderRunEvent {
    ProviderRunEvent::new(
        metadata(sequence, 100 + sequence as i64),
        payload,
        "task-demo",
    )
    .expect("event")
}

#[test]
fn event_page_requires_contiguous_sequence_cursor_and_single_terminal_tail() {
    let page = ProviderRunEventPage::validated(
        vec![
            event(1, ProviderRunEventPayload::RunStarted { revision: 1 }),
            event(
                2,
                ProviderRunEventPayload::Progress {
                    summary: "working".to_string(),
                },
            ),
            event(
                3,
                ProviderRunEventPayload::Completed {
                    output_artifacts: Vec::new(),
                },
            ),
        ],
        Some("event-0003".to_string()),
        "provider-run-demo",
        None,
    )
    .expect("event page");
    assert_eq!(page.events().len(), 3);
    assert_eq!(page.last_cursor(), Some("event-0003"));

    assert_eq!(
        ProviderRunEventPage::validated(
            vec![
                event(1, ProviderRunEventPayload::RunStarted { revision: 1 }),
                event(
                    2,
                    ProviderRunEventPayload::Completed {
                        output_artifacts: Vec::new(),
                    },
                ),
                event(
                    3,
                    ProviderRunEventPayload::Progress {
                        summary: "late".to_string(),
                    },
                ),
            ],
            Some("event-0003".to_string()),
            "provider-run-demo",
            None,
        ),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}

#[test]
fn event_page_rejects_cursor_gap_regression_and_wrong_run() {
    let page_after_one = vec![event(
        2,
        ProviderRunEventPayload::Progress {
            summary: "working".to_string(),
        },
    )];
    assert!(
        ProviderRunEventPage::validated(
            page_after_one.clone(),
            Some("event-0002".to_string()),
            "provider-run-demo",
            Some("event-0001"),
        )
        .is_ok()
    );
    assert_eq!(
        ProviderRunEventPage::validated(
            page_after_one.clone(),
            Some("event-0002".to_string()),
            "provider-run-demo",
            Some("event-0000"),
        ),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
    assert_eq!(
        ProviderRunEventPage::validated(
            page_after_one,
            Some("event-0002".to_string()),
            "provider-run-other",
            Some("event-0001"),
        ),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}

#[test]
fn failed_event_must_bind_the_same_provider_run() {
    let failure = ProviderRunFailure::new(
        ProviderRunFailureCode::UnknownOutcome,
        false,
        "provider-run-other".to_string(),
        "trace-demo".to_string(),
    )
    .expect("failure");
    assert_eq!(
        ProviderRunEvent::new(
            metadata(2, 102),
            ProviderRunEventPayload::Failed { error: failure },
            "task-demo",
        ),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}

#[test]
fn output_artifacts_must_match_the_authorized_task() {
    let artifact = ProviderArtifactRef::new(
        "artifact-output",
        "task-other",
        crate::ProviderArtifactKind::Report,
        1,
        crate::ProviderArtifactRetention::Task,
        100,
    )
    .expect("artifact");
    assert_eq!(
        ProviderRunEvent::new(
            metadata(2, 102),
            ProviderRunEventPayload::Completed {
                output_artifacts: vec![artifact],
            },
            "task-demo",
        ),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}

#[test]
fn completed_event_rejects_duplicate_artifact_revisions() {
    let artifact = ProviderArtifactRef::new(
        "artifact-output",
        "task-demo",
        crate::ProviderArtifactKind::Report,
        1,
        crate::ProviderArtifactRetention::Task,
        100,
    )
    .expect("artifact");
    assert_eq!(
        ProviderRunEvent::new(
            metadata(2, 102),
            ProviderRunEventPayload::Completed {
                output_artifacts: vec![artifact.clone(), artifact],
            },
            "task-demo",
        ),
        Err(AgentPlatformProviderError::InvalidResponse)
    );
}
