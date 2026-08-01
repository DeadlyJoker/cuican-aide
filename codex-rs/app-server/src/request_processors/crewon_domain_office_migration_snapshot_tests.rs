use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;

use super::OfficeLegacySnapshotError;
use super::OfficeMigrationBlockingRun;
use super::OfficeMigrationQuiesceState;
use super::normalize_legacy_office_record;

fn persisted(config: JsonValue) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "version": 1,
        "kind": "office",
        "savedAt": "2026-06-28T12:00:00.000Z",
        "config": config,
    }))
    .expect("serialize legacy fixture")
}

fn workspace(activity: JsonValue) -> JsonValue {
    json!({
        "title": "设计交付办公室",
        "workspace": {
            "recordId": "office-design",
            "recordRevision": "revision-7",
            "threadId": "thread-manager",
            "members": [
                {"memberId": "manager", "role": "leader", "threadId": "thread-manager"},
                {"memberId": "reviewer", "agentId": "agent-review", "threadId": "thread-review"}
            ],
            "activity": activity,
            "messages": [{"id": "message-1", "text": "保留群聊含义"}]
        }
    })
}

#[test]
fn normalizes_idle_and_completed_history_without_semantic_loss() {
    let source = persisted(workspace(json!({
        "runs": [
            {"id": "run-completed", "status": "completed", "threadId": "thread-manager"},
            {"id": "run-failed", "status": "failed", "delegations": [{"status": "completed"}]}
        ],
        "approvals": [{"id": "approval-1", "status": "pending"}],
        "artifacts": [{"id": "artifact-1", "contentSha256": "sha256:abc"}],
        "sharedLedger": {"summary": "风险已收敛"}
    })));

    let observed = normalize_legacy_office_record("design-office.json", &source)
        .expect("normalize idle office");
    assert_eq!(observed.record_id, "office-design");
    assert_eq!(observed.source_revision, "revision-7");
    assert_eq!(observed.source_bytes, source.len() as u64);
    assert_eq!(observed.quiesce_state, OfficeMigrationQuiesceState::Idle);
    let snapshot: JsonValue =
        serde_json::from_str(&observed.snapshot_json).expect("parse normalized snapshot");
    assert_eq!(snapshot["schema"], "crewon.office-legacy-snapshot/v1");
    assert_eq!(snapshot["recordId"], "office-design");
    assert_eq!(snapshot["recordRevision"], "revision-7");
    assert_eq!(
        snapshot["config"],
        workspace(json!({
            "runs": [
                {"id": "run-completed", "status": "completed", "threadId": "thread-manager"},
                {"id": "run-failed", "status": "failed", "delegations": [{"status": "completed"}]}
            ],
            "approvals": [{"id": "approval-1", "status": "pending"}],
            "artifacts": [{"id": "artifact-1", "contentSha256": "sha256:abc"}],
            "sharedLedger": {"summary": "风险已收敛"}
        }))
    );
}

#[test]
fn canonical_snapshot_is_stable_across_json_key_order() {
    let left = br#"{"version":1,"kind":"office","savedAt":null,"config":{"title":"Office","workspace":{"recordId":"office-1","recordRevision":"revision-1","threadId":"thread-1","activity":{"runs":[]}}}}"#;
    let right = br#"{"config":{"workspace":{"activity":{"runs":[]},"threadId":"thread-1","recordRevision":"revision-1","recordId":"office-1"},"title":"Office"},"savedAt":null,"kind":"office","version":1}"#;

    let left = normalize_legacy_office_record("office.json", left).expect("normalize left");
    let right = normalize_legacy_office_record("office.json", right).expect("normalize right");
    assert_eq!(left.snapshot_json, right.snapshot_json);
    assert_eq!(left.snapshot_digest, right.snapshot_digest);
    assert_ne!(left.source_digest, right.source_digest);
}

#[test]
fn identifies_running_and_active_child_work_as_blocking() {
    let running = persisted(workspace(json!({
        "runs": [{
            "id": "run-active",
            "status": "running",
            "threadId": "thread-manager",
            "turnId": "turn-1"
        }]
    })));
    let observed =
        normalize_legacy_office_record("office.json", &running).expect("normalize running office");
    assert_eq!(
        observed.quiesce_state,
        OfficeMigrationQuiesceState::Blocked(OfficeMigrationBlockingRun {
            run_id: "run-active".to_string(),
            thread_id: "thread-manager".to_string(),
            turn_id: Some("turn-1".to_string()),
            manager_is_steerable: true,
        })
    );

    let active_child = persisted(workspace(json!({
        "runs": [{
            "id": "run-terminal-manager",
            "status": "failed",
            "delegations": [{"id": "delegation-1", "status": "running"}]
        }]
    })));
    let observed = normalize_legacy_office_record("office.json", &active_child)
        .expect("normalize active child office");
    assert_eq!(
        observed.quiesce_state,
        OfficeMigrationQuiesceState::Blocked(OfficeMigrationBlockingRun {
            run_id: "run-terminal-manager".to_string(),
            thread_id: "thread-manager".to_string(),
            turn_id: None,
            manager_is_steerable: false,
        })
    );
}

#[test]
fn derives_stable_legacy_identity_and_redacts_debug_output() {
    let source = persisted(json!({
        "title": "Legacy Office",
        "workspace": {"threadId": "thread-legacy", "activity": {"runs": []}}
    }));
    let observed = normalize_legacy_office_record("legacy-office.json", &source)
        .expect("normalize legacy office");
    assert!(observed.record_id.starts_with("legacy-"));
    assert!(observed.source_revision.starts_with("legacy-"));
    let snapshot: JsonValue =
        serde_json::from_str(&observed.snapshot_json).expect("parse normalized snapshot");
    assert_eq!(
        snapshot["config"]["workspace"]["recordId"],
        observed.record_id
    );
    assert_eq!(
        snapshot["config"]["workspace"]["recordRevision"],
        observed.source_revision
    );
    let debug = format!("{observed:?}");
    assert!(debug.contains("[REDACTED]"));
    assert!(!debug.contains("Legacy Office"));
    assert!(!debug.contains("thread-legacy"));
}

#[test]
fn rejects_corrupt_unknown_and_oversized_sources_fail_closed() {
    assert_eq!(
        normalize_legacy_office_record("office.json", b"not-json"),
        Err(OfficeLegacySnapshotError::InvalidEnvelope)
    );
    assert_eq!(
        normalize_legacy_office_record(
            "office.json",
            &persisted(json!({"title": "Office", "workspace": {"activity": {"runs": {}}}}))
        ),
        Err(OfficeLegacySnapshotError::InvalidActivityRuns)
    );
    assert_eq!(
        normalize_legacy_office_record(
            "office.json",
            &persisted(workspace(json!({"runs": [{"status": "mystery"}]})))
        ),
        Err(OfficeLegacySnapshotError::InvalidBlockingRun)
    );
    let oversized = vec![b' '; crewon_state::MAX_OFFICE_MIGRATION_SOURCE_BYTES as usize + 1];
    assert_eq!(
        normalize_legacy_office_record("office.json", &oversized),
        Err(OfficeLegacySnapshotError::SourceTooLarge)
    );

    let max_source_bytes = crewon_state::MAX_OFFICE_MIGRATION_SOURCE_BYTES as usize;
    let empty = persisted(workspace(json!({"runs": [], "padding": ""})));
    let padding = "x".repeat(max_source_bytes - empty.len() - 8);
    let bounded_source = persisted(workspace(json!({"runs": [], "padding": padding})));
    assert!(bounded_source.len() <= max_source_bytes);
    assert_eq!(
        normalize_legacy_office_record("office.json", &bounded_source),
        Err(OfficeLegacySnapshotError::SnapshotTooLarge)
    );
}
