use crate::ArtifactManifestRecord;
use crate::ArtifactRecordErrorKind;
use crate::PlatformAuditEventRecord;
use pretty_assertions::assert_eq;

#[test]
fn metadata_validation_rejects_sensitive_keys_inside_nested_arrays() {
    let mut event = audit_event();
    let mut json: serde_json::Value =
        serde_json::from_str(&event.metadata_json).expect("fixture JSON");
    json["cost"] = serde_json::json!({
        "type": "usage",
        "cost": {"nested": [[[{"body": "must-not-enter-audit"}]]]}
    });
    event.metadata_json = json.to_string();

    let error = event
        .validate()
        .expect_err("sensitive nested key must fail");
    assert_eq!(
        (error.field(), error.kind()),
        ("metadataJson", ArtifactRecordErrorKind::SensitiveMetadata)
    );
}

#[test]
fn metadata_validation_bounds_array_depth() {
    let mut event = audit_event();
    let mut nested = serde_json::json!(0);
    for _ in 0..40 {
        nested = serde_json::json!([nested]);
    }
    let mut json: serde_json::Value =
        serde_json::from_str(&event.metadata_json).expect("fixture JSON");
    json["cost"] = serde_json::json!({"type": "usage", "cost": nested});
    event.metadata_json = json.to_string();

    let error = event.validate().expect_err("deep metadata must fail");
    assert_eq!(
        (error.field(), error.kind()),
        ("metadataJson", ArtifactRecordErrorKind::TooLong)
    );
}

#[test]
fn audit_record_accepts_unknown_outcome_but_rejects_unstructured_error_text() {
    let mut event = audit_event();
    let mut json: serde_json::Value =
        serde_json::from_str(&event.metadata_json).expect("fixture JSON");
    json["outcome"] = serde_json::json!({
        "type": "unknown",
        "errorCode": "dynamicTool.timeout"
    });
    event.metadata_json = json.to_string();
    event.validate().expect("bounded unknown outcome");

    json["outcome"]["message"] = serde_json::json!("provider timeout body");
    event.metadata_json = json.to_string();
    let error = event
        .validate()
        .expect_err("raw external error text must be rejected");
    assert_eq!(
        (error.field(), error.kind()),
        ("metadataJson", ArtifactRecordErrorKind::InconsistentFields)
    );
}

#[test]
fn manifest_record_rejects_identity_mismatch_inside_json() {
    let record = ArtifactManifestRecord {
        artifact_id: "artifact-1".to_string(),
        revision: 1,
        idempotency_key: "artifact-create-1".to_string(),
        payload_id: "payload-1".to_string(),
        manifest_json: manifest_json("artifact-2"),
        created_at: 100,
    };
    let error = record.validate().expect_err("identity mismatch must fail");
    assert_eq!(
        (error.field(), error.kind()),
        ("manifestJson", ArtifactRecordErrorKind::InconsistentFields)
    );
}

fn audit_event() -> PlatformAuditEventRecord {
    PlatformAuditEventRecord {
        event_id: "event-1".to_string(),
        idempotency_key: "audit-1".to_string(),
        event_type: "policyEvaluated".to_string(),
        metadata_json: serde_json::json!({
            "schemaVersion": 1,
            "eventId": "event-1",
            "idempotencyKey": "audit-1",
            "actor": {"actorId": "actor-1", "tenantId": null, "spaceId": null},
            "workspace": {
                "workspaceKey": "workspace-1",
                "bindingId": "binding-1",
                "scope": "office",
                "scopeId": "office-1"
            },
            "execution": {"type": "conversation", "threadId": "thread-1", "turnId": "turn-1"},
            "action": "policyEvaluated",
            "outcome": {"type": "succeeded"},
            "trace": {"traceId": "trace-1", "spanId": "span-1", "parentSpanId": null},
            "cost": {"type": "none"},
            "resource": {"type": "none"},
            "approval": {"type": "none"},
            "artifacts": [],
            "payload": {"type": "none"},
            "occurredAt": 100
        })
        .to_string(),
        payload_id: None,
        occurred_at: 100,
    }
}

fn manifest_json(artifact_id: &str) -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "artifactRef": {"artifactId": artifact_id, "revision": 1},
        "kind": "report",
        "payload": {
            "payloadId": "payload-1",
            "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "byteLen": 1,
            "mediaType": "application/json",
            "sensitivity": "internal"
        },
        "producer": {"actorId": "actor-1", "tenantId": null, "spaceId": null},
        "workspace": {
            "workspaceKey": "workspace-1",
            "bindingId": "binding-1",
            "scope": "office",
            "scopeId": "office-1"
        },
        "execution": {"type": "conversation", "threadId": "thread-1", "turnId": "turn-1"},
        "resource": {"type": "none"},
        "approval": {"type": "none"},
        "trace": {"traceId": "trace-1", "spanId": "span-1", "parentSpanId": null},
        "verification": "verified",
        "retention": {"type": "userManaged"},
        "createdAt": 100
    })
    .to_string()
}
