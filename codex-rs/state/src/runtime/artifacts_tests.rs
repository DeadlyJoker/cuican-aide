use super::StateRuntime;
use crate::ArtifactCommitOutcome;
use crate::ArtifactCommitRecord;
use crate::ArtifactDeletionReason;
use crate::ArtifactManifestRecord;
use crate::ArtifactPayloadDeleteOutcome;
use crate::ArtifactPayloadDeleteRecord;
use crate::ArtifactPayloadRecord;
use crate::ArtifactPayloadSensitivity;
use crate::ArtifactPayloadStatus;
use crate::ArtifactRetentionKind;
use crate::AuditAppendOutcome;
use crate::PlatformAuditEventRecord;
use crate::StoredArtifactMetadataRecord;
use crate::StoredArtifactPayloadMetadataRecord;
use crate::digest_bytes;
use crate::runtime::state_db_path;
use crate::runtime::test_support::unique_temp_dir;
use pretty_assertions::assert_eq;

const SECRET_MARKER: &str = "raw-tool-body-should-disappear-7f8935";

#[tokio::test]
async fn artifact_commit_is_atomic_idempotent_and_survives_restart() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let commit = artifact_commit("1", b"bounded report", ArtifactRetentionKind::UserManaged);

    assert_eq!(
        runtime
            .commit_artifact_record(&commit)
            .await
            .expect("first commit"),
        ArtifactCommitOutcome::Created
    );
    assert_eq!(
        runtime
            .commit_artifact_record(&commit)
            .await
            .expect("idempotent retry"),
        ArtifactCommitOutcome::ExistingSame
    );
    let mut conflicting = commit.clone();
    conflicting.payload.media_type = "text/plain".to_string();
    replace_json_string(
        &mut conflicting.manifest.manifest_json,
        "/payload/mediaType",
        "text/plain",
    );
    replace_json_string(
        &mut conflicting.created_event.metadata_json,
        "/payload/payload/mediaType",
        "text/plain",
    );
    assert_eq!(
        runtime
            .commit_artifact_record(&conflicting)
            .await
            .expect("conflict result"),
        ArtifactCommitOutcome::Conflict
    );

    let expected = runtime
        .get_artifact_record("artifact-1", 1)
        .await
        .expect("read Artifact")
        .expect("stored Artifact");
    assert_eq!(expected.payload.content, Some(b"bounded report".to_vec()));
    assert_eq!(
        runtime
            .get_artifact_metadata_record("artifact-1", 1)
            .await
            .expect("read Artifact metadata"),
        Some(StoredArtifactMetadataRecord {
            manifest: expected.manifest.clone(),
            payload: StoredArtifactPayloadMetadataRecord {
                payload_id: expected.payload.payload_id.clone(),
                sha256: expected.payload.sha256.clone(),
                byte_len: expected.payload.byte_len,
                media_type: expected.payload.media_type.clone(),
                sensitivity: expected.payload.sensitivity,
                retention_kind: expected.payload.retention_kind,
                expires_at: expected.payload.expires_at,
                status: expected.payload.status,
                deletion_reason: expected.payload.deletion_reason,
                deleted_at: expected.payload.deleted_at,
                created_at: expected.payload.created_at,
            },
        })
    );
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_artifact_record("artifact-1", 1)
            .await
            .expect("read reopened Artifact"),
        Some(expected)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn artifact_body_length_tampering_fails_before_blob_is_returned() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let commit = artifact_commit("1", b"short body", ArtifactRetentionKind::UserManaged);
    runtime
        .commit_artifact_record(&commit)
        .await
        .expect("commit Artifact");
    sqlx::query("UPDATE artifact_payloads SET content = zeroblob(131072) WHERE payload_id = ?")
        .bind(&commit.payload.payload_id)
        .execute(runtime.pool.as_ref())
        .await
        .expect("tamper body length");

    assert_eq!(
        runtime
            .get_artifact_record("artifact-1", 1)
            .await
            .expect("read tampered Artifact"),
        None
    );
    assert!(
        runtime
            .get_artifact_metadata_record("artifact-1", 1)
            .await
            .expect("read immutable metadata")
            .is_some()
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn identity_conflict_rolls_back_payload_and_manifest() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let commit = artifact_commit("1", b"must roll back", ArtifactRetentionKind::UserManaged);
    let colliding_event = audit_event(
        "created-1",
        "other-audit-idempotency",
        "externalAction",
        None,
        100,
    );
    assert_eq!(
        runtime
            .append_platform_audit_event(&colliding_event)
            .await
            .expect("seed Audit Event"),
        AuditAppendOutcome::Created
    );

    assert_eq!(
        runtime
            .commit_artifact_record(&commit)
            .await
            .expect("identity conflict"),
        ArtifactCommitOutcome::Conflict
    );
    assert_eq!(
        runtime
            .get_artifact_record("artifact-1", 1)
            .await
            .expect("read missing Artifact"),
        None
    );
    let payload_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artifact_payloads")
        .fetch_one(runtime.pool.as_ref())
        .await
        .expect("payload count");
    assert_eq!(payload_count, 0);
    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn deletion_keeps_manifest_and_audit_but_physically_removes_body() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let commit = artifact_commit(
        "1",
        SECRET_MARKER.as_bytes(),
        ArtifactRetentionKind::UserManaged,
    );
    runtime
        .commit_artifact_record(&commit)
        .await
        .expect("commit Artifact");
    let delete = delete_record(
        "1",
        SECRET_MARKER.as_bytes(),
        ArtifactDeletionReason::UserRequested,
        150,
    );
    assert_eq!(
        runtime
            .delete_artifact_payload(&delete)
            .await
            .expect("delete payload"),
        ArtifactPayloadDeleteOutcome::Deleted
    );
    assert_eq!(
        runtime
            .delete_artifact_payload(&delete)
            .await
            .expect("idempotent delete"),
        ArtifactPayloadDeleteOutcome::AlreadyDeleted
    );
    assert_eq!(
        runtime
            .delete_artifact_payload(&delete_record(
                "1",
                SECRET_MARKER.as_bytes(),
                ArtifactDeletionReason::AuthorityPolicy,
                151,
            ))
            .await
            .expect("conflicting delete retry"),
        ArtifactPayloadDeleteOutcome::AuditConflict
    );

    let stored = runtime
        .get_artifact_record("artifact-1", 1)
        .await
        .expect("read Artifact")
        .expect("stored Artifact");
    assert_eq!(stored.payload.status, ArtifactPayloadStatus::Deleted);
    assert_eq!(stored.payload.content, None);
    assert_eq!(
        stored.payload.deletion_reason,
        Some(ArtifactDeletionReason::UserRequested)
    );
    assert!(
        runtime
            .get_platform_audit_event("created-1")
            .await
            .expect("read creation audit")
            .is_some()
    );
    assert!(
        runtime
            .get_platform_audit_event("deleted-1")
            .await
            .expect("read deletion audit")
            .is_some()
    );
    assert_eq!(
        runtime
            .commit_artifact_record(&commit)
            .await
            .expect("retry create after delete"),
        ArtifactCommitOutcome::ExistingSame
    );
    assert_eq!(
        runtime
            .get_artifact_record("artifact-1", 1)
            .await
            .expect("read after retry")
            .expect("Artifact")
            .payload
            .content,
        None
    );
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_artifact_record("artifact-1", 1)
            .await
            .expect("read reopened")
            .expect("Artifact")
            .payload
            .content,
        None
    );
    reopened.close().await;
    assert_state_files_do_not_contain(&codex_home, SECRET_MARKER.as_bytes()).await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn compliance_and_expiry_deletion_are_fail_closed_and_bounded() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let compliance = artifact_commit("1", b"compliance", ArtifactRetentionKind::Compliance);
    runtime
        .commit_artifact_record(&compliance)
        .await
        .expect("commit compliance Artifact");
    assert_eq!(
        runtime
            .delete_artifact_payload(&delete_record(
                "1",
                b"compliance",
                ArtifactDeletionReason::UserRequested,
                150,
            ))
            .await
            .expect("user delete decision"),
        ArtifactPayloadDeleteOutcome::AuthorityDenied
    );
    assert_eq!(
        runtime
            .delete_artifact_payload(&delete_record(
                "1",
                b"compliance",
                ArtifactDeletionReason::RetentionExpired,
                199,
            ))
            .await
            .expect("early expiry decision"),
        ArtifactPayloadDeleteOutcome::AuthorityDenied
    );

    for suffix in ["2", "3", "4"] {
        runtime
            .commit_artifact_record(&artifact_commit(
                suffix,
                suffix.as_bytes(),
                ArtifactRetentionKind::Session,
            ))
            .await
            .expect("commit expiring Artifact");
    }
    assert_eq!(
        runtime
            .list_expired_artifact_payload_ids(199, 2)
            .await
            .expect("no expired payloads"),
        Vec::<String>::new()
    );
    assert_eq!(
        runtime
            .list_expired_artifact_payload_ids(200, 2)
            .await
            .expect("bounded expired payloads"),
        vec!["payload-1".to_string(), "payload-2".to_string()]
    );
    assert!(
        runtime
            .list_expired_artifact_payload_ids(200, 0)
            .await
            .is_err()
    );
    assert_eq!(
        runtime
            .delete_artifact_payload(&delete_record(
                "1",
                b"compliance",
                ArtifactDeletionReason::RetentionExpired,
                200,
            ))
            .await
            .expect("expiry delete"),
        ArtifactPayloadDeleteOutcome::Deleted
    );
    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn standalone_audit_append_is_idempotent_and_conflict_aware() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let event = audit_event("event-1", "audit-1", "policyEvaluated", None, 100);
    assert_eq!(
        runtime
            .append_platform_audit_event(&event)
            .await
            .expect("append event"),
        AuditAppendOutcome::Created
    );
    assert_eq!(
        runtime
            .append_platform_audit_event(&event)
            .await
            .expect("retry event"),
        AuditAppendOutcome::ExistingSame
    );
    let mut conflict = event;
    conflict.event_type = "approvalDecided".to_string();
    replace_json_string(&mut conflict.metadata_json, "/action", "approvalDecided");
    assert_eq!(
        runtime
            .append_platform_audit_event(&conflict)
            .await
            .expect("event conflict"),
        AuditAppendOutcome::Conflict
    );
    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

async fn initialized(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(codex_home.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize State Runtime")
}

fn artifact_commit(
    suffix: &str,
    content: &[u8],
    retention_kind: ArtifactRetentionKind,
) -> ArtifactCommitRecord {
    let payload_id = format!("payload-{suffix}");
    let artifact_id = format!("artifact-{suffix}");
    let digest = digest_bytes(content);
    let expires_at = (retention_kind != ArtifactRetentionKind::UserManaged).then_some(200);
    ArtifactCommitRecord {
        payload: ArtifactPayloadRecord {
            payload_id: payload_id.clone(),
            sha256: digest.clone(),
            media_type: "application/json".to_string(),
            sensitivity: ArtifactPayloadSensitivity::WorkspaceSensitive,
            retention_kind,
            expires_at,
            content: content.to_vec(),
            created_at: 100,
        },
        manifest: ArtifactManifestRecord {
            artifact_id: artifact_id.clone(),
            revision: 1,
            idempotency_key: format!("artifact-create-{suffix}"),
            payload_id: payload_id.clone(),
            manifest_json: manifest_json(
                &artifact_id,
                &payload_id,
                &digest,
                content.len(),
                retention_kind,
                expires_at,
            ),
            created_at: 100,
        },
        created_event: creation_audit_event(
            suffix,
            &artifact_id,
            &payload_id,
            &digest,
            content.len(),
        ),
    }
}

fn delete_record(
    suffix: &str,
    content: &[u8],
    reason: ArtifactDeletionReason,
    deleted_at: i64,
) -> ArtifactPayloadDeleteRecord {
    let payload_id = format!("payload-{suffix}");
    let event_type = if reason == ArtifactDeletionReason::RetentionExpired {
        "retentionExpired"
    } else {
        "payloadDeleted"
    };
    ArtifactPayloadDeleteRecord {
        payload_id: payload_id.clone(),
        reason,
        deleted_at,
        audit_event: deletion_audit_event(suffix, event_type, &payload_id, content, deleted_at),
    }
}

fn manifest_json(
    artifact_id: &str,
    payload_id: &str,
    digest: &str,
    byte_len: usize,
    retention_kind: ArtifactRetentionKind,
    expires_at: Option<i64>,
) -> String {
    let retention = match retention_kind {
        ArtifactRetentionKind::Session => {
            serde_json::json!({"type": "session", "expiresAt": expires_at})
        }
        ArtifactRetentionKind::Task => {
            serde_json::json!({"type": "task", "expiresAt": expires_at})
        }
        ArtifactRetentionKind::UserManaged => serde_json::json!({"type": "userManaged"}),
        ArtifactRetentionKind::Compliance => {
            serde_json::json!({"type": "compliance", "expiresAt": expires_at})
        }
    };
    serde_json::json!({
        "schemaVersion": 1,
        "artifactRef": {"artifactId": artifact_id, "revision": 1},
        "kind": "report",
        "payload": {
            "payloadId": payload_id,
            "digest": digest,
            "byteLen": byte_len,
            "mediaType": "application/json",
            "sensitivity": "workspaceSensitive"
        },
        "producer": {"actorId": "actor-1", "tenantId": "tenant-1", "spaceId": null},
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
        "retention": retention,
        "createdAt": 100
    })
    .to_string()
}

fn creation_audit_event(
    suffix: &str,
    artifact_id: &str,
    payload_id: &str,
    digest: &str,
    byte_len: usize,
) -> PlatformAuditEventRecord {
    let event_id = format!("created-{suffix}");
    let idempotency_key = format!("audit-created-{suffix}");
    PlatformAuditEventRecord {
        event_id: event_id.clone(),
        idempotency_key: idempotency_key.clone(),
        event_type: "artifactCreated".to_string(),
        metadata_json: serde_json::json!({
            "schemaVersion": 1,
            "eventId": event_id,
            "idempotencyKey": idempotency_key,
            "actor": {"actorId": "actor-1", "tenantId": "tenant-1", "spaceId": null},
            "workspace": {
                "workspaceKey": "workspace-1",
                "bindingId": "binding-1",
                "scope": "office",
                "scopeId": "office-1"
            },
            "execution": {"type": "conversation", "threadId": "thread-1", "turnId": "turn-1"},
            "action": "artifactCreated",
            "outcome": {"type": "succeeded"},
            "trace": {"traceId": "trace-1", "spanId": "span-1", "parentSpanId": null},
            "cost": {"type": "none"},
            "resource": {"type": "none"},
            "approval": {"type": "none"},
            "artifacts": [{"artifactId": artifact_id, "revision": 1}],
            "payload": {
                "type": "payload",
                "payload": {
                    "payloadId": payload_id,
                    "digest": digest,
                    "byteLen": byte_len,
                    "mediaType": "application/json",
                    "sensitivity": "workspaceSensitive"
                }
            },
            "occurredAt": 100
        })
        .to_string(),
        payload_id: Some(payload_id.to_string()),
        occurred_at: 100,
    }
}

fn deletion_audit_event(
    suffix: &str,
    event_type: &str,
    payload_id: &str,
    content: &[u8],
    occurred_at: i64,
) -> PlatformAuditEventRecord {
    let event_id = format!("deleted-{suffix}");
    let idempotency_key = format!("audit-deleted-{suffix}");
    let digest = digest_bytes(content);
    PlatformAuditEventRecord {
        event_id: event_id.clone(),
        idempotency_key: idempotency_key.clone(),
        event_type: event_type.to_string(),
        metadata_json: serde_json::json!({
            "schemaVersion": 1,
            "eventId": event_id,
            "idempotencyKey": idempotency_key,
            "actor": {"actorId": "actor-1", "tenantId": "tenant-1", "spaceId": null},
            "workspace": {
                "workspaceKey": "workspace-1",
                "bindingId": "binding-1",
                "scope": "office",
                "scopeId": "office-1"
            },
            "execution": {"type": "conversation", "threadId": "thread-1", "turnId": "turn-1"},
            "action": event_type,
            "outcome": {"type": "succeeded"},
            "trace": {"traceId": "trace-1", "spanId": "span-delete", "parentSpanId": "span-1"},
            "cost": {"type": "none"},
            "resource": {"type": "none"},
            "approval": {"type": "none"},
            "artifacts": [],
            "payload": {
                "type": "payload",
                "payload": {
                    "payloadId": payload_id,
                    "digest": digest,
                    "byteLen": content.len(),
                    "mediaType": "application/json",
                    "sensitivity": "workspaceSensitive"
                }
            },
            "occurredAt": occurred_at
        })
        .to_string(),
        payload_id: Some(payload_id.to_string()),
        occurred_at,
    }
}

fn audit_event(
    event_id: &str,
    idempotency_key: &str,
    event_type: &str,
    payload_id: Option<&str>,
    occurred_at: i64,
) -> PlatformAuditEventRecord {
    let payload = payload_id.map_or_else(
        || serde_json::json!({"type": "none"}),
        |payload_id| {
            serde_json::json!({
                "type": "payload",
                "payload": {
                    "payloadId": payload_id,
                    "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "byteLen": 1,
                    "mediaType": "application/json",
                    "sensitivity": "workspaceSensitive"
                }
            })
        },
    );
    PlatformAuditEventRecord {
        event_id: event_id.to_string(),
        idempotency_key: idempotency_key.to_string(),
        event_type: event_type.to_string(),
        metadata_json: serde_json::json!({
            "schemaVersion": 1,
            "eventId": event_id,
            "idempotencyKey": idempotency_key,
            "actor": {"actorId": "actor-1", "tenantId": "tenant-1", "spaceId": null},
            "workspace": {
                "workspaceKey": "workspace-1",
                "bindingId": "binding-1",
                "scope": "office",
                "scopeId": "office-1"
            },
            "execution": {"type": "conversation", "threadId": "thread-1", "turnId": "turn-1"},
            "action": event_type,
            "outcome": {"type": "succeeded"},
            "trace": {"traceId": "trace-1", "spanId": "span-1", "parentSpanId": null},
            "cost": {"type": "none"},
            "resource": {"type": "none"},
            "approval": {"type": "none"},
            "artifacts": [],
            "payload": payload,
            "occurredAt": occurred_at
        })
        .to_string(),
        payload_id: payload_id.map(str::to_string),
        occurred_at,
    }
}

async fn assert_state_files_do_not_contain(codex_home: &std::path::Path, needle: &[u8]) {
    let base = state_db_path(codex_home);
    for suffix in ["", "-wal", "-shm"] {
        let path = std::path::PathBuf::from(format!("{}{suffix}", base.display()));
        let Ok(bytes) = tokio::fs::read(path).await else {
            continue;
        };
        assert!(
            !bytes.windows(needle.len()).any(|window| window == needle),
            "deleted payload remained in an active SQLite file"
        );
    }
}

fn replace_json_string(json: &mut String, pointer: &str, replacement: &str) {
    let mut value: serde_json::Value = serde_json::from_str(json).expect("parse fixture JSON");
    *value
        .pointer_mut(pointer)
        .expect("fixture JSON pointer must exist") =
        serde_json::Value::String(replacement.to_string());
    *json = value.to_string();
}
